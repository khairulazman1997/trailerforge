import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Egress } from '@trailerforge/core';
import { JobQueue } from '@trailerforge/jobs';
import { beforeEach, describe, expect, it } from 'vitest';
import { VISION_JOB, registerAnalysisJobs } from './jobs.js';
import { PINNED_VISION_MODEL } from './vision-model.js';
import {
  VisionConsentRequired,
  downloadVisionModel,
  embedRecording,
  embedTexts,
  frameSampleTimes,
  shotVisionText,
  sidecarEmbedder,
  stubEmbedder,
  visionDownloadDisclosure,
  visionModelDir,
  visionModelStatus,
  visionScore,
  type VisionModelManifest,
} from './vision.js';

let home: string;
let fetched: string[];
const files: Record<string, Buffer> = {
  'vision.onnx': Buffer.from('v'.repeat(3000)),
  'text.onnx': Buffer.from('t'.repeat(2000)),
  'tokenizer.json': Buffer.from('{"tok":1}'),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const manifest: VisionModelManifest = {
  id: 'test-clip',
  title: 'Test CLIP',
  license: 'MIT',
  source: 'example/test-clip@abc123',
  files: Object.entries(files).map(([name, b]) => ({
    name: name as 'vision.onnx',
    url: `https://models.example.org/${name}`,
    bytes: b.length,
    sha256: sha(b),
  })),
};
const fakeFetch = (override: Record<string, Buffer> = {}) =>
  (async (url: string) => {
    fetched.push(String(url));
    const name = String(url).split('/').pop()!;
    return new Response(new Uint8Array(override[name] ?? files[name]!));
  }) as unknown as typeof fetch;
const egress = (f = fakeFetch()) =>
  new Egress({ logFile: join(home, 'logs', 'egress.jsonl'), fetch: f });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-vision-'));
  fetched = [];
});

describe('vision model download', () => {
  it('stays unavailable until a model is pinned in the build', async () => {
    expect(await visionModelStatus(home, null)).toBe('unavailable');
    await expect(
      downloadVisionModel({ home, egress: egress(), manifest: null, consent: true }),
    ).rejects.toThrow(/pinned/);
    expect(fetched).toEqual([]);
  });

  it('never touches the network without an explicit yes', async () => {
    await expect(
      downloadVisionModel({ home, egress: egress(), manifest, consent: false }),
    ).rejects.toBeInstanceOf(VisionConsentRequired);
    expect(fetched).toEqual([]);
    expect(await visionModelStatus(home, manifest)).toBe('absent');
  });

  it('downloads once with consent, verifies every file, and is ready offline afterwards', async () => {
    const seen: number[] = [];
    await downloadVisionModel({
      home,
      egress: egress(),
      manifest,
      consent: true,
      onProgress: (f) => seen.push(f),
    });
    expect(await visionModelStatus(home, manifest)).toBe('ready');
    expect(fetched).toHaveLength(3);
    expect(seen.at(-1)).toBe(1);
    await downloadVisionModel({ home, egress: egress(), manifest, consent: true });
    expect(fetched).toHaveLength(3); // nothing fetched again
    await writeFile(join(visionModelDir(home, manifest), 'text.onnx'), 'tampered');
    expect(await visionModelStatus(home, manifest)).toBe('absent');
  });

  it('rejects a file whose checksum does not match, and stays absent', async () => {
    const bad = Buffer.from(files['text.onnx']!).fill(88, 0, 1);
    await expect(
      downloadVisionModel({
        home,
        egress: egress(fakeFetch({ 'text.onnx': bad })),
        manifest,
        consent: true,
      }),
    ).rejects.toMatchObject({ code: 'checksum-mismatch' });
    expect(await visionModelStatus(home, manifest)).toBe('absent');
  });

  it('discloses what it downloads, from where, and that nothing is sent', () => {
    expect(visionDownloadDisclosure(manifest)).toMatchObject({
      hosts: ['models.example.org'],
      totalBytes: 3000 + 2000 + 9,
      license: 'MIT',
    });
  });
});

