// Browser-safe: no Node imports. Used by the UI (web mode and Electron) and by tests.
import type { Project } from '@trailerforge/schema';

// Wire types come from the engine; type-only, so nothing from it reaches the browser bundle.
export type {
  BriefField,
  BriefForm,
  BriefSuggestion,
  CaptureStatus,
  CaptureView,
  ClaudeCodeView,
  ExportOutcome,
  LibraryMediaKind,
  LlmPreview,
  RenderedPack,
  PendingHandoff,
  RoutesView,
  ScanSummary,
  SecretsView,
  VisionView,
  WatchedFoldersView,
} from '@trailerforge/engine';
import type { LlmPreview, PendingHandoff, RoutesView, SecretsView } from '@trailerforge/engine';
import type {
  ClaudeCodeView,
  LibraryMediaKind,
  VisionView,
  WatchedFoldersView,
} from '@trailerforge/engine';
import type { BriefForm, BriefSuggestion } from '@trailerforge/engine';
import type { CaptureStatus, CaptureView, ExportOutcome, RenderedPack } from '@trailerforge/engine';
import type {
  analyzeOp,
  brandImportOp,
  brandViewOp,
  createDefaultVariantsOp,
  cutGridOp,
  effectsViewOp,
  setSfxFolderOp,
  sfxViewOp,
  templatePreviewOp,
  templatesViewOp,
  variantsViewOp,
  footageStatusOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
  matchSuggestOp,
} from '@trailerforge/engine';

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

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
  | { kind: 'rank-takes'; options?: { overwriteChosen?: boolean } }
  | {
      kind: 'capture-tips';
      options?: { groupKeys?: string[]; force?: boolean; overwriteEdited?: boolean };
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
      videoTypes: {
        id: string;
        name: string;
        description?: string;
        defaultTemplateId?: string;
        typicalDuration?: { min: number; max: number };
      }[];
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
  llmProviders() {
    return this.request<
      {
        id: string;
        name: string;
        kind: string;
        sendsDataOffDevice: boolean;
        available: { ok: true } | { ok: false; reason: string };
      }[]
    >('GET', '/v1/llm/providers');
  }
  llmRoutes() {
    return this.request<RoutesView>('GET', '/v1/llm/routes');
  }
  saveRoutes(config: unknown) {
    return this.request<RoutesView>('PUT', '/v1/llm/routes', config);
  }
  resetRoutes() {
    return this.request<RoutesView>('DELETE', '/v1/llm/routes');
  }
  secrets() {
    return this.request<SecretsView>('GET', '/v1/secrets');
  }
  /** Write-only: the service never sends a key back. */
  setApiKey(value: string) {
    return this.request<SecretsView>('PUT', '/v1/secrets/anthropic-api-key', { value });
  }
  clearApiKey() {
    return this.request<SecretsView>('DELETE', '/v1/secrets/anthropic-api-key');
  }
  watchedFolders() {
    return this.request<WatchedFoldersView>('GET', '/v1/settings/watched-folders');
  }
  /** Replace the watched folders (absolute paths of existing folders; at most 20). */
  setWatchedFolders(folders: string[]) {
    return this.request<WatchedFoldersView>('PUT', '/v1/settings/watched-folders', { folders });
  }
  claudeCode() {
    return this.request<ClaudeCodeView>('GET', '/v1/claude-code');
  }
  /** `app` (default): talk to this running app; `standalone`: start its own copy (app closed). */
  connectClaudeCode(mode: 'app' | 'standalone' = 'app') {
    return this.request<ClaudeCodeView>('POST', '/v1/claude-code/connect', { mode });
  }
  disconnectClaudeCode() {
    return this.request<ClaudeCodeView>('DELETE', '/v1/claude-code');
  }
  /** The vision model's state and what downloading it would do. */
  vision() {
    return this.request<VisionView>('GET', '/v1/vision');
  }
  /** Start the one-time model download (a task; progress arrives as `vision.progress` events). */
  downloadVision() {
    return this.request<TaskView>('POST', '/v1/vision/download', { consent: true });
  }
  handoffs() {
    return this.request<PendingHandoff[]>('GET', '/v1/handoffs');
  }
  replyHandoff(id: string, text: string) {
    return this.request<{ accepted: boolean }>(
      'POST',
      `/v1/handoffs/${encodeURIComponent(id)}/reply`,
      { text },
    );
  }
  cancelHandoff(id: string) {
    return this.request<{ cancelled: boolean }>(
      'POST',
      `/v1/handoffs/${encodeURIComponent(id)}/cancel`,
      {},
    );
  }
  /** What a task would send, to which provider, before anything is sent. */
  llmPreview(
    id: string,
    task:
      'storyboard.generate' | 'storyboard.regenerate-section' | 'brief.suggest' | 'capture.tips',
  ) {
    return this.request<LlmPreview>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/llm-preview?task=${task}`,
    );
  }
  /** The capture checklist: groups and shots, setup hints, stored tips and recording settings. */
  capture(id: string, include: 'all' | 'todo' = 'all') {
    return this.request<CaptureView>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/capture?include=${include}`,
    );
  }
  variants(id: string) {
    return this.request<Result<typeof variantsViewOp>>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/variants`,
    );
  }
  /** One version per format target that has none, at the master's length. */
  createDefaultVariants(id: string) {
    return this.request<Result<typeof createDefaultVariantsOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/variants/defaults`,
      {},
    );
  }
  brand(id: string) {
    return this.request<Result<typeof brandViewOp>>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/brand`,
    );
  }
  /** The path is on the machine running the service (the desktop app's file picker gives it). */
  importBrandFile(
    id: string,
    o: {
      kind: 'logo' | 'font';
      path: string;
      role?: 'heading' | 'body';
      family?: string;
      bold?: boolean;
    },
  ) {
    return this.request<Result<typeof brandImportOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/brand/import`,
      o,
    );
  }
  graphicTemplates() {
    return this.request<Result<typeof templatesViewOp>>('GET', '/v1/templates');
  }
  previewTemplate(
    id: string,
    o: {
      templateId: string;
      params?: Record<string, unknown>;
      at?: number;
      seconds?: number;
      size?: { width: number; height: number };
      png?: boolean;
    },
  ) {
    return this.request<Result<typeof templatePreviewOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/templates/preview`,
      o,
    );
  }
  effects() {
    return this.request<Result<typeof effectsViewOp>>('GET', '/v1/effects');
  }
  sfx() {
    return this.request<Result<typeof sfxViewOp>>('GET', '/v1/sfx');
  }
  setSfxFolder(folder: string | null) {
    return this.request<Result<typeof setSfxFolderOp>>('POST', '/v1/sfx/folder', { folder });
  }
  footage(id: string) {
    return this.request<Result<typeof footageStatusOp>>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/footage`,
    );
  }
  /** Paths are on the machine running the service (the desktop app's file picker gives them). */
  importFootage(id: string, paths: string[]) {
    return this.request<Result<typeof importFootageOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/footage/import`,
      { paths },
    );
  }
  analyzeFootage(id: string, opts: { assetIds?: string[]; music?: boolean } = {}) {
    return this.request<Result<typeof analyzeOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/footage/analyze`,
      opts,
    );
  }
  footageMatches(id: string) {
    return this.request<Result<typeof matchSuggestOp>>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/footage/matches`,
    );
  }
  acceptMatches(
    id: string,
    opts: { minConfidence?: 'certain' | 'high' | 'medium'; assetIds?: string[] } = {},
  ) {
    return this.request<Result<typeof matchAcceptOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/footage/matches/accept`,
      opts,
    );
  }
  cutGrid(id: string) {
    return this.request<Result<typeof cutGridOp>>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/cut/grid`,
    );
  }
  /**
   * A recording's editing copy, thumbnail or filmstrip, or a music file, as a Blob (an `<img>` or
   * the player cannot send the token itself).
   */
  async media(assetId: string, what: LibraryMediaKind): Promise<Blob> {
    const res = await this.fetchFn(
      `${this.opts.baseUrl}/v1/library/assets/${encodeURIComponent(assetId)}/${what}`,
      {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      },
    );
    if (!res.ok) {
      const e = (
        (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null
      )?.error;
      throw new ServiceError(res.status, e?.code ?? 'http', e?.message ?? res.statusText);
    }
    return res.blob();
  }
  generateCut(id: string, opts: { leadFrames?: number } = {}) {
    return this.request<Result<typeof generateCutOp>>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/cut`,
      opts,
    );
  }
  captureStatus(id: string) {
    return this.request<CaptureStatus>(
      'GET',
      `/v1/projects/${encodeURIComponent(id)}/capture/status`,
    );
  }
  /** Writes the pack under the project's `exports/capture/` folder. */
  exportCapture(
    id: string,
    opts: { formats?: ('md' | 'html' | 'json')[]; omitExcluded?: boolean } = {},
  ) {
    return this.request<ExportOutcome>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/capture/export`,
      opts,
    );
  }
  /** The pack as text, for the browser to save through its own download or save dialog. */
  renderCapture(id: string, opts: { format: 'md' | 'html' | 'json'; omitExcluded?: boolean }) {
    return this.request<RenderedPack>(
      'POST',
      `/v1/projects/${encodeURIComponent(id)}/capture/render`,
      opts,
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
