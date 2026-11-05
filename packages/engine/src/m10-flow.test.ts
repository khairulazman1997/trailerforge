import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubTranscriber, type ModelManifest, type RawTranscript } from '@trailerforge/analysis';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { conceptsOp } from './concepts-ops.js';
import { Engine } from './engine.js';
import { importFootageOp } from './footage-ops.js';
import { exportVersionOp, qualityOp } from './render-ops.js';
import { createShortOp, generateShortCutOp } from './shorts-ops.js';
import { voiceCleanReportOp } from './voice-clean.js';
import { placeVoiceOp } from './voice-ops.js';

/**
 * The whole M10 flow, twice from scratch: a concept from the (mock) AI → the template → filled
 * with real FFmpeg recordings, a picture and one long voiceover take → the lines found by a
 * (stub) transcript → the cut with subtitles and voice clean-up on the music → two hook
 * versions → exports with and without the music. Both runs must give the same bytes, and not
 * one network connection may be made.
 */

const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

const LINES = ['This boss has one tell.', 'Miss it and you are done.'];
const concept = {
  title: 'Parry or die',
  hook: 'A boss swing stops dead on a perfect parry.',
  formatId: 'game-trailer/tiktok-voiceover',
  pitch: 'The parry is what makes Ember Knight different.',
  shotList: ['A perfect parry on the Ash Warden', 'Key art', 'The forest run'],
  voiceover: LINES,
  targetSeconds: 15,
  entityIds: ['ent_warden'],
};
const say = (text: string, at: number): [number, number, string][] =>
  text.split(' ').map((w, i) => [at + i * 0.35, at + i * 0.35 + 0.3, w]);
const heard = [...say(LINES[0]!, 0.5), ...say(LINES[1]!, 3.0)];
const modelFile = Buffer.from('{"fake":true}');
const manifest: ModelManifest = {
  id: 'test-whisper',
  title: 'Test Whisper',
  license: 'MIT',
  source: 'example/test@1',
  files: [{ name: 'config.json', url: 'https://models.example.org/config.json', bytes: modelFile.length, sha256: createHash('sha256').update(modelFile).digest('hex') }], // prettier-ignore
};

const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.close();
});

