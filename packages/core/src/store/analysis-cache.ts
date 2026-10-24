import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ContentHash } from '@trailerforge/schema';
import type { z } from 'zod';
import { writeFileAtomic } from './fs-atomic.js';

const ANALYZER = /^[a-z][a-z0-9.-]{0,63}$/;
const VERSION = /^[0-9A-Za-z.-]{1,32}$/;

/**
 * `<cache>/analysis/<hash>/<analyzer>@<version>.json`. Keyed by the asset's quick hash, so a moved
 * or re-imported file keeps its analysis, and by analyzer version, so a changed analyzer never
 * reads stale results. Analysis is never stored in `project.json`.
 */
export function analysisCacheFile(
  analysisDir: string,
  hash: string,
  analyzer: string,
  version: string,
): string {
  if (!ContentHash.safeParse(hash).success) throw new Error(`bad content hash "${hash}"`);
  if (!ANALYZER.test(analyzer)) throw new Error(`bad analyzer name "${analyzer}"`);
  if (!VERSION.test(version)) throw new Error(`bad analyzer version "${version}"`);
  return join(analysisDir, hash, `${analyzer}@${version}.json`);
}

/** Cached result, or null when absent, unreadable or no longer matching `schema`. */
export async function readAnalysisCache<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic write: a cancelled or crashed analysis never leaves a partial result behind. */
export async function writeAnalysisCache(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(value));
}
