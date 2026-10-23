import type { Project } from '@trailerforge/schema';
import type { ChangeEvent, ProjectStore } from './store/project-store.js';

/**
 * Core project events. Plugins emit and listen to their own namespaced events
 * (`<pluginId>/<event>`) through the untyped overloads.
 */
export interface CoreEvents {
  'core/project.opened': { projectId: string; dir: string };
  'core/project.changed': { projectId: string; change: Omit<ChangeEvent, 'project'> };
  'core/project.saved': { projectId: string; dir: string };
  'core/project.closed': { projectId: string; dir: string };
  'core/storyboard.approved': { projectId: string; storyboardId: string; revision: number };
  'core/footage.ingested': { projectId: string; assetIds: string[] };
  'core/job.updated': {
    jobId: string;
    type: string;
    status: string;
    progress: number;
    projectId: string | null;
  };
  'core/render.done': { projectId: string; timelineId: string; outputs: string[] };
}

type Handler = (payload: unknown) => unknown;

export interface EventBusOptions {
  /** Called when a handler throws or rejects. Handlers never break emitters or each other. */
  onError?: (err: unknown, type: string) => void;
}

/**
 * Synchronous in-process event bus. Handlers run in subscription order; a handler added or
 * removed during dispatch takes effect from the next emit.
 */
export class EventBus<E extends object = CoreEvents> {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly anyHandlers = new Set<(type: string, payload: unknown) => void>();

  constructor(private readonly opts: EventBusOptions = {}) {}

  on<K extends keyof E & string>(type: K, handler: (payload: E[K]) => unknown): () => void;
  on(type: string, handler: (payload: unknown) => unknown): () => void;
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(type);
    };
  }

  once<K extends keyof E & string>(type: K, handler: (payload: E[K]) => void): () => void;
  once(type: string, handler: (payload: unknown) => void): () => void;
  once(type: string, handler: Handler): () => void {
    const off = this.on(type, (payload: unknown) => {
      off();
      return handler(payload);
    });
    return off;
  }

  /** Observe every event (logging, devtools, the future Planner's activity feed). */
  onAny(handler: (type: string, payload: unknown) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
  emit(type: string, payload: unknown): void;
  emit(type: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])])
      this.invoke(type, () => handler(payload));
    for (const handler of [...this.anyHandlers]) this.invoke(type, () => handler(type, payload));
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  private invoke(type: string, fn: () => unknown): void {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch((err: unknown) => this.report(err, type));
    } catch (err) {
      this.report(err, type);
    }
  }

  private report(err: unknown, type: string): void {
    try {
      this.opts.onError?.(err, type);
    } catch {
      // an error reporter that throws must not break dispatch either
    }
  }
}

/** Forward a store's changes to the bus. Returns an unsubscribe function. */
export function bridgeProjectStore(store: ProjectStore, bus: EventBus<CoreEvents>): () => void {
  return store.subscribe(({ project, ...change }: ChangeEvent & { project: Project }) => {
    bus.emit('core/project.changed', { projectId: project.id, change });
  });
}
