import type { z } from 'zod';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobContext<I, C> {
  readonly jobId: string;
  readonly input: I;
  /** Last saved checkpoint, or null on a fresh start. Resume from here after a restart. */
  readonly checkpoint: C | null;
  /** 1-based attempt number. Interruptions (crash, shutdown) don't count as attempts. */
  readonly attempt: number;
  /** Aborted on cancel, timeout or shutdown; check `signal.reason`. */
  readonly signal: AbortSignal;
  /**
   * Per-job scratch directory. Survives retries and restarts (so partial outputs can be part
   * of a checkpoint) and is deleted when the job succeeds, fails for good or is cancelled.
   */
  readonly tempDir: string;
  progress(fraction: number, message?: string): void;
  /** Persisted immediately; must be JSON-serializable. */
  saveCheckpoint(checkpoint: C): void;
}

export interface JobDefinition<I = unknown, C = unknown, O = unknown> {
  /** Namespaced, e.g. `core/media.proxy`, `core/render.segment`. */
  type: string;
  input: z.ZodType<I>;
  run(ctx: JobContext<I, C>): Promise<O>;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before retry n (1-based). Default 1s * 2^(n-1), capped at 60s. */
  backoffMs?: (retry: number) => number;
  /** Max concurrent jobs of this type (e.g. 1 for GPU encodes). Default: no extra limit. */
  concurrency?: number;
  timeoutMs?: number;
}

export function defineJob<I, C = never, O = void>(
  def: JobDefinition<I, C, O>,
): JobDefinition<I, C, O> {
  return def;
}

/** Throw from `run` for failures that retrying cannot fix (corrupt file, missing codec). */
export class JobError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  input: unknown;
  output: unknown;
  error: { message: string; code?: string } | null;
  checkpoint: unknown;
  progress: number;
  message: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  projectId: string | null;
  dedupeKey: string | null;
  runAfter: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type JobEvent =
  | { kind: 'queued'; job: JobRecord }
  | { kind: 'started'; job: JobRecord }
  | { kind: 'progress'; job: JobRecord }
  | { kind: 'retrying'; job: JobRecord; delayMs: number }
  | { kind: 'succeeded'; job: JobRecord }
  | { kind: 'failed'; job: JobRecord }
  | { kind: 'cancelled'; job: JobRecord }
  | { kind: 'interrupted'; job: JobRecord };

export interface EnqueueOptions {
  priority?: number;
  projectId?: string;
  /** While a job with this key is queued or running, enqueueing again returns its id. */
  dedupeKey?: string;
}
