import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MotionRenderJob, MotionRenderer } from '@trailerforge/plugin-api';
import { SEQUENCE_DONE } from './renderer.js';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** JSON with sorted object keys, so equal values always give equal text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/**
 * The identity of an EffectCraft render (plan M10 decision 7): renderer, CPU, the EffectCraft
 * version, what is drawn (the `.ecproj` or `.ectemplate` by content hash) and how (values, size,
 * rate, length). Paths never count: moving a project does not re-render.
 */
export function motionContentHash(o: {
  version: string;
  templateId: string;
  sourceSha256: string;
  params: Record<string, unknown>;
  resolution: MotionRenderJob['resolution'];
  frameRate: MotionRenderJob['frameRate'];
  duration: number;
}): string {
  return sha256(
    canonicalJson([
      'effectcraft',
      'cpu',
      o.version,
      o.templateId,
      o.sourceSha256,
      o.params,
      o.resolution,
      o.frameRate,
      o.duration,
    ]),
  );
}

export interface CachedMotionFrames {
  dir: string;
  pattern: string;
  frames: number;
  contentHash: string;
  /** True when the frames came from the cache and nothing was rendered. */
  cached: boolean;
  /** False once a re-render of the same input drew different frames (recorded for good). */
  reproducible: boolean;
  warnings: string[];
}

interface SumsRecord {
  digest: string;
  mismatch?: true;
}

/**
 * A motion renderer's frames through a content-hash cache: `<cacheRoot>/<hash 24>/` holds the
 * sequence, `<hash 24>.sums.json` the digest of the first render's frames. A later render of the
 * same input (the folder was cleared) is compared with it; a difference marks the input as not
 * reproducible, which the render manifest then carries with a warning at export.
 */
export async function cachedMotionFrames(
  renderer: MotionRenderer,
  job: Omit<MotionRenderJob, 'outDir'>,
  o: { cacheRoot: string; signal: AbortSignal; contentHash?: string },
): Promise<CachedMotionFrames> {
  const contentHash = o.contentHash ?? (await renderer.fingerprint(job));
  const dir = join(o.cacheRoot, contentHash.slice(0, 24));
  const sumsPath = `${dir}.sums.json`;
  const prev = await readSums(sumsPath);
  const warnings: string[] = [];
  let cached = true;
  let frames: number;
  if (existsSync(join(dir, SEQUENCE_DONE))) {
    frames = Number((await readFile(join(dir, SEQUENCE_DONE), 'utf8')).trim());
  } else {
    cached = false;
    const r = await renderer.render({ ...job, outDir: dir }, o.signal);
    warnings.push(...r.warnings);
    frames = r.frames;
    const digest = await framesDigest(dir);
    if (!prev) await writeFile(sumsPath, JSON.stringify({ digest } satisfies SumsRecord));
    else if (prev.digest !== digest && !prev.mismatch) {
      prev.mismatch = true;
      await writeFile(sumsPath, JSON.stringify(prev));
    }
  }
  const reproducible = !prev?.mismatch;
  if (!reproducible)
    warnings.push(
      `${renderer.name} drew different frames for the same input on a re-render; this export may not be byte-identical when rendered again`,
    );
  return { dir, pattern: 'frame_%06d.png', frames, contentHash, cached, reproducible, warnings };
}

async function readSums(path: string): Promise<SumsRecord | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SumsRecord;
  } catch {
    return null;
  }
}

/** One digest over every frame file of a sequence, in order. */
export async function framesDigest(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.png')).sort()) {
    h.update(f);
    h.update(sha256(await readFile(join(dir, f))));
  }
  return h.digest('hex');
}
