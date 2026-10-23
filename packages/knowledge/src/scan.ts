import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import { isSecretPath, SECRET_DIRS } from './secrets.js';

/** Read-only file access used by the scanner; tests wrap it to record every path opened. */
export interface RepoFs {
  readdir(
    path: string,
  ): Promise<
    { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]
  >;
  lstat(path: string): Promise<{ size: number; mtimeMs: number }>;
  readFile(path: string): Promise<Buffer>;
  /** Read up to `bytes` from the start of the file. */
  readHead(path: string, bytes: number): Promise<Buffer>;
}

export const nodeRepoFs: RepoFs = {
  readdir: (p) => readdir(p, { withFileTypes: true }),
  lstat: (p) => lstat(p),
  readFile: (p) => readFile(p),
  async readHead(p, bytes) {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
};

/** Per-file record kept between scans so unchanged files aren't read again. */
export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}
export type ScanManifest = Record<string, ManifestEntry>;

export type SkipReason =
  | 'gitignored'
  | 'excluded'
  | 'not-included'
  | 'secret'
  | 'too-large'
  | 'binary'
  | 'lfs-pointer'
  | 'symlink'
  | 'unreadable';

export interface ScanOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  /** Files larger than this are skipped without being opened. Default 1 MiB. */
  maxFileBytes?: number;
  /** Stop after this many accepted files. Default 20 000. */
  maxFiles?: number;
  /** Manifest from the previous scan; unchanged size+mtime reuses the stored hash. */
  previous?: ScanManifest;
  fs?: RepoFs;
  signal?: AbortSignal;
}

export interface ScanResult {
  root: string;
  /** Accepted text files, repo-relative POSIX paths, sorted. */
  files: string[];
  manifest: ScanManifest;
  /** Accepted files that are new or changed since `previous`. */
  changed: string[];
  /** Paths in `previous` that are no longer accepted. */
  removed: string[];
  skipped: { path: string; reason: SkipReason }[];
  /** sha256 over the sorted (path, hash) list; equal digests mean nothing changed. */
  digestHash: string;
  truncated: boolean;
}

/** Always skipped: VCS internals and Unity/engine build output that .gitignore usually covers. */
const ALWAYS_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'Library',
  'Temp',
  'Obj',
  'Logs',
]);

/** Known binary formats, skipped by name so they're never opened. */
const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif bmp tga tif tiff psd psb exr hdr dds ktx webp ico icns svgz ' +
    'wav mp3 ogg flac aiff aif m4a wma bank fsb ' +
    'mp4 mov avi mkv webm m4v ' +
    'fbx obj blend max ma mb 3ds dae glb gltf abc usd usdz ' +
    'ttf otf woff woff2 ' +
    'zip 7z rar gz tgz bz2 xz tar unitypackage pak ' +
    'dll exe so dylib a lib pdb bin dat db sqlite ' +
    'pdf doc docx xls xlsx ppt pptx'
  ).split(' '),
);

const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';
const SNIFF_BYTES = 8000;

interface IgnoreScope {
  base: string; // repo-relative dir ('' for root)
  ig: Ignore;
}

/**
 * Walk a local repo read-only and return the text files extractors may read. Order of checks:
 * VCS/build dirs → secrets (by path) → .gitignore → exclude/include globs → size → binary
 * extension → content sniff (NUL byte, LFS pointer). Secret files are never opened; neither is
 * anything over the size cap or with a binary extension. Symlinks are never followed.
 */
export async function scanRepo(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const fs = opts.fs ?? nodeRepoFs;
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 20_000;
  const include = opts.include ?? [];
  const exclude = opts.exclude ?? [];
  const glob = (path: string, patterns: readonly string[]) =>
    patterns.some((p) => minimatch(path, p, { dot: true }));
  const previous = opts.previous ?? {};

  const files: string[] = [];
  const manifest: ScanManifest = {};
  const changed: string[] = [];
  const skipped: ScanResult['skipped'] = [];
  let truncated = false;

  const ignoredBy = (scopes: IgnoreScope[], rel: string, isDir: boolean) =>
    scopes.some(({ base, ig }) => {
      const sub = base ? posix.relative(base, rel) : rel;
      return sub !== '' && !sub.startsWith('..') && ig.ignores(isDir ? `${sub}/` : sub);
    });

  async function loadGitignore(dirRel: string): Promise<IgnoreScope | null> {
    const rel = dirRel ? `${dirRel}/.gitignore` : '.gitignore';
    try {
      const text = (await fs.readFile(join(root, rel))).toString('utf8');
      return { base: dirRel, ig: ignore().add(text) };
    } catch {
      return null;
    }
  }

  async function walk(dirRel: string, scopes: IgnoreScope[]): Promise<void> {
    opts.signal?.throwIfAborted();
    const own = await loadGitignore(dirRel);
    const active = own ? [...scopes, own] : scopes;
    const entries = await fs.readdir(dirRel ? join(root, dirRel) : root);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated) return;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink' });
        continue;
      }
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name)) continue;
        if (SECRET_DIRS.has(e.name.toLowerCase())) {
          skipped.push({ path: `${rel}/`, reason: 'secret' });
          continue;
        }
        if (ignoredBy(active, rel, true)) {
          skipped.push({ path: `${rel}/`, reason: 'gitignored' });
          continue;
        }
        if (glob(rel, exclude) || glob(`${rel}/`, exclude)) {
          skipped.push({ path: `${rel}/`, reason: 'excluded' });
          continue;
        }
        await walk(rel, active);
        continue;
      }
      if (!e.isFile()) continue;
      const reason = await consider(rel, active);
      if (reason) skipped.push({ path: rel, reason });
    }
  }

  async function consider(rel: string, scopes: IgnoreScope[]): Promise<SkipReason | null> {
    // Secrets first, by path only: nothing below this line may run for them.
    if (isSecretPath(rel)) return 'secret';
    if (rel === '.gitignore' || rel.endsWith('/.gitignore')) return 'excluded';
    if (ignoredBy(scopes, rel, false)) return 'gitignored';
    if (glob(rel, exclude)) return 'excluded';
    if (include.length > 0 && !glob(rel, include)) return 'not-included';
    const ext = posix.extname(rel).slice(1).toLowerCase();
    if (BINARY_EXT.has(ext)) return 'binary';

    const abs = join(root, rel);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return 'unreadable';
    }
    if (st.size > maxBytes) return 'too-large';

    const prev = previous[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      manifest[rel] = prev;
    } else {
      let head: Buffer;
      try {
        head = await fs.readHead(abs, SNIFF_BYTES);
      } catch {
        return 'unreadable';
      }
      if (head.toString('latin1').startsWith(LFS_HEADER)) return 'lfs-pointer';
      if (head.includes(0)) return 'binary';
      let body: Buffer;
      try {
        body = st.size <= SNIFF_BYTES ? head : await fs.readFile(abs);
      } catch {
        return 'unreadable';
      }
      const hash = createHash('sha256').update(body).digest('hex');
      manifest[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
      if (prev?.hash !== hash) changed.push(rel);
    }
    files.push(rel);
    if (files.length >= maxFiles) truncated = true;
    return null;
  }

  await walk('', []);
  files.sort();
  changed.sort();
  const removed = Object.keys(previous)
    .filter((p) => !(p in manifest))
    .sort();
  const digestHash = createHash('sha256')
    .update(files.map((f) => `${f}\0${manifest[f]!.hash}`).join('\n'))
    .digest('hex');
  return { root, files, manifest, changed, removed, skipped, digestHash, truncated };
}
