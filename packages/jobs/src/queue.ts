import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JobDb } from './db.js';
import {
  JobError,
  type EnqueueOptions,
  type JobContext,
  type JobDefinition,
  type JobEvent,
  type JobRecord,
  type JobStatus,
} from './types.js';

export interface JobQueueOptions {
  /** SQLite file (app-level, e.g. `<appData>/jobs.sqlite`). */
  dbPath: string;
  /** Root for per-job scratch directories. */
  tempRoot: string;
  /** Max jobs running at once across all types. Default 2. */
  concurrency?: number;
  /** Min interval between persisted progress updates. Default 250 ms. */
  progressThrottleMs?: number;
  now?: () => number;
}

type AbortReason = 'cancel' | 'shutdown' | 'timeout';

interface Running {
  type: string;
  controller: AbortController;
  done: Promise<void>;
}

const defaultBackoff = (retry: number) => Math.min(60_000, 1000 * 2 ** (retry - 1));

/**
 * Persistent background job queue. Jobs survive app restarts: anything left `running` by a
 * crashed process is re-queued on `start()` and resumes from its last checkpoint.
 */
export class JobQueue {
  private readonly db: JobDb;
  private readonly defs = new Map<string, JobDefinition<unknown, unknown, unknown>>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<(e: JobEvent) => void>();
  private readonly concurrency: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopping = false;

  constructor(private readonly opts: JobQueueOptions) {
    this.db = new JobDb(opts.dbPath);
    this.concurrency = opts.concurrency ?? 2;
    this.throttleMs = opts.progressThrottleMs ?? 250;
    this.now = opts.now ?? Date.now;
  }

  register<I, C, O>(def: JobDefinition<I, C, O>): this {
    if (this.defs.has(def.type)) throw new Error(`job type already registered: ${def.type}`);
    this.defs.set(def.type, def as JobDefinition<unknown, unknown, unknown>);
    this.pump();
    return this;
  }

  enqueue<I>(
    def: Pick<JobDefinition<I>, 'type' | 'input'> | string,
    input: NoInfer<I>,
    options: EnqueueOptions = {},
  ): string {
    const type = typeof def === 'string' ? def : def.type;
    const registered = this.defs.get(type);
    if (!registered) throw new Error(`unknown job type: ${type}`);
    const parsed = registered.input.safeParse(input);
    if (!parsed.success) throw new Error(`invalid input for ${type}: ${parsed.error.message}`);
    if (options.dedupeKey) {
      const existing = this.db.activeByDedupeKey(options.dedupeKey);
      if (existing) return existing.id;
    }
    const id = randomUUID();
    const now = this.now();
    this.db.insert({
      id,
      type,
      status: 'queued',
      input: parsed.data,
      maxAttempts: registered.maxAttempts ?? 3,
      priority: options.priority ?? 0,
      projectId: options.projectId ?? null,
      dedupeKey: options.dedupeKey ?? null,
      runAfter: now,
      createdAt: now,
    });
    this.emit('queued', id);
    this.pump();
    return id;
  }

  get(id: string): JobRecord | undefined {
    return this.db.get(id);
  }

  list(filter?: { status?: JobStatus; projectId?: string }): JobRecord[] {
    return this.db.list(filter);
  }

  subscribe(listener: (e: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Begin processing. Re-queues jobs orphaned by a previous crash. */
  start(): void {
    if (this.started) return;
    this.db.requeueOrphans();
    this.started = true;
    this.stopping = false;
    this.pump();
  }

  /**
   * Stop processing. Running jobs are aborted with reason `shutdown` and go back to the queue
   * (keeping their checkpoint and temp dir) to resume on the next start.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const r of this.running.values()) r.controller.abort('shutdown' satisfies AbortReason);
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  async close(): Promise<void> {
    await this.stop();
    this.db.close();
  }

  /** Cancel a queued or running job. Returns false if it already finished. */
  async cancel(id: string): Promise<boolean> {
    const r = this.running.get(id);
    if (r) {
      r.controller.abort('cancel' satisfies AbortReason);
      await r.done;
      // The job may have finished on its own before the abort landed.
      return this.db.get(id)?.status === 'cancelled';
    }
    const job = this.db.get(id);
    if (job?.status !== 'queued') return false;
    this.db.update(id, { status: 'cancelled', finishedAt: this.now() });
    await this.cleanup(id);
    this.emit('cancelled', id);
    return true;
  }

  /** Re-queue a failed or cancelled job from scratch (attempts reset, checkpoint kept). */
  retry(id: string): boolean {
    const job = this.db.get(id);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return false;
    this.db.update(id, {
      status: 'queued',
      attempts: 0,
      error: null,
      runAfter: this.now(),
      finishedAt: null,
    });
    this.emit('queued', id);
    this.pump();
    return true;
  }

  private pump(): void {
    if (!this.started || this.stopping) return;
    const types = [...this.defs.keys()];
    // One reading of the clock for both the "ready now" query and the wake-up time: with two
    // readings a job that became due in between was neither started nor scheduled, and sat
    // queued until something else happened to pump.
    const now = this.now();
    for (const job of this.db.ready(now, types)) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(job.id)) continue;
      const limit = this.defs.get(job.type)!.concurrency;
      if (limit !== undefined && this.runningOfType(job.type) >= limit) continue;
      this.launch(job);
    }
    this.scheduleWake(types, now);
  }

