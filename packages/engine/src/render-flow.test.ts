import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDecisions } from '@trailerforge/core';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { analyzeOp, generateCutOp, importFootageOp, matchAcceptOp } from './footage-ops.js';
import { createDefaultVariantsOp } from './graphics-ops.js';
import { OpError } from './ops.js';
import {
  approveVersionOp,
  exportVersionOp,
  handoffOp,
  hardwareDraftArgs,
  presetsViewOp,
  qualityOp,
  renderDraftOp,
  reviewViewOp,
} from './render-ops.js';

/** Review, Quality Gate, draft, export and handoff on real recordings. */

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;
let tall: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-render-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
  store = await engine.createProject(join(root, 'Render.tforge'), {
    ...sampleProject(),
    id: 'proj_render',
  } as never);
  const codes = shotCodes(store.state);
  const rec = (name: string, src: string) =>
    ff(['-f', 'lavfi', '-i', `${src}=s=320x180:r=30:d=6`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, name)]); // prettier-ignore
  rec(`parry ${codes.get('shot_parry')}.mp4`, 'testsrc2');
  rec(`boss ${codes.get('shot_boss')}.mp4`, 'smptebars');
  // A beat from short clicks over a steady tone, so the sound has loudness a limiter can hit.
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
  tall = store.state.storyboard!.variants.find((v) => v.id === 'var_tt')!.id;
  // ProRes keeps the test quick; the web presets are rendered in the render package's tests.
  store.dispatch('core/export.set', { variantId: tall, presetId: 'core/master' });
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

