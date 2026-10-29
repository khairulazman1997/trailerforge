import { applyPatches, enablePatches, type Patch } from 'immer';
import {
  ServiceError,
  type BriefForm,
  type BriefSuggestion,
  type CaptureView,
  type ClaudeCodeView,
  type ExportOutcome,
  type LibraryMediaKind,
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
  type LocalModelsView,
  type VisionView,
  type WatchedFoldersView,
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

export interface VersionsSnapshot {
  view: Awaited<ReturnType<ServiceClient['variants']>>;
  version: number;
}

export interface BrandSnapshot {
  view: Awaited<ReturnType<ServiceClient['brand']>>;
  version: number;
}

export interface ReviewSnapshot {
  views: Awaited<ReturnType<ServiceClient['review']>>;
  version: number;
}

export interface QualitySnapshot {
  report: Awaited<ReturnType<ServiceClient['quality']>>;
  version: number;
  /** The overrides it was computed with, so a changed reason refetches. */
  overrides: string;
}

/** Which version a render task was started for (this session). */
export interface RenderRun {
  projectId: string;
  kind: 'render-draft' | 'export' | 'handoff';
  variantId: string | null;
}

export interface RenderProgressView {
  kind: string;
  phase: string;
  fraction: number;
  message?: string | undefined;
}

/** The brand's logo and fonts as the browser holds them, for the preview. */
export interface BrandAssets {
  /** Identifies the files these were loaded from. */
  key: string;
  /** `<hash>.<ext>` names that loaded. */
  present: ReadonlySet<string>;
  /** `media/<hash>.<ext>` → data URI (the logo). */
  images: Record<string, string>;
}

export interface Catalog {
  templates: Awaited<ReturnType<ServiceClient['graphicTemplates']>>;
  effects: Awaited<ReturnType<ServiceClient['effects']>>;
}

export type ClientLike = Pick<
  ServiceClient,
  | 'info'
  | 'graphicTemplates'
  | 'effects'
  | 'variants'
  | 'review'
  | 'exportPresets'
  | 'approveVersion'
  | 'quality'
  | 'draft'
  | 'createDefaultVariants'
  | 'brand'
  | 'brandFile'
  | 'importBrandFile'
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
  | 'localModels'
  | 'useOfflineRoutes'
  | 'secrets'
  | 'setApiKey'
  | 'clearApiKey'
  | 'vision'
  | 'downloadVision'
  | 'watchedFolders'
  | 'claudeCode'
  | 'connectClaudeCode'
  | 'disconnectClaudeCode'
  | 'setWatchedFolders'
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
  /** The versions (derived from the master cut) and the brand kit, per project. */
  versions: Record<string, VersionsSnapshot>;
  /** What is installed: graphics templates, transitions, effects and sounds (read once). */
  catalog: Catalog | null;
  brands: Record<string, BrandSnapshot>;
  /** The brand's own fonts and logo, loaded into the page for the graphics preview. */
  brandAssets: Record<string, BrandAssets>;
  /** Each version's review state, per project. */
  review: Record<string, ReviewSnapshot>;
  /** The Quality Gate on a version's plan, by `<project>|<version>`. */
  quality: Record<string, QualitySnapshot>;
  /** Overrides the user has chosen for the next export, by `<project>|<version>` → check id → reason. */
  gateOverrides: Record<string, Record<string, string>>;
  /** The renders this page started, by task id. */
  renderRuns: Record<string, RenderRun>;
  /** The export presets (read once). */
  presets: Awaited<ReturnType<ServiceClient['exportPresets']>> | null;
  /** Progress of the render running in a project (events from the engine). */
  renderProgress: Record<string, RenderProgressView>;
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
  /** The opt-in vision model: state and disclosure; null until a screen asks. */
  vision: VisionView | null;
  localModels: LocalModelsView | null;
  /** Download progress 0–1 and its task, while the model is downloading. */
  visionDownload: { taskId: string; fraction: number } | null;
  /** Whether Claude Code is connected to this app's tools; null until Settings asks. */
  claudeCode: ClaudeCodeView | null;
  /** Folders whose new recordings are imported automatically; null until a screen asks. */
  watched: WatchedFoldersView | null;
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
  versions: {},
  catalog: null,
  brands: {},
  brandAssets: {},
  review: {},
  quality: {},
  gateOverrides: {},
  renderRuns: {},
  presets: null,
  renderProgress: {},
  cutGrid: {},
  notices: {},
  decisions: {},
  handoffs: [],
  settings: null,
  vision: null,
  localModels: null,
  visionDownload: null,
  watched: null,
  claudeCode: null,
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
        if (t.kind === 'vision-download') {
          if (t.status === 'running') {
            this.set((s) => ({
              visionDownload: s.visionDownload ?? { taskId: t.id, fraction: 0 },
            }));
            break;
          }
          this.set({ visionDownload: null });
          await this.loadVision();
          if (t.status === 'succeeded')
            this.toast('info', 'AI vision is ready. It runs on this computer.');
          else if (t.status === 'failed')
            this.toast(
              'error',
              `The model download failed: ${t.error?.message ?? 'unknown error'}`,
            );
          break;
        }
        if (RENDER_KINDS.has(t.kind) && t.status !== 'running') {
          this.set((s) => {
            const { [t.projectId]: _p, ...renderProgress } = s.renderProgress;
            return { renderProgress };
          });
          if (t.status === 'succeeded') await this.refreshReview(t.projectId);
        }
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
        // Someone (this window, another one, Claude Code) changed keys, routes or watched folders.
        if (this.state.settings) await this.loadSettings();
        if (this.state.localModels) await this.loadLocalModels();
        if (this.state.watched) await this.loadWatched();
        break;
      case 'vision.progress': {
        const p = data as { taskId: string; fraction: number };
        this.set({ visionDownload: { taskId: p.taskId, fraction: p.fraction } });
        break;
      }
      case 'render.progress': {
        const { projectId, ...p } = data as unknown as { projectId: string } & RenderProgressView;
        this.set((s) => ({ renderProgress: { ...s.renderProgress, [projectId]: p } }));
        break;
      }
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
      const { [id]: _versions, ...versions } = s.versions;
      const { [id]: _brand, ...brands } = s.brands;
      const { [id]: _review, ...review } = s.review;
      const { [id]: _assets, ...brandAssets } = s.brandAssets;
      const renderRuns = Object.fromEntries(
        Object.entries(s.renderRuns).filter(([, r]) => r.projectId !== id),
      );
      const { [id]: _progress, ...renderProgress } = s.renderProgress;
      const mine = (k: string) => !k.startsWith(`${id}|`);
      const quality = Object.fromEntries(Object.entries(s.quality).filter(([k]) => mine(k)));
      const gateOverrides = Object.fromEntries(
        Object.entries(s.gateOverrides).filter(([k]) => mine(k)),
      );
      return {
        review,
        renderRuns,
        brandAssets,
        renderProgress,
        quality,
        gateOverrides,
        versions,
        brands,
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

  // ---- vision and watched folders ----

  async loadVision(): Promise<void> {
    const v = await this.run((c) => c.vision());
    if (v) this.set({ vision: v });
  }

  /** Start the one-time download; the caller has shown the disclosure and been told yes. */
  async startVisionDownload(): Promise<boolean> {
    const t = await this.run((c) => c.downloadVision());
    if (!t) return false;
    this.set((s) => ({ visionDownload: s.visionDownload ?? { taskId: t.id, fraction: 0 } }));
    return true;
  }

  async cancelVisionDownload(): Promise<void> {
    const d = this.state.visionDownload;
    if (d) await this.run((c) => c.cancelTask(d.taskId));
  }

  async loadClaudeCode(): Promise<void> {
    const v = await this.run((c) => c.claudeCode());
    if (v) this.set({ claudeCode: v });
  }

  async connectClaudeCode(mode: 'app' | 'standalone' = 'app'): Promise<boolean> {
    const v = await this.run((c) => c.connectClaudeCode(mode));
    if (!v) return false;
    this.set({ claudeCode: v });
    this.toast('info', 'Claude Code is connected. Start a new Claude Code session to use it.');
    return true;
  }

  async disconnectClaudeCode(): Promise<void> {
    const v = await this.run((c) => c.disconnectClaudeCode());
    if (v) this.set({ claudeCode: v });
  }

  async loadWatched(): Promise<void> {
    const w = await this.run((c) => c.watchedFolders());
    if (w) this.set({ watched: w });
  }

  async setWatched(folders: string[]): Promise<boolean> {
    const w = await this.run((c) => c.setWatchedFolders(folders));
    if (!w) return false;
    this.set({ watched: w });
    return true;
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

  /** Ask the local model server (on this computer) which models it has. */
  async loadLocalModels(): Promise<void> {
    const v = await this.run((c) => c.localModels());
    if (v) this.set({ localModels: v });
  }

  /** Route every task to one local model. */
  async useOfflineRoutes(model: string): Promise<boolean> {
    const r = await this.run((c) => c.useOfflineRoutes(model));
    if (!r) return false;
    await Promise.all([this.loadSettings(), this.loadLocalModels()]);
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
  mediaUrl(assetId: string, what: LibraryMediaKind): Promise<string | null> {
    const key = `${what}:${assetId}`;
    let url = this.mediaUrls.get(key);
    if (!url) {
      // A preview that is not built yet is normal, not an error to show.
      const quiet = what === 'thumbnail' || what === 'filmstrip';
      const fetchBlob = quiet
        ? this.client?.media(assetId, what).catch(() => undefined)
        : this.run((c) => c.media(assetId, what));
      url = Promise.resolve(fetchBlob).then((b) => (b ? URL.createObjectURL(b) : null));
      this.mediaUrls.set(key, url);
      void url.then((u) => u === null && this.mediaUrls.delete(key));
    }
    return url;
  }

  // ---- the brand's own fonts and logo in the preview ----

  /**
   * Loads the brand's font files into the page (as the family the brand declares) and its logo as
   * a data URI, so the preview draws what the final render draws. Files that fail to load are left
   * out, and the preview falls back to Inter for them, as the render does for a missing file.
   */
  async loadBrandAssets(projectId: string): Promise<void> {
    const brand = this.state.projects[projectId]?.project.brand;
    if (!this.client || !brand) return;
    const files = [
      ...(brand.logo ? [{ file: brand.logo }] : []),
      ...brand.fonts.map((f) => ({ file: f.file, font: f })),
    ];
    const key = files.map((f) => `${f.file.hash}.${f.file.ext}`).join('|');
    if (this.state.brandAssets[projectId]?.key === key) return;
    const present = new Set<string>();
    const images: Record<string, string> = {};
    for (const f of files) {
      const name = `${f.file.hash}.${f.file.ext}`;
      try {
        const blob = await this.client.brandFile(projectId, name);
        if ('font' in f && f.font) {
          if (typeof FontFace === 'undefined') continue;
          const face = new FontFace(f.font.family, await blob.arrayBuffer(), {
            weight: f.font.bold ? '700' : '400',
          });
          document.fonts.add(await face.load());
        } else {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          images[`media/${name}`] =
            `data:${f.file.ext === 'svg' ? 'image/svg+xml' : 'image/png'};base64,${btoa(bin)}`;
        }
        present.add(name);
      } catch {
        // Missing or unreadable: the preview falls back, with the brand page's warning.
      }
    }
    this.set((s) => ({ brandAssets: { ...s.brandAssets, [projectId]: { key, present, images } } }));
  }

  // ---- review, quality gate and drafts ----

  /** Reads every version's review state; a quiet failure keeps the old snapshot. */
  async refreshReview(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    try {
      const views = await this.client.review(projectId);
      this.set((s) => ({ review: { ...s.review, [projectId]: { views, version } } }));
    } catch {
      // Busy or closed: keep what is shown.
    }
  }

  /** The Quality Gate on a version's plan, with the overrides chosen so far. */
  async loadQuality(projectId: string, variantId: string | null): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    const key = `${projectId}|${variantId ?? 'master'}`;
    const chosen = this.state.gateOverrides[key] ?? {};
    const overrides = Object.entries(chosen)
      .filter(([, reason]) => reason.trim())
      .map(([checkId, reason]) => ({ checkId, reason }));
    const stamp = JSON.stringify(overrides);
    try {
      const report = await this.client.quality(projectId, variantId, overrides);
      this.set((s) => ({
        quality: { ...s.quality, [key]: { report, version, overrides: stamp } },
      }));
    } catch {
      // Keep what is shown.
    }
  }

  /** Chooses (or with an empty reason, drops) an override for the next export of a version. */
  setGateOverride(projectId: string, variantId: string | null, checkId: string, reason: string) {
    const key = `${projectId}|${variantId ?? 'master'}`;
    this.set((s) => {
      const mine = { ...(s.gateOverrides[key] ?? {}) };
      if (reason) mine[checkId] = reason;
      else delete mine[checkId];
      return { gateOverrides: { ...s.gateOverrides, [key]: mine } };
    });
  }

  private async startRender(
    projectId: string,
    run: Omit<RenderRun, 'projectId'>,
    req: TaskRequest,
  ): Promise<TaskView | null> {
    const t = await this.startTask(projectId, req);
    if (t) this.set((s) => ({ renderRuns: { ...s.renderRuns, [t.id]: { projectId, ...run } } }));
    return t;
  }

  async startDraft(projectId: string, variantId: string | null): Promise<boolean> {
    const t = await this.startRender(
      projectId,
      { kind: 'render-draft', variantId },
      { kind: 'render-draft', options: { variantId } },
    );
    return t !== null;
  }

  /** Export a version with the overrides (check id → reason) chosen on the Review tab. */
  async startExport(projectId: string, variantId: string | null): Promise<boolean> {
    const chosen = this.state.gateOverrides[`${projectId}|${variantId ?? 'master'}`] ?? {};
    const overrides = Object.entries(chosen)
      .filter(([, reason]) => reason.trim())
      .map(([checkId, reason]) => ({ checkId, reason }));
    const t = await this.startRender(
      projectId,
      { kind: 'export', variantId },
      { kind: 'export', options: { variantId, ...(overrides.length ? { overrides } : {}) } },
    );
    return t !== null;
  }

  async startHandoff(
    projectId: string,
    variantId: string | null,
    formats: ('fcpxml' | 'otio' | 'edl')[],
  ): Promise<boolean> {
    const t = await this.startRender(
      projectId,
      { kind: 'handoff', variantId },
      { kind: 'handoff', options: { variantId, formats } },
    );
    return t !== null;
  }

  /** Reads the export presets once; a quiet failure leaves them unset. */
  async loadPresets(): Promise<void> {
    if (this.state.presets || !this.client) return;
    try {
      this.set({ presets: await this.client.exportPresets() });
    } catch {
      // Try again the next time a screen asks.
    }
  }

  /** Approve a version as it is now. */
  async approve(projectId: string, variantId: string | null, note?: string): Promise<boolean> {
    const r = await this.run((c) => c.approveVersion(projectId, variantId, note));
    if (!r) return false;
    await this.waitForVersion(projectId, (this.state.projects[projectId]?.version ?? 0) + 1);
    await this.refreshReview(projectId);
    return true;
  }

  private draftUrls = new Map<string, Promise<string | null>>();

  /** A playable address for a version's current draft (fetched once per content, with the token). */
  draftUrl(
    projectId: string,
    variantId: string | null,
    contentHash: string,
  ): Promise<string | null> {
    const key = `${projectId}|${variantId ?? 'master'}|${contentHash}`;
    let url = this.draftUrls.get(key);
    if (!url) {
      url = Promise.resolve(this.client?.draft(projectId, variantId).catch(() => undefined)).then(
        (b) => (b ? URL.createObjectURL(b) : null),
      );
      this.draftUrls.set(key, url);
      void url.then((u) => u === null && this.draftUrls.delete(key));
    }
    return url;
  }

  // ---- versions and brand ----

  /** Reads what is installed once; a quiet failure leaves it unset (the screens say so). */
  async loadCatalog(): Promise<void> {
    if (this.state.catalog || !this.client) return;
    try {
      const [templates, effects] = await Promise.all([
        this.client.graphicTemplates(),
        this.client.effects(),
      ]);
      this.set({ catalog: { templates, effects } });
    } catch {
      // Try again the next time a screen asks.
    }
  }

  /** Reads the versions derived from the master cut; a quiet failure keeps the old snapshot. */
  async refreshVersions(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    try {
      const view = await this.client.variants(projectId);
      this.set((s) => ({ versions: { ...s.versions, [projectId]: { view, version } } }));
    } catch {
      // Busy or closed: keep what is shown.
    }
  }

  async createDefaultVersions(projectId: string): Promise<number> {
    const r = await this.run((c) => c.createDefaultVariants(projectId));
    if (!r) return 0;
    this.toast(
      'info',
      r.added.length
        ? `Added ${r.added.length} version${r.added.length === 1 ? '' : 's'}. Undo goes back.`
        : 'Every format already has a version.',
    );
    return r.added.length;
  }

  async refreshBrand(projectId: string): Promise<void> {
    const version = this.state.projects[projectId]?.version;
    if (version === undefined || !this.client) return;
    try {
      const view = await this.client.brand(projectId);
      this.set((s) => ({ brands: { ...s.brands, [projectId]: { view, version } } }));
    } catch {
      // Busy or closed: keep what is shown.
    }
  }

  /** Copies a logo or font (a path on the computer running the engine) into the project. */
  async importBrandFile(
    projectId: string,
    o: { kind: 'logo' | 'font'; path: string; role?: 'heading' | 'body'; bold?: boolean },
  ): Promise<boolean> {
    const r = await this.run((c) => c.importBrandFile(projectId, o));
    if (!r) return false;
    this.toast(
      'info',
      `${o.kind === 'logo' ? 'Logo' : 'Font'} set from ${r.file.name}. Undo goes back.`,
    );
    await this.waitForVersion(projectId, (this.state.projects[projectId]?.version ?? 0) + 1);
    await this.refreshBrand(projectId);
    return true;
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
          : Promise.resolve({ matches: [], recordings: [], usedVision: false }),
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

/** Renders only read the project, so editing goes on while they run. */
const RENDER_KINDS = new Set(['render-draft', 'export', 'handoff']);

/** The task currently running on a project, if any that pauses editing. */
export function busyTask(state: AppState, projectId: string): TaskView | undefined {
  return Object.values(state.tasks).find(
    (t) => t.projectId === projectId && t.status === 'running' && t.blocking !== false,
  );
}
