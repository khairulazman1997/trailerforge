import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, rename, rm, truncate } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const TMP_MARKER = '.tmp-';

/**
 * Crash-safe file replace: write a sibling temp file, fsync it, rename over the target, fsync
 * the directory. Readers see either the old or the new content, never a torn write.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}${TMP_MARKER}${process.pid}-${randomBytes(4).toString('hex')}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameRetrying(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dirname(path));
}

/** Waits (ms) between rename attempts: about 1.5 s in all before giving up. */
const RENAME_BACKOFF = [10, 20, 40, 80, 160, 320, 400, 400] as const;
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * On Windows, renaming over a file fails with EPERM/EBUSY/EACCES while another handle has it
 * open without delete sharing (a reader in this or another process, a virus scanner, the
 * search indexer). That lasts milliseconds, so retry with a short backoff. Elsewhere these
 * errors are real (permissions), so they are thrown at once. The temp file stays in place
 * between attempts, so a crash still leaves either the old target or the new one.
 */
export async function renameRetrying(
  from: string,
  to: string,
  opts: {
    rename?: (from: string, to: string) => Promise<void>;
    platform?: NodeJS.Platform;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const doRename = opts.rename ?? rename;
  const platform = opts.platform ?? process.platform;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = platform === 'win32' && code !== undefined && TRANSIENT_RENAME.has(code);
      const wait = RENAME_BACKOFF[attempt];
      if (!transient || wait === undefined) throw err;
      await sleep(wait);
    }
  }
}

/** Append and fsync. A crash may leave a torn last line; readers must tolerate that. */
export async function appendDurable(path: string, data: string): Promise<void> {
  const fh = await open(path, 'a');
  try {
    await fh.appendFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // Directories can't be opened/fsynced on Windows; rename is already durable there.
  } finally {
    await fh?.close();
  }
}

/** Remove temp files left by a crash mid-write of `path`. Returns how many were removed. */
export async function cleanupTempFiles(path: string): Promise<number> {
  const dir = dirname(path);
  const prefix = basename(path) + TMP_MARKER;
  const stale = (await readdir(dir)).filter((name) => name.startsWith(prefix));
  await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
  return stale.length;
}

/**
 * Drop a partial last line left by a crash mid-append, so the next append starts on a fresh
 * line instead of being glued onto the torn one. Returns true if anything was removed.
 */
export async function truncateTornTail(path: string): Promise<boolean> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    return false;
  }
  if (data.length === 0 || data[data.length - 1] === 0x0a) return false;
  await truncate(path, data.lastIndexOf(0x0a) + 1);
  return true;
}
