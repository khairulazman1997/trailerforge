import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubTranscriber, type ModelManifest, type RawTranscript } from '@trailerforge/analysis';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleShortProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { importFootageOp } from './footage-ops.js';
import { OpError } from './ops.js';
import { placeVoiceOp, voiceDownloadOp, voiceStatusOp } from './voice-ops.js';

const F = FLICKS_PER_SECOND;
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

/** What the stub "hears", by file name: words at given seconds. */
const heard: Record<string, [number, number, string][]> = {};
const say = (text: string, at: number): [number, number, string][] =>
  text.split(' ').map((w, i) => [at + i * 0.35, at + i * 0.35 + 0.3, w]);
const stub = stubTranscriber((path, o) => {
  const words = heard[path.split('/').pop()!] ?? [];
  prompts.push(o.prompt ?? '');
  return {
    duration: 8,
    language: 'en',
    languageProbability: 0.99,
    segments: [],
    words: words.map(([start, end, text]) => ({ start, end, text, p: 0.9 })),
    envelope: { hop: 0.01, db: [] },
  } satisfies RawTranscript;
});
const prompts: string[] = [];

let root: string;
let withModel: Engine;
let noModel: Engine;
const ids: Record<string, string> = {};

async function idle(engine: Engine) {
  const end = Date.now() + 60_000;
  while (!engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) {
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-voice-ops-'));
  const home = join(root, 'home');
  withModel = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, voiceModel: manifest, transcriber: () => stub }); // prettier-ignore
  noModel = await Engine.start({ home: join(root, 'home2'), autosaveMs: 0, loadUserPlugins: false, voiceModel: null }); // prettier-ignore
  // Mark the fake model as downloaded and verified.
  const dir = join(home, 'models', manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), modelFile);
  await writeFile(join(dir, 'verified.json'), JSON.stringify({ 'config.json': manifest.files[0]!.sha256 })); // prettier-ignore
  // A long take (two bursts) and a single line with silence around it.
  const tone = (name: string, expr: string, d: number) =>
    ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${d}`, join(root, name)]);
  tone(
    'long take.wav',
    'if(between(t\\,0.5\\,2.2)+between(t\\,3\\,5)\\,0.3*sin(2*PI*220*t)\\,0)',
    6,
  );
  tone('line two.wav', 'if(between(t\\,1\\,2.5)\\,0.3*sin(2*PI*330*t)\\,0)', 4);
  heard['long take.wav'] = [
    ...say('This boss has one tell.', 0.5),
    ...say('Miss it and you are, um,', 3),
    ...say('Miss it and you are done.', 5.5),
  ];
  for (const e of [withModel, noModel]) {
    const s = await e.createProject(join(root, `seed-${e === withModel ? 'a' : 'b'}.tforge`), { ...sampleShortProject(), name: 'Seed' } as never); // prettier-ignore
    await importFootageOp(e, s, {
      paths: [join(root, 'long take.wav'), join(root, 'line two.wav')],
    });
    await idle(e);
    await s.close();
  }
  for (const a of withModel.library.list()) ids[a.originalName] = a.id;
}, 120_000);
afterAll(async () => {
  await withModel.close();
  await noModel.close();
});

let n = 0;
const open = (engine: Engine) =>
  engine.createProject(join(root, `p${n++}.tforge`), { ...sampleShortProject(), name: 'Voice' } as never); // prettier-ignore
const vo = (store: Awaited<ReturnType<typeof open>>, id: string) =>
  store.state.shorts[0]!.storyboard!.voLines.find((v) => v.id === id)!;

describe('voice model', () => {
  it('reports its state and downloads only with a yes', async () => {
    expect((await voiceStatusOp(withModel)).status).toBe('ready');
    expect(await voiceStatusOp(noModel)).toEqual({ status: 'unavailable', disclosure: null });
    await expect(voiceDownloadOp(noModel, { consent: true })).rejects.toBeInstanceOf(OpError);
    await expect(voiceDownloadOp(withModel, { consent: false })).rejects.toThrow(/explicit yes/);
  });
});

describe('placeVoiceOp', { timeout: 60_000 }, () => {
  it('splits one long take into the lines, keeps the last good take, and places them as one step', async () => {
    const store = await open(withModel);
    const r = await placeVoiceOp(withModel, store, SHORT, { assetId: ids['long take.wav'] });
    expect(r.method).toBe('transcript');
    expect(r.lines.map((l) => [l.voLineId, l.status])).toEqual([
      ['svo_1', 'matched'],
      ['svo_2', 'matched'],
    ]);
    expect(r.placed).toBe(2);
    // The second line was said twice; the clean last take at 5.5 s wins, the first is left over.
    expect(r.lines[1]!.in).toBe(Math.round(5.5 * F - 0.06 * F));
    expect(r.unused.map((u) => u.text)).toEqual(['Miss it and you are, um,']);
    expect(vo(store, 'svo_2').takes.at(-1)).toMatchObject({ assetId: ids['long take.wav'], matchedBy: 'suggestion', sourceIn: r.lines[1]!.in, sourceOut: r.lines[1]!.out }); // prettier-ignore
    // The script went along as a hint, so names come out right.
    expect(prompts.at(-1)).toBe('This boss has one tell. Miss it and you are done.');
    store.undo();
    expect(vo(store, 'svo_2').takes).toEqual([]);
    await store.close();
  });

  it('a line not in the take is reported missing and left as it was', async () => {
    heard['line two.wav'] = say('Something else entirely here.', 1);
    const store = await open(withModel);
    store.dispatch('core/shorts.fill-slot', { shortId: SHORT, target: { voLineId: 'svo_2' }, assetId: ids['line two.wav']!, input: 'voiceover' }); // prettier-ignore
    store.dispatch('core/shorts.clear-slot', { shortId: SHORT, target: { voLineId: 'svo_1' } });
    const r = await placeVoiceOp(withModel, store, SHORT);
    expect(r.lines.map((l) => [l.voLineId, l.status])).toEqual([
      ['svo_1', 'no-recording'],
      ['svo_2', 'missing'],
    ]);
    expect(r.placed).toBe(0);
    expect(vo(store, 'svo_2').takes[0]!.sourceIn).toBeUndefined();
    await store.close();
  });

  it('without the model: a file per line is trimmed of its silence; a long take waits for the model', async () => {
    const store = await open(noModel);
    await noModel.library.reload();
    const byName = Object.fromEntries(noModel.library.list().map((a) => [a.originalName, a.id]));
    store.dispatch('core/shorts.fill-slot', { shortId: SHORT, target: { voLineId: 'svo_2' }, assetId: byName['line two.wav']!, input: 'voiceover' }); // prettier-ignore
    store.dispatch('core/shorts.clear-slot', { shortId: SHORT, target: { voLineId: 'svo_1' } });
    const r = await placeVoiceOp(noModel, store, SHORT);
    expect(r.method).toBe('envelope');
    expect(r.lines[1]).toMatchObject({ voLineId: 'svo_2', status: 'trimmed' });
    // Voice from 1 s to 2.5 s: 60 ms before, 150 ms after.
    expect(Math.abs(r.lines[1]!.in! - (1 - 0.06) * F)).toBeLessThanOrEqual(0.011 * F);
    expect(Math.abs(r.lines[1]!.out! - (2.5 + 0.15) * F)).toBeLessThanOrEqual(0.011 * F);
    expect(vo(store, 'svo_2').takes[0]!.sourceIn).toBe(r.lines[1]!.in);
    const long = await placeVoiceOp(noModel, store, SHORT, { assetId: byName['long take.wav'] });
    expect(long.lines.map((l) => l.status)).toEqual(['needs-model', 'needs-model']);
    expect(long.placed).toBe(0);
    await store.close();
  });

  it('says what is wrong', async () => {
    const store = await open(withModel);
    await expect(placeVoiceOp(withModel, store, 'short_nope')).rejects.toBeInstanceOf(OpError);
    await expect(placeVoiceOp(withModel, store, SHORT, { assetId: 'asset_nope' })).rejects.toThrow(/no recording/); // prettier-ignore
    store.dispatch('core/shorts.set-storyboard', { shortId: SHORT, storyboard: null });
    await expect(placeVoiceOp(withModel, store, SHORT)).rejects.toThrow(/no voiceover lines/);
    await store.close();
  });
});
