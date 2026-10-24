import { lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  AssetLibrary,
  LIBRARY_SCHEMA_VERSION,
  LibraryAsset,
  type AssetKind,
} from '@trailerforge/schema';
import { cleanupTempFiles, writeFileAtomic } from '../store/fs-atomic.js';
import { ProjectLockedError, acquireLock, type Lock } from '../store/lock.js';
import { assetIdForHash, quickHashFile } from './hash.js';

const VIDEO = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.flv', '.ts', '.mxf'];
const AUDIO = ['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.aif', '.aiff'];
const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'];
const FONT = ['.ttf', '.otf', '.woff', '.woff2'];

export function assetKindFromName(name: string): AssetKind {
  const ext = extname(name).toLowerCase();
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (IMAGE.includes(ext)) return 'image';
  if (ext === '.svg') return 'svg';
  if (FONT.includes(ext)) return 'font';
  if (ext === '.json' || ext === '.lottie') return 'lottie';
  return 'other';
}

/** Runtime presence of an asset's file: never stored. */
export type AssetFileStatus = 'ok' | 'missing' | 'changed';

export class LibraryOpenError extends Error {
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`asset library at ${path} is unreadable (${reason}); it was left untouched`, options);
    this.name = 'LibraryOpenError';
  }
}

export interface ImportResult {
  asset: LibraryAsset;
  /** A new library entry was written. */
  created: boolean;
  /** An existing entry whose file had gone missing now points at this path. */
  relinked: boolean;
}

export interface RelinkOptions {
  signal?: AbortSignal;
  /** Stop walking after this many files (default 50,000). */
  maxFiles?: number;
  /** Directory depth below each root (default 12). */
  maxDepth?: number;
}

export interface RelinkResult {
  assetId: string;
  from: string;
  to: string;
}

export interface LibraryStoreOptions {
  /** How long a mutation waits for another process holding the library lock (default 5 s). */
  lockTimeoutMs?: number;
  now?: () => Date;
}

/**
 * The app-level asset library: one JSON file under `<home>/library/`. Every mutation re-reads the
 * file under a short-lived lock, applies the change, validates and writes atomically, so a CLI
 * and the service can share a home without losing each other's writes, and a crash leaves either
 * the old or the new library. An unreadable file is reported, never overwritten.
 */
export class LibraryStore {
  private snapshot: LibraryAsset[] = [];

  private constructor(
    readonly dir: string,
    private readonly opts: LibraryStoreOptions,
  ) {}

  get file(): string {
    return join(this.dir, 'library.json');
  }

  private get lockFile(): string {
    return join(this.dir, 'library.lock');
  }

  static async open(home: string, opts: LibraryStoreOptions = {}): Promise<LibraryStore> {
    const store = new LibraryStore(join(resolve(home), 'library'), opts);
    await mkdir(store.dir, { recursive: true });
    await cleanupTempFiles(store.file);
    await store.reload();
    return store;
  }

  /** Re-read the file (another process may have changed it). */
  async reload(): Promise<void> {
    this.snapshot = (await this.read()).assets;
  }

  list(): readonly LibraryAsset[] {
    return this.snapshot;
  }

  get(id: string): LibraryAsset | undefined {
    return this.snapshot.find((a) => a.id === id);
  }

  findByQuickHash(quickHash: string): LibraryAsset | undefined {
    return this.snapshot.find((a) => a.quickHash === quickHash);
  }

  /**
   * Add a file by reference. Same content already in the library: returns that entry, relinking
   * it to `path` when its own file is gone.
   */
  async importFile(path: string, opts: { kind?: AssetKind } = {}): Promise<ImportResult> {
    const abs = resolve(path);
    const { quickHash, sizeBytes, modifiedAt } = await quickHashFile(abs);
    let result!: ImportResult;
    await this.mutate(async (assets) => {
      const existing = assets.find((a) => a.quickHash === quickHash);
      if (existing) {
        const moved = existing.uri !== abs && (await fileStatus(existing)) !== 'ok';
        const asset = moved ? { ...existing, uri: abs } : existing;
        result = { asset, created: false, relinked: moved };
        return moved ? assets.map((a) => (a === existing ? asset : a)) : null;
      }
      const asset = LibraryAsset.parse({
        id: assetIdForHash(quickHash),
        kind: opts.kind ?? assetKindFromName(abs),
        uri: abs,
        quickHash,
        sizeBytes,
        fileModifiedAt: modifiedAt,
        originalName: basename(abs),
        addedAt: this.now().toISOString(),
      });
      result = { asset, created: true, relinked: false };
      return [...assets, asset];
    });
    return result;
  }

