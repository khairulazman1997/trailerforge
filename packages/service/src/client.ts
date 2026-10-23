// Browser-safe: no Node imports. Used by the UI (web mode and Electron) and by tests.
import type { Project } from '@trailerforge/schema';

// Wire types come from the engine; type-only, so nothing from it reaches the browser bundle.
export type { BriefField, BriefForm, BriefSuggestion, ScanSummary } from '@trailerforge/engine';
import type { BriefForm, BriefSuggestion } from '@trailerforge/engine';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface ServiceEventMessage {
  seq: number;
  type: string;
  at: string;
  data: unknown;
}

export interface ProjectView {
  id: string;
  dir: string;
  /** Bumps on every change; `project.changed` events carry the version they produce. */
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  busy: TaskView | null;
  project: Project;
}

export interface EditResult {
  version: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface TaskView {
  id: string;
  kind: string;
  projectId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export type TaskRequest =
  | { kind: 'generate'; options?: { duration?: number; template?: string; assume?: boolean } }
  | {
      kind: 'regenerate-section';
      options: { sectionId: string; instruction?: string; keepEdited?: boolean };
    }
  | {
      kind: 'scan';
      options?: { repo?: string; force?: boolean; deep?: boolean; allowDeep?: boolean };
    };

export interface ServiceClientOptions {
  /** e.g. http://127.0.0.1:41234 */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** Typed client for the local engine service. */
export class ServiceClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ServiceClientOptions) {
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string; details?: unknown };
    } | null;
    if (!res.ok) {
      const e = data?.error;
      throw new ServiceError(
        res.status,
        e?.code ?? 'http',
        e?.message ?? res.statusText,
        e?.details,
      );
    }
    return data as T;
  }

  info() {
    return this.request<{
      apiVersion: string;
      lastSeq: number;
      videoTypes: { id: string; name: string; defaultTemplateId?: string }[];
      templates: { id: string; videoTypeId: string; name: string }[];
      commands: string[];
    }>('GET', '/v1/info');
  }
  listProjects() {
    return this.request<{ id: string; name: string; dir: string }[]>('GET', '/v1/projects');
  }
  openProject(dir: string) {
    return this.request<ProjectView>('POST', '/v1/projects/open', { dir });
  }
  createProject(p: { dir: string; name: string; videoTypeId?: string }) {
    return this.request<ProjectView>('POST', '/v1/projects/create', p);
  }
  closeProject(id: string) {
    return this.request<{ closed: boolean }>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/close`,
      {},
    );
  }
  getProject(id: string) {
    return this.request<ProjectView>('GET', `/v1/projects/${encodeURIComponent(id)}`);
  }
  briefStatus(id: string) {
    return this.request<unknown>('GET', `/v1/projects/${encodeURIComponent(id)}/brief-status`);
  }
  decisions(id: string, limit = 50) {
    return this.request<unknown[]>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/decisions?limit=${limit}`,
    );
  }
  briefForm(id: string) {
    return this.request<BriefForm>('GET', `/v1/projects/${encodeURIComponent(id)}/brief`);
  }
  answerBrief(id: string, questionId: string, value: unknown) {
    return this.request<EditResult>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/brief/answers`,
      {
        questionId,
        value,
      },
    );
  }
  assumeMissing(id: string) {
    return this.request<EditResult & { added: number }>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/brief/assume`,
      {},
    );
  }
  /** Ask the LLM for a proposal for one field. Aborting the signal cancels the request. */
  suggestBrief(id: string, questionId: string, signal?: AbortSignal) {
    return this.request<BriefSuggestion>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/brief/suggest`,
      { questionId },
      signal,
    );
  }
  command(id: string, type: string, payload: unknown) {
    return this.request<EditResult>('POST', `/v1/projects/${encodeURIComponent(id)}/commands`, {
      type,
      payload,
    });
  }
  undo(id: string) {
    return this.request<EditResult & { done: boolean }>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/undo`,
      {},
    );
  }
  redo(id: string) {
    return this.request<EditResult & { done: boolean }>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/redo`,
      {},
    );
  }
  startTask(id: string, task: TaskRequest) {
    return this.request<TaskView>('POST', `/v1/projects/${encodeURIComponent(id)}/tasks`, task);
  }
  getTask(taskId: string) {
    return this.request<TaskView>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }
  cancelTask(taskId: string) {
    return this.request<TaskView>('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  /** Poll until the task is no longer running. */
  async waitForTask(taskId: string, pollMs = 25): Promise<TaskView> {
    for (;;) {
      const t = await this.getTask(taskId);
      if (t.status !== 'running') return t;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Live events, in order. Pass `after` (the last seq you processed) when reconnecting to get
   * what you missed; a `reset` event means the gap was too long and you should refetch state.
   */
  async *events(
    opts: { after?: number; signal?: AbortSignal; onOpen?: () => void } = {},
  ): AsyncGenerator<ServiceEventMessage> {
    const q = opts.after !== undefined ? `?after=${opts.after}` : '';
    const res = await this.fetchFn(`${this.opts.baseUrl}/v1/events${q}`, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      throw new ServiceError(
        res.status,
        data?.error?.code ?? 'http',
        data?.error?.message ?? res.statusText,
      );
    }
    opts.onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data) yield JSON.parse(data) as ServiceEventMessage;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
