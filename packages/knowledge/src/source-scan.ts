import type { ExtractedEntity, KnowledgeExtractor } from '@trailerforge/plugin-api';
import type { KnowledgeSource } from '@trailerforge/schema';
import { extractorContext } from './context.js';
import { dedupe } from './generic.js';
import { scanRepo, type ScanManifest, type ScanResult } from './scan.js';

export interface SourceScanResult {
  scan: ScanResult;
  entities: ExtractedEntity[];
  /** Extractors that threw or weren't registered; the rest still ran. */
  problems: { extractorId: string; message: string }[];
  /** The scan's digest equals `skipIfDigest`: nothing changed, so extractors were not run. */
  unchanged: boolean;
}

/** Extractors worth running on this repo: those whose `detect` clears the threshold. */
export async function detectExtractors(
  scan: Pick<ScanResult, 'root' | 'files'>,
  all: readonly KnowledgeExtractor[],
  threshold = 0.5,
): Promise<string[]> {
  const ids: string[] = [];
  for (const x of all) if ((await x.detect(scan)) >= threshold) ids.push(x.id);
  return ids.sort();
}

/**
 * Scan a source's folder and run its extractors over what the scanner accepted. One failing
 * extractor doesn't stop the others. Nothing is written: the caller applies the result through
 * `core/knowledge.apply-scan`.
 */
export async function scanSource(
  source: Pick<KnowledgeSource, 'path' | 'include' | 'exclude' | 'extractorIds'>,
  getExtractor: (id: string) => KnowledgeExtractor | undefined,
  opts: {
    previous?: ScanManifest;
    maxFileBytes?: number;
    signal?: AbortSignal;
    /** Digest of the last applied scan; when the repo still hashes to it, extraction is skipped. */
    skipIfDigest?: string | null;
  } = {},
): Promise<SourceScanResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const scan = await scanRepo(source.path, {
    include: source.include,
    exclude: source.exclude,
    signal,
    ...(opts.previous ? { previous: opts.previous } : {}),
    ...(opts.maxFileBytes ? { maxFileBytes: opts.maxFileBytes } : {}),
  });
  if (opts.skipIfDigest && scan.digestHash === opts.skipIfDigest)
    return { scan, entities: [], problems: [], unchanged: true };
  const ctx = extractorContext(scan, signal);
  const entities: ExtractedEntity[] = [];
  const problems: SourceScanResult['problems'] = [];
  for (const id of source.extractorIds) {
    const extractor = getExtractor(id);
    if (!extractor) {
      problems.push({ extractorId: id, message: 'extractor is not installed' });
      continue;
    }
    try {
      entities.push(...(await extractor.extract(ctx)));
    } catch (err) {
      signal.throwIfAborted();
      problems.push({ extractorId: id, message: (err as Error).message });
    }
  }
  return { scan, entities: dedupe(entities), problems, unchanged: false };
}
