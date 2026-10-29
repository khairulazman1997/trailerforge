import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Egress, LibraryStore, type CommandRegistry } from '@trailerforge/core';
import {
  PINNED_VISION_MODEL,
  registerAnalysisJobs,
  sidecarEmbedder,
  type VisionEmbedder,
  type VisionModelManifest,
} from '@trailerforge/analysis';
import { Ingestor, registerIngestJobs } from '@trailerforge/ingest';
import {
  bridgeProjectStore,
  coreCommands,
  EventBus,
  ProjectStore,
  type CoreEvents,
} from '@trailerforge/core';
import { JobQueue } from '@trailerforge/jobs';
import {
  createAnthropicProvider,
  createChatHandoffProvider,
  createClaudeCodeProvider,
  createOllamaProvider,
  normalizeOllamaUrl,
  LlmClient,
  loadRoutesConfig,
  type ClaudeCodeOptions,
  type LlmClientOptions,
} from '@trailerforge/llm';
import { PluginHost, type Plugin, type PluginStatus } from '@trailerforge/plugin-api';
import {
  PROJECT_SCHEMA_VERSION,
  type KnowledgeEntity,
  type ProjectInput,
} from '@trailerforge/schema';
import {
  detectCapabilities,
  resolveTools,
  type Capabilities,
  type FfmpegTools,
} from '@trailerforge/media';
import { excludedTerms, gameTrailerPack } from '@trailerforge/pack-game-trailer';
import { FilterRegistry } from '@trailerforge/effects';
import { corePlugin } from './core-plugin.js';
import { HandoffHub } from './handoff.js';
import { openFileSecretStore, type SecretStore } from './secrets.js';
import { WatchedFolders } from './watched-folders.js';

export interface EngineOptions {
  /** App data dir (job DB, temp, plugins). Default: $TFORGE_HOME or ~/.trailerforge */
  home?: string;
  /** Extra plugins (after the built-in core plugin and Game Trailer pack). */
  plugins?: Plugin[];
  /** Also load drop-in plugins from `<home>/plugins`. Default true. */
  loadUserPlugins?: boolean;
  featureFlags?: string[];
  jobConcurrency?: number;
  autosaveMs?: number;
  /** The FFmpeg to check and use (tests point it at a fake one). Default: `TFORGE_FFMPEG_DIR` or PATH. */
  ffmpegTools?: FfmpegTools;
  /** Replace the default LLM client (Anthropic API, then Claude Code) with your own. */
  llm?: LlmClient;
  /** Where API keys are kept. Default: a file only the current user can read, under `home`. */
  secrets?: SecretStore;
  /** Options for the Claude Code CLI provider (tests point it at a fake CLI). */
  claudeCode?: ClaudeCodeOptions;
  /** The network door's fetch (tests inject one). Default: the global `fetch`. */
  egressFetch?: typeof fetch;
  /** The opt-in vision model. Default: the one pinned in this build (null hides the feature). */
  visionModel?: VisionModelManifest | null;
  /** Builds the vision embedder for a model folder (tests pass a stub). Default: the sidecar. */
  visionEmbedder?: (modelDir: string, modelId: string) => VisionEmbedder;
  /** How often watched folders are polled, in ms (default 2,000). */
  watchIntervalMs?: number;
  /** Disclosure gate for the default client; called before any request leaves the machine. */
  approveSend?: LlmClientOptions['approveSend'];
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TFORGE_HOME ?? join(homedir(), '.trailerforge');
}

/**
 * Wires the subsystems together: plugins register into the host; their commands and job types
 * are installed into the command registry and job queue; stores and jobs report on the bus.
 * UI shells (Electron, web) and the CLI all talk to this.
 */
export class Engine {
  readonly projects = new Map<string, ProjectStore>();
  private readonly unbridge = new Map<string, () => void>();

  private constructor(
    readonly home: string,
    readonly bus: EventBus<CoreEvents>,
    readonly plugins: PluginHost,
    readonly commands: CommandRegistry,
    readonly jobs: JobQueue,
    readonly library: LibraryStore,
    readonly ingestor: Ingestor,
    readonly watched: WatchedFolders,
    readonly egress: Egress,
    readonly vision: {
      manifest: VisionModelManifest | null;
      embedder: (modelDir: string, modelId: string) => VisionEmbedder;
    },
    readonly llm: LlmClient,
    readonly secrets: SecretStore,
    readonly handoff: HandoffHub,
    readonly routesPath: string,
    readonly pluginStatus: PluginStatus[],
    private readonly autosaveMs: number,
  ) {}

