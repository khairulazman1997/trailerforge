import { applyPatches, enablePatches, type Patch } from 'immer';
import {
  ServiceError,
  type BriefForm,
  type BriefSuggestion,
  type CaptureView,
  type ExportOutcome,
  type LlmPreview,
  type PendingHandoff,
  type RenderedPack,
  type RoutesView,
  type SecretsView,
  type ProjectView,
  type ServiceClient,
  type ServiceEventMessage,
  type TaskRequest,
  type TaskView,
} from '@trailerforge/service/client';
import type { DecisionRecord } from '@trailerforge/schema';
import type { Connection } from './connection.js';

enablePatches();

/** The slice of the service client the store uses; tests supply a fake. */
export interface FootageSnapshot {
  status: Awaited<ReturnType<ServiceClient['footage']>>;
  matches: Awaited<ReturnType<ServiceClient['footageMatches']>>;
  /** Project version the suggestions were computed at. */
  version: number;
}

export type ClientLike = Pick<
  ServiceClient,
  | 'info'
  | 'footage'
  | 'cutGrid'
  | 'media'
  | 'generateCut'
  | 'importFootage'
  | 'analyzeFootage'
  | 'footageMatches'
  | 'acceptMatches'
  | 'listProjects'
  | 'openProject'
  | 'createProject'
  | 'closeProject'
  | 'getProject'
  | 'command'
  | 'undo'
  | 'redo'
  | 'startTask'
  | 'cancelTask'
  | 'events'
  | 'briefForm'
  | 'answerBrief'
  | 'assumeMissing'
  | 'suggestBrief'
  | 'capture'
  | 'exportCapture'
  | 'renderCapture'
  | 'decisions'
  | 'llmPreview'
  | 'handoffs'
  | 'replyHandoff'
  | 'cancelHandoff'
  | 'llmProviders'
  | 'llmRoutes'
  | 'saveRoutes'
  | 'resetRoutes'
  | 'secrets'
  | 'setApiKey'
  | 'clearApiKey'
>;

export type ProviderStatus = Awaited<ReturnType<ServiceClient['llmProviders']>>[number];

export interface SettingsData {
  providers: ProviderStatus[];
  routes: RoutesView;
  secrets: SecretsView;
}

export type Info = Awaited<ReturnType<ServiceClient['info']>>;

export interface JobUpdate {
  jobId: string;
  type: string;
  status: string;
  progress: number;
  projectId: string | null;
}

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed';

export interface AppState {
  status: ConnectionStatus;
  error: string | null;
  info: Info | null;
  projects: Record<string, ProjectView>;
  /** Open projects in the order they were opened. */
  order: string[];
  tasks: Record<string, TaskView>;
  jobs: Record<string, JobUpdate>;
  /** The brief screen's data per project, tagged with the project version it was read at. */
  briefs: Record<string, { version: number; form: BriefForm }>;
  /** Which capture tips are up to date, per project, tagged with the version it was read at. */
  captureTips: Record<string, { version: number; groups: CaptureView['tips']['groups'] }>;
  /** Recordings, import progress and match suggestions per project (read from the engine). */
  footage: Record<string, FootageSnapshot>;
  /** The beat grid the cut lands on, per project (null: music not chosen or analysed yet). */
  cutGrid: Record<string, { version: number; grid: Awaited<ReturnType<ServiceClient['cutGrid']>> }>;
  /** Latest progress message of a running task, per project (cleared when the task ends). */
  notices: Record<string, string>;
  /** Why the storyboard looks the way it does: automated decisions, oldest first. */
  decisions: Record<string, DecisionRecord[]>;
  /** Copy-to-chat requests waiting for a pasted reply, oldest first. */
  handoffs: PendingHandoff[];
  /** Providers, routes and key status; null until the Settings screen asks for them. */
  settings: SettingsData | null;
  toasts: Toast[];
  /** Last event sequence number applied; used to resume after a dropped stream. */
  lastSeq: number;
}

