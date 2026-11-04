import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, type Egress } from '@trailerforge/core';

/**
 * Opt-in local models (vision, voice): a manifest pins exact URLs at a fixed revision with each
 * file's size and sha256; the download goes through `Egress` once, with the user's consent, and
 * nothing is uploaded. A `verified.json` marker is written last, so an interrupted download is
 * resumed file by file.
 */

export interface ModelFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface ModelManifest {
  /** Folder name under `<home>/models/` and part of cache keys. */
  id: string;
  title: string;
  /** SPDX id; must allow closed-source use. */
  license: string;
  /** Where it comes from (repository and revision), for the disclosure. */
  source: string;
  files: ModelFile[];
  /** Hosts the download may be redirected to (a host's file CDN), shown in the disclosure. */
  servedFrom?: string[];
}

/** `unavailable`: none pinned in this build; `absent`: not downloaded (or changed); `ready`. */
export type ModelStatus = 'unavailable' | 'absent' | 'ready';

export const modelDir = (home: string, m: Pick<ModelManifest, 'id'>) => join(home, 'models', m.id);

const VERIFIED = 'verified.json';

export async function modelStatus(home: string, m: ModelManifest | null): Promise<ModelStatus> {
  if (!m) return 'unavailable';
  const dir = modelDir(home, m);
  try {
    const verified = JSON.parse(await readFile(join(dir, VERIFIED), 'utf8')) as Record<
      string,
      string
    >;
    for (const f of m.files) {
      if (verified[f.name] !== f.sha256) return 'absent';
      if ((await stat(join(dir, f.name))).size !== f.bytes) return 'absent';
    }
    return 'ready';
  } catch {
    return 'absent';
  }
}

export function modelDisclosure(m: ModelManifest, afterwards: string) {
  return {
    title: m.title,
    license: m.license,
    source: m.source,
    hosts: [...new Set([...m.files.map((f) => new URL(f.url).host), ...(m.servedFrom ?? [])])],
    totalBytes: m.files.reduce((n, f) => n + f.bytes, 0),
    sends: 'Nothing about you or your project: this only downloads the model, once.',
    afterwards,
  };
}

export class ModelConsentRequired extends Error {
  constructor(what: string) {
    super(`downloading the ${what} needs an explicit yes`);
    this.name = 'ModelConsentRequired';
  }
}

export async function downloadModel(o: {
  home: string;
  egress: Egress;
  manifest: ModelManifest;
  /** Logged with every request, e.g. "Download the local voice model …". */
  purpose: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const m = o.manifest;
  const dir = modelDir(o.home, m);
  const total = m.files.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  for (const f of m.files) {
    const dest = join(dir, f.name);
    const have = await stat(dest).catch(() => null);
    if (!have || have.size !== f.bytes || !(await sha256Is(dest, f.sha256))) {
      await o.egress.download(f.url, dest, {
        purpose: o.purpose,
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

async function sha256Is(path: string, expected: string): Promise<boolean> {
  return (
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex') === expected
  );
}
