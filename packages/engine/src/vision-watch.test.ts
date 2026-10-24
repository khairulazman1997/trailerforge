import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubEmbedder, VISION_JOB, type VisionModelManifest } from '@trailerforge/analysis';
import { IMPORT_JOB } from '@trailerforge/ingest';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine, type EngineOptions } from './engine.js';
import { analyzeOp, importFootageOp, libraryMediaOp, matchSuggestOp } from './footage-ops.js';
import { OpError } from './ops.js';
import { visionDownloadOp, visionStatusOp } from './vision-ops.js';

const files: Record<string, Buffer> = {
  'vision.onnx': Buffer.from('v'.repeat(3000)),
  'text.onnx': Buffer.from('t'.repeat(2000)),
  'tokenizer.json': Buffer.from('{"tok":1}'),
};
const manifest: VisionModelManifest = {
  id: 'test-clip',
  title: 'Test CLIP',
  license: 'MIT',
  source: 'example/test-clip@abc123',
  files: Object.entries(files).map(([name, b]) => ({
    name: name as 'vision.onnx',
    url: `https://models.example.org/${name}`,
    bytes: b.length,
    sha256: createHash('sha256').update(b).digest('hex'),
  })),
};
const fetched: string[] = [];
const fakeFetch = (async (url: string) => {
  fetched.push(String(url));
  return new Response(new Uint8Array(files[String(url).split('/').pop()!]!));
}) as unknown as typeof fetch;
let embedCalls = 0;

let root: string;
const engines: Engine[] = [];
const start = async (home: string, extra: Partial<EngineOptions> = {}) => {
  const e = await Engine.start({
    home,
    autosaveMs: 0,
    loadUserPlugins: false,
    visionModel: manifest,
    egressFetch: fakeFetch,
    // The stub keys its cache by the model's id, like the real sidecar embedder does.
    visionEmbedder: (_dir, id) => {
      const s = stubEmbedder();
      return {
        modelId: id,
        embedFrames: (p, t) => (embedCalls++, s.embedFrames(p, t)),
        embedTexts: (t) => (embedCalls++, s.embedTexts(t)),
      };
    },
    watchIntervalMs: 40,
    ...extra,
  });
  engines.push(e);
  return e;
};
const idle = async (engine: Engine, ms = 60_000) => {
  const end = Date.now() + ms;
  while (engine.jobs.list().some((j) => j.status === 'queued' || j.status === 'running')) {
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
};
const recording = (path: string, seconds: number) =>
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=320x180:r=30:d=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-vision-watch-'));
});
afterAll(async () => {
  for (const e of engines) await e.close();
});

describe('vision wiring', () => {
  it('is hidden when no model is pinned, and matching works without it', async () => {
    const engine = await start(join(root, 'none'), { visionModel: null });
    expect(await visionStatusOp(engine)).toEqual({ status: 'unavailable', disclosure: null });
    await expect(visionDownloadOp(engine, { consent: true })).rejects.toBeInstanceOf(OpError);
    const store = await engine.createProject(join(root, 'None.tforge'), sampleProject() as never);
    expect((await matchSuggestOp(engine, store)).usedVision).toBe(false);
    expect(fetched).toEqual([]);
  });

  it('downloads only with consent, then embeds frames during analysis and scores matches from the cache', async () => {
    const engine = await start(join(root, 'v'));
    const before = await visionStatusOp(engine);
    expect(before.status).toBe('absent');
    expect(before.disclosure).toMatchObject({ license: 'MIT', hosts: ['models.example.org'] });

    await expect(visionDownloadOp(engine, { consent: false })).rejects.toBeInstanceOf(OpError);
    expect(fetched).toEqual([]);
    const progress: number[] = [];
    const after = await visionDownloadOp(engine, {
      consent: true,
      onProgress: (f) => progress.push(f),
    });
    expect(after.status).toBe('ready');
    expect(fetched).toHaveLength(3);
    expect(progress.at(-1)).toBe(1);
    const log = await readFile(join(root, 'v', 'logs', 'egress.jsonl'), 'utf8');
    expect(log).toContain('nothing is uploaded');

    const store = await engine.createProject(join(root, 'V.tforge'), sampleProject() as never);
    const clip = join(root, 'take-v.mp4');
    recording(clip, 3);
    await importFootageOp(engine, store, { paths: [clip] });
    await idle(engine);
    // Before analysis, no frame vectors: matching does not decode anything itself.
    embedCalls = 0;
    expect((await matchSuggestOp(engine, store)).usedVision).toBe(false);
    expect(embedCalls).toBe(0);

    const first = await analyzeOp(engine, store, { music: false });
    expect(first.jobs.map((j) => j.type)).toContain(VISION_JOB);
    await idle(engine);
    const second = await analyzeOp(engine, store, { music: false });
    expect(second.jobs.map((j) => j.type)).not.toContain(VISION_JOB); // cached by hash

    const m = await matchSuggestOp(engine, store);
    expect(m.usedVision).toBe(true);
    expect(
      m.matches.flatMap((x) => x.candidates.flatMap((c) => c.reasons.map((r) => r.signal))),
    ).toContain('vision');
  }, 120_000);
});