const initial: AppState = {
  status: 'idle',
  error: null,
  info: null,
  projects: {},
  order: [],
  tasks: {},
  jobs: {},
  briefs: {},
  captureTips: {},
  footage: {},
  cutGrid: {},
  notices: {},
  decisions: {},
  handoffs: [],
  settings: null,
  toasts: [],
  lastSeq: 0,
};

interface ProjectChanged {
  projectId: string;
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  patches: Patch[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Human-readable text for a failed request (what a toast shows). */
export function describeFailure(err: unknown): string {
  if (err instanceof ServiceError) {
    const detail = Array.isArray(err.details)
      ? (err.details as { path?: string; message?: string; label?: string }[])
          .slice(0, 3)
          .map((d) => d.message ?? d.label ?? '')
          .filter(Boolean)
          .join('; ')
      : '';
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Client-side mirror of the engine's state. The service is the source of truth: edits are sent
 * as commands, and the state changes when the matching event arrives (patches applied in version
 * order, with a refetch on any gap), so every window and tool sees the same thing.
 */
export class AppStore {
  private state: AppState = initial;
  private readonly listeners = new Set<() => void>();
  private client: ClientLike | null = null;
  private abort: AbortController | null = null;
  private toastId = 0;

  constructor(private readonly makeClient: (c: Connection) => ClientLike) {}

  // ---- external-store plumbing (useSyncExternalStore) ----
  getState = (): AppState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    for (const l of this.listeners) l();
  }

  // ---- connection ----
  async connect(conn: Connection): Promise<boolean> {
    this.disconnect();
    const abort = (this.abort = new AbortController());
    const client = (this.client = this.makeClient(conn));
    this.set({ ...initial, status: 'connecting' });
    try {
      const info = await client.info();
      this.set({ info, lastSeq: info.lastSeq });
      await this.refetchAll();
      this.set({ handoffs: await client.handoffs(), status: 'ready', error: null });
    } catch (err) {
      this.set({ status: 'failed', error: describeFailure(err) });
      return false;
    }
    void this.pump(client, abort.signal);
    return true;
  }

  disconnect(): void {
    this.abort?.abort();
    this.abort = null;
    this.client = null;
    this.set({ ...initial });
  }

  private async pump(client: ClientLike, signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const stream = client.events({
          after: this.state.lastSeq,
          signal,
          onOpen: () => {
            attempt = 0;
            if (this.state.status !== 'ready') this.set({ status: 'ready', error: null });
          },
        });
        for await (const ev of stream) await this.apply(ev);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ServiceError && err.status === 401) {
          this.set({
            status: 'failed',
            error: 'The token was rejected. Reconnect with a new link.',
          });
          return;
        }
      }
      if (signal.aborted) return;
      this.set({ status: 'reconnecting' });
      await sleep(Math.min(5000, 250 * 2 ** attempt++), signal);
    }
  }

