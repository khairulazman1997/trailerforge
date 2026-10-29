import type { LlmProvider } from '@trailerforge/plugin-api';
import { formatInstructions, jsonSchemaFor, withRepairs } from '../structured.js';

/** The address of a stock Ollama install. */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export interface OllamaProviderOptions {
  /** Where the local server listens; default `OLLAMA_HOST` or the stock address. */
  baseUrl?: string | (() => string | undefined);
  /** The network door (the app passes `Egress.llmFetch`, which only lets this machine through). */
  fetch?: typeof fetch;
  /** Wraps the calls that are not part of a request (availability, the model list). */
  scope?: <R>(purpose: string, run: () => Promise<R>) => Promise<R>;
  /** Used when the route names no model. */
  model?: string;
  /** Replies longer than this are cut off (and rejected). Default 16000. */
  maxTokens?: number;
  /** Context window asked for; local servers default to a small one. Default 32768. */
  contextTokens?: number;
  maxRepairs?: number;
}

interface TagsReply {
  models?: { name?: string; model?: string }[];
}
interface ChatReply {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** A base URL as the server's address (an `OLLAMA_HOST` of `host:port` has no scheme). */
export function normalizeOllamaUrl(raw: string | undefined): string {
  let u = (raw ?? '').trim();
  if (!u) return DEFAULT_OLLAMA_URL;
  if (!/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

/**
 * A model running on this computer through Ollama. Nothing leaves the machine: requests go to
 * `localhost` only (the app's network door refuses anything else for this provider). Replies are
 * constrained with the server's structured output (`format` = the JSON Schema) and still checked
 * against the Zod schema with the usual repair loop; local models fail more often than hosted
 * ones, so the repair rounds matter here.
 */
export function createOllamaProvider(
  opts: OllamaProviderOptions = {},
): LlmProvider & { models(): Promise<string[]> } {
  const base = () =>
    normalizeOllamaUrl(
      (typeof opts.baseUrl === 'function' ? opts.baseUrl() : opts.baseUrl) ??
        process.env.OLLAMA_HOST,
    );
  const f = (): typeof fetch => opts.fetch ?? fetch;
  const scoped = <R>(purpose: string, run: () => Promise<R>) =>
    opts.scope ? opts.scope(purpose, run) : run();
  const maxTokens = opts.maxTokens ?? 16_000;

  const models = async (): Promise<string[]> => {
    const res = await scoped('Ask the local model server which models it has', () =>
      f()(`${base()}/api/tags`, { signal: AbortSignal.timeout(5000) }),
    );
    if (!res.ok)
      throw new OllamaError(`the local model server answered HTTP ${res.status}`, res.status);
    const body = (await res.json()) as TagsReply;
    return (body.models ?? [])
      .map((m) => m.name ?? m.model ?? '')
      .filter(Boolean)
      .sort();
  };

  return {
    id: 'core/ollama',
    name: 'Ollama (a model on this computer)',
    kind: 'api',
    sendsDataOffDevice: false,
    models,
    async available() {
      try {
        const list = await models();
        return list.length
          ? { ok: true }
          : { ok: false, reason: 'Ollama is running but has no models: run "ollama pull <model>"' };
      } catch (err) {
        return {
          ok: false,
          reason: `Ollama is not reachable at ${base()}: ${(err as Error).message}. Install it from ollama.com and start it.`,
        };
      }
    },
    async generate(request, signal) {
      const model = request.model ?? opts.model;
      if (!model)
        throw new OllamaError(
          'no local model chosen: pick one in Settings (or set it in the route)',
        );
      const usage = { inputTokens: 0, outputTokens: 0 };
      let servedBy = model;
      let native = true;
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];

      const call = async (): Promise<string> => {
        const body = {
          model,
          stream: false,
          messages: [
            {
              role: 'system',
              content: native
                ? request.system
                : `${request.system}\n\n${formatInstructions(request.schema)}`,
            },
            ...messages,
          ],
          ...(native ? { format: JSON.parse(jsonSchemaFor(request.schema)) } : { format: 'json' }),
          options: {
            num_ctx: opts.contextTokens ?? 32_768,
            num_predict: maxTokens,
            temperature: 0,
          },
        };
        const res = await f()(`${base()}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        let json: ChatReply = {};
        try {
          json = JSON.parse(text) as ChatReply;
        } catch {
          // not JSON: reported below
        }
        if (!res.ok)
          throw new OllamaError(
            json.error ?? `the local model server answered HTTP ${res.status}`,
            res.status,
          );
        usage.inputTokens += json.prompt_eval_count ?? 0;
        usage.outputTokens += json.eval_count ?? 0;
        if (json.model) servedBy = json.model;
        if (json.done_reason === 'length')
          throw new OllamaError(
            `the model's reply was cut off at ${maxTokens} tokens; use a larger model or a shorter task`,
          );
        return json.message?.content ?? '';
      };

      const send = async (prompt: string): Promise<string> => {
        messages.push({ role: 'user', content: prompt });
        let text: string;
        try {
          text = await call();
        } catch (err) {
          // An older server may not take a schema as `format`: ask for plain JSON instead.
          if (native && err instanceof OllamaError && err.status === 400) {
            native = false;
            text = await call();
          } else throw err;
        }
        messages.push({ role: 'assistant', content: text });
        return text;
      };

      const { value } = await withRepairs(
        request.schema,
        (prompt) => send(prompt),
        request.prompt,
        opts.maxRepairs ?? 3,
      );
      return { value, model: servedBy, usage };
    },
  };
}
