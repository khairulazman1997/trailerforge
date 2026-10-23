import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandDef } from '@trailerforge/core';
import type { JobDefinition } from '@trailerforge/jobs';
import {
  ExportPreset,
  PlatformProfile,
  UiPanel,
  VideoTypeDef,
  type AnalysisStep,
  type EffectDef,
  type KnowledgeExtractor,
  type LlmProvider,
  type MotionRenderer,
  type StoryboardTemplate,
  type TransitionDef,
} from './contributions.js';
import { PLUGIN_API_VERSION, PluginManifest, type Plugin } from './manifest.js';
import { Registry } from './registry.js';
import type { z } from 'zod';

/** Wrappers for contributions keyed by something other than `id`. */
export interface CommandContribution {
  id: string;
  def: CommandDef<unknown>;
}
export interface JobContribution {
  id: string;
  def: JobDefinition<unknown, unknown, unknown>;
}

export interface EventSource {
  on(type: string, handler: (payload: unknown) => void): () => void;
}

export interface PluginStatus {
  id: string;
  version: string | null;
  state: 'active' | 'disabled';
  error?: string;
}

export interface PluginHostOptions {
  featureFlags?: Iterable<string>;
  /** Event bus (task 1.5). Without one, `ctx.on` throws. */
  events?: EventSource;
  /** Max time a plugin's `register` may take. Default 10 s. */
  registerTimeoutMs?: number;
  log?: (entry: { plugin: string; level: 'info' | 'warn' | 'error'; message: string }) => void;
}

/** What a plugin's `register(ctx)` receives. Every registration is attributed to the plugin. */
export interface PluginContext {
  readonly pluginId: string;
  videoTypes: { register(def: VideoTypeDef): void };
  templates: { register(def: StoryboardTemplate): void };
  platforms: { register(def: PlatformProfile): void };
  exportPresets: { register(def: ExportPreset): void };
  transitions: { register<P>(def: TransitionDef<P>): void };
  effects: { register<P>(def: EffectDef<P>): void };
  analysisSteps: { register(def: AnalysisStep): void };
  knowledgeExtractors: { register(def: KnowledgeExtractor): void };
  motionRenderers: { register(def: MotionRenderer): void };
  llmProviders: { register(def: LlmProvider): void };
  uiPanels: { register(def: UiPanel): void };
  commands: { register<P>(def: CommandDef<P>): void };
  jobs: { register<I, C, O>(def: JobDefinition<I, C, O>): void };
  features: { isEnabled(flag: string): boolean };
  on(type: string, handler: (payload: unknown) => void): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * Loads plugins and owns every registry. Built-in features load through the same path as
 * third-party plugins. A plugin loads all-or-nothing: if `register` throws (including a
 * rejected registration), everything it registered is rolled back and it is disabled.
 *
 * Plugins run in-process and are trusted code the user chose to install.
 */
export class PluginHost {
  readonly registries = {
    videoTypes: new Registry<z.output<typeof VideoTypeDef>>('video type', VideoTypeDef),
    templates: new Registry<StoryboardTemplate>('template'),
    platforms: new Registry<z.output<typeof PlatformProfile>>('platform', PlatformProfile),
    exportPresets: new Registry<z.output<typeof ExportPreset>>('export preset', ExportPreset),
    transitions: new Registry<TransitionDef>('transition'),
    effects: new Registry<EffectDef>('effect'),
    analysisSteps: new Registry<AnalysisStep>('analysis step'),
    knowledgeExtractors: new Registry<KnowledgeExtractor>('knowledge extractor'),
    motionRenderers: new Registry<MotionRenderer>('motion renderer'),
    llmProviders: new Registry<LlmProvider>('LLM provider'),
    uiPanels: new Registry<z.output<typeof UiPanel>>('UI panel', UiPanel),
    commands: new Registry<CommandContribution>('command'),
    jobs: new Registry<JobContribution>('job type'),
  };

  private readonly statuses = new Map<string, PluginStatus>();
  private readonly unsubscribers = new Map<string, (() => void)[]>();
  private readonly flags: Set<string>;

  constructor(private readonly opts: PluginHostOptions = {}) {
    this.flags = new Set(opts.featureFlags ?? []);
  }

  status(): PluginStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  isActive(id: string): boolean {
    return this.statuses.get(id)?.state === 'active';
  }

