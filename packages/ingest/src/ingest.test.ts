import { spawn } from 'node:child_process';
import { appendFile, copyFile, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LibraryStore } from '@trailerforge/core';
import { JobQueue, type JobRecord } from '@trailerforge/jobs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetCachePaths } from './cache-paths.js';
import { Ingestor } from './ingestor.js';
import {
  FULL_HASH_JOB,
  IMPORT_JOB,
  PREVIEWS_JOB,
  registerIngestJobs,
  type ImportOutput,
} from './jobs.js';
import { clip } from './test-media.js';

let home: string;
let library: LibraryStore;
let queue: JobQueue;
let ingestor: Ingestor;
const open: JobQueue[] = [];

const makeQueue = (h = home) => {
  const q = new JobQueue({
    dbPath: join(h, 'jobs.sqlite'),
    tempRoot: join(h, 'tmp'),
    progressThrottleMs: 0,
  });
  open.push(q);
  return q;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-ingest-'));
  library = await LibraryStore.open(home);
  queue = makeQueue();
  registerIngestJobs({ library, queue, home, growthCheckMs: 30, retryDelayMs: 40 });
  ingestor = new Ingestor({ queue });
  queue.start();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((q) => q.close()));
});

async function until(q: JobQueue, done: (q: JobQueue) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!done(q)) {
    if (Date.now() > end)
      throw new Error(
        `timed out; jobs: ${JSON.stringify(q.list().map((j) => [j.type, j.status, j.attempts, j.runAfter - Date.now(), j.error]))}`,
      );
    await new Promise((r) => setTimeout(r, 25));
  }
}
const idle = (q: JobQueue) =>
  q.list().every((j) => j.status !== 'queued' && j.status !== 'running');
const finished = async (q: JobQueue, id: string): Promise<JobRecord> => {
  await until(q, (x) => !['queued', 'running'].includes(x.get(id)?.status ?? 'queued'));
  return q.get(id)!;
};
async function importOne(path: string, projectId?: string) {
  const { jobs } = await ingestor.importPaths([path], projectId ? { projectId } : {});
  return finished(queue, jobs[0]!.jobId);
}

