import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUICK_HASH_CHUNK, assetIdForHash, fullHashFile, quickHashFile } from './hash.js';
import { LibraryOpenError, LibraryStore, assetKindFromName } from './library-store.js';

let root: string;
let home: string;
let media: string;
const now = () => new Date('2026-10-24T10:00:00Z');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-lib-'));
  home = join(root, 'home');
  media = join(root, 'media');
  await mkdir(media, { recursive: true });
});

async function file(name: string, data: Buffer | string = randomBytes(1024)) {
  const p = join(media, name);
  await writeFile(p, data);
  return p;
}

describe('quick hash', () => {
  it('hashes small files whole and is stable', async () => {
    const data = Buffer.from('hello');
    const p = await file('a.wav', data);
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(5n);
    const expected = createHash('sha256').update(size).update(data).digest('hex');
    expect((await quickHashFile(p)).quickHash).toBe(expected);
    expect((await quickHashFile(p)).sizeBytes).toBe(5);
  });

  it('reads only the ends of large files', async () => {
    const big = randomBytes(2 * QUICK_HASH_CHUNK + 1000);
    const a = await file('a.mp4', big);
    const changedMiddle = Buffer.from(big);
    changedMiddle.writeUInt8(
      changedMiddle.readUInt8(QUICK_HASH_CHUNK + 500) ^ 0xff,
      QUICK_HASH_CHUNK + 500,
    );
    const b = await file('b.mp4', changedMiddle);
    const changedEnd = Buffer.from(big);
    changedEnd.writeUInt8(
      changedEnd.readUInt8(changedEnd.length - 1) ^ 0xff,
      changedEnd.length - 1,
    );
    const c = await file('c.mp4', changedEnd);
    const [ha, hb, hc] = await Promise.all(
      [a, b, c].map(async (p) => (await quickHashFile(p)).quickHash),
    );
    expect(ha).toBe(hb); // middle is not read; the full hash tells them apart
    expect(ha).not.toBe(hc);
    expect(await fullHashFile(a)).not.toBe(await fullHashFile(b));
    expect(await fullHashFile(a)).toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('full hash honours abort', async () => {
    const p = await file('x.mp4', randomBytes(4096));
    const ac = new AbortController();
    ac.abort();
    await expect(fullHashFile(p, { signal: ac.signal })).rejects.toThrow();
  });
});

describe('LibraryStore', () => {
  it('imports by reference, dedupes by content and persists', async () => {
    const lib = await LibraryStore.open(home, { now });
    const data = randomBytes(2048);
    const p = await file('Shot B2-03.mp4', data);
    const first = await lib.importFile(p);
    expect(first.created).toBe(true);
    expect(first.asset).toMatchObject({
      kind: 'video',
      uri: p,
      sizeBytes: 2048,
      originalName: 'Shot B2-03.mp4',
      addedAt: '2026-10-24T10:00:00.000Z',
    });
    expect(first.asset.id).toBe(assetIdForHash(first.asset.quickHash));
    expect(first.asset.contentHash).toBeUndefined();

    const copy = await file('copy.mp4', data);
    const second = await lib.importFile(copy);
    expect(second).toMatchObject({ created: false, relinked: false });
    expect(second.asset.uri).toBe(p); // original still there: keep it

    const reopened = await LibraryStore.open(home);
    expect(reopened.list().map((a) => a.id)).toEqual([first.asset.id]);
  });

  it('relinks on import when the known file is gone', async () => {
    const lib = await LibraryStore.open(home);
    const data = randomBytes(1500);
    const p = await file('a.mp4', data);
    const { asset } = await lib.importFile(p);
    await rm(p);
    expect(await lib.status(asset.id)).toBe('missing');
    const moved = await file('renamed.mp4', data);
    const again = await lib.importFile(moved);
    expect(again).toMatchObject({ created: false, relinked: true });
    expect(lib.get(asset.id)?.uri).toBe(moved);
    expect(await lib.status(asset.id)).toBe('ok');
  });

  it('relinks moved and renamed files by size and hash, skipping symlinks and dot-folders', async () => {
    const lib = await LibraryStore.open(home);
    const a = await lib.importFile(await file('a.mp4', randomBytes(3000)));
    const b = await lib.importFile(await file('b.wav', randomBytes(3000)));
    const c = await lib.importFile(await file('c.png', randomBytes(10)));
    const elsewhere = join(root, 'elsewhere', 'deep');
    await mkdir(elsewhere, { recursive: true });
    await rename(a.asset.uri, join(elsewhere, 'take1.mp4'));
    await mkdir(join(root, 'elsewhere', '.hidden'));
    await rename(b.asset.uri, join(root, 'elsewhere', '.hidden', 'b.wav'));
    await writeFile(join(elsewhere, 'decoy.mp4'), randomBytes(3000)); // same size, other content
    await symlink(c.asset.uri, join(elsewhere, 'link.png'));

    const results = await lib.relink([join(root, 'elsewhere')]);
    expect(results).toEqual([
      { assetId: a.asset.id, from: a.asset.uri, to: join(elsewhere, 'take1.mp4') },
    ]);
    expect(await lib.status(a.asset.id)).toBe('ok');
    expect(await lib.status(b.asset.id)).toBe('missing');
    expect(await lib.status(c.asset.id)).toBe('ok');
    expect(await lib.relink([join(root, 'elsewhere')])).toEqual([]);
  });

  it('reports a changed file (size differs) and relink honours abort', async () => {
    const lib = await LibraryStore.open(home);
    const { asset } = await lib.importFile(await file('a.mp4', randomBytes(100)));
    await writeFile(asset.uri, randomBytes(200));
    expect(await lib.status(asset.id)).toBe('changed');
    const ac = new AbortController();
    ac.abort();
    await expect(lib.relink([media], { signal: ac.signal })).rejects.toThrow();
  });

  it('updates entries but never their identity', async () => {
    const lib = await LibraryStore.open(home);
    const { asset } = await lib.importFile(await file('a.mp4'));
    const full = await fullHashFile(asset.uri);
    const updated = await lib.update(asset.id, (a) => ({
      ...a,
      contentHash: full,
      tags: ['boss'],
    }));
    expect(updated).toMatchObject({ contentHash: full, tags: ['boss'] });
    await expect(lib.update(asset.id, (a) => ({ ...a, id: 'asset_other' }))).rejects.toThrow(
      /cannot change/,
    );
    await expect(lib.update('nope', (a) => a)).rejects.toThrow(/unknown/);
    expect(await lib.remove(asset.id)).toBe(true);
    expect(await lib.remove(asset.id)).toBe(false);
    expect(lib.list()).toEqual([]);
  });

  it('two stores on one home keep each other’s writes', async () => {
    const one = await LibraryStore.open(home);
    const two = await LibraryStore.open(home);
    await Promise.all([
      one.importFile(await file('1.mp4')),
      two.importFile(await file('2.mp4')),
      one.importFile(await file('3.mp4')),
      two.importFile(await file('4.mp4')),
    ]);
    await one.reload();
    expect(one.list()).toHaveLength(4);
  });

  it('refuses an unreadable library and leaves it untouched', async () => {
    await mkdir(join(home, 'library'), { recursive: true });
    const path = join(home, 'library', 'library.json');
    await writeFile(path, '{"schemaVersion": 1, "assets": [{"id": 1}]}');
    await expect(LibraryStore.open(home)).rejects.toBeInstanceOf(LibraryOpenError);
    await writeFile(path, 'not json');
    await expect(LibraryStore.open(home)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, 'utf8')).toBe('not json');
  });

  it('detects kinds from file names', () => {
    expect(assetKindFromName('X.MKV')).toBe('video');
    expect(assetKindFromName('song.flac')).toBe('audio');
    expect(assetKindFromName('logo.svg')).toBe('svg');
    expect(assetKindFromName('notes.txt')).toBe('other');
  });
});