describe('review, gate, draft, export and handoff', { timeout: 300_000 }, () => {
  it('lists the presets and every version with its review state', async () => {
    expect(hardwareDraftArgs('h264_nvenc')).toContain('-cq');
    expect(hardwareDraftArgs('h264_vaapi')).toBeNull(); // needs device setup: software instead
    const p = await presetsViewOp(engine);
    expect(p.presets.map((x) => x.id)).toContain('core/steam');
    const views = await reviewViewOp(engine, store);
    expect(views.map((v) => v.variantId)).toEqual([null, tall, expect.any(String)]);
    const v = views.find((x) => x.variantId === tall)!;
    expect(v).toMatchObject({
      approval: 'none',
      draftReady: false,
      comments: 0,
      export: { presetId: 'core/master' },
    });
    expect(v.export.fileName).toMatch(/\.mov$/);
    expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an approval holds through comments and goes stale on an edit; undo restores it', async () => {
    const { contentHash } = await approveVersionOp(engine, store, { variantId: tall, note: 'ok' });
    const state = async () =>
      (await reviewViewOp(engine, store)).find((x) => x.variantId === tall)!;
    expect((await state()).approval).toBe('approved');
    store.dispatch('core/review.comment', { variantId: tall, at: 0, text: 'Nice hook' });
    expect(await state()).toMatchObject({
      approval: 'approved',
      contentHash,
      comments: 1,
      openComments: 1,
    });
    store.dispatch('core/variants.override', {
      variantId: tall,
      slotId: 'shot_boss',
      patch: { excluded: true },
    });
    expect((await state()).approval).toBe('stale');
    store.undo();
    expect((await state()).approval).toBe('approved');
  });

  it('the plan gate blocks a placeholder with no override, and lets the cut through once it is fixed', async () => {
    const before = await qualityOp(engine, store, null);
    const item = store.state.timelines
      .find((t) => t.id === 'tl_rough')!
      .tracks.flatMap((t) => t.items)
      .find((i) => i.kind === 'clip' && i.slotId === 'shot_boss')!;
    store.dispatch('core/timeline.to-placeholder', { timelineId: 'tl_rough', itemId: item.id });
    const blocked = await qualityOp(engine, store, null, [
      { checkId: 'core/placeholders', reason: 'trust me' },
    ]);
    expect(blocked.verdict.allowed).toBe(false);
    expect(blocked.verdict.blocking.map((f) => f.checkId)).toContain('core/placeholders');
    await expect(exportVersionOp(engine, store, null)).rejects.toMatchObject({
      code: 'gate-blocked',
    });
    store.undo();
    expect((await qualityOp(engine, store, null)).verdict.blocking).toEqual(
      before.verdict.blocking,
    );
  });

  it('renders a 720p review draft, cached by content, identical twice', async () => {
    const seen: string[] = [];
    const a = await renderDraftOp(engine, store, tall, {
      hardware: false,
      onProgress: (p) => seen.push(p.phase),
    });
    expect(seen).toContain('segments');
    expect(a.file).toMatch(/cache[\\/]drafts/);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', a.file]).toString()) as { streams: { codec_type: string; width?: number; height?: number }[] }; // prettier-ignore
    expect(probe.streams.find((s) => s.codec_type === 'video')).toMatchObject({
      width: 406,
      height: 720,
    });
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    const first = readFileSync(a.file);
    const b = await renderDraftOp(engine, store, tall, { hardware: false });
    expect(readFileSync(b.file).equals(first)).toBe(true);
    expect((await reviewViewOp(engine, store)).find((x) => x.variantId === tall)!.draftReady).toBe(
      true,
    );
  });

  it('exports with the preset, checks the file, delivers it with a poster and a record; identical twice', async () => {
    const r = await exportVersionOp(engine, store, tall);
    expect(r.file).toMatch(/exports[\\/]render[\\/]var_tt[\\/].*\.mov$/);
    expect(existsSync(r.poster) && existsSync(r.record)).toBe(true);
    expect(r).toMatchObject({ preset: 'core/master', reproducible: true, overridden: [] });
    const record = JSON.parse(readFileSync(r.record, 'utf8')) as {
      facts: { video: { width: number; height: number } };
    };
    expect(record.facts.video).toMatchObject({ width: 1080, height: 1920 });
    const again = await exportVersionOp(engine, store, tall);
    expect(again.sha256).toBe(r.sha256);
    expect(readdirSync(join(r.file, '..')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('an unreachable loudness target needs an override with a reason, which is logged', async () => {
    store.dispatch('core/export.set', { variantId: tall, loudnessLufs: -6 });
    let err: unknown;
    try {
      await exportVersionOp(engine, store, tall);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).code).toBe('gate-blocked');
    expect((err as OpError).message).toMatch(/loudness is .*needs an override/i);
    const ok = await exportVersionOp(engine, store, tall, {
      overrides: [{ checkId: 'core/loudness', reason: 'The platform normalises it anyway' }],
    });
    expect(ok.overridden).toEqual(['core/loudness']);
    const log = await readDecisions(store.paths.decisions);
    expect(
      log.some((d) => d.step === 'core/quality-gate' && /platform normalises/.test(d.summary)),
    ).toBe(true);
    store.dispatch('core/export.set', { variantId: tall, loudnessLufs: null });
  });

  it('cancelling an export leaves no file behind', async () => {
    store.dispatch('core/export.set', { variantId: tall, fileName: 'cancelled-one' });
    const ctl = new AbortController();
    await expect(
      exportVersionOp(engine, store, tall, {
        signal: ctl.signal,
        onProgress: (p) => p.phase === 'segments' && ctl.abort(),
      }),
    ).rejects.toThrow();
    expect(existsSync(join(store.paths.exports, 'render', tall, 'cancelled-one.mov'))).toBe(false);
    store.dispatch('core/export.set', { variantId: tall, fileName: null });
  });

  it('writes FCPXML, OTIO and EDL with alpha clips for the cards and captions', async () => {
    const r = await handoffOp(engine, store, tall);
    expect(r.files.map((f) => f.format)).toEqual(['fcpxml', 'otio', 'edl']);
    expect(r.graphics.length).toBeGreaterThan(0);
    for (const g of r.graphics) expect(existsSync(g)).toBe(true);
    const fcp = readFileSync(r.files[0]!.file, 'utf8');
    expect(fcp).toContain('<fcpxml version="1.10">');
    expect(fcp).toContain('file://');
    expect(readFileSync(r.files[2]!.file, 'ascii')).toMatch(/^TITLE: /);
    const again = await handoffOp(engine, store, tall, { formats: ['edl'] });
    expect(readFileSync(again.files[0]!.file, 'utf8')).toBe(readFileSync(r.files[2]!.file, 'utf8'));
  });
});
