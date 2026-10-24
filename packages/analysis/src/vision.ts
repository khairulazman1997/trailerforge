import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analysisCacheFile,
  readAnalysisCache,
  writeAnalysisCache,
  writeFileAtomic,
  type Egress,
} from '@trailerforge/core';
import { resolveTools } from '@trailerforge/media';
import { z } from 'zod';
import { callSidecar, type SidecarCommand } from './sidecar.js';

/** Either one combined `model.onnx` or separate vision and text models, plus the tokenizer. */
export const VISION_FILES = ['model.onnx', 'vision.onnx', 'text.onnx', 'tokenizer.json'] as const;

export interface VisionModelFile {
  name: (typeof VISION_FILES)[number];
  url: string;
  bytes: number;
  sha256: string;
}

export interface VisionModelManifest {
  /** Folder name under `<home>/models/` and part of cache keys, e.g. `clip-vit-b32`. */
  id: string;
  title: string;
  /** SPDX id; must allow closed-source use. */
  license: string;
  /** Where it comes from (repository and revision), for the disclosure. */
  source: string;
  files: VisionModelFile[];
  /** Hosts the download may be redirected to (a host's file CDN), shown in the disclosure. */
  servedFrom?: string[];
}

export type VisionModelStatus = 'unavailable' | 'absent' | 'ready';

export const visionModelDir = (home: string, m: Pick<VisionModelManifest, 'id'>) =>
  join(home, 'models', m.id);

const VERIFIED = 'verified.json';

/**
 * `unavailable`: no model pinned in this build (the feature stays hidden); `absent`: pinned but
 * not downloaded (or a file changed since); `ready`: every file is there with the size it had
 * when its checksum was verified.
 */
export async function visionModelStatus(
  home: string,
  manifest: VisionModelManifest | null,
): Promise<VisionModelStatus> {
  if (!manifest) return 'unavailable';
  const dir = visionModelDir(home, manifest);
  try {
    const verified = JSON.parse(await readFile(join(dir, VERIFIED), 'utf8')) as Record<
      string,
      string
    >;
    for (const f of manifest.files) {
      if (verified[f.name] !== f.sha256) return 'absent';
      if ((await stat(join(dir, f.name))).size !== f.bytes) return 'absent';
    }
    return 'ready';
  } catch {
    return 'absent';
  }
}

/** What the download will do, shown before asking for consent. */
export function visionDownloadDisclosure(m: VisionModelManifest) {
  return {
    title: m.title,
    license: m.license,
    source: m.source,
    hosts: [...new Set([...m.files.map((f) => new URL(f.url).host), ...(m.servedFrom ?? [])])],
    totalBytes: m.files.reduce((n, f) => n + f.bytes, 0),
    sends: 'Nothing about you or your project: this only downloads the model, once.',
    afterwards: 'Matching runs on this computer; footage and frames never leave it.',
  };
}

export class VisionConsentRequired extends Error {
  constructor() {
    super('downloading the vision model needs an explicit yes');
    this.name = 'VisionConsentRequired';
  }
}

/**
 * One-time, opt-in model download through `Egress`. Each file is checked against its pinned size
 * and sha256 before it is kept; the `verified.json` marker is written last, so an interrupted
 * download is simply resumed file by file next time.
 */