  /** Load a batch of plugins in dependency order. Returns the status of each. */
  async load(plugins: readonly Plugin[]): Promise<PluginStatus[]> {
    const byId = new Map<string, Plugin>();
    const keys: string[] = [];
    for (const [i, plugin] of plugins.entries()) {
      const manifest = PluginManifest.safeParse(pick(plugin));
      const id = manifest.success
        ? manifest.data.id
        : typeof plugin?.id === 'string'
          ? plugin.id
          : `<plugin #${i}>`;
      keys[i] = id;
      if (!manifest.success) {
        this.disable(
          id,
          null,
          `invalid manifest: ${manifest.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
        );
      } else if (typeof plugin.register !== 'function') {
        this.disable(id, plugin.version, 'missing register() function');
      } else if (manifest.data.apiVersion !== PLUGIN_API_VERSION) {
        this.disable(
          id,
          plugin.version,
          `needs plugin API v${manifest.data.apiVersion}; this app provides v${PLUGIN_API_VERSION}`,
        );
      } else if (byId.has(id) || this.statuses.has(id)) {
        keys[i] = `${id}#dup${i}`;
        this.disable(keys[i], plugin.version, `duplicate plugin id "${id}"`);
      } else {
        byId.set(id, plugin);
      }
    }

    for (const id of topoOrder(byId, (dep) => this.isActive(dep))) {
      const plugin = byId.get(id)!;
      const failedDep = (plugin.dependsOn ?? []).find((d) => !this.isActive(d));
      if (failedDep) {
        const why =
          byId.has(failedDep) || this.statuses.has(failedDep)
            ? 'failed to load'
            : 'is not installed';
        this.disable(id, plugin.version, `dependency "${failedDep}" ${why}`);
        continue;
      }
      try {
        await withTimeout(
          Promise.resolve(plugin.register(this.contextFor(id))),
          this.opts.registerTimeoutMs ?? 10_000,
          `register() of "${id}" timed out`,
        );
        this.statuses.set(id, { id, version: plugin.version, state: 'active' });
        this.log(id, 'info', `loaded ${plugin.name} ${plugin.version}`);
      } catch (err) {
        this.rollback(id);
        this.disable(id, plugin.version, err instanceof Error ? err.message : String(err));
      }
    }
    // Plugins left out of the order are part of a dependency cycle.
    for (const [id, plugin] of byId) {
      if (!this.statuses.has(id)) this.disable(id, plugin.version, 'dependency cycle');
    }
    return keys.map((k) => this.statuses.get(k)!);
  }

  /**
   * Load every plugin folder under `dir`. Each folder has a package.json whose `main` module
   * default-exports a plugin. Import errors disable that plugin only.
   */
  async loadFromDirectory(dir: string): Promise<PluginStatus[]> {
    const plugins: Plugin[] = [];
    const failed: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, entry.name);
      try {
        const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as {
          main?: string;
        };
        const mod = (await import(pathToFileURL(join(folder, pkg.main ?? 'index.js')).href)) as {
          default?: Plugin;
        };
        if (!mod.default) throw new Error('module has no default export');
        plugins.push(mod.default);
      } catch (err) {
        failed.push(`dir:${entry.name}`);
        this.disable(
          failed.at(-1)!,
          null,
          `could not load ${folder}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return [...failed.map((k) => this.statuses.get(k)!), ...(await this.load(plugins))];
  }

  private contextFor(owner: string): PluginContext {
    const r = this.registries;
    const reg = <T extends { id: string }>(registry: Registry<T>) => ({
      register: (def: unknown) => {
        registry.add(owner, def);
      },
    });
    return {
      pluginId: owner,
      videoTypes: reg(r.videoTypes),
      templates: reg(r.templates),
      platforms: reg(r.platforms),
      exportPresets: reg(r.exportPresets),
      transitions: reg(r.transitions),
      effects: reg(r.effects),
      analysisSteps: reg(r.analysisSteps),
      knowledgeExtractors: reg(r.knowledgeExtractors),
      motionRenderers: reg(r.motionRenderers),
      llmProviders: reg(r.llmProviders),
      uiPanels: reg(r.uiPanels),
      commands: { register: (def) => void r.commands.add(owner, { id: def.type, def }) },
      jobs: { register: (def) => void r.jobs.add(owner, { id: def.type, def }) },
      features: { isEnabled: (flag) => this.flags.has(flag) },
      on: (type, handler) => {
        if (!this.opts.events) throw new Error('event bus not available');
        const off = this.opts.events.on(type, (payload) => {
          try {
            handler(payload);
          } catch (err) {
            this.log(owner, 'error', `handler for "${type}" threw: ${String(err)}`);
          }
        });
        this.unsubscribers.set(owner, [...(this.unsubscribers.get(owner) ?? []), off]);
      },
      log: (level, message) => this.log(owner, level, message),
    };
  }

  private rollback(owner: string): void {
    for (const registry of Object.values(this.registries)) registry.removeOwner(owner);
    for (const off of this.unsubscribers.get(owner) ?? []) off();
    this.unsubscribers.delete(owner);
  }

  private disable(id: string, version: string | null, error: string): void {
    this.statuses.set(id, { id, version, state: 'disabled', error });
    this.log(id, 'error', `disabled: ${error}`);
  }

  private log(plugin: string, level: 'info' | 'warn' | 'error', message: string): void {
    this.opts.log?.({ plugin, level, message });
  }
}

function pick(p: Plugin | undefined): unknown {
  if (!p || typeof p !== 'object') return p;
  const { register: _r, ...manifest } = p;
  return manifest;
}

/** Kahn's algorithm over in-batch dependencies; already-loaded plugins count as satisfied. */
function topoOrder(plugins: Map<string, Plugin>, loaded: (id: string) => boolean): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, p] of plugins) {
    const deps = (p.dependsOn ?? []).filter((d) => plugins.has(d) && !loaded(d));
    indegree.set(id, deps.length);
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), id]);
  }
  const ready = [...plugins.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return order;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