  // ---- applying events ----
  async apply(ev: ServiceEventMessage): Promise<void> {
    if (ev.type === 'reset') {
      await this.refetchAll();
      if (this.client) this.set({ handoffs: await this.client.handoffs() });
      this.set({ lastSeq: ev.seq });
      return;
    }
    this.set((s) => ({ lastSeq: Math.max(s.lastSeq, ev.seq) }));
    const data = ev.data as Record<string, unknown>;
    switch (ev.type) {
      case 'project.changed':
        await this.applyChange(data as unknown as ProjectChanged);
        break;
      case 'project.opened': {
        const id = String(data.projectId);
        if (!this.state.projects[id]) await this.refetchProject(id);
        break;
      }
      case 'project.closed':
        this.removeProject(String(data.projectId));
        break;
      case 'task.updated': {
        const t = data as unknown as TaskView;
        this.set((s) => {
          const { [t.projectId]: _done, ...notices } = s.notices;
          return {
            tasks: { ...s.tasks, [t.id]: t },
            notices: t.status === 'running' ? s.notices : notices,
          };
        });
        if (t.status === 'failed') {
          this.toast('error', `${t.kind} failed: ${t.error?.message ?? 'unknown error'}`);
        } else if (t.status === 'succeeded' && t.kind === 'generate') {
          const r = t.result as { provider: string; slots: number; seconds: number } | undefined;
          if (r)
            this.toast(
              'info',
              `Storyboard written with ${r.provider}: ${r.slots} slots, ${r.seconds} s. Undo goes back to what you had.`,
            );
        } else if (t.status === 'succeeded' && t.kind === 'regenerate-section') {
          const r = t.result as { provider: string; section: { name: string } } | undefined;
          if (r)
            this.toast('info', `Rewrote “${r.section.name}” with ${r.provider}. Undo goes back.`);
        }
        break;
      }
      case 'task.notice': {
        const n = data as { projectId: string; message: string };
        this.set((s) => ({ notices: { ...s.notices, [n.projectId]: n.message } }));
        break;
      }
      case 'handoff.requested': {
        const h = data as unknown as PendingHandoff;
        this.set((s) => ({ handoffs: [...s.handoffs.filter((x) => x.id !== h.id), h] }));
        break;
      }
      case 'handoff.resolved': {
        const id = String(data.id);
        this.set((s) => ({ handoffs: s.handoffs.filter((x) => x.id !== id) }));
        break;
      }
      case 'settings.changed':
        // Someone (this window, another one, Claude Code) changed keys or routes: re-read them.
        if (this.state.settings) await this.loadSettings();
        break;
      case 'job.updated': {
        const j = data as unknown as JobUpdate;
        this.set((s) => ({ jobs: { ...s.jobs, [j.jobId]: j } }));
        break;
      }
      default:
        break;
    }
  }

  private async applyChange(c: ProjectChanged) {
    const current = this.state.projects[c.projectId];
    if (!current) return;
    if (c.version <= current.version) return; // already have it (we fetched after it happened)
    if (c.version !== current.version + 1) {
      await this.refetchProject(c.projectId); // missed one: don't guess
      return;
    }
    const project = applyPatches(current.project, c.patches);
    this.putProject({
      ...current,
      project,
      version: c.version,
      canUndo: c.canUndo,
      canRedo: c.canRedo,
    });
  }

  private putProject(view: ProjectView) {
    this.set((s) => ({
      projects: { ...s.projects, [view.id]: view },
      order: s.order.includes(view.id) ? s.order : [...s.order, view.id],
    }));
  }

  private removeProject(id: string) {
    this.set((s) => {
      const { [id]: _gone, ...projects } = s.projects;
      const { [id]: _brief, ...briefs } = s.briefs;
      const { [id]: _tips, ...captureTips } = s.captureTips;
      const { [id]: _notice, ...notices } = s.notices;
      const { [id]: _why, ...decisions } = s.decisions;
      return {
        projects,
        briefs,
        captureTips,
        notices,
        decisions,
        order: s.order.filter((x) => x !== id),
      };
    });
  }

  private async refetchProject(id: string) {
    if (!this.client) return;
    try {
      this.putProject(await this.client.getProject(id));
    } catch (err) {
      if (err instanceof ServiceError && err.status === 404) this.removeProject(id);
      else throw err;
    }
  }

  private async refetchAll() {
    if (!this.client) return;
    const open = await this.client.listProjects();
    const views = await Promise.all(open.map((p) => this.client!.getProject(p.id)));
    this.set({
      projects: Object.fromEntries(views.map((v) => [v.id, v])),
      order: views.map((v) => v.id),
    });
  }

  // ---- actions (errors become toasts; each returns whether it worked) ----
  private async run<T>(fn: (c: ClientLike) => Promise<T>): Promise<T | undefined> {
    if (!this.client) return undefined;
    try {
      return await fn(this.client);
    } catch (err) {
      this.toast('error', describeFailure(err));
      return undefined;
    }
  }

