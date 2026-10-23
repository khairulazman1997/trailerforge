import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

let root: string;
let home: string;
let clip: string;

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, '--home', home], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-cli-'));
  home = join(root, 'home');
  clip = join(root, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=d=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    clip,
  ]);
}, 60_000);

describe('tforge CLI (end-to-end smoke)', () => {
  it('creates a project, reloads it, probes and proxies media, and lists jobs', async () => {
    const dir = join(root, 'Ember.tforge');
    const created = await run(
      'new',
      dir,
      '--name',
      'Ember Knight',
      '--type',
      'game-trailer/release-trailer',
      '--json',
    );
    expect(created.code).toBe(0);
    const { id } = JSON.parse(created.out) as { id: string };

    const info = await run('info', dir, '--json');
    expect(info.code).toBe(0);
    expect(JSON.parse(info.out)).toMatchObject({
      id,
      name: 'Ember Knight',
      schemaVersion: 1,
      videoType: 'game-trailer/release-trailer',
      domainPack: 'game-trailer',
    });

    const probed = await run('probe', clip);
    expect(probed.code).toBe(0);
    expect(probed.out).toMatch(/video: h264 320x180 @ 30\.000 fps/);

    const proxy = await run('proxy', clip, '--out', join(root, 'clip.proxy.mp4'), '--json');
    expect(proxy.code).toBe(0);
    expect(existsSync(join(root, 'clip.proxy.mp4'))).toBe(true);

    const jobs = await run('jobs', '--json');
    expect(
      (JSON.parse(jobs.out) as { type: string; status: string }[]).map((j) => [j.type, j.status]),
    ).toEqual([['core/media.proxy', 'succeeded']]);
  }, 60_000);

  it('lists the built-in core plugin as active', async () => {
    const r = await run('plugins');
    expect(r.out).toMatch(/^core\s+active/m);
  });

  it('reports failures with typed messages and exit codes', async () => {
    const bad = join(root, 'bad.mp4');
    await writeFile(bad, 'not a video');
    expect(await run('probe', bad)).toMatchObject({
      code: 1,
      err: expect.stringMatching(/^corrupt-file:/),
    });

    const failedProxy = await run('proxy', bad, '--out', join(root, 'bad.proxy.mp4'));
    expect(failedProxy.code).toBe(1);
    expect(failedProxy.err).toMatch(/proxy failed: corrupt-file/);

    expect(await run('info', join(root, 'missing.tforge'))).toMatchObject({
      code: 1,
      err: expect.stringMatching(/no project\.json/),
    });
    expect((await run('frobnicate')).code).toBe(2);
    expect((await run('new', join(root, 'x.tforge'))).code).toBe(2); // missing --name
  }, 60_000);
});