  static async start(opts: EngineOptions = {}): Promise<Engine> {
    const home = resolve(opts.home ?? defaultHome());
    await mkdir(join(home, 'plugins'), { recursive: true });
    const bus = new EventBus<CoreEvents>({
      onError: (err, type) => console.error(`[event ${type}]`, err),
    });
    const host = new PluginHost({ events: bus, featureFlags: opts.featureFlags ?? [] });
    const status = [
      ...(await host.load([corePlugin, gameTrailerPack, ...(opts.plugins ?? [])])),
      ...(opts.loadUserPlugins === false
        ? []
        : await host.loadFromDirectory(join(home, 'plugins'))),
    ];

    const commands = coreCommands();
    for (const { def } of host.registries.commands.list()) commands.register(def);

    const jobs = new JobQueue({
      dbPath: join(home, 'jobs.sqlite'),
      tempRoot: join(home, 'tmp'),
      concurrency: opts.jobConcurrency ?? 2,
    });
    for (const { def } of host.registries.jobs.list()) jobs.register(def);
    // Footage ingest and local analysis: registered before the queue starts, so a job left
    // running by a crash resumes at startup.
    const library = await LibraryStore.open(home);
    registerIngestJobs({ library, queue: jobs, home });
    const embedder = opts.visionEmbedder ?? ((dir: string, id: string) => sidecarEmbedder(dir, id));
    registerAnalysisJobs(jobs, { visionEmbedder: embedder });
    const ingestor = new Ingestor({ queue: jobs });
    const watched = new WatchedFolders(home, ingestor, opts.watchIntervalMs);
    const egress = new Egress({
      logFile: join(home, 'logs', 'egress.jsonl'),
      ...(opts.egressFetch ? { fetch: opts.egressFetch } : {}),
    });
    jobs.subscribe(({ job }) =>
      bus.emit('core/job.updated', {
        jobId: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        projectId: job.projectId,
      }),
    );
    jobs.start();

    // Providers are built lazily and only used if the routes pick them, so starting the engine
    // never touches the network or needs a key.
    const secrets = opts.secrets ?? (await openFileSecretStore(join(home, 'secrets.json')));
    const handoff = new HandoffHub();
    const chat = createChatHandoffProvider(handoff);
    const providers = {
      // A key saved in settings wins; ANTHROPIC_API_KEY is the fallback.
      // Both go out only through Egress: purpose stated, hosts allow-listed, exclusions checked.
      'core/anthropic': createAnthropicProvider({
        apiKey: () => secrets.get('anthropic-api-key'),
        fetch: egress.llmFetch({ provider: 'core/anthropic', hosts: ['api.anthropic.com'] }),
      }),
      // A model on this computer: only `localhost` is reachable for it, whatever the address says.
      'core/ollama': createOllamaProvider({
        fetch: egress.llmFetch({ provider: 'core/ollama', hosts: [], localhost: true }),
        scope: (purpose, run) => egress.scope({ purpose }, run),
      }),
      'core/claude-code': createClaudeCodeProvider({
        ...opts.claudeCode,
        handOff: (text) =>
          egress.handOff({ provider: 'core/claude-code', tool: 'claude-code', text }),
      }),
      // Only offered while something (the service) can show the prompt to a person.
      'core/chat-handoff': {
        ...chat,
        available: async () =>
          handoff.available
            ? { ok: true as const }
            : { ok: false as const, reason: 'Copy-to-chat needs the TrailerForge app open' },
      },
    };
    const routesPath = join(home, 'llm.routes.json');
    const llm =
      opts.llm ??
      new LlmClient({
        providers: (id) => providers[id as keyof typeof providers],
        routes: await loadRoutesConfig(routesPath),
        ...(opts.approveSend ? { approveSend: opts.approveSend } : {}),
        scope: (info, run) =>
          egress.scope(
            {
              purpose: `AI request "${info.task}" (${info.provider.name})`,
              // Exclusions keep names off other people's servers; a model on this computer may see them.
              forbidden: info.provider.sendsDataOffDevice ? info.forbidden : [],
            },
            run,
          ),
      });
    const engine = new Engine(
      home,
      bus,
      host,
      commands,
      jobs,
      library,
      ingestor,
      watched,
      egress,
      {
        manifest: opts.visionModel === undefined ? PINNED_VISION_MODEL : opts.visionModel,
        embedder,
      },
      llm,
      secrets,
      handoff,
      routesPath,
      status,
      opts.autosaveMs ?? 2000,
    );
    engine.ollama = providers['core/ollama'];
    engine.tools = opts.ffmpegTools ?? resolveTools();
    await watched.start();
    return engine;
  }

