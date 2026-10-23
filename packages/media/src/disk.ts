import { statfs } from 'node:fs/promises';
import { MediaError } from './errors.js';

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * Fail fast before a long encode instead of dying at 95%. `marginBytes` keeps headroom for
 * the OS and other writers.
 */
export async function ensureFreeSpace(
  dir: string,
  neededBytes: number,
  marginBytes = 512 * 1024 ** 2,
): Promise<void> {
  const free = await freeBytes(dir);
  if (free < neededBytes + marginBytes) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new MediaError(
      'out-of-disk',
      `Need ~${gb(neededBytes + marginBytes)} GB free in ${dir}, only ${gb(free)} GB available`,
    );
  }
}
