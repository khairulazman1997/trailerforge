import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '@trailerforge/media';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { stillMotion } from '@trailerforge/cut';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { importFootageOp, libraryMediaOp } from './footage-ops.js';
import { OpError } from './ops.js';
import { STILL_SECONDS, buildVersion, qualityOp, renderDraftOp } from './render-ops.js';

/** An image in the cut, through the real import, build, gate and draft. */

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const F = FLICKS_PER_SECOND;
let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;
let imageId: string;
let videoId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-stills-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
  store = await engine.createProject(join(root, 'Stills.tforge'), {
    ...sampleProject(),
    id: 'proj_stills',
  } as never);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1600x900:r=1:d=1',
    '-frames:v',
    '1',
    join(root, 'key art.png'),
  ]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')]); // prettier-ignore
  await importFootageOp(engine, store, {
    paths: [join(root, 'key art.png'), join(root, 'clip.mp4')],
  });
  await idle();
  imageId = engine.library.list().find((a) => a.kind === 'image')!.id;
  videoId = engine.library.list().find((a) => a.kind === 'video')!.id;
  for (const [assetId, role] of [
    [imageId, 'graphic'],
    [videoId, 'footage'],
  ] as const)
    store.dispatch('core/assets.add', { assetId, role });
  const motion = stillMotion({ style: 'push-in', duration: 2 * F });
  store.dispatch('core/timeline.set', {
    timeline: {
      id: 'tl_rough',
      name: 'Rough cut',
      frameRate: { num: 30, den: 1 },
      resolution: { width: 1080, height: 1920 },
      tracks: [
        {
          id: 'trk_picture',
          kind: 'video',
          items: [
            { id: 'i1', kind: 'clip', start: 0, duration: 2 * F, assetId: imageId, sourceIn: 0, transform: motion }, // prettier-ignore
            {
              id: 'i2',
              kind: 'clip',
              start: 2 * F,
              duration: 1 * F,
              assetId: imageId,
              sourceIn: 0,
            },
            {
              id: 'v1',
              kind: 'clip',
              start: 3 * F,
              duration: 2 * F,
              assetId: videoId,
              sourceIn: 0,
            },
          ],
        },
      ],
    },
  });
}, 120_000);
afterAll(async () => engine.close());

async function idle(ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('images in the cut', { timeout: 180_000 }, () => {
  it('an imported image is an image asset with an editing copy and a thumbnail, served to the UI', async () => {
    const a = engine.library.get(imageId)!;
    expect(a).toMatchObject({ kind: 'image', originalName: 'key art.png' });
    expect(a.media?.video[0]).toMatchObject({ width: 1600, height: 900 });
    const still = await libraryMediaOp(engine, imageId, 'still');
    expect(still.type).toBe('image/jpeg');
    expect((await libraryMediaOp(engine, imageId, 'thumbnail')).type).toBe('image/jpeg');
    await expect(libraryMediaOp(engine, imageId, 'proxy')).rejects.toBeInstanceOf(OpError);
    await expect(libraryMediaOp(engine, videoId, 'still')).rejects.toBeInstanceOf(OpError);
  });

  it('is built as a still source: no running time of its own, no sound, no jump-cut warning', async () => {
    const b = await buildVersion(engine, store, null);
    expect(b.sources.get(imageId)).toMatchObject({ still: true, duration: STILL_SECONDS, hasAudio: false, width: 1600, height: 900 }); // prettier-ignore
    expect(b.sources.get(videoId)!.still).toBeUndefined();
    expect(b.compileError).toBeUndefined();
    const q = await qualityOp(engine, store, null);
    expect(q.findings.map((f) => f.checkId)).not.toContain('core/jump-cut');
    expect(q.findings.filter((f) => f.tier === 'hard')).toEqual([]);
  });

  it('renders a draft with the move, exactly as long as the cut', async () => {
    const d = await renderDraftOp(engine, store, null, { hardware: false });
    const info = await probe(d.file);
    expect(info.video[0]!.height).toBe(720); // 9:16 at 720 p
    expect(Math.abs(info.video[0]!.width - 405)).toBeLessThanOrEqual(1);
    expect(Math.round(info.duration * 30)).toBe(150);
  });
});
