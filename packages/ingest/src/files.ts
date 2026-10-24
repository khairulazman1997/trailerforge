import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { assetKindFromName } from '@trailerforge/core';
import type { AssetKind } from '@trailerforge/schema';

/** Names recorders and downloaders use while a file is still being written. */
const STAGING_EXT = new Set(['.part', '.partial', '.tmp', '.temp', '.crdownload', '.download']);

export function isStagingName(name: string): boolean {
  return STAGING_EXT.has(extname(name).toLowerCase()) || name.endsWith('~');
}

/** What a folder import or the watcher picks up. Files named one by one may be any known kind. */
export const FOLDER_KINDS: readonly AssetKind[] = ['video', 'audio'];

export interface SkippedPath {
  path: string;
  reason: 'not-found' | 'unsupported' | 'staging-file' | 'unreadable';
}

export interface CollectOptions {
  signal?: AbortSignal;
  /** Stop after this many files (default 5,000). */
  maxFiles?: number;
  /** Folder depth below each given folder (default 8). */
  maxDepth?: number;
  /** Kinds taken from inside folders (default video and audio). */
  folderKinds?: readonly AssetKind[];
}

export interface Collected {
  /** Absolute paths: given files first-come, folder contents sorted by name; no repeats. */
  files: string[];
  skipped: SkippedPath[];
  /** `maxFiles` was reached; there are more files than listed. */
  truncated: boolean;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Expand dropped or browsed paths into files to import. A file named directly is taken whatever
 * its kind (except unknown ones); folders are walked for video and audio only, skipping dot
 * entries, symlinks and recorder temp files, within bounds. The walk is deterministic.
 */
export async function collectMediaFiles(
  paths: string[],
  opts: CollectOptions = {},
): Promise<Collected> {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 8;
  const folderKinds = opts.folderKinds ?? FOLDER_KINDS;
  const files: string[] = [];
  const have = new Set<string>();
  const skipped: SkippedPath[] = [];
  let truncated = false;

  const add = (path: string): boolean => {
    if (have.has(path)) return true;
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    have.add(path);
    files.push(path);
    return true;
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: dir, reason: 'unreadable' });
      return;
    }
    entries.sort(byName);
    for (const e of entries) {
      opts.signal?.throwIfAborted();
      if (truncated) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1);
      } else if (e.isFile() && !isStagingName(e.name)) {
        if (folderKinds.includes(assetKindFromName(e.name))) add(p);
      }
    }
  };

  for (const given of paths) {
    opts.signal?.throwIfAborted();
    const path = resolve(given);
    let st;
    try {
      st = await stat(path); // an explicit choice may be a symlink: follow it
    } catch {
      skipped.push({ path, reason: 'not-found' });
      continue;
    }
    if (st.isDirectory()) await walk(path, 0);
    else if (!st.isFile()) skipped.push({ path, reason: 'unsupported' });
    else if (isStagingName(path)) skipped.push({ path, reason: 'staging-file' });
    else if (assetKindFromName(path) === 'other') skipped.push({ path, reason: 'unsupported' });
    else add(path);
    if (truncated) break;
  }
  return { files, skipped, truncated };
}
