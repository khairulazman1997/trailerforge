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
  approveSend?: (info: { task: string; provider: LlmProvider }) => boolean | Promise<boolean>;
  log?: (entry: LlmCallLog) => void;
}

/** Routes each task to a provider, enforces the disclosure gate and logs every call. */
export class LlmClient {
  private readonly availability = new Map<string, Promise<boolean>>();

  constructor(private readonly opts: LlmClientOptions) {}

  async generate<T>(
    task: string,
    req: { system: string; prompt: string; schema: z.ZodType<T> },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<LlmResult<T> & { provider: string; fellBack: boolean }> {
    const route = await resolveRoute(this.opts.routes, task, (id) => this.isAvailable(id));
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
      const result = await provider.generate(
        {
          task,
          ...req,
          ...(route.model ? { model: route.model } : {}),
          ...(route.effort ? { effort: route.effort } : {}),
        },
        signal,
      );
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
      const route = await resolveRoute(this.opts.routes, task, (id) => this.isAvailable(id));
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
    let cached = this.availability.get(id);
    if (!cached) {
      const provider = this.opts.providers(id);
      cached = provider
        ? provider
            .available()
            .then((a) => a.ok)
            .catch(() => false)
        : Promise.resolve(false);
      this.availability.set(id, cached);
    }
    return cached;
  }
}
