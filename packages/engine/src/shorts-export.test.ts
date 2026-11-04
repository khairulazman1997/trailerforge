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
const stub = stubTranscriber(
  () =>
    ({
      duration: 6,
      language: 'en',
      languageProbability: 0.99,
      segments: [],
      words: heard.map(([start, end, text]) => ({ start, end, text, p: 0.9 })),
      envelope: { hop: 0.01, db: [] },
    }) satisfies RawTranscript,
);

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