  /** Providers shown in settings and accepted in routes: the built-in ones plus any a route names. */
  /**
   * The LLM client for work on one project: every request it makes carries the project's
   * "keep out of AI requests" names to the network boundary, which refuses a request naming one.
   */
  llmFor(store: { state: { knowledge: readonly KnowledgeEntity[] } }): LlmClient {
    return this.llm.withForbidden(excludedTerms(store.state.knowledge));
  }

  /** The local model provider (Ollama), for the model list in settings. */
  ollama!: ReturnType<typeof createOllamaProvider>;

  /** The FFmpeg and ffprobe in use. */
  tools!: FfmpegTools;
  private caps: Promise<Capabilities> | undefined;

  /** What this FFmpeg build can do (read once; `forget` re-reads after the user installs another). */
  capabilities(forget = false): Promise<Capabilities> {
    if (forget || !this.caps) {
      this.caps = detectCapabilities(this.tools);
      this.caps.catch(() => (this.caps = undefined));
    }
    return this.caps;
  }

  /** Where the local model server is expected to listen. */
  ollamaUrl(): string {
    return normalizeOllamaUrl(process.env.OLLAMA_HOST);
  }

  llmProviderIds(): string[] {
    const cfg = this.llm.routesConfig;
    return [
      ...new Set([
        'core/anthropic',
        'core/claude-code',
        'core/chat-handoff',
        'core/ollama',
        ...Object.values(cfg.routes).map((r) => r.provider),
        ...(cfg.default ? [cfg.default.provider] : []),
        ...cfg.fallbacks,
      ]),
    ];
  }

  /** The installed transitions and effects (built in and from plugins), for generation and pickers. */
  filters(): FilterRegistry {
    const reg = new FilterRegistry();
    for (const d of this.plugins.registries.transitions.list()) reg.register(d as never);
    for (const d of this.plugins.registries.effects.list()) reg.register(d as never);
    return reg;
  }

  async createProject(
    dir: string,
    init: Partial<ProjectInput> & { name: string },
  ): Promise<ProjectStore> {
    const now = new Date().toISOString();
    const store = await ProjectStore.create(
      resolve(dir),
      {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: `proj_${randomUUID().slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        domainPackId: 'game-trailer',
        brief: {},
        ...init,
      },
      this.storeOptions(),
    );
    return this.track(store);
  }

  async openProject(dir: string): Promise<ProjectStore> {
    const existing = this.projects.get(resolve(dir));
    if (existing) return existing;
    return this.track(await ProjectStore.open(resolve(dir), this.storeOptions()));
  }

  async closeProject(dir: string): Promise<void> {
    const key = resolve(dir);
    const store = this.projects.get(key);
    if (!store) return;
    await store.close();
    this.unbridge.get(key)?.();
    this.unbridge.delete(key);
    this.projects.delete(key);
    this.bus.emit('core/project.closed', { projectId: store.state.id, dir: key });
  }

  async close(): Promise<void> {
    await this.watched.stop();
    for (const dir of [...this.projects.keys()]) await this.closeProject(dir);
    await this.jobs.close();
  }

  private storeOptions() {
    return { commands: this.commands, autosaveMs: this.autosaveMs };
  }

  private track(store: ProjectStore): ProjectStore {
    const dir = store.paths.dir;
    this.projects.set(dir, store);
    this.unbridge.set(dir, bridgeProjectStore(store, this.bus));
    this.bus.emit('core/project.opened', { projectId: store.state.id, dir });
    return store;
  }
}
