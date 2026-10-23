import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CommandRegistry } from '@trailerforge/core';
import {
  bridgeProjectStore,
  coreCommands,
  EventBus,
  ProjectStore,
  type CoreEvents,
} from '@trailerforge/core';
import { JobQueue } from '@trailerforge/jobs';
import { PluginHost, type Plugin, type PluginStatus } from '@trailerforge/plugin-api';
import { PROJECT_SCHEMA_VERSION, type ProjectInput } from '@trailerforge/schema';
import { gameTrailerPack } from '@trailerforge/pack-game-trailer';
import { corePlugin } from './core-plugin.js';

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
    return new Engine(home, bus, host, commands, jobs, status, opts.autosaveMs ?? 2000);
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
