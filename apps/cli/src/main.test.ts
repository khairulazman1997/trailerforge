import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

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

describe('tforge variants, brand, effects and sfx', () => {
  let root: string;
  let dir: string;
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...args, '--home', join(root, 'home')],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      process.env,
      { engine: { llm } },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tforge-cligfx-'));
    dir = join(root, 'G.tforge');
    const engine = await Engine.start({
      home: join(root, 'home'),
      autosaveMs: 0,
      loadUserPlugins: false,
      llm,
    });
    await engine.createProject(dir, sampleProject() as never);
    await engine.close();
  });

  it('lists versions, adds the missing ones and edits a version', async () => {
    const list = await run(['variants', 'list', dir]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/var_tt: TikTok 9:16/);
    expect(list.out).toMatch(/Formats without a version: fmt_yt/);
    expect((await run(['variants', 'defaults', dir])).out).toMatch(/Added var_/);
    const set = await run([
      'variants',
      'set',
      dir,
      'var_tt',
      '--length',
      '15',
      '--reframe',
      'fill',
    ]);
    expect(set.code).toBe(0);
    const ov = await run([
      'variants',
      'override',
      dir,
      'var_tt',
      '--slot',
      'shot_parry',
      '--keep',
      '--focus',
      '0.4,0.5',
    ]);
    expect(ov.code).toBe(0);
    const json = await run(['variants', 'list', dir, '--json']);
    const tt = (
      JSON.parse(json.out) as {
        variants: {
          id: string;
          targetDuration: number;
          reframe: string;
          overrides: Record<string, unknown>;
        }[];
      }
    ).variants.find((v) => v.id === 'var_tt')!;
    expect(tt).toMatchObject({ targetDuration: 15, reframe: 'fill' });
    expect(tt.overrides.shot_parry).toEqual({ excluded: false, cropCenter: { x: 0.4, y: 0.5 } });
    expect((await run(['variants', 'override', dir, 'var_tt', '--clear'])).code).toBe(0);
    expect((await run(['variants', 'remove', dir, 'var_tt'])).code).toBe(0);
    const bad = await run(['variants', 'add', dir]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--target/);
    expect(
      (await run(['variants', 'override', dir, 'var_x', '--slot', 's', '--focus', '2,2'])).code,
    ).toBe(2);
  });

  it('sets brand colours and sizes, imports a logo, and flags low contrast', async () => {
    expect((await run(['brand', 'show', dir])).out).toMatch(/No brand kit yet/);
    const set = await run(['brand', 'set', dir, '--set', 'primary=#ff8800', '--set', 'title=0.1']);
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/primary #ff8800/);
    expect(set.out).toMatch(/title 0\.1/);
    const logo = join(root, 'logo.svg');
    await writeFile(
      logo,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>',
    );
    expect((await run(['brand', 'logo', dir, logo])).out).toMatch(/Set the logo from logo\.svg/);
    const low = await run([
      'brand',
      'set',
      dir,
      '--set',
      'text=#999999',
      '--set',
      'background=#aaaaaa',
    ]);
    expect(low.code).toBe(1); // warnings found
    expect(low.out).toMatch(/! The text on background contrast/);
    expect((await run(['brand', 'set', dir, '--set', 'sparkle=1'])).code).toBe(2);
    expect((await run(['brand', 'logo', dir, join(root, 'missing.svg')])).code).toBe(2);
    expect((await run(['brand', 'reset', dir])).code).toBe(0);
  });

  it('lists what is installed and manages the sound folder', async () => {
    const e = await run(['effects']);
    expect(e.out).toMatch(/Transitions: .*whip/);
    expect(e.out).toMatch(/Sounds: whoosh, riser, impact, sub-drop/);
    const pack = join(root, 'pack');
    await (await import('node:fs/promises')).mkdir(pack);
    await writeFile(join(pack, 'big-impact.wav'), 'x');
    expect((await run(['sfx', 'folder', pack])).out).toMatch(/Using .*pack \(1 files\)/);
    expect((await run(['sfx', 'show'])).out).toMatch(/big-impact\.wav: impact/);
    expect((await run(['sfx', 'folder', 'none'])).out).toMatch(/only the generated sounds/);
    expect((await run(['sfx', 'folder', join(root, 'nope')])).code).toBe(2);
  });
});
