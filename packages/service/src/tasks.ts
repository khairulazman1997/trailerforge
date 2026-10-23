import { randomUUID } from 'node:crypto';
import type { EventLog } from './events.js';

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  kind: string;
  projectId: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Long-running operations (LLM generation, scans). One at a time per project: while one runs,
 * edits to that project are refused, because the operation read the project when it started
 * and would overwrite changes made meanwhile.
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord & { controller: AbortController }>();

  constructor(
    private readonly events: EventLog,
    private readonly describeError: (err: unknown) => {
      code: string;
      message: string;
      details?: unknown;
    },
  ) {}

  busy(projectId: string): TaskRecord | undefined {
    for (const t of this.tasks.values())
      if (t.projectId === projectId && t.status === 'running') return this.view(t);
    return undefined;
  }

  get(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t && this.view(t);
  }

  start(
    kind: string,
    projectId: string,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): TaskRecord {
    const controller = new AbortController();
    const task = {
      id: randomUUID(),
      kind,
      projectId,
      status: 'running' as TaskStatus,
      startedAt: new Date().toISOString(),
      controller,
    };
    this.tasks.set(task.id, task);
    this.events.emit('task.updated', this.view(task));
    void run(controller.signal).then(
      (result) =>
        this.finish(task, controller.signal.aborted ? 'cancelled' : 'succeeded', { result }),
      (err: unknown) =>
        this.finish(task, controller.signal.aborted ? 'cancelled' : 'failed', {
          error: this.describeError(err),
        }),
    );
    return this.view(task);
  }

  /** Abort a running task. The operation checks the signal before writing, so nothing lands. */
  cancel(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status === 'running') t.controller.abort(new Error('cancelled'));
    return this.view(t);
  }

  /** Wait for every running task (used on shutdown). */
  async drain(): Promise<void> {
    for (const t of this.tasks.values())
      if (t.status === 'running') t.controller.abort(new Error('shutting down'));
    while ([...this.tasks.values()].some((t) => t.status === 'running'))
      await new Promise((r) => setTimeout(r, 10));
  }

  private finish(
    task: TaskRecord & { controller: AbortController },
    status: TaskStatus,
    out: { result?: unknown; error?: TaskRecord['error'] },
  ) {
    task.status = status;
    task.finishedAt = new Date().toISOString();
    if (status === 'succeeded') task.result = out.result;
    if (status === 'failed' && out.error) task.error = out.error;
    this.events.emit('task.updated', this.view(task));
  }

  private view(t: TaskRecord & { controller?: AbortController }): TaskRecord {
    const { controller: _c, ...rest } = t;
    return { ...rest };
  }
}