  private scheduleWake(types: string[], now: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.db.nextRunAfter(types);
    if (next === undefined) return;
    const delay = next - now;
    if (delay <= 0) return; // ready now; pump runs again when a slot frees up
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
  }

  private runningOfType(type: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.type === type) n++;
    return n;
  }

  private launch(job: JobRecord): void {
    const def = this.defs.get(job.type)!;
    const controller = new AbortController();
    const attempt = job.attempts + 1;
    const tempDir = join(this.opts.tempRoot, job.id);
    mkdirSync(tempDir, { recursive: true });
    this.db.update(job.id, { status: 'running', startedAt: this.now() });
    this.emit('started', job.id);

    let lastProgressWrite = 0;
    const ctx: JobContext<unknown, unknown> = {
      jobId: job.id,
      input: job.input,
      checkpoint: job.checkpoint,
      attempt,
      signal: controller.signal,
      tempDir,
      progress: (fraction, message) => {
        // A job that was cancelled, timed out or shut down may still report; ignore it.
        if (controller.signal.aborted || this.stopping) return;
        const t = this.now();
        if (fraction < 1 && t - lastProgressWrite < this.throttleMs) return;
        lastProgressWrite = t;
        this.db.update(job.id, {
          progress: Math.min(1, Math.max(0, fraction)),
          ...(message === undefined ? {} : { message }),
        });
        this.emit('progress', job.id);
      },
      saveCheckpoint: (checkpoint) => this.db.update(job.id, { checkpoint }),
    };

    const timeout =
      def.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort('timeout' satisfies AbortReason), def.timeoutMs);

    const done = (async () => {
      try {
        const output = await def.run(ctx);
        const reason = controller.signal.reason as AbortReason | undefined;
        if (controller.signal.aborted && reason === 'cancel') await this.finishCancelled(job.id);
        else await this.finishSucceeded(job.id, attempt, output);
      } catch (err) {
        const reason = controller.signal.reason as AbortReason | undefined;
        if (controller.signal.aborted && reason === 'cancel') await this.finishCancelled(job.id);
        else if (controller.signal.aborted && reason === 'shutdown') this.finishInterrupted(job.id);
        else if (controller.signal.aborted && reason === 'timeout') {
          await this.finishFailed(
            job.id,
            attempt,
            def,
            new JobError(`timed out after ${def.timeoutMs} ms`, true, 'timeout'),
          );
        } else await this.finishFailed(job.id, attempt, def, err);
      } finally {
        if (timeout) clearTimeout(timeout);
        this.running.delete(job.id);
        this.pump();
      }
    })();
    this.running.set(job.id, { type: job.type, controller, done });
  }

  private async finishSucceeded(id: string, attempt: number, output: unknown) {
    this.db.update(id, {
      status: 'succeeded',
      output: output === undefined ? null : output,
      error: null,
      progress: 1,
      attempts: attempt,
      finishedAt: this.now(),
    });
    await this.cleanup(id);
    this.emit('succeeded', id);
  }

  private async finishFailed(
    id: string,
    attempt: number,
    def: JobDefinition<unknown, unknown, unknown>,
    err: unknown,
  ) {
    const error = {
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof JobError && err.code ? { code: err.code } : {}),
    };
    const retryable = !(err instanceof JobError) || err.retryable;
    const maxAttempts = def.maxAttempts ?? 3;
    if (retryable && attempt < maxAttempts) {
      const delayMs = (def.backoffMs ?? defaultBackoff)(attempt);
      this.db.update(id, {
        status: 'queued',
        attempts: attempt,
        error,
        runAfter: this.now() + delayMs,
      });
      this.emit('retrying', id, delayMs);
      return;
    }
    this.db.update(id, { status: 'failed', attempts: attempt, error, finishedAt: this.now() });
    await this.cleanup(id);
    this.emit('failed', id);
  }

  private async finishCancelled(id: string) {
    this.db.update(id, { status: 'cancelled', finishedAt: this.now() });
    await this.cleanup(id);
    this.emit('cancelled', id);
  }

  private finishInterrupted(id: string) {
    this.db.update(id, { status: 'queued' });
    this.emit('interrupted', id);
  }

  private cleanup(id: string): Promise<void> {
    return rm(join(this.opts.tempRoot, id), { recursive: true, force: true });
  }

  private emit(kind: JobEvent['kind'], id: string, delayMs = 0): void {
    const job = this.db.get(id);
    if (!job) return;
    const event = (kind === 'retrying' ? { kind, job, delayMs } : { kind, job }) as JobEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // subscribers must not break the queue
      }
    }
  }
}
