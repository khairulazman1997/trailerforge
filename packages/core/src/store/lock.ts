import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';

export class ProjectLockedError extends Error {
  constructor(
    readonly holder: { pid: number; host: string; at: string },
    path: string,
  ) {
    super(
      `project is open in another TrailerForge instance (pid ${holder.pid} on ${holder.host}): ${path}`,
    );
    this.name = 'ProjectLockedError';
  }
}

export interface Lock {
  release(): Promise<void>;
}

/**
 * Exclusive lock file. A lock left by a crashed process on this machine is detected (its pid is
 * gone) and taken over; locks from other hosts are always respected.
 */
export async function acquireLock(path: string): Promise<Lock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }),
      );
      await fh.close();
      return { release: () => rm(path, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readHolder(path);
      if (holder && (holder.host !== hostname() || isAlive(holder.pid))) {
        throw new ProjectLockedError(holder, path);
      }
      await rm(path, { force: true }); // stale or unreadable lock
    }
  }
  throw new Error(`could not acquire lock: ${path}`);
}

async function readHolder(path: string) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as {
      pid: number;
      host: string;
      at: string;
    };
    return typeof data.pid === 'number' && typeof data.host === 'string' ? data : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
