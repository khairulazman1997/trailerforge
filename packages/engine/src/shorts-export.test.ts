import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubTranscriber, type ModelManifest, type RawTranscript } from '@trailerforge/analysis';
import { probe } from '@trailerforge/media';
import { approvalState } from '@trailerforge/schema';
import { sampleShortProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { importFootageOp } from './footage-ops.js';
import {
  approveVersionOp,
  buildVersion,
  exportVersionOp,
  handoffOp,
  qualityOp,
  renderDraftOp,
  reviewViewOp,
} from './render-ops.js';
import { buildShortOp, generateShortCutOp } from './shorts-ops.js';
import { placeVoiceOp } from './voice-ops.js';
import { VOICE_TARGET_LUFS, voiceCleanReportOp } from './voice-clean.js';
import { OpError } from './ops.js';

/** A TikTok through the whole chain: template, files, voiceover, cut, subtitles, review, export. */

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const SHORT = 'short_parry';

const modelFile = Buffer.from('{"fake":true}');
const manifest: ModelManifest = {
  id: 'test-whisper',
  title: 'Test Whisper',
  license: 'MIT',
  source: 'example/test@1',
  files: [{ name: 'config.json', url: 'https://models.example.org/config.json', bytes: modelFile.length, sha256: createHash('sha256').update(modelFile).digest('hex') }], // prettier-ignore
};
const say = (text: string, at: number): [number, number, string][] =>
  text.split(' ').map((w, i) => [at + i * 0.35, at + i * 0.35 + 0.3, w]);
const heard = [...say('This boss has one tell.', 0.5), ...say('Miss it and you are done.', 3.0)];
const heardFrom: string[] = [];
const stub = stubTranscriber((path) => {
  heardFrom.push(path);
  return {
    duration: 6,
    language: 'en',
    languageProbability: 0.99,
    segments: [],
    words: heard.map(([start, end, text]) => ({ start, end, text, p: 0.9 })),
    envelope: { hop: 0.01, db: [] },
  } satisfies RawTranscript;
});

let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;
const ids: Record<string, string> = {};

async function idle() {
  const end = Date.now() + 60_000;
  while (!engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) {
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-short-export-'));
  const home = join(root, 'home');
  engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, voiceModel: manifest, transcriber: () => stub }); // prettier-ignore
  const dir = join(home, 'models', manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), modelFile);
  await writeFile(join(dir, 'verified.json'), JSON.stringify({ 'config.json': manifest.files[0]!.sha256 })); // prettier-ignore
  ff(['-f', 'lavfi', '-i', 'gradients=s=320x180:r=30:d=6:c0=0x4488cc:c1=0xffcc66:speed=0.02', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'gameplay.mp4')]); // prettier-ignore
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1600x900:r=1:d=1',
    '-frames:v',
    '1',
    join(root, 'key art.png'),
  ]);
  const tone = (name: string, expr: string, d: number) =>
    ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${d}`, join(root, name)]);
  tone('voice.wav', 'if(between(t\\,0.5\\,2.2)+between(t\\,3\\,5)\\,0.3*sin(2*PI*220*t)\\,0)', 6);
  tone('music.wav', '0.2*sin(2*PI*110*t)', 20);
  const p = sampleShortProject();
  p.shorts![0]!.storyboard = null;
  p.shorts![0]!.concept = { ...p.shorts![0]!.concept, formatId: 'game-trailer/tiktok-voiceover' } as never; // prettier-ignore
  store = await engine.createProject(join(root, 'Short.tforge'), {
    ...p,
    name: 'Ember Knight',
  } as never);
  await importFootageOp(engine, store, { paths: ['gameplay.mp4', 'key art.png', 'voice.wav', 'music.wav'].map((n) => join(root, n)) }); // prettier-ignore
  await idle();
  for (const a of engine.library.list()) ids[a.originalName] = a.id;
  await buildShortOp(engine, store, SHORT, { wording: false });
  const slot = (key: string) => `${SHORT}_${key}`;
  const fill = (key: string, asset: string, input: string) =>
    store.dispatch('core/shorts.fill-slot', { shortId: SHORT, target: { slotId: slot(key) }, assetId: ids[asset]!, input }); // prettier-ignore
  fill('hook', 'gameplay.mp4', 'gameplay');
  fill('b1', 'key art.png', 'image');
  fill('b2', 'gameplay.mp4', 'gameplay');
  fill('b3', 'gameplay.mp4', 'video');
  store.dispatch('core/assets.add', { assetId: ids['music.wav']!, role: 'music' });
  store.dispatch('core/shorts.storyboard.update-music', { shortId: SHORT, edit: { patch: { trackAssetId: ids['music.wav']! } } }); // prettier-ignore
  store.dispatch('core/shorts.set-subtitles', { shortId: SHORT, enabled: true, style: 'lines' });
  await placeVoiceOp(engine, store, SHORT, { assetId: ids['voice.wav']! });
}, 120_000);
afterAll(async () => {
  await engine.close();
});

describe('a TikTok, end to end', { timeout: 300_000 }, () => {
  it('builds its cut from the voice, with subtitles from the transcript, as one undo step', async () => {
    const before = store.state.timelines.length;
    const r = await generateShortCutOp(engine, store, SHORT);
    expect(r).toMatchObject({ timelineId: 'tl_short_short_parry', mode: 'voice', placeholders: 0 });
    expect(r.cues).toBeGreaterThanOrEqual(2);
    const tl = store.state.timelines.find((t) => t.id === r.timelineId)!;
    expect(tl.resolution).toEqual({ width: 1080, height: 1920 });
    const cues = tl.tracks.find((t) => t.id === 'trk_subtitles')!.items;
    expect(cues.map((c) => (c as { label: string }).label)).toEqual(['This boss has one tell.', 'Miss it and you are done.']); // prettier-ignore
    // The image got a move; the voice and the music are on their own tracks.
    const art = tl.tracks.flatMap((t) => t.items).find((i) => i.id === `rc_${SHORT}_b1`) as {
      transform?: unknown;
    };
    expect(art.transform).toBeDefined();
    expect(tl.tracks.map((t) => t.id)).toEqual(expect.arrayContaining(['trk_picture', 'trk_voice', 'trk_music', 'trk_subtitles'])); // prettier-ignore
    expect(store.state.timelines).toHaveLength(before + 1);
    store.undo();
    expect(store.state.timelines).toHaveLength(before);
    await generateShortCutOp(engine, store, SHORT);
  });

  it('cleans the voice at render: heard from the cleaned copy, measured, and switchable', async () => {
    expect(heardFrom[0]).toMatch(/voice-clean[\\/].+-v1\.wav$/);
    const report = await voiceCleanReportOp(engine, store, SHORT);
    expect(report).toMatchObject({ enabled: true, targetLufs: VOICE_TARGET_LUFS });
    const info = report.lines[0]!.info!;
    expect(info.after.lufs).not.toBeNull();
    expect(info.noiseFloorDb).toBe(-80); // the test voice is digital silence between words
    expect(Math.abs(info.after.lufs! + info.gainDb - VOICE_TARGET_LUFS)).toBeLessThan(0.1);
    const on = await buildVersion(engine, store, SHORT);
    const vo = on.timeline.tracks.find((t) => t.id === 'trk_voice')!.items[0]!;
    expect((vo.extensions.core as { voiceClean?: unknown }).voiceClean).toEqual({ version: 1, gainDb: info.gainDb, noiseFloorDb: -80 }); // prettier-ignore
    // The stored cut is not touched.
    const stored = store.state.timelines.find((t) => t.id === `tl_short_${SHORT}`)!;
    expect(JSON.stringify(stored)).not.toContain('voiceClean');
    store.dispatch('core/shorts.set-voice-clean', { shortId: SHORT, enabled: false });
    const off = await buildVersion(engine, store, SHORT);
    expect(off.contentHash).not.toBe(on.contentHash);
    store.dispatch('core/shorts.set-voice-clean', { shortId: SHORT, enabled: true });
    expect((await buildVersion(engine, store, SHORT)).contentHash).toBe(on.contentHash);
  });

  it('is a version of the project: listed, built with the platform’s safe area, TikTok preset by default', async () => {
    const list = await reviewViewOp(engine, store);
    // The sample trailer's own versions are listed too; the short is one more.
    expect(list.map((v) => v.variantId)).toContain(SHORT);
    expect(list.find((v) => v.variantId === SHORT)).toMatchObject({ name: 'Parry or die', size: { width: 1080, height: 1920 }, approval: 'none', export: { presetId: 'core/tiktok', presetName: 'TikTok', issues: [] } }); // prettier-ignore
    const b = await buildVersion(engine, store, SHORT);
    expect(b.compileError).toBeUndefined();
    expect(b.sources.get(ids['key art.png']!)).toMatchObject({ still: true });
    // The subtitles are drawn, and the safe area is the platform's (not title-safe).
    expect(b.scenes.some((s) => s.templateId === 'core/subtitle-line')).toBe(true);
    const q = await qualityOp(engine, store, SHORT);
    expect(q.findings.filter((f) => f.tier === 'hard')).toEqual([]);
    expect(q.findings.map((f) => f.checkId)).not.toContain('core/platform-safe-area');
    // Subtitles are read as they are spoken: no "too brief to read" for them.
    const subs = new Set(
      b.timeline.tracks.find((t) => t.id === 'trk_subtitles')!.items.map((i) => i.id),
    );
    expect(
      q.findings.filter((f) => f.checkId === 'core/read-time' && subs.has(f.itemId ?? '')),
    ).toEqual([]);
  });

  it('is reviewed like the trailer: a draft, comments, an approval that goes stale on an edit', async () => {
    const d = await renderDraftOp(engine, store, SHORT, { hardware: false });
    const info = await probe(d.file);
    expect(info.video[0]!.height).toBe(720);
    store.dispatch('core/review.comment', { variantId: SHORT, at: 0, text: 'Hook is slow' });
    const { contentHash } = await approveVersionOp(engine, store, { variantId: SHORT });
    expect(approvalState(store.state.review, SHORT, contentHash)).toBe('approved');
    const mine = async () =>
      (await reviewViewOp(engine, store)).find((v) => v.variantId === SHORT)!;
    expect(await mine()).toMatchObject({ approval: 'approved', openComments: 1, draftReady: true });
    store.dispatch('core/shorts.set-subtitles', { shortId: SHORT, style: 'word-pop' });
    await generateShortCutOp(engine, store, SHORT);
    expect((await mine()).approval).toBe('stale');
    await expect(
      approveVersionOp(engine, store, { variantId: 'short_nope' }),
    ).rejects.toBeInstanceOf(OpError);
  });

  it('exports with the TikTok preset: 1080×1920, subtitles beside the video, identical twice', async () => {
    store.dispatch('core/shorts.set-subtitles', { shortId: SHORT, style: 'lines' });
    await generateShortCutOp(engine, store, SHORT);
    const r = await exportVersionOp(engine, store, SHORT);
    expect(r.preset).toBe('core/tiktok');
    const info = await probe(r.file);
    expect(info.video[0]).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
    expect(r.file).toContain(join('exports', 'render', SHORT));
    expect(r.subtitleFiles.map((f) => f.split('.').pop())).toEqual(['srt', 'vtt']);
    const srt = await readFile(r.subtitleFiles[0]!, 'utf8');
    expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> 00:00:0\d,\d{3}\nThis boss has one tell\.\n\n2\n/);
    expect(await readFile(r.subtitleFiles[1]!, 'utf8')).toMatch(/^WEBVTT\n\n00:00:0\d\.\d{3} --> /);
    expect(existsSync(r.poster)).toBe(true);
    const again = await exportVersionOp(engine, store, SHORT);
    expect(again.sha256).toBe(r.sha256);
  });

  it('exports with and without the music, and a timing-only track is never rendered', async () => {
    const both = await exportVersionOp(engine, store, SHORT);
    expect(both.musicFree?.file).toMatch(/-nomusic\.mp4$/);
    expect(both.musicFree?.sha256).not.toBe(both.sha256);
    expect(existsSync(both.musicFree!.file)).toBe(true);
    expect(both.musicFree!.musicFree).toBeUndefined();

    store.dispatch('core/export.set', { variantId: SHORT, presetId: 'core/tiktok', music: 'without' }); // prettier-ignore
    const only = await exportVersionOp(engine, store, SHORT);
    expect(only.file).toMatch(/-nomusic\.mp4$/);
    expect(only.musicFree).toBeUndefined();
    expect(only.sha256).toBe(both.musicFree!.sha256);

    // The same song as a reference for the beat only: the cut keeps its grid, no music track.
    store.dispatch('core/export.set', { variantId: SHORT, music: null });
    const track = store.state.shorts.find((x) => x.id === SHORT)!.storyboard!.music.trackAssetId!;
    store.dispatch('core/shorts.set-music', { shortId: SHORT, assetId: track, timingOnly: true });
    await generateShortCutOp(engine, store, SHORT);
    const tl = store.state.timelines.find((t) => t.id === `tl_short_${SHORT}`)!;
    expect(tl.tracks.some((t) => t.id === 'trk_music')).toBe(false);
    const one = await exportVersionOp(engine, store, SHORT);
    expect(one.musicFree).toBeUndefined();
    expect(one.file).not.toMatch(/-nomusic/);
    store.dispatch('core/shorts.set-music', { shortId: SHORT, assetId: track });
    await generateShortCutOp(engine, store, SHORT);
  });

  it('a hook version is its own version: another opening, same length, own review, own file', async () => {
    const tl = store.state.timelines.find((t) => t.id === `tl_short_${SHORT}`)!;
    const hookSlot = store.state.shorts[0]!.storyboard!.sections[0]!.slots.find((x) => x.kind === 'shot')!; // prettier-ignore
    store.dispatch('core/shorts.add-hook', { shortId: SHORT, hook: { name: 'Question', kind: 'question', caption: 'Can you parry this?' } }); // prettier-ignore
    store.dispatch('core/shorts.add-hook', { shortId: SHORT, hook: { name: 'Cold open', kind: 'cold-open' } }); // prettier-ignore
    expect(store.state.shorts[0]!.hooks.map((h) => h.id)).toEqual(['a', 'b']);
    const vid = `${SHORT}_hk_a`;
    const base = await buildVersion(engine, store, SHORT);
    const a = await buildVersion(engine, store, vid);
    const b = await buildVersion(engine, store, `${SHORT}_hk_b`);
    expect(a.name).toBe('Parry or die hook a');
    const caps = (x: typeof a) => (x.timeline.tracks.find((t) => t.id === 'trk_captions')?.items ?? []).filter((i) => i.slotId === hookSlot.id).map((i) => (i as { text: string }).text); // prettier-ignore
    expect(caps(a)).toEqual(['Can you parry this?']);
    expect(caps(b)).toEqual([]);
    expect(a.contentHash).not.toBe(base.contentHash);
    expect(a.contentHash).not.toBe(b.contentHash);
    const dur = (x: typeof a) => x.timeline.tracks.flatMap((t) => t.items).reduce((m, i) => Math.max(m, i.start + i.duration), 0); // prettier-ignore
    expect(dur(a)).toBe(dur(base));
    expect(JSON.stringify(store.state.timelines.find((t) => t.id === tl.id))).toBe(
      JSON.stringify(tl),
    ); // not stored

    const review = await reviewViewOp(engine, store);
    expect(review.map((v) => v.variantId)).toEqual(expect.arrayContaining([SHORT, vid, `${SHORT}_hk_b`])); // prettier-ignore
    await approveVersionOp(engine, store, { variantId: vid });
    expect(approvalState(store.state.review, vid, a.contentHash)).toBe('approved');
    expect(approvalState(store.state.review, `${SHORT}_hk_b`, b.contentHash)).toBe('none');
    store.dispatch('core/shorts.edit-hook', { shortId: SHORT, hookId: 'a', patch: { caption: 'Another try' } }); // prettier-ignore
    const edited = await buildVersion(engine, store, vid);
    expect(approvalState(store.state.review, vid, edited.contentHash)).toBe('stale');

    const f = await exportVersionOp(engine, store, vid);
    expect(f.file).toContain(join('exports', 'render', vid));
    expect(f.file).toMatch(/hook[-_ ]a/i);
    const base2 = await exportVersionOp(engine, store, SHORT);
    expect(f.sha256).not.toBe(base2.sha256);
    expect((await exportVersionOp(engine, store, vid)).sha256).toBe(f.sha256);
    // Removing a hook version drops its review; removing the short drops all.
    store.dispatch('core/shorts.remove-hook', { shortId: SHORT, hookId: 'a' });
    expect(store.state.review.approvals.some((x) => x.variantId === vid)).toBe(false);
    await expect(buildVersion(engine, store, vid)).rejects.toBeInstanceOf(OpError);
    store.dispatch('core/shorts.remove-hook', { shortId: SHORT, hookId: 'b' });
  });

  it('hands off to an editor, and dropping the short drops its review', async () => {
    const h = await handoffOp(engine, store, SHORT, { formats: ['otio', 'edl'] });
    expect(h.files.some((f) => f.file.endsWith('.otio'))).toBe(true);
    store.dispatch('core/shorts.remove', { shortId: SHORT });
    expect(store.state.review.comments).toEqual([]);
    expect(store.state.review.approvals).toEqual([]);
    expect(store.state.timelines.find((t) => t.id === 'tl_short_short_parry')).toBeUndefined();
    store.undo();
    expect(store.state.review.comments).toHaveLength(1);
  });
});