  /** Resolves once the local copy has caught up to `version`, so a caller reads what it wrote. */
  private waitForVersion(projectId: string, version: number, timeoutMs = 3000): Promise<void> {
    const reached = () => (this.state.projects[projectId]?.version ?? 0) >= version;
    if (reached()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => (off(), clearTimeout(timer), resolve());
      const off = this.subscribe(() => reached() && done());
      const timer = setTimeout(
        () => void this.refetchProject(projectId).then(done, done),
        timeoutMs,
      );
    });
  }

  async openProject(dir: string): Promise<string | null> {
    const view = await this.run((c) => c.openProject(dir));
    if (!view) return null;
    this.putProject(view);
    return view.id;
  }

  async createProject(p: {
    dir: string;
    name: string;
    videoTypeId?: string;
  }): Promise<string | null> {
    const view = await this.run((c) => c.createProject(p));
    if (!view) return null;
    this.putProject(view);
    return view.id;
  }

  async closeProject(id: string): Promise<boolean> {
    const r = await this.run((c) => c.closeProject(id));
    if (!r) return false;
    this.removeProject(id);
    return true;
  }

  async command(projectId: string, type: string, payload: unknown): Promise<boolean> {
    const r = await this.run((c) => c.command(projectId, type, payload));
    if (!r) return false;
    await this.waitForVersion(projectId, r.version);
    return true;
  }

  async undo(projectId: string): Promise<boolean> {
    const r = await this.run((c) => c.undo(projectId));
    if (!r) return false;
    await this.waitForVersion(projectId, r.version);
    return r.done;
  }

  async redo(projectId: string): Promise<boolean> {
    const r = await this.run((c) => c.redo(projectId));
    if (!r) return false;
    await this.waitForVersion(projectId, r.version);
    return r.done;
  }

  async startTask(projectId: string, req: TaskRequest): Promise<TaskView | null> {
    const t = await this.run((c) => c.startTask(projectId, req));
    if (!t) return null;
    this.set((s) => ({ tasks: { ...s.tasks, [t.id]: s.tasks[t.id] ?? t } }));
    return t;
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.run((c) => c.cancelTask(taskId));
  }

  // ---- brief ----
  private briefLoading = new Map<string, number>();

  /**
   * Make sure the brief form for the project's current version is loaded. Cheap to call on every
   * render-effect: it does nothing when the stored form is current or a fetch for this version
   * is already running.
   */
  async loadBrief(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    if (this.state.briefs[projectId]?.version === version) return;
    if (this.briefLoading.get(projectId) === version) return;
    this.briefLoading.set(projectId, version);
    try {
      const form = await this.client.briefForm(projectId);
      // Keep the newest read if two overlapped.
      if ((this.state.briefs[projectId]?.version ?? -1) <= version) {
        this.set((s) => ({ briefs: { ...s.briefs, [projectId]: { version, form } } }));
      }
    } catch (err) {
      this.toast('error', describeFailure(err));
    } finally {
      if (this.briefLoading.get(projectId) === version) this.briefLoading.delete(projectId);
    }
  }

  async answerBrief(projectId: string, questionId: string, value: unknown): Promise<boolean> {
    const r = await this.run((c) => c.answerBrief(projectId, questionId, value));
    if (!r) return false;
    await this.waitForVersion(projectId, r.version);
    return true;
  }

  /** A proposal for one field; nothing is saved until the user accepts it. */
  async suggestBrief(projectId: string, questionId: string): Promise<BriefSuggestion | null> {
    return (await this.run((c) => c.suggestBrief(projectId, questionId))) ?? null;
  }

  /** Returns how many assumptions were logged, or null if it failed. */
  async assumeMissing(projectId: string): Promise<number | null> {
    const r = await this.run((c) => c.assumeMissing(projectId));
    if (!r) return null;
    await this.waitForVersion(projectId, r.version);
    return r.added;
  }

  // ---- settings ----
  async loadSettings(): Promise<void> {
    const data = await this.run(async (c) => {
      const [providers, routes, secrets] = await Promise.all([
        c.llmProviders(),
        c.llmRoutes(),
        c.secrets(),
      ]);
      return { providers, routes, secrets } satisfies SettingsData;
    });
    if (data) this.set({ settings: data });
  }

  /** The key is sent once and never read back. */
  async setApiKey(value: string): Promise<boolean> {
    const r = await this.run((c) => c.setApiKey(value));
    if (!r) return false;
    await this.loadSettings();
    return true;
  }

  async clearApiKey(): Promise<boolean> {
    const r = await this.run((c) => c.clearApiKey());
    if (!r) return false;
    await this.loadSettings();
    return true;
  }

  async saveRoutes(config: unknown): Promise<boolean> {
    const r = await this.run((c) => c.saveRoutes(config));
    if (!r) return false;
    await this.loadSettings();
    return true;
  }

  async resetRoutes(): Promise<boolean> {
    const r = await this.run((c) => c.resetRoutes());
    if (!r) return false;
    await this.loadSettings();
    return true;
  }

  // ---- Copy prompt to chat ----
  async replyHandoff(id: string, text: string): Promise<boolean> {
    return !!(await this.run((c) => c.replyHandoff(id, text)));
  }

  async cancelHandoff(id: string): Promise<boolean> {
    return !!(await this.run((c) => c.cancelHandoff(id)));
  }

  // ---- LLM disclosure ----
  /** What a generation would send and to whom; null if the request failed (a toast says why). */
  async llmPreview(
    projectId: string,
    task:
      'storyboard.generate' | 'storyboard.regenerate-section' | 'brief.suggest' | 'capture.tips',
  ): Promise<LlmPreview | null> {
    return (await this.run((c) => c.llmPreview(projectId, task))) ?? null;
  }

  // ---- the cut ----

  async loadCutGrid(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    try {
      const grid = await this.client.cutGrid(projectId);
      this.set((s) => ({ cutGrid: { ...s.cutGrid, [projectId]: { version, grid } } }));
    } catch {
      // No storyboard yet, or the engine is busy: the page shows what it can.
    }
  }

  /** Builds or rebuilds the rough cut (one undo step); returns what happened, or null on failure. */
  async generateCut(
    projectId: string,
  ): Promise<Awaited<ReturnType<ServiceClient['generateCut']>> | null> {
    const r = await this.run((c) => c.generateCut(projectId));
    if (!r) return null;
    this.toast(
      'info',
      `Rough cut ready: ${r.items} items, ${r.placeholders} placeholder${r.placeholders === 1 ? '' : 's'}. Undo goes back.`,
    );
    return r;
  }

  private mediaUrls = new Map<string, Promise<string | null>>();

  /** A playable address for a recording's editing copy or a music file (fetched once with the token). */
  mediaUrl(assetId: string, what: 'proxy' | 'audio'): Promise<string | null> {
    const key = `${what}:${assetId}`;
    let url = this.mediaUrls.get(key);
    if (!url) {
      url = this.run((c) => c.media(assetId, what)).then((b) =>
        b ? URL.createObjectURL(b) : null,
      );
      this.mediaUrls.set(key, url);
      void url.then((u) => u === null && this.mediaUrls.delete(key));
    }
    return url;
  }

  // ---- footage ----

  /** Reads recordings, job progress and suggestions; a quiet failure leaves the old snapshot. */
  async refreshFootage(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    try {
      const [status, matches] = await Promise.all([
        this.client.footage(projectId),
        this.state.projects[projectId]?.project.storyboard
          ? this.client.footageMatches(projectId)
          : Promise.resolve({ matches: [], recordings: [] }),
      ]);
      this.set((s) => ({ footage: { ...s.footage, [projectId]: { status, matches, version } } }));
    } catch {
      // The engine is busy or the project closed: keep what is shown.
    }
  }

  async importFootage(projectId: string, paths: string[]): Promise<boolean> {
    const r = await this.run((c) => c.importFootage(projectId, paths));
    if (!r) return false;
    if (r.jobs.length === 0) {
      this.toast(
        'error',
        'No recordings found there. Choose video files, or a folder that has some.',
      );
      return false;
    }
    this.toast('info', `Importing ${r.jobs.length} recording${r.jobs.length === 1 ? '' : 's'}…`);
    await this.refreshFootage(projectId);
    return true;
  }

  async analyzeFootage(projectId: string): Promise<boolean> {
    const r = await this.run((c) => c.analyzeFootage(projectId));
    if (!r) return false;
    this.toast(
      'info',
      r.jobs.length
        ? `Analysing ${r.jobs.length} item${r.jobs.length === 1 ? '' : 's'} on this computer…`
        : 'Everything is already analysed.',
    );
    await this.refreshFootage(projectId);
    return true;
  }

  async acceptMatches(
    projectId: string,
    minConfidence: 'certain' | 'high' | 'medium' = 'high',
  ): Promise<number> {
    const r = await this.run((c) => c.acceptMatches(projectId, { minConfidence }));
    if (!r) return 0;
    this.toast(
      r.attached.length ? 'info' : 'error',
      r.attached.length
        ? `Attached ${r.attached.length} recording${r.attached.length === 1 ? '' : 's'}. Undo goes back.`
        : 'Nothing was confident enough to attach on its own. Choose a shot for each recording below.',
    );
    await this.refreshFootage(projectId);
    return r.attached.length;
  }

  // ---- capture ----
  private tipsLoading = new Map<string, number>();

  /**
   * Which stored capture tips are fresh or out of date. That needs the engine (it hashes what a
   * request would contain), so it is read per project version like the brief form.
   */
  async loadCaptureTips(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    if (this.state.captureTips[projectId]?.version === version) return;
    if (this.tipsLoading.get(projectId) === version) return;
    this.tipsLoading.set(projectId, version);
    try {
      const view = await this.client.capture(projectId);
      if ((this.state.captureTips[projectId]?.version ?? -1) <= version) {
        this.set((s) => ({
          captureTips: { ...s.captureTips, [projectId]: { version, groups: view.tips.groups } },
        }));
      }
    } catch {
      // No storyboard yet, or the engine is busy: the page shows tips without a freshness badge.
    } finally {
      if (this.tipsLoading.get(projectId) === version) this.tipsLoading.delete(projectId);
    }
  }

  /** Writes the pack under the project's exports folder. */
  async exportCapture(
    projectId: string,
    opts: { formats?: ('md' | 'html' | 'json')[]; omitExcluded?: boolean },
  ): Promise<ExportOutcome | null> {
    return (await this.run((c) => c.exportCapture(projectId, opts))) ?? null;
  }

  /** The pack as text, to hand to the browser's own save or download. */
  async renderCapture(
    projectId: string,
    opts: { format: 'md' | 'html' | 'json'; omitExcluded?: boolean },
  ): Promise<RenderedPack | null> {
    return (await this.run((c) => c.renderCapture(projectId, opts))) ?? null;
  }

  // ---- decision log ----
  async loadDecisions(projectId: string): Promise<void> {
    if (!this.client || !this.state.projects[projectId]) return;
    try {
      const list = (await this.client.decisions(projectId, 100)) as DecisionRecord[];
      this.set((s) => ({ decisions: { ...s.decisions, [projectId]: list } }));
    } catch (err) {
      this.toast('error', describeFailure(err));
    }
  }

  // ---- toasts ----
  toast(kind: Toast['kind'], message: string): void {
    const t: Toast = { id: ++this.toastId, kind, message };
    this.set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
  }
  dismissToast = (id: number): void =>
    this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** The task currently running on a project, if any. */
export function busyTask(state: AppState, projectId: string): TaskView | undefined {
  return Object.values(state.tasks).find(
    (t) => t.projectId === projectId && t.status === 'running',
  );
}