describe('embeddings (contract, stub embedder)', () => {
  it('caches frame vectors by recording hash and model, and text vectors by text', async () => {
    const e = stubEmbedder();
    const rec = {
      path: '/rec/a.mp4',
      quickHash: 'a'.repeat(64),
      durationSec: 10,
      analysisDir: join(home, 'cache'),
    };
    const first = await embedRecording(e, rec);
    expect(first).toMatchObject({ cached: false, times: frameSampleTimes(10) });
    expect((await embedRecording(e, rec)).cached).toBe(true);
    const texts = ['a boss arena', 'a forest run'];
    const v1 = await embedTexts(e, texts, rec.analysisDir);
    const callsAfter = e.calls;
    const v2 = await embedTexts(e, [...texts, 'a new shot'], rec.analysisDir);
    expect(v2.slice(0, 2)).toEqual(v1);
    expect(e.calls).toBe(callsAfter + 1); // only the new text was embedded
  });

  it('scores a recording by its best frame', () => {
    expect(
      visionScore(
        [
          [1, 0],
          [0, 1],
        ],
        [0, 1],
      ),
    ).toBe(1);
    expect(visionScore([], [1, 0])).toBe(0);
    expect(frameSampleTimes(8, 4)).toEqual([1, 3, 5, 7]);
    expect(frameSampleTimes(0)).toEqual([]);
  });

  it('describes a shot in words from its own fields and entity names', () => {
    expect(
      shotVisionText(
        {
          title: 'Boss reveal',
          captureInstruction: 'Walk into the arena',
          framing: 'Wide',
          location: 'Forest',
        },
        ['The Ash Warden'],
      ),
    ).toBe('a video game screenshot: Walk into the arena. Wide. Forest. The Ash Warden');
  });
});

describe('the sidecar embedder (tiny real ONNX model)', () => {
  it('embeds frames and texts, and the job caches them', async () => {
    const workers = resolve(dirname(fileURLToPath(import.meta.url)), '../../../workers/analysis');
    const modelDir = join(home, 'models', 'tiny');
    execFileSync('uv', [
      'run',
      '--project',
      workers,
      '--frozen',
      '--quiet',
      'python',
      '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(join(workers, 'tests'))}); from pathlib import Path; from tiny_model import build; build(Path(${JSON.stringify(modelDir)}))`,
    ]);
    const video = join(home, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=2',
      '-pix_fmt',
      'yuv420p',
      video,
    ]);

    const e = sidecarEmbedder(modelDir, 'tiny');
    const frames = await e.embedFrames(video, [0.5, 1.5]);
    expect(frames).toHaveLength(2);
    expect(Math.abs(Math.hypot(...frames[0]!) - 1)).toBeLessThan(1e-3);
    const [t] = await e.embedTexts(['a red boss']);
    expect(t).toHaveLength(8);

    const q = new JobQueue({
      dbPath: join(home, 'jobs.sqlite'),
      tempRoot: join(home, 'tmp'),
      progressThrottleMs: 0,
    });
    registerAnalysisJobs(q);
    q.start();
    try {
      const input = {
        path: video,
        quickHash: 'b'.repeat(64),
        analysisDir: join(home, 'cache'),
        durationSec: 2,
        modelDir,
        modelId: 'tiny',
      };
      const done = async (id: string) => {
        while (['queued', 'running'].includes(q.get(id)!.status))
          await new Promise((r) => setTimeout(r, 50));
        return q.get(id)!;
      };
      expect(await done(q.enqueue(VISION_JOB, input))).toMatchObject({
        status: 'succeeded',
        output: { cached: false, frames: 8 },
      });
      expect(await done(q.enqueue(VISION_JOB, input))).toMatchObject({ output: { cached: true } });
      const missing = await done(
        q.enqueue(VISION_JOB, {
          ...input,
          quickHash: 'c'.repeat(64),
          modelDir: join(home, 'none'),
        }),
      );
      expect(missing).toMatchObject({
        status: 'failed',
        attempts: 1,
        error: { code: 'model-missing' },
      });
    } finally {
      await q.close();
    }
  }, 120_000);
});

describe.skipIf(!process.env.TFORGE_VISION_LIVE || !PINNED_VISION_MODEL)(
  'live: the pinned model',
  () => {
    it('downloads, verifies and tells a red picture from a blue one', async () => {
      const m = PINNED_VISION_MODEL!;
      await downloadVisionModel({
        home,
        egress: new Egress({ logFile: join(home, 'egress.jsonl') }),
        manifest: m,
        consent: true,
      });
      expect(await visionModelStatus(home, m)).toBe('ready');
      const video = join(home, 'red.mp4');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=320x180:r=30:d=1',
        '-pix_fmt',
        'yuv420p',
        video,
      ]);
      const e = sidecarEmbedder(visionModelDir(home, m), m.id);
      const frames = await e.embedFrames(video, [0.5]);
      const [red, blue] = await e.embedTexts(['a plain red image', 'a plain blue image']);
      expect(visionScore(frames, red!)).toBeGreaterThan(visionScore(frames, blue!));
    }, 600_000);
  },
);
