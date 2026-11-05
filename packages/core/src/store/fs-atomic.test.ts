import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renameRetrying, writeFileAtomic } from './fs-atomic.js';

const errno = (code: string) => Object.assign(new Error(code), { code });

function flaky(failures: string[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    rename: async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      const code = failures.shift();
      if (code) throw errno(code);
    },
    sleep: async (ms: number) => void waits.push(ms),
  };
}

describe('renameRetrying', () => {
  it('rides out a Windows sharing violation', async () => {
    const f = flaky(['EPERM', 'EBUSY', 'EACCES']);
    await renameRetrying('a', 'b', { ...f, platform: 'win32' });
    expect(f.calls).toHaveLength(4);
    expect(f.waits).toEqual([10, 20, 40]);
  });

  it('gives up after about 1.5 s and throws the last error', async () => {
    const f = flaky(Array(20).fill('EPERM'));
    await expect(renameRetrying('a', 'b', { ...f, platform: 'win32' })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(f.calls).toHaveLength(9);
    expect(f.waits.reduce((s, w) => s + w, 0)).toBe(1430);
  });

  it('throws other errors, and these errors off Windows, at once', async () => {
    const enoent = flaky(['ENOENT']);
    await expect(renameRetrying('a', 'b', { ...enoent, platform: 'win32' })).rejects.toMatchObject({ code: 'ENOENT' }); // prettier-ignore
    const posix = flaky(['EACCES']);
    await expect(renameRetrying('a', 'b', { ...posix, platform: 'linux' })).rejects.toMatchObject({ code: 'EACCES' }); // prettier-ignore
    expect([enoent.calls.length, posix.calls.length]).toEqual([1, 1]);
  });
});

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-atomic-'));
    const file = join(dir, 'library.json');
    await writeFileAtomic(file, 'one');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, `v${i}`)));
    expect(await readFile(file, 'utf8')).toMatch(/^v\d+$/);
    expect(await readdir(dir)).toEqual(['library.json']);
  });
});
