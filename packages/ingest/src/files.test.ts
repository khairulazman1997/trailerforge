import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectMediaFiles, isStagingName } from './files.js';

let root: string;
const touch = async (rel: string) => {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, 'x');
  return p;
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-files-'));
});

// Windows allows file symlinks only with admin rights or Developer Mode; Linux CI covers the case.
const windowsWithoutSymlinks = (e: NodeJS.ErrnoException) => {
  if (process.platform !== 'win32' || e.code !== 'EPERM') throw e;
};

describe('collectMediaFiles', () => {
  it('walks folders for video and audio in a stable order, skipping the rest', async () => {
    const b = await touch('rec/b.mkv');
    const a = await touch('rec/a.mp4');
    const deep = await touch('rec/sub/deep/c.wav');
    await touch('rec/notes.txt');
    await touch('rec/logo.png');
    await touch('rec/clip.mp4.part');
    await touch('rec/.hidden/secret.mp4');
    await touch('rec/.dot.mp4');
    await symlink(a, join(root, 'rec', 'link.mp4')).catch(windowsWithoutSymlinks);
    const r = await collectMediaFiles([join(root, 'rec')]);
    expect(r.files).toEqual([a, b, deep]);
    expect(r.skipped).toEqual([]);
    expect(r.truncated).toBe(false);
    expect((await collectMediaFiles([join(root, 'rec')])).files).toEqual(r.files);
  });

  it('takes files named directly whatever their kind, and reports what it cannot use', async () => {
    const png = await touch('logo.png');
    const mp4 = await touch('a.mp4');
    const part = await touch('b.mp4.tmp');
    const txt = await touch('notes.txt');
    const r = await collectMediaFiles([png, mp4, mp4, part, txt, join(root, 'nope.mp4')]);
    expect(r.files).toEqual([png, mp4]);
    expect(r.skipped).toEqual([
      { path: part, reason: 'staging-file' },
      { path: txt, reason: 'unsupported' },
      { path: join(root, 'nope.mp4'), reason: 'not-found' },
    ]);
  });

  it('is bounded in count and depth, and abortable', async () => {
    for (let i = 0; i < 5; i++) await touch(`many/f${i}.mp4`);
    await touch('d0/d1/d2/deep.mp4');
    const capped = await collectMediaFiles([join(root, 'many')], { maxFiles: 3 });
    expect(capped.files).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect((await collectMediaFiles([join(root, 'd0')], { maxDepth: 1 })).files).toEqual([]);
    expect((await collectMediaFiles([join(root, 'd0')], { maxDepth: 2 })).files).toHaveLength(1);
    const ac = new AbortController();
    ac.abort();
    await expect(collectMediaFiles([join(root, 'many')], { signal: ac.signal })).rejects.toThrow();
  });

  it('recognises recorder temp names', () => {
    for (const n of ['a.part', 'a.MP4.tmp', 'a.crdownload', 'a.mp4~'])
      expect(isStagingName(n)).toBe(true);
    for (const n of ['a.mp4', 'tmp.mkv', 'part.wav']) expect(isStagingName(n)).toBe(false);
  });
});
