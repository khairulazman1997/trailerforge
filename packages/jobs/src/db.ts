import { DatabaseSync } from 'node:sqlite';
import type { JobRecord, JobStatus } from './types.js';

/**
 * Thin persistence layer over node:sqlite (no native module to rebuild for Electron). Kept
 * small so it can be swapped for better-sqlite3 if node:sqlite changes.
 */
const SCHEMA_VERSION = 1;

interface Row {
  id: string;
  type: string;
  status: JobStatus;
  input: string;
  output: string | null;
  error: string | null;
  checkpoint: string | null;
  progress: number;
  message: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  project_id: string | null;
  dedupe_key: string | null;
  run_after: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const parse = (s: string | null): unknown => (s === null ? null : JSON.parse(s));

function toRecord(r: Row): JobRecord {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    input: parse(r.input),
    output: parse(r.output),
    error: parse(r.error) as JobRecord['error'],
    checkpoint: parse(r.checkpoint),
    progress: r.progress,
    message: r.message,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    priority: r.priority,
    projectId: r.project_id,
    dedupeKey: r.dedupe_key,
    runAfter: r.run_after,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export class JobDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;',
    );
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (user_version > SCHEMA_VERSION)
      throw new Error(`job database is from a newer app (v${user_version})`);
    if (user_version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT,
          error TEXT,
          checkpoint TEXT,
          progress REAL NOT NULL DEFAULT 0,
          message TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          project_id TEXT,
          dedupe_key TEXT,
          run_after INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, run_after, priority);
        CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key)
          WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
        PRAGMA user_version = 1;
      `);
    }
  }

  insert(
    job: Omit<
      JobRecord,
      | 'output'
      | 'error'
      | 'checkpoint'
      | 'progress'
      | 'message'
      | 'attempts'
      | 'startedAt'
      | 'finishedAt'
    >,
  ): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, status, input, max_attempts, priority, project_id, dedupe_key, run_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.type,
        job.status,
        JSON.stringify(job.input),
        job.maxAttempts,
        job.priority,
        job.projectId,
        job.dedupeKey,
        job.runAfter,
        job.createdAt,
      );
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row && toRecord(row);
  }

  activeByDedupeKey(key: string): JobRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')`)
      .get(key) as Row | undefined;
    return row && toRecord(row);
  }

  list(filter: { status?: JobStatus; projectId?: string } = {}): JobRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toRecord);
  }

  /** Queued jobs whose backoff has elapsed, highest priority first, then oldest. */
  ready(now: number, types: string[]): JobRecord[] {
    if (types.length === 0) return [];
    const placeholders = types.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? AND type IN (${placeholders})
           ORDER BY priority DESC, created_at, rowid`,
        )
        .all(now, ...types) as unknown as Row[]
    ).map(toRecord);
  }

  nextRunAfter(types: string[]): number | undefined {
    if (types.length === 0) return undefined;
    const placeholders = types.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT MIN(run_after) AS t FROM jobs WHERE status = 'queued' AND type IN (${placeholders})`,
      )
      .get(...types) as { t: number | null };
    return row.t ?? undefined;
  }

  /** Jobs left `running` by a process that died; they go back to the queue to resume. */
  requeueOrphans(): number {
    return Number(
      this.db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`).run().changes,
    );
  }

  update(
    id: string,
    fields: Partial<
      Pick<
        JobRecord,
        | 'status'
        | 'output'
        | 'error'
        | 'checkpoint'
        | 'progress'
        | 'message'
        | 'attempts'
        | 'runAfter'
        | 'startedAt'
        | 'finishedAt'
      >
    >,
  ): void {
    const map: Record<string, string> = {
      status: 'status',
      output: 'output',
      error: 'error',
      checkpoint: 'checkpoint',
      progress: 'progress',
      message: 'message',
      attempts: 'attempts',
      runAfter: 'run_after',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    };
    const json = new Set(['output', 'error', 'checkpoint']);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${map[key]} = ?`);
      args.push(
        json.has(key)
          ? value === null
            ? null
            : JSON.stringify(value)
          : (value as string | number | null),
      );
    }
    if (sets.length)
      this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  close(): void {
    this.db.close();
  }
}