describe('watched folders', () => {
  it('validates, persists, imports only new recordings, and resumes after a restart', async () => {
    const home = join(root, 'w');
    const obs = join(root, 'obs');
    await mkdir(obs);
    await writeFile(join(obs, 'old.mp4'), 'already here'); // existing files are not imported
    let engine = await start(home);
    expect(engine.watched.view()).toEqual({ folders: [], watching: false, problems: [] });
    await expect(engine.watched.set(['relative/path'])).rejects.toBeInstanceOf(OpError);
    await expect(engine.watched.set([join(root, 'missing')])).rejects.toBeInstanceOf(OpError);

    const view = await engine.watched.set([obs, obs]);
    expect(view).toMatchObject({ folders: [obs], watching: true });
    expect(JSON.parse(await readFile(join(home, 'watched-folders.json'), 'utf8'))).toEqual({
      version: 1,
      folders: [obs],
    });
    const imports = (e: Engine) =>
      e.jobs
        .list()
        .filter((j) => j.type === IMPORT_JOB)
        .map((j) => (j.input as { path: string }).path);
    await new Promise((r) => setTimeout(r, 300));
    expect(imports(engine)).toEqual([]);

    await writeFile(join(obs, 'new.mp4'), 'a new recording');
    await until(() => imports(engine).length === 1);
    expect(imports(engine)).toEqual([join(obs, 'new.mp4')]);

    await engine.close();
    engines.splice(engines.indexOf(engine), 1);
    engine = await start(home);
    expect(engine.watched.view()).toMatchObject({ folders: [obs], watching: true });
    await writeFile(join(obs, 'while-open.mp4'), 'another one');
    await until(() => imports(engine).some((p) => p.endsWith('while-open.mp4')));
    expect(imports(engine).filter((p) => p.endsWith('new.mp4'))).toHaveLength(1);

    expect(await engine.watched.set([])).toMatchObject({ folders: [], watching: false });
  }, 60_000);
});

describe('previews', () => {
  it('serves a recording thumbnail and filmstrip from the library cache only', async () => {
    const engine = await start(join(root, 'p'), { visionModel: null });
    const store = await engine.createProject(join(root, 'P.tforge'), sampleProject() as never);
    const clip = join(root, 'take-p.mp4');
    recording(clip, 2);
    await importFootageOp(engine, store, { paths: [clip] });
    await idle(engine);
    const id = engine.library.list()[0]!.id;
    for (const what of ['thumbnail', 'filmstrip'] as const) {
      const f = await libraryMediaOp(engine, id, what);
      expect(f.type).toBe('image/jpeg');
      expect(f.size).toBeGreaterThan(0);
      expect(f.path).toContain(join('library', 'cache'));
    }
    await expect(libraryMediaOp(engine, 'asset_nope', 'thumbnail')).rejects.toBeInstanceOf(OpError);
  }, 60_000);
});
