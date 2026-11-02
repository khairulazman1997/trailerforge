import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { importFootageOp, matchAcceptOp, matchSuggestOp } from './footage-ops.js';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-unity-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
});
afterAll(async () => {
  await engine.close();
});

async function idle(ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sidecar = (code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'trailerforge.unity-take',
    version: 1,
    code,
    take: 1,
    level: 'live',
    pass: { camera: 'main', hud: 'off', speed: 1, width: 320, height: 180, fps: 30, codec: 'h264' },
    frames: 60,
    seconds: 2,
    ...over,
  });

describe('takes recorded by the Unity package', () => {
  it('imports finished takes only, attaches them by sidecar code with their origin, reports a foreign code', async () => {
    const codes = shotCodes(Project.parse(sampleProject()));
    const parry = codes.get('shot_parry')!;
    const boss = codes.get('shot_boss')!;
    const dir = join(root, 'unity-out');
    mkdirSync(join(dir, '.tfpartial'), { recursive: true });
    const clip = (path: string, tint: string) =>
      ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=${tint}:s=320x180:r=30:d=2`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        path,
      ]);

    // 1. named by code, with a sidecar; 2. renamed, the sidecar still says which shot; 3. a foreign code
    clip(join(dir, `${parry}_take01.mp4`), 'red');
    writeFileSync(join(dir, `${parry}_take01.tfshot.json`), sidecar(parry));
    clip(join(dir, 'renamed.mp4'), 'green');
    writeFileSync(
      join(dir, 'renamed.tfshot.json'),
      sidecar(boss, {
        level: 'replay',
        performanceId: 'perf_7',
        pass: { camera: 'orbit', speed: 0.5 },
      }),
    );
    clip(join(dir, 'foreign.mp4'), 'blue');
    writeFileSync(join(dir, 'foreign.tfshot.json'), sidecar('TF-ZZZZZ'));
    // still being written: must never be imported
    clip(join(dir, '.tfpartial', `${boss}_take02.mp4`), 'white');
    writeFileSync(join(dir, `${boss}_take03.mp4.tmp`), 'half a file');

    const store = await engine.createProject(join(root, 'Unity.tforge'), {
      ...sampleProject(),
      id: 'proj_unity',
    } as never);
    const imp = await importFootageOp(engine, store, { paths: [dir] });
    await idle();
    expect(
      engine.library
        .list()
        .map((a) => a.originalName)
        .sort(),
    ).toEqual([`${parry}_take01.mp4`, 'foreign.mp4', 'renamed.mp4']);
    expect(imp.jobs.length).toBe(3);

    const suggested = await matchSuggestOp(engine, store);
    const foreign = suggested.matches.find(
      (m) => suggested.recordings.find((r) => r.assetId === m.assetId)?.name === 'foreign.mp4',
    );
    expect(foreign?.unknownCodes).toEqual(['TF-ZZZZZ']);

    const accepted = await matchAcceptOp(engine, store, { minConfidence: 'certain' });
    expect(accepted.attached.map((a) => a.slotId).sort()).toEqual(['shot_boss', 'shot_parry']);
    const shot = (id: string) =>
      store.state
        .storyboard!.sections.flatMap((s) => s.slots)
        .find((s): s is ShotSlot => s.id === id && s.kind === 'shot')!;
    expect(shot('shot_parry').takes[0]!.origin).toEqual({
      app: 'unity',
      level: 'live',
      label: 'Unity live · main camera · HUD off · 320×180 @ 30',
    });
    expect(shot('shot_boss').takes[0]!.origin).toMatchObject({
      level: 'replay',
      performanceId: 'perf_7',
      label: 'Unity replay · orbit camera · 0.5× speed',
    });
    // the foreign take is in the library but on no shot
    expect(accepted.attached).toHaveLength(2);
  }, 120_000);
});
