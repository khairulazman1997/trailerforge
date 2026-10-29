import type { LlmProvider, LlmResult } from '@trailerforge/plugin-api';
import type { z } from 'zod';
import { resolveRoute, type RoutesConfig } from './routes.js';

export class LlmConsentError extends Error {
  constructor(
    readonly task: string,
    readonly providerId: string,
  ) {
    super(`sending "${task}" to ${providerId} was not approved`);
    this.name = 'LlmConsentError';
  }
}

export interface LlmCallLog {
  task: string;
  provider: string;
  model: string;
  fellBack: boolean;
  ms: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface LlmClientOptions {
  providers: (id: string) => LlmProvider | undefined;
  routes: RoutesConfig;
  /**
   * Disclosure gate, called before any request that leaves the machine. Return false to block.
   * Default: allow (the UI wires a real prompt).
   */
  /** How long a provider's availability answer is reused. Default 10 s. */
  availabilityTtlMs?: number;
  approveSend?: (info: { task: string; provider: LlmProvider }) => boolean | Promise<boolean>;
  log?: (entry: LlmCallLog) => void;
  /**
   * Wraps every provider call (the app runs it inside `Egress.scope`, which states the purpose
   * and carries the names the project keeps out of AI requests to the network boundary).
   */
  scope?: <R>(
    info: { task: string; provider: LlmProvider; forbidden: readonly string[] },
    run: () => Promise<R>,
  ) => Promise<R>;
}

/** Routes each task to a provider, enforces the disclosure gate and logs every call. */
export class LlmClient {
  private availability = new Map<string, { at: number; ok: Promise<boolean> }>();
  private routes: RoutesConfig;
  private forbidden: readonly string[] = [];

  constructor(private readonly opts: LlmClientOptions) {
    this.routes = opts.routes;
  }

  /**
   * The same client, with names that must never leave in a request (a project's exclusions):
   * checked again at the network boundary on every call made through the view.
   */
  withForbidden(terms: readonly string[]): LlmClient {
    const view = Object.create(this) as LlmClient;
    Object.defineProperty(view, 'forbidden', { value: terms });
    return view;
  }

  /** The routes in effect (task -> provider/model/effort, default, fallbacks). */
  get routesConfig(): RoutesConfig {
    return this.routes;
  }

  /** Switch to new routes immediately, e.g. after the user edits `llm.routes.json`. */
  setRoutes(routes: RoutesConfig): void {
    this.routes = routes;
    this.invalidate();
  }

  /** Forget cached availability, e.g. after an API key was added or removed. */
  invalidate(): void {
    this.availability.clear();
  }

  /** Each provider's current availability, for a settings screen. Never sends anything. */
  async status(ids: readonly string[]): Promise<
    {
      id: string;
      name: string;
      kind: string;
      sendsDataOffDevice: boolean;
      available: { ok: true } | { ok: false; reason: string };
    }[]
  > {
    return Promise.all(
      ids.map(async (id) => {
        const p = this.opts.providers(id);
        if (!p) {
          return {
            id,
            name: id,
            kind: 'unknown',
            sendsDataOffDevice: false,
            available: { ok: false as const, reason: 'not installed' },
          };
        }
        const available = await p
          .available()
          .catch((e: unknown) => ({ ok: false as const, reason: String(e) }));
        return {
          id,
          name: p.name,
          kind: p.kind,
          sendsDataOffDevice: p.sendsDataOffDevice,
          available,
        };
      }),
    );
  }

  async generate<T>(
    task: string,
    req: { system: string; prompt: string; schema: z.ZodType<T> },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<LlmResult<T> & { provider: string; fellBack: boolean }> {
    const route = await resolveRoute(this.routes, task, (id) => this.isAvailable(id));
    const provider = this.opts.providers(route.provider)!;
    if (
      provider.sendsDataOffDevice &&
      this.opts.approveSend &&
      !(await this.opts.approveSend({ task, provider }))
    ) {
      throw new LlmConsentError(task, provider.id);
    }
    const started = Date.now();
    try {
      const call = () =>
        provider.generate(
          {
            task,
            ...req,
            ...(route.model ? { model: route.model } : {}),
            ...(route.effort ? { effort: route.effort } : {}),
          },
          signal,
        );
      const result = this.opts.scope
        ? await this.opts.scope({ task, provider, forbidden: this.forbidden }, call)
        : await call();
      this.opts.log?.({
        task,
        provider: provider.id,
        model: result.model,
        fellBack: route.fellBack,
        ms: Date.now() - started,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      return { ...result, provider: provider.id, fellBack: route.fellBack };
    } catch (err) {
      this.opts.log?.({
        task,
        provider: provider.id,
        model: route.model ?? '',
        fellBack: route.fellBack,
        ms: Date.now() - started,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Which provider, model and effort would handle `task` right now? Sends nothing and never
   * throws: when no provider is available the answer says why. This is what a "you are about to
   * send ..." dialog shows before the user agrees.
   */
  async describeRoute(
    task: string,
  ): Promise<
    | { ok: true; provider: LlmProvider; model?: string; effort?: string; fellBack: boolean }
    | { ok: false; reason: string }
  > {
    try {
      const route = await resolveRoute(this.routes, task, (id) => this.isAvailable(id));
      const provider = this.opts.providers(route.provider)!;
      return {
        ok: true,
        provider,
        ...(route.model ? { model: route.model } : {}),
        ...(route.effort ? { effort: route.effort } : {}),
        fellBack: route.fellBack,
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  private isAvailable(id: string): Promise<boolean> {
    const ttl = this.opts.availabilityTtlMs ?? 10_000;
    const hit = this.availability.get(id);
    if (hit && Date.now() - hit.at < ttl) return hit.ok;
    const provider = this.opts.providers(id);
    const ok = provider
      ? provider
          .available()
          .then((a) => a.ok)
          .catch(() => false)
      : Promise.resolve(false);
    this.availability.set(id, { at: Date.now(), ok });
    return ok;
  }
}