  /** Replace one entry; `fn` must keep its id and quick hash. */
  async update(id: string, fn: (asset: LibraryAsset) => LibraryAsset): Promise<LibraryAsset> {
    let updated!: LibraryAsset;
    await this.mutate((assets) => {
      const current = assets.find((a) => a.id === id);
      if (!current) throw new Error(`unknown library asset "${id}"`);
      updated = LibraryAsset.parse(fn(current));
      if (updated.id !== id || updated.quickHash !== current.quickHash) {
        throw new Error(`library asset "${id}": id and quickHash cannot change`);
      }
      return assets.map((a) => (a === current ? updated : a));
    });
    return updated;
  }

  /** Forget an entry (the file itself is never touched). Projects referring to it keep the id. */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((assets) => {
      const next = assets.filter((a) => a.id !== id);
      removed = next.length !== assets.length;
      return removed ? next : null;
    });
    return removed;
  }

  async status(id: string): Promise<AssetFileStatus> {
    const asset = this.get(id);
    if (!asset) throw new Error(`unknown library asset "${id}"`);
    return fileStatus(asset);
  }

  /**
   * Find missing or changed files under `roots` by size and quick hash and point their entries at
   * the new paths. Symlinks and dot-folders are skipped; the walk is bounded and abortable.
   */
  async relink(roots: string[], opts: RelinkOptions = {}): Promise<RelinkResult[]> {
    await this.reload();
    const lost: LibraryAsset[] = [];
    for (const a of this.snapshot) if ((await fileStatus(a)) !== 'ok') lost.push(a);
    if (lost.length === 0) return [];
    const bySize = new Map<number, LibraryAsset[]>();
    for (const a of lost) bySize.set(a.sizeBytes, [...(bySize.get(a.sizeBytes) ?? []), a]);

    const found = new Map<string, string>(); // asset id -> new path
    const maxFiles = opts.maxFiles ?? 50_000;
    const maxDepth = opts.maxDepth ?? 12;
    let seen = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || seen >= maxFiles || found.size === lost.length) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable folder: skip
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        opts.signal?.throwIfAborted();
        if (seen >= maxFiles || found.size === lost.length) return;
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile()) {
          seen++;
          let size: number;
          try {
            size = (await lstat(p)).size;
          } catch {
            continue;
          }
          const candidates = bySize.get(size)?.filter((a) => !found.has(a.id));
          if (!candidates?.length) continue;
          let hash: string;
          try {
            hash = (await quickHashFile(p)).quickHash;
          } catch {
            continue;
          }
          const match = candidates.find((a) => a.quickHash === hash);
          if (match) found.set(match.id, p);
        }
      }
    };
    for (const root of roots) await walk(resolve(root), 0);
    if (found.size === 0) return [];

    const results: RelinkResult[] = [];
    await this.mutate((assets) =>
      assets.map((a) => {
        const to = found.get(a.id);
        if (!to || to === a.uri) return a;
        results.push({ assetId: a.id, from: a.uri, to });
        return { ...a, uri: to };
      }),
    );
    return results;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async read(): Promise<AssetLibrary> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: LIBRARY_SCHEMA_VERSION, assets: [] };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new LibraryOpenError(this.file, 'not valid JSON', { cause: err });
    }
    const parsed = AssetLibrary.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new LibraryOpenError(this.file, `${first?.path.join('.')}: ${first?.message}`);
    }
    return parsed.data;
  }

  /** `fn` returns the new asset list, or null for no change. */
  private async mutate(
    fn: (assets: LibraryAsset[]) => LibraryAsset[] | null | Promise<LibraryAsset[] | null>,
  ): Promise<void> {
    const lock = await this.lock();
    try {
      const current = await this.read();
      const next = await fn(current.assets);
      if (next) {
        const lib = AssetLibrary.parse({ schemaVersion: LIBRARY_SCHEMA_VERSION, assets: next });
        await writeFileAtomic(this.file, `${JSON.stringify(lib, null, 2)}\n`);
        this.snapshot = lib.assets;
      } else this.snapshot = current.assets;
    } finally {
      await lock.release();
    }
  }

  private async lock(): Promise<Lock> {
    const deadline = Date.now() + (this.opts.lockTimeoutMs ?? 5000);
    for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
      try {
        return await acquireLock(this.lockFile);
      } catch (err) {
        if (!(err instanceof ProjectLockedError)) throw err;
        if (Date.now() >= deadline) {
          throw new Error(`asset library is busy (pid ${err.holder.pid} holds ${this.lockFile})`, {
            cause: err,
          });
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

async function fileStatus(asset: LibraryAsset): Promise<AssetFileStatus> {
  try {
    const st = await stat(asset.uri);
    return st.isFile() && st.size === asset.sizeBytes ? 'ok' : 'changed';
  } catch {
    return 'missing';
  }
}
