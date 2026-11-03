import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EffectCraftRenderer,
  PROJECT_TEMPLATE_ID,
  cachedMotionFrames,
  canonicalJson,
  motionContentHash,
} from './index.js';

const STUB = fileURLToPath(new URL('./__fixtures__/stub-cli.mjs', import.meta.url));
const renderer = (mode = 'ok', workRoot: string) =>
  new EffectCraftRenderer({ cli: { bin: process.execPath, prefixArgs: [STUB, mode] }, workRoot });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tf-ecc-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base = {
  version: '0.9.2',
  templateId: PROJECT_TEMPLATE_ID,
  sourceSha256: 'a'.repeat(64),
  params: { comp: 'T', extra: { b: 1, a: 2 } },
  resolution: { width: 64, height: 36 },
  frameRate: { num: 30, den: 1 },
  duration: FLICKS_PER_SECOND,
};

async function project(path: string, name = 'T') {
  await writeFile(
    path,
    JSON.stringify({
      savedBy: '0.9.2',
      schema: 2,
      comps: [{ name, width: 64, height: 36, frameRate: 30, duration: 2 }],
      log: [],
    }),
  );
}

describe('motionContentHash', () => {
  it('changes only with what is drawn or the EffectCraft version', () => {
    const h = motionContentHash(base);
    expect(motionContentHash({ ...base, params: { extra: { a: 2, b: 1 }, comp: 'T' } })).toBe(h);
    for (const change of [
      { version: '0.9.3' },
      { sourceSha256: 'b'.repeat(64) },
      { params: { comp: 'U' } },
      { resolution: { width: 36, height: 64 } },
      { frameRate: { num: 24, den: 1 } },
      { duration: 2 * FLICKS_PER_SECOND },
    ])
      expect(motionContentHash({ ...base, ...change })).not.toBe(h);
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: undefined })).toBe('{"b":[1,{"c":2,"d":1}]}');
  });

  it('a project counts by its bytes, not its path', async () => {
    const r = renderer('ok', join(root, 'work'));
    const a = join(root, 'a.ecproj');
    const b = join(root, 'moved', 'b.ecproj');
    await project(a);
    await mkdir(join(root, 'moved'));
    await copyFile(a, b);
    const job = (p: string) => ({
      templateId: PROJECT_TEMPLATE_ID,
      params: { project: p, comp: 'T' },
      duration: FLICKS_PER_SECOND,
      resolution: { width: 64, height: 36 },
      frameRate: { num: 30, den: 1 },
    });
    expect(await r.fingerprint(job(a))).toBe(await r.fingerprint(job(b)));
    await project(b, 'Other');
    expect(await r.fingerprint(job(b))).not.toBe(await r.fingerprint(job(a)));
  });
});

describe('cachedMotionFrames', () => {
  it('renders once, then serves the cache; a drifting re-render is flagged for good', async () => {
    const file = join(root, 'p.ecproj');
    await project(file);
    const job = {
      templateId: PROJECT_TEMPLATE_ID,
      params: { project: file, comp: 'T' },
      duration: FLICKS_PER_SECOND / 2,
      resolution: { width: 64, height: 36 },
      frameRate: { num: 30, den: 1 },
    };
    const cacheRoot = join(root, 'frames');
    const signal = new AbortController().signal;
    let renders = 0;
    const counted = (r: EffectCraftRenderer) =>
      Object.assign(Object.create(r) as EffectCraftRenderer, {
        render: (...a: Parameters<EffectCraftRenderer['render']>) => (renders++, r.render(...a)),
      });
    const ok = counted(renderer('ok', join(root, 'work')));
    const first = await cachedMotionFrames(ok, job, { cacheRoot, signal });
    expect(first).toMatchObject({ cached: false, reproducible: true, frames: 15, warnings: [] });
    expect(first.dir).toBe(join(cacheRoot, first.contentHash.slice(0, 24)));
    const second = await cachedMotionFrames(ok, job, { cacheRoot, signal });
    expect(second).toMatchObject({ cached: true, reproducible: true, frames: 15 });
    expect(renders).toBe(1);

    // The cache is cleared and the same input draws something else: not reproducible.
    await rm(first.dir, { recursive: true });
    const drift = counted(renderer('drift', join(root, 'work')));
    const third = await cachedMotionFrames(drift, job, {
      cacheRoot,
      signal,
      contentHash: first.contentHash,
    });
    expect(third).toMatchObject({ cached: false, reproducible: false });
    expect(third.warnings.join()).toMatch(/different frames for the same input/);
    const fourth = await cachedMotionFrames(ok, job, { cacheRoot, signal });
    expect(fourth).toMatchObject({ cached: true, reproducible: false });

    // A clean re-render of the same bytes stays reproducible.
    const other = join(root, 'frames2');
    const a = await cachedMotionFrames(ok, job, { cacheRoot: other, signal });
    await rm(a.dir, { recursive: true });
    expect(await cachedMotionFrames(ok, job, { cacheRoot: other, signal })).toMatchObject({
      cached: false,
      reproducible: true,
    });
  });
});
