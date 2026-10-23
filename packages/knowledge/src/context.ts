import { join } from 'node:path';
import type { KnowledgeExtractorContext } from '@trailerforge/plugin-api';
import { nodeRepoFs, type RepoFs, type ScanResult } from './scan.js';

export class RepoAccessError extends Error {
  constructor(readonly path: string) {
    super(
      `"${path}" is not a scanned file (outside the repo, ignored, binary, too large or secret)`,
    );
    this.name = 'RepoAccessError';
  }
}

/**
 * Extractor context over a scan. `readText` only serves files the scanner accepted, so an
 * extractor can't reach secrets, ignored files or anything outside the repo, whatever path it asks for.
 */
export function extractorContext(
  scan: ScanResult,
  signal: AbortSignal,
  fs: RepoFs = nodeRepoFs,
): KnowledgeExtractorContext {
  const allowed = new Set(scan.files);
  return {
    root: scan.root,
    files: scan.files,
    signal,
    async readText(path) {
      signal.throwIfAborted();
      if (!allowed.has(path)) throw new RepoAccessError(path);
      return (await fs.readFile(join(scan.root, path))).toString('utf8');
    },
  };
}