async function idle(engine: Engine) {
  const end = Date.now() + 120_000;
  while (!engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) {
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** One run from an empty folder; returns what the checks look at. */
async function flow() {
  const root = await mkdtemp(join(tmpdir(), 'tforge-m10-'));
  const home = join(root, 'home');
  const llm = new LlmClient({
    providers: (id) =>
      id === 'core/mock' ? createMockProvider({ 'tiktok.concepts': { concepts: [concept] } }) : undefined, // prettier-ignore
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  const transcriber = stubTranscriber(
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
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm, voiceModel: manifest, transcriber: () => transcriber }); // prettier-ignore
  engines.push(engine);
  const models = join(home, 'models', manifest.id);
  await mkdir(models, { recursive: true });
  await writeFile(join(models, 'config.json'), modelFile);
  await writeFile(join(models, 'verified.json'), JSON.stringify({ 'config.json': manifest.files[0]!.sha256 })); // prettier-ignore

  // Recordings: bright gameplay (the output gate reads dark frames as black), key art, one long
  // voiceover take with the two lines and a little hiss between them, and the music.
  ff(['-f', 'lavfi', '-i', 'gradients=s=320x180:r=30:d=6:c0=0x4488cc:c1=0xffcc66:speed=0.02:seed=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'gameplay.mp4')]); // prettier-ignore
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x900:r=1:d=1', '-frames:v', '1', join(root, 'key art.png')]); // prettier-ignore
  ff(['-f', 'lavfi', '-i', "aevalsrc='if(between(t\\,0.5\\,2.2)+between(t\\,3\\,5)\\,0.3*sin(2*PI*220*t)\\,0)':s=48000:d=6", '-f', 'lavfi', '-i', 'anoisesrc=d=6:a=0.004:seed=5:r=48000', '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', join(root, 'voice.wav')]); // prettier-ignore
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*110*t)':s=48000:d=20", join(root, 'music.wav')]);

  const store = await engine.createProject(join(root, 'Ember.tforge'), { ...sampleProject(), name: 'Ember Knight' } as never); // prettier-ignore
  const ideas = await conceptsOp(engine, store, { count: 1 });
  expect(ideas.added.map((c) => c.title)).toEqual(['Parry or die']);
  const made = await createShortOp(engine, store, { conceptId: ideas.added[0]!.id, wording: false }); // prettier-ignore
  const id = made.shortId;

  await importFootageOp(engine, store, { paths: ['gameplay.mp4', 'key art.png', 'voice.wav', 'music.wav'].map((n) => join(root, n)) }); // prettier-ignore
  await idle(engine);
  await engine.library.reload();
  const asset = (name: string) => engine.library.list().find((a) => a.originalName === name)!.id;
  const short = () => store.state.shorts.find((x) => x.id === id)!;
  const shots = short().storyboard!.sections.flatMap((s) => s.slots).filter((x) => x.kind === 'shot'); // prettier-ignore
  shots.forEach((slot, i) => {
    const image = i === 1 && (slot.accepts ?? []).includes('image');
    store.dispatch('core/shorts.fill-slot', { shortId: id, target: { slotId: slot.id }, assetId: asset(image ? 'key art.png' : 'gameplay.mp4'), input: image ? 'image' : 'gameplay' }); // prettier-ignore
  });
  const placed = await placeVoiceOp(engine, store, id, { assetId: asset('voice.wav') });
  expect(placed.method).toBe('transcript');
  expect(placed.lines.map((l) => l.status)).toEqual(['matched', 'matched']);
  store.dispatch('core/shorts.set-music', { shortId: id, assetId: asset('music.wav') });
  store.dispatch('core/shorts.set-subtitles', { shortId: id, enabled: true, style: 'word-pop' });
  store.dispatch('core/shorts.set-post-copy', { shortId: id, caption: 'One perfect parry.', hashtags: ['EmberKnight'], coverTitle: 'Parry or die' }); // prettier-ignore
  const cut = await generateShortCutOp(engine, store, id);
  expect(cut).toMatchObject({ mode: 'voice', placeholders: 0 });
  expect(cut.cues).toBeGreaterThanOrEqual(2);
  store.dispatch('core/shorts.add-hook', { shortId: id, hook: { name: 'Question', kind: 'question', caption: 'Can you parry this?' } }); // prettier-ignore
  store.dispatch('core/shorts.add-hook', { shortId: id, hook: { name: 'Cold open', kind: 'cold-open' } }); // prettier-ignore

  const clean = await voiceCleanReportOp(engine, store, id);
  const gate = await qualityOp(engine, store, id);
  const main = await exportVersionOp(engine, store, id);
  const hookA = await exportVersionOp(engine, store, `${id}_hk_a`);
  const hookB = await exportVersionOp(engine, store, `${id}_hk_b`);
  const tl = JSON.stringify(store.state.timelines.find((t) => t.id === `tl_short_${id}`));
  return { id, clean, gate, main, hookA, hookB, tl };
}

describe('M10: a TikTok from concept to export', { timeout: 600_000 }, () => {
  let a: Awaited<ReturnType<typeof flow>>;
  let b: Awaited<ReturnType<typeof flow>>;

  it('runs the whole flow, writing every file a post needs', async () => {
    a = await flow();
    expect(a.gate.verdict.allowed).toBe(true);
    expect(a.clean.lines.every((l) => l.info && l.info.after.lufs !== null)).toBe(true);
    for (const f of [
      a.main.file,
      a.main.poster,
      a.main.postFile!,
      a.main.coverFile!,
      ...a.main.subtitleFiles,
    ])
      // prettier-ignore
      expect(existsSync(f), f).toBe(true);
    expect(a.main.musicFree?.file).toMatch(/-nomusic\.mp4$/);
    expect(a.main.musicFree!.sha256).not.toBe(a.main.sha256);
    expect(new Set([a.main.sha256, a.hookA.sha256, a.hookB.sha256]).size).toBe(3);
    expect(a.main.preset).toBe('core/tiktok');
  });

  it('gives the same bytes from scratch', async () => {
    b = await flow();
    expect(b.id).toBe(a.id);
    expect(b.tl).toBe(a.tl);
    expect(b.clean).toEqual(a.clean);
    expect(b.main.contentHash).toBe(a.main.contentHash);
    for (const [x, y] of [
      [a.main, b.main],
      [a.main.musicFree!, b.main.musicFree!],
      [a.hookA, b.hookA],
      [a.hookB, b.hookB],
    ] as const)
      expect(y.sha256, x.file).toBe(x.sha256);
    expect(sha(b.main.coverFile!)).toBe(sha(a.main.coverFile!));
    expect(readFileSync(b.main.postFile!, 'utf8')).toBe(readFileSync(a.main.postFile!, 'utf8'));
    expect(readFileSync(b.main.subtitleFiles[0]!, 'utf8')).toBe(readFileSync(a.main.subtitleFiles[0]!, 'utf8')); // prettier-ignore
  });

  it('made no network connection anywhere in the flow', () => {
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
