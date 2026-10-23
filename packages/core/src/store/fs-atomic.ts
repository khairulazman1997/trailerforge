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
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dirname(path));
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