export async function downloadVisionModel(o: {
  home: string;
  egress: Egress;
  manifest: VisionModelManifest | null;
  consent: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  if (!o.manifest) throw new Error('no vision model is pinned in this build');
  if (o.consent !== true) throw new VisionConsentRequired();
  const m = o.manifest;
  const dir = visionModelDir(o.home, m);
  const total = m.files.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  for (const f of m.files) {
    const dest = join(dir, f.name);
    const have = await stat(dest).catch(() => null);
    if (!have || have.size !== f.bytes || !(await sha256File(dest, f.sha256))) {
      await o.egress.download(f.url, dest, {
        purpose: `Download the local AI vision model (${m.title}, ${m.license}): one time, nothing is uploaded`,
        expectedBytes: f.bytes,
        sha256: f.sha256,
        ...(o.signal ? { signal: o.signal } : {}),
        onProgress: (b) => o.onProgress?.((done + b) / total),
      });
    }
    done += f.bytes;
    o.onProgress?.(done / total);
  }
  await writeFileAtomic(
    join(dir, VERIFIED),
    `${JSON.stringify(Object.fromEntries(m.files.map((f) => [f.name, f.sha256])))}\n`,
  );
}

async function sha256File(path: string, expected: string): Promise<boolean> {
  return (
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex') === expected
  );
}

/** Turns frames and text into comparable unit vectors. */
export interface VisionEmbedder {
  /** Part of cache keys: a different model never reuses another's vectors. */
  readonly modelId: string;
  embedFrames(path: string, times: number[], signal?: AbortSignal): Promise<number[][]>;
  embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

const Vectors = z.strictObject({
  dim: z.int().nonnegative(),
  vectors: z.array(z.array(z.number())),
});

/** The real embedder: the CLIP-style ONNX model in the sidecar, on the CPU, offline. */
export function sidecarEmbedder(
  modelDir: string,
  modelId: string,
  opts: { command?: SidecarCommand; ffmpeg?: string } = {},
): VisionEmbedder {
  const call = async (method: string, params: object, signal?: AbortSignal) =>
    Vectors.parse(
      await callSidecar(
        method,
        { modelDir, ...params },
        {
          ...(opts.command ? { command: opts.command } : {}),
          ...(signal ? { signal } : {}),
        },
      ),
    ).vectors;
  return {
    modelId,
    embedFrames: (path, times, signal) =>
      call(
        'vision.embed_frames',
        { path, times, ffmpeg: opts.ffmpeg ?? resolveTools().ffmpeg },
        signal,
      ),
    embedTexts: (texts, signal) => call('vision.embed_texts', { texts }, signal),
  };
}

/** Deterministic fake vectors from hashes: for tests and for contract-checking callers. */
export function stubEmbedder(dim = 16): VisionEmbedder & { calls: number } {
  const vec = (key: string) => {
    const h = createHash('sha256').update(key).digest();
    const v = Array.from({ length: dim }, (_, i) => h[i % h.length]! - 127.5);
    const n = Math.hypot(...v);
    return v.map((x) => Math.round((x / n) * 1e5) / 1e5);
  };
  const e = {
    modelId: 'stub',
    calls: 0,
    embedFrames: async (path: string, times: number[]) => {
      e.calls++;
      return times.map((t) => vec(`${path}@${t}`));
    },
    embedTexts: async (texts: string[]) => {
      e.calls++;
      return texts.map((t) => vec(`text:${t}`));
    },
  };
  return e;
}

/** Where to look in a recording: `n` evenly spaced moments, away from the very ends. */
export function frameSampleTimes(durationSec: number, n = 8): number[] {
  if (durationSec <= 0) return [];
  return Array.from(
    { length: n },
    (_, i) => Math.round(((i + 0.5) / n) * durationSec * 1000) / 1000,
  );
}

const FrameCache = z.strictObject({
  modelId: z.string(),
  times: z.array(z.number()),
  vectors: z.array(z.array(z.number())),
});
const TextCache = z.strictObject({
  modelId: z.string(),
  text: z.string(),
  vector: z.array(z.number()),
});

const cacheVersion = (e: VisionEmbedder) => `${e.modelId}.1`;

/** Frame vectors for a recording, cached by its quick hash and the model. */
export async function embedRecording(
  e: VisionEmbedder,
  rec: { path: string; quickHash: string; durationSec: number; analysisDir: string },
  signal?: AbortSignal,
): Promise<{ times: number[]; vectors: number[][]; cached: boolean }> {
  const file = analysisCacheFile(rec.analysisDir, rec.quickHash, 'vision-frames', cacheVersion(e));
  const hit = await readAnalysisCache(file, FrameCache);
  if (hit && hit.modelId === e.modelId)
    return { times: hit.times, vectors: hit.vectors, cached: true };
  const times = frameSampleTimes(rec.durationSec);
  const vectors = await e.embedFrames(rec.path, times, signal);
  await writeAnalysisCache(file, { modelId: e.modelId, times, vectors });
  return { times, vectors, cached: false };
}

/** Text vectors, cached by the text's hash and the model; only the missing ones are computed. */
export async function embedTexts(
  e: VisionEmbedder,
  texts: string[],
  analysisDir: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  const files = texts.map((t) =>
    analysisCacheFile(
      analysisDir,
      createHash('sha256').update(t).digest('hex'),
      'vision-text',
      cacheVersion(e),
    ),
  );
  const out = await Promise.all(files.map((f) => readAnalysisCache(f, TextCache)));
  const missing = texts.map((t, i) => (out[i]?.text === t ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const vectors = await e.embedTexts(
      missing.map((i) => texts[i]!),
      signal,
    );
    await Promise.all(
      missing.map((i, k) => {
        out[i] = { modelId: e.modelId, text: texts[i]!, vector: vectors[k]! };
        return writeAnalysisCache(files[i]!, out[i]);
      }),
    );
  }
  return out.map((c) => c!.vector);
}

/** Cosine similarity of unit vectors. */
export const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

/** How well a recording matches a shot: the best frame's similarity to the shot's text. */
export const visionScore = (frames: number[][], text: number[]) =>
  frames.length ? Math.max(...frames.map((f) => dot(f, text))) : 0;

/**
 * The words the model compares frames against. Built from the shot's own fields and its knowledge
 * entities' names; it stays on this computer (local model), so nothing is redacted here.
 */
export function shotVisionText(
  shot: { title: string; captureInstruction: string; framing: string; location: string },
  entityNames: string[] = [],
): string {
  const parts = [
    shot.captureInstruction || shot.title,
    shot.framing,
    shot.location,
    entityNames.join(', '),
  ];
  return `a video game screenshot: ${parts.filter((p) => p.trim()).join('. ')}`.slice(0, 300);
}
