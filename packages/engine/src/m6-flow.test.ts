import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { FLICKS_PER_SECOND, flicksToFrames, type Timeline } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { analyzeOp, generateCutOp, importFootageOp, matchAcceptOp } from './footage-ops.js';
import { createDefaultVariantsOp } from './graphics-ops.js';
import { buildVersion, exportVersionOp, handoffOp, qualityOp } from './render-ops.js';

/**
 * The whole M6 flow on real recordings: the master and both versions exported with their
 * presets, the same bytes from scratch twice, a flashing cut stopped by the Quality Gate,
 * the editor handoff read back, and not one network connection on the way.
 */

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;
const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-m6-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
  store = await engine.createProject(join(root, 'M6.tforge'), {
    ...sampleProject(),
    id: 'proj_m6',
  } as never);
  const codes = shotCodes(store.state);
  const rec = (name: string, src: string) =>
    ff(['-f', 'lavfi', '-i', `${src}=s=640x360:r=30:d=6`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, name)]); // prettier-ignore
  rec(`parry ${codes.get('shot_parry')}.mp4`, 'testsrc2');
  rec(`boss ${codes.get('shot_boss')}.mp4`, 'smptebars');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.35*sin(2*PI*220*t)+if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,0.6*sin(2*PI*2000*t)\\,0)':s=44100:d=20", join(root, 'song.wav')]); // prettier-ignore
  await importFootageOp(engine, store, {
    paths: [join(root, `parry ${codes.get('shot_parry')}.mp4`), join(root, `boss ${codes.get('shot_boss')}.mp4`), join(root, 'song.wav')],
  }); // prettier-ignore
  await idle();
  store.dispatch('core/music.set-track', {
    assetId: engine.library.list().find((a) => a.originalName === 'song.wav')!.id,
  });
  await analyzeOp(engine, store);
  await idle();
  await matchAcceptOp(engine, store, { minConfidence: 'certain' });
  await generateCutOp(engine, store);
  createDefaultVariantsOp(store);
}, 240_000);
afterAll(async () => engine.close());

async function idle(ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const versions = () => store.state.storyboard!.variants.map((v) => v.id);
const length = (t: Timeline) =>
  Math.max(...t.tracks.flatMap((k) => k.items.map((i) => i.start + i.duration)));

describe('M6 flow', { timeout: 600_000 }, () => {
  it('exports the master, the 16:9 and the 9:16 version with their presets', async () => {
    expect(versions()).toEqual(['var_tt', expect.stringMatching(/^var_/)]);
    const sizes: string[] = [];
    for (const id of [null, ...versions()]) {
      const b = await buildVersion(engine, store, id);
      const t0 = performance.now();
      const r = await exportVersionOp(engine, store, id);
      const seconds = (performance.now() - t0) / 1000;
      const record = JSON.parse(readFileSync(r.record, 'utf8')) as {
        facts: { video: { width: number; height: number } };
      };
      sizes.push(`${record.facts.video.width}x${record.facts.video.height}`);
      expect(r).toMatchObject({ reproducible: true, overridden: [] });
      // Real-time factor on this machine's CPU, for the build log (render + checks).
      const film = length(b.timeline) / FLICKS_PER_SECOND;
      const line = `${id ?? 'master'} ${r.preset} ${film.toFixed(1)} s in ${seconds.toFixed(1)} s = ${(film / seconds).toFixed(2)}x real time\n`; // prettier-ignore
      if (process.env.TFORGE_TIMING_FILE) appendFileSync(process.env.TFORGE_TIMING_FILE, line);
    }
    expect(sizes).toEqual(['1920x1080', '1080x1920', '1920x1080']);
  });

  it('renders the same bytes from scratch a second time', async () => {
    const first = await exportVersionOp(engine, store, 'var_tt');
    for (const dir of ['render', 'render-out', 'frames', 'quality'])
      rmSync(join(store.paths.cache, dir), { recursive: true, force: true });
    const again = await exportVersionOp(engine, store, 'var_tt');
    expect(again.sha256).toBe(first.sha256);
    expect(readFileSync(again.poster).equals(readFileSync(first.poster))).toBe(true);
  });

  it('the Quality Gate stops a cut that flashes more than three times a second', async () => {
    const tl = store.state.timelines.find((t) => t.id === 'tl_rough')!;
    const track = tl.tracks.find((k) => k.kind === 'video')!;
    const clips = track.items.filter((i) => i.kind === 'clip');
    const a = clips[0]!;
    const b = track.items.find((i) => i.start === a.start + a.duration && i.kind === 'clip')!;
    const glitch = { transitionId: 'core/glitch', fromItemId: a.id, toItemId: b.id, duration: FLICKS_PER_SECOND, params: { rate: 8 } }; // prettier-ignore
    // The editing command refuses it...
    expect(() =>
      store.dispatch('core/timeline.set-transition', {
        timelineId: tl.id,
        toItemId: b.id,
        transition: {
          transitionId: 'core/glitch',
          duration: FLICKS_PER_SECOND,
          params: { rate: 8 },
        },
      }),
    ).toThrow();
    // ...and a timeline that carries it anyway (e.g. from a plugin or a hand-edited file) is blocked.
    const flashing = structuredClone(tl);
    const t = flashing.tracks.find((k) => k.id === track.id)!;
    t.transitions = [
      ...t.transitions.filter((x) => x.toItemId !== b.id),
      { id: 'tr_strobe', ...glitch },
    ];
    store.dispatch('core/timeline.set', { timeline: flashing });
    const q = await qualityOp(engine, store, null, [{ checkId: 'core/flash-plan', reason: 'no' }]);
    expect(q.verdict.allowed).toBe(false);
    expect(q.verdict.blocking.map((f) => f.checkId)).toContain('core/flash-plan');
    await expect(exportVersionOp(engine, store, null)).rejects.toMatchObject({
      code: 'gate-blocked',
    });
    store.undo();
    expect((await qualityOp(engine, store, null)).verdict.allowed).toBe(true);
  });

  it('hands the cut to an editor: the OTIO reads back with the same cuts', async () => {
    const r = await handoffOp(engine, store, 'var_tt');
    const b = await buildVersion(engine, store, 'var_tt');
    const otio = JSON.parse(readFileSync(r.files.find((f) => f.format === 'otio')!.file, 'utf8')) as OtioTimeline; // prettier-ignore
    const R = b.timeline.frameRate;
    const video = otio.tracks.children.find((k) => k.kind === 'Video')!;
    const frames = video.children
      .filter((c) => c.OTIO_SCHEMA !== 'Transition.1')
      .reduce((s, c) => s + c.source_range!.duration.value, 0);
    const bottom = b.timeline.tracks.find((k) => k.kind === 'video')!;
    expect(frames).toBe(flicksToFrames(length({ ...b.timeline, tracks: [bottom] }), R));
    const named = video.children.filter((c) => c.OTIO_SCHEMA.startsWith('Clip'));
    expect(named.map((c) => c.metadata?.trailerforge?.itemId)).toEqual(
      bottom.items.map((i) => i.id),
    );
  });

  it('made no network connection anywhere in the flow', () => {
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});

interface OtioItem {
  OTIO_SCHEMA: string;
  kind?: string;
  source_range?: { duration: { value: number } };
  metadata?: { trailerforge?: { itemId?: string } };
  children: OtioItem[];
}
interface OtioTimeline {
  tracks: { children: OtioItem[] };
}
