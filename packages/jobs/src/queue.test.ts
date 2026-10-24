import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobQueue } from './queue.js';
import { stepJob } from './test-jobs.js';
import { defineJob, JobError, type JobEvent, type JobRecord } from './types.js';

let root: string;
const queues: JobQueue[] = [];

function makeQueue(concurrency = 2) {
  const q = new JobQueue({
    dbPath: join(root, 'jobs.sqlite'),
    tempRoot: join(root, 'tmp'),
    concurrency,
    progressThrottleMs: 0,
  });
  queues.push(q);
  return q;
}

/** Resolve when job `id` reaches one of `statuses`. */
function waitFor(q: JobQueue, id: string, ...statuses: JobRecord['status'][]): Promise<JobRecord> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const job = q.get(id);
      if (job && statuses.includes(job.status)) {
        off();
        clearTimeout(t);
        resolve(job);
      }
    };
    const off = q.subscribe(check);
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${statuses.join('/')}; status=${q.get(id)?.status}`));
    }, 10_000);
    check();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A job that waits on a gate the test controls, tracking concurrency. */
function gated(type: string, opts: { concurrency?: number } = {}) {
  let active = 0;
  const stats = { maxActive: 0, order: [] as string[] };
  const gates: (() => void)[] = [];
  const def = defineJob<{ name: string }, never, string>({
    type,
    input: z.strictObject({ name: z.string() }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: async (ctx) => {
      active++;
      stats.maxActive = Math.max(stats.maxActive, active);
      stats.order.push(ctx.input.name);
      await new Promise<void>((resolve, reject) => {
        gates.push(resolve);
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      active--;
      return ctx.input.name;
    },
  });
  const releaseAll = async () => {
    while (gates.length) gates.shift()!();
    await sleep(10);
  };
  return { def, stats, releaseAll, pending: () => gates.length };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-jobs-'));
});

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close().catch(() => undefined)));
});

describe('JobQueue basics', () => {
  it('runs a job to success, stores output and emits events in order', async () => {
    const q = makeQueue();
    q.register(stepJob);
    const kinds: string[] = [];
    q.subscribe((e: JobEvent) => kinds.push(e.kind));
    q.start();
    const id = q.enqueue(stepJob, { steps: 3, stepMs: 1 });
    const job = await waitFor(q, id, 'succeeded');
    expect(job.output).toEqual({ ranFrom: 0, attempt: 1 });
    expect(job.progress).toBe(1);
    expect(kinds[0]).toBe('queued');
    expect(kinds[1]).toBe('started');
    expect(kinds.at(-1)).toBe('succeeded');
    expect(kinds.filter((k) => k === 'progress')).toHaveLength(3);
  });

  it('validates input and job type at enqueue time', () => {
    const q = makeQueue();
    q.register(stepJob);
    expect(() => q.enqueue(stepJob, { steps: -1, stepMs: 0 })).toThrow(/invalid input/);
    expect(() => q.enqueue('test/nope', {})).toThrow(/unknown job type/);
  });

  it('does nothing until started', async () => {
    const q = makeQueue();
    q.register(stepJob);
    const id = q.enqueue(stepJob, { steps: 1, stepMs: 0 });
    await sleep(30);
    expect(q.get(id)?.status).toBe('queued');
  });

  it('deduplicates active jobs by key', async () => {
    const q = makeQueue();
    q.register(stepJob);
    const a = q.enqueue(stepJob, { steps: 1, stepMs: 0 }, { dedupeKey: 'proxy:abc' });
    const b = q.enqueue(stepJob, { steps: 1, stepMs: 0 }, { dedupeKey: 'proxy:abc' });
    expect(b).toBe(a);
    q.start();
    await waitFor(q, a, 'succeeded');
    const c = q.enqueue(stepJob, { steps: 1, stepMs: 0 }, { dedupeKey: 'proxy:abc' });
    expect(c).not.toBe(a);
  });
});

describe('scheduling', () => {
  it('respects global concurrency', async () => {
    const q = makeQueue(2);
    const g = gated('test/gated');
    q.register(g.def).start();
    const ids = ['a', 'b', 'c', 'd'].map((name) => q.enqueue(g.def, { name }));
    await sleep(20);
    expect(g.pending()).toBe(2);
    for (let i = 0; i < 3; i++) await g.releaseAll();
    await Promise.all(ids.map((id) => waitFor(q, id, 'succeeded')));
    expect(g.stats.maxActive).toBe(2);
  });

  it('respects per-type concurrency', async () => {
    const q = makeQueue(4);
    const g = gated('test/gpu', { concurrency: 1 });
    q.register(g.def).start();
    const ids = ['a', 'b', 'c'].map((name) => q.enqueue(g.def, { name }));
    await sleep(20);
    expect(g.pending()).toBe(1);
    for (let i = 0; i < 4; i++) await g.releaseAll();
    await Promise.all(ids.map((id) => waitFor(q, id, 'succeeded')));
    expect(g.stats.maxActive).toBe(1);
  });

  it('runs higher priority first, then oldest first', async () => {
    const q = makeQueue(1);
    const g = gated('test/prio');
    q.register(g.def);
    const ids = [
      q.enqueue(g.def, { name: 'low-1' }),
      q.enqueue(g.def, { name: 'high' }, { priority: 10 }),
      q.enqueue(g.def, { name: 'low-2' }),
    ];
    q.start();
    for (let i = 0; i < 4; i++) await g.releaseAll();
    await Promise.all(ids.map((id) => waitFor(q, id, 'succeeded')));
    expect(g.stats.order).toEqual(['high', 'low-1', 'low-2']);
  });
});

describe('failures and retries', () => {
  it('retries with backoff, then succeeds', async () => {
    const q = makeQueue();
    let calls = 0;
    const flaky = defineJob<object, never, number>({
      type: 'test/flaky',
      input: z.strictObject({}),
      backoffMs: () => 20,
      run: async () => {
        calls++;
        if (calls < 3) throw new Error(`boom ${calls}`);
        return calls;
      },
    });
    const kinds: string[] = [];
    q.subscribe((e) => kinds.push(e.kind));
    q.register(flaky).start();
    const id = q.enqueue(flaky, {});
    const job = await waitFor(q, id, 'succeeded');
    expect(job.output).toBe(3);
    expect(job.attempts).toBe(3);
    expect(kinds.filter((k) => k === 'retrying')).toHaveLength(2);
  });

  it('never loses a retry whose time comes while the clock ticks (no stuck queued jobs)', async () => {
    // A clock that moves on every reading, as a real one does between two calls in a row.
    let t = 1_000_000;
    const q = new JobQueue({
      dbPath: join(root, 'ticking.sqlite'),
      tempRoot: join(root, 'tmp'),
      progressThrottleMs: 0,
      now: () => t++,
    });
    queues.push(q);
    let calls = 0;
    const flaky = defineJob<object, never, number>({
      type: 'test/ticking',
      input: z.strictObject({}),
      maxAttempts: 40,
      backoffMs: (retry) => 1 + (retry % 4), // 2 ms is the one that used to be lost

      run: async () => {
        if (++calls < 30) throw new JobError('again', true);
        return calls;
      },
    });
    q.register(flaky).start();
    const id = q.enqueue(flaky, {});
    expect((await waitFor(q, id, 'succeeded')).output).toBe(30);
  });

  it('fails for good after maxAttempts and records the error', async () => {
    const q = makeQueue();
    const broken = defineJob<object>({
      type: 'test/broken',
      input: z.strictObject({}),
      maxAttempts: 2,
      backoffMs: () => 5,
      run: async () => {
        throw new Error('always');
      },
    });
    q.register(broken).start();
    const id = q.enqueue(broken, {});
    const job = await waitFor(q, id, 'failed');
    expect(job.attempts).toBe(2);
    expect(job.error).toEqual({ message: 'always' });
  });

  it('does not retry non-retryable errors and cleans the temp dir', async () => {
    const q = makeQueue();
    const corrupt = defineJob<object>({
      type: 'test/corrupt',
      input: z.strictObject({}),
      run: async (ctx) => {
        await writeFile(join(ctx.tempDir, 'partial.bin'), 'x');
        throw new JobError('file is corrupt', false, 'corrupt-file');
      },
    });
    q.register(corrupt).start();
    const id = q.enqueue(corrupt, {});
    const job = await waitFor(q, id, 'failed');
    expect(job.attempts).toBe(1);
    expect(job.error).toEqual({ message: 'file is corrupt', code: 'corrupt-file' });
    expect(existsSync(join(root, 'tmp', id))).toBe(false);
  });

  it('times out long jobs', async () => {
    const q = makeQueue();
    const slow = defineJob<object>({
      type: 'test/slow',
      input: z.strictObject({}),
      timeoutMs: 30,
      maxAttempts: 1,
      run: (ctx) =>
        new Promise((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('stopped'))),
        ),
    });
    q.register(slow).start();
    const id = q.enqueue(slow, {});
    const job = await waitFor(q, id, 'failed');
    expect(job.error?.code).toBe('timeout');
  });

  it('can manually retry a failed job', async () => {
    const q = makeQueue();
    let fail = true;
    const once = defineJob<object, never, string>({
      type: 'test/once',
      input: z.strictObject({}),
      maxAttempts: 1,
      run: async () => {
        if (fail) throw new Error('first');
        return 'ok';
      },
    });
    q.register(once).start();
    const id = q.enqueue(once, {});
    await waitFor(q, id, 'failed');
    fail = false;
    expect(q.retry(id)).toBe(true);
    expect((await waitFor(q, id, 'succeeded')).output).toBe('ok');
  });
});

describe('cancel', () => {
  it('cancels a queued job', async () => {
    const q = makeQueue();
    q.register(stepJob);
    const id = q.enqueue(stepJob, { steps: 1, stepMs: 0 });
    expect(await q.cancel(id)).toBe(true);
    expect(q.get(id)?.status).toBe('cancelled');
    q.start();
    await sleep(20);
    expect(q.get(id)?.status).toBe('cancelled');
  });

  it('aborts a running job and deletes its temp dir', async () => {
    const q = makeQueue();
    q.register(stepJob).start();
    const id = q.enqueue(stepJob, { steps: 100, stepMs: 20 });
    await waitFor(q, id, 'running');
    await writeFile(join(root, 'tmp', id, 'segment.mp4'), 'x');
    expect(await q.cancel(id)).toBe(true);
    expect(q.get(id)?.status).toBe('cancelled');
    expect(existsSync(join(root, 'tmp', id))).toBe(false);
  });

  it('returns false for finished jobs', async () => {
    const q = makeQueue();
    q.register(stepJob).start();
    const id = q.enqueue(stepJob, { steps: 1, stepMs: 0 });
    await waitFor(q, id, 'succeeded');
    expect(await q.cancel(id)).toBe(false);
  });
});

describe('resume', () => {
  it('graceful stop re-queues running jobs, which resume from their checkpoint', async () => {
    const q1 = makeQueue();
    q1.register(stepJob).start();
    const id = q1.enqueue(stepJob, { steps: 50, stepMs: 10 });
    await sleep(120);
    await q1.close();
    queues.splice(queues.indexOf(q1), 1);
    const mid = makeQueue();
    const interrupted = mid.get(id)!;
    expect(interrupted.status).toBe('queued');
    expect((interrupted.checkpoint as { done: number }).done).toBeGreaterThan(0);
    mid.register(stepJob).start();
    const job = await waitFor(mid, id, 'succeeded');
    const out = job.output as { ranFrom: number; attempt: number };
    expect(out.ranFrom).toBe((interrupted.checkpoint as { done: number }).done);
    expect(out.attempt).toBe(1); // interruptions are not counted as failed attempts
  });

  it('survives the process being killed and resumes after restart', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const dbPath = join(root, 'jobs.sqlite');
    const tempRoot = join(root, 'tmp');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsx, join(here, 'crash-child.ts'), dbPath, tempRoot],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('step 5')) child.kill('SIGKILL');
      });
      child.on('exit', (_c, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(err))));
    });

    const q = makeQueue();
    const [orphan] = q.list();
    expect(orphan?.status).toBe('running'); // left behind by the dead process
    q.register(stepJob).start();
    const job = await waitFor(q, orphan!.id, 'succeeded');
    const out = job.output as { ranFrom: number; attempt: number };
    expect(out.ranFrom).toBeGreaterThanOrEqual(5);
    expect(out.attempt).toBe(1);
    expect(existsSync(join(tempRoot, orphan!.id))).toBe(false);
  }, 30_000);
});

describe('late reports', () => {
  it('ignores progress and checkpoints from a job after it was cancelled or the queue closed', async () => {
    const q = makeQueue();
    let report!: (f: number) => void;
    const late = defineJob<object>({
      type: 'test/late',
      input: z.strictObject({}),
      run: async (ctx) => {
        report = (f) => ctx.progress(f);
        await new Promise((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    });
    q.register(late).start();
    const id = q.enqueue(late, {});
    await waitFor(q, id, 'running');
    await q.cancel(id);
    expect(() => report(0.5)).not.toThrow();
    expect(q.get(id)?.progress).toBe(0);
    await q.close();
    expect(() => report(0.9)).not.toThrow(); // the database is closed now
  });
});