describe('footage import', () => {
  it('registers a recording, probes it, and builds previews and the full hash in the background', async () => {
    const job = await importOne(clip('a'), 'proj_1');
    expect(job.status).toBe('succeeded');
    const out = job.output as ImportOutput;
    expect(out).toMatchObject({ kind: 'video', created: true, relinked: false });
    expect(out.warnings.map((w) => w.code)).toEqual(['low-resolution']); // the test clip is 320×180
    const asset = library.get(out.assetId)!;
    expect(asset.uri).toBe(clip('a'));
    expect(asset.media?.video[0]?.height).toBe(180);

    await until(queue, idle);
    await library.reload();
    const paths = assetCachePaths(home, asset.quickHash);
    for (const p of [paths.thumbnail, paths.filmstrip, paths.proxy])
      expect(existsSync(p)).toBe(true);
    expect((await readdir(paths.dir)).sort()).toEqual(['filmstrip.jpg', 'proxy.mp4', 'thumb.jpg']);
    expect(library.get(asset.id)?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const types = queue
      .list()
      .map((j) => j.type)
      .sort();
    expect(types).toEqual([FULL_HASH_JOB, IMPORT_JOB, PREVIEWS_JOB].sort());
    expect(queue.list().every((j) => j.projectId === 'proj_1')).toBe(true);
  }, 60_000);

  it('does not import the same recording twice, however it is named or where it is', async () => {
    const first = (await importOne(clip('dup'))).output as ImportOutput;
    await until(queue, idle);
    const copy = join(home, 'Copy of dup.mp4');
    await new Promise<void>((res, rej) => copyFile(clip('dup'), copy, (e) => (e ? rej(e) : res())));
    const second = (await importOne(copy)).output as ImportOutput;
    expect(second).toMatchObject({ assetId: first.assetId, created: false });
    await until(queue, idle);
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]?.uri).toBe(clip('dup')); // original still there: keep pointing at it
    expect(
      queue.list().filter((j) => j.type === PREVIEWS_JOB && j.status === 'succeeded'),
    ).toHaveLength(2);
    const made = queue
      .list()
      .filter((j) => j.type === PREVIEWS_JOB)
      .map((j) => j.output);
    expect(made[1]).toEqual({ thumbnail: false, filmstrip: false, proxy: false }); // nothing redone
  }, 60_000);

  it('warns about variable frame rate', async () => {
    const out = (await importOne(clip('vfr', { vfr: true }))).output as ImportOutput;
    expect(out.warnings.map((w) => w.code)).toContain('variable-frame-rate');
  }, 60_000);

  it('refuses a file that is not media and leaves nothing in the library', async () => {
    const bad = join(home, 'garbage.mp4');
    await writeFile(bad, 'this is not a video '.repeat(100));
    const job = await importOne(bad);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('corrupt-file');
    expect(library.list()).toEqual([]);
    const gone = await ingestor.importPaths([join(home, 'gone.mp4')]);
    expect(gone.jobs).toEqual([]);
    expect(gone.skipped).toEqual([{ path: join(home, 'gone.mp4'), reason: 'not-found' }]);
  });

  it('imports a folder: media only, one job per file, a second drop joins the first', async () => {
    const dir = join(home, 'drop');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await copyAs(clip('f1'), join(dir, 'one.mp4'));
    await copyAs(clip('f2'), join(dir, 'nested', 'two.mp4'));
    await writeFile(join(dir, 'notes.txt'), 'x');
    await writeFile(join(dir, 'three.mp4.part'), 'x');
    const r = await ingestor.importPaths([dir]);
    expect(r.jobs.map((j) => j.path)).toEqual([
      join(dir, 'nested', 'two.mp4'),
      join(dir, 'one.mp4'),
    ]);
    const again = await ingestor.importPaths([dir]);
    expect(again.jobs.map((j) => j.jobId)).toEqual(r.jobs.map((j) => j.jobId));
    await until(queue, idle);
    expect(library.list()).toHaveLength(2);
  }, 60_000);

  it('retries a file that is still being written, and imports it once it stops', async () => {
    const live = join(home, 'live.mp4');
    await copyAs(clip('live'), live);
    let n = 0;
    const timer = setInterval(() => {
      if (n++ < 6) appendFile(live, Buffer.alloc(1), () => undefined);
    }, 15);
    const job = await importOne(live);
    clearInterval(timer);
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBeGreaterThan(1);
  }, 60_000);

  it('gives up on a recording that never stops growing, with a clear reason', async () => {
    const live = join(home, 'forever.mp4');
    await copyAs(clip('forever'), live);
    const timer = setInterval(() => appendFile(live, Buffer.alloc(1), () => undefined), 5);
    const job = await importOne(live);
    clearInterval(timer);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'file-still-growing' } });
    expect(library.list()).toEqual([]);
  }, 60_000);

  it('cancelling an import leaves no library entry and no scratch files', async () => {
    const q = makeQueue(await mkdtemp(join(tmpdir(), 'tforge-ingest-c-')));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lib = await LibraryStore.open(home);
    registerIngestJobs({ library: lib, queue: q, home, growthCheckMs: 20, onStage: () => held });
    q.start();
    const { jobs } = await new Ingestor({ queue: q }).importPaths([clip('cancelled')]);
    await until(q, (x) => x.get(jobs[0]!.jobId)?.status === 'running');
    const cancelled = q.cancel(jobs[0]!.jobId);
    release(); // the held stage ignores the abort, as a slow step would, until released
    expect(await cancelled).toBe(true);
    expect(q.get(jobs[0]!.jobId)?.status).toBe('cancelled');
    await lib.reload();
    expect(lib.list()).toEqual([]);
  });

  it('the watched folder queues an import for each finished recording', async () => {
    const folder = join(home, 'obs');
    await mkdir(folder);
    const w = ingestor.watch({ folders: [folder], stableChecks: 2, projectId: 'proj_w' });
    await w.poll();
    await copyAs(clip('watched'), join(folder, 'TF-ABCDE take1.mp4'));
    for (let i = 0; i < 4; i++) await w.poll();
    await until(queue, idle);
    const imports = queue.list().filter((j) => j.type === IMPORT_JOB);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ status: 'succeeded', projectId: 'proj_w' });
    expect(library.list().map((a) => a.originalName)).toEqual(['TF-ABCDE take1.mp4']);
  }, 60_000);
});

const copyAs = (from: string, to: string) =>
  new Promise<void>((res, rej) => copyFile(from, to, (e) => (e ? rej(e) : res())));

describe('crash recovery', () => {
  it('a process killed mid-import resumes on restart without duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-ingest-k-'));
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const source = clip('killed');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsx, join(here, 'crash-child.ts'), dir, source],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('registered')) child.kill('SIGKILL');
      });
      child.on('exit', (_c, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(err))));
    });

    const lib = await LibraryStore.open(dir);
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0]?.media).toBeUndefined(); // died before probing
    const q = makeQueue(dir);
    expect(q.list().map((j) => j.status)).toEqual(['running']); // left behind by the dead process
    registerIngestJobs({ library: lib, queue: q, home: dir, growthCheckMs: 20 });
    q.start();
    await until(q, idle);

    await lib.reload();
    expect(lib.list()).toHaveLength(1);
    const asset = lib.list()[0]!;
    expect(asset.media?.duration).toBeGreaterThan(1);
    expect(asset.contentHash).toBeDefined();
    const paths = assetCachePaths(dir, asset.quickHash);
    expect((await readdir(paths.dir)).sort()).toEqual(['filmstrip.jpg', 'proxy.mp4', 'thumb.jpg']);
    expect(
      q
        .list()
        .filter((j) => j.type === IMPORT_JOB)
        .map((j) => j.status),
    ).toEqual(['succeeded']);
  }, 90_000);
});
