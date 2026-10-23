import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '@trailerforge/plugin-api';
import { formatInstructions, jsonSchemaFor, withRepairs } from '../structured.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** The model declined (stop_reason "refusal"). Retrying the same request won't help. */
export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(
      `the model declined this request${category ? ` (${category})` : ''}${explanation ? `: ${explanation}` : ''}`,
    );
    this.name = 'LlmRefusalError';
  }
}

/** The reply was cut off by max_tokens, so any JSON in it is incomplete. */
export class LlmTruncatedError extends Error {
  constructor(readonly maxTokens: number) {
    super(`the model's reply was cut off at ${maxTokens} tokens; raise maxTokens for this task`);
    this.name = 'LlmTruncatedError';
  }
}

/** The slice of a Messages API response this provider reads. */
export interface AnthropicMessage {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The slice of the SDK client this provider calls; tests stub it. */
export interface AnthropicLike {
  messages: {
    create(
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage>;
  };
  beta: {
    messages: {
      create(
        params: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ): Promise<AnthropicMessage>;
    };
  };
}

export interface AnthropicProviderOptions {
  /** Defaults to ANTHROPIC_API_KEY. Ignored when `client` is given. */
  apiKey?: string;
  client?: AnthropicLike;
  /** Used when the route names no model. */
  model?: string;
  /** Output cap per reply; storyboards are the largest task. Default 16000 (non-streaming safe). */
  maxTokens?: number;
  /**
   * Server-side fallback ("default" routes a policy decline to another model inside the same
   * call). Claude API only; pass false for other platforms or to see refusals directly.
   */
  fallbacks?: 'default' | false;
  maxRepairs?: number;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Anthropic Messages API provider. Replies are constrained with `output_config.format`
 * (JSON Schema from the Zod schema) and still validated against Zod, with the usual repair loop.
 * No thinking/temperature params: current models reject them or pick adaptive thinking
 * themselves; `effort` is the depth control.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): LlmProvider {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const maxTokens = opts.maxTokens ?? 16_000;
  const fallbacks = opts.fallbacks ?? 'default';
  let client = opts.client;
  const getClient = (): AnthropicLike =>
    (client ??= new Anthropic({ apiKey }) as unknown as AnthropicLike);

  return {
    id: 'core/anthropic',
    name: 'Anthropic API',
    kind: 'api',
    sendsDataOffDevice: true,
    async available() {
      return opts.client || apiKey
        ? { ok: true }
        : { ok: false, reason: 'No Anthropic API key: set ANTHROPIC_API_KEY' };
    },
    async generate(request, signal) {
      const model = request.model ?? opts.model ?? DEFAULT_ANTHROPIC_MODEL;
      const usage = { inputTokens: 0, outputTokens: 0 };
      let servedBy = model;
      let native = true;
      const messages: { role: 'user' | 'assistant'; content: string }[] = [];

      const call = async (): Promise<string> => {
        const params: Record<string, unknown> = {
          model,
          max_tokens: maxTokens,
          system: native
            ? request.system
            : `${request.system}\n\n${formatInstructions(request.schema)}`,
          messages,
        };
        const outputConfig: Record<string, unknown> = {};
        if (request.effort) outputConfig.effort = request.effort;
        if (native) {
          outputConfig.format = {
            type: 'json_schema',
            schema: JSON.parse(jsonSchemaFor(request.schema)),
          };
        }
        if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
        const c = getClient();
        const res = fallbacks
          ? await c.beta.messages.create(
              { ...params, betas: [FALLBACK_BETA], fallbacks },
              { signal },
            )
          : await c.messages.create(params, { signal });

        usage.inputTokens += res.usage?.input_tokens ?? 0;
        usage.outputTokens += res.usage?.output_tokens ?? 0;
        if (res.model) servedBy = res.model;
        if (res.stop_reason === 'refusal') {
          throw new LlmRefusalError(
            res.stop_details?.category ?? null,
            res.stop_details?.explanation ?? null,
          );
        }
        if (res.stop_reason === 'max_tokens') throw new LlmTruncatedError(maxTokens);
        return res.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
      };

      const send = async (prompt: string): Promise<string> => {
        // Attempt 0 is the request; later attempts are repair prompts that follow the failed reply.
        messages.push({ role: 'user', content: prompt });
        let text: string;
        try {
          text = await call();
        } catch (err) {
          // The API rejected the schema itself (unsupported keyword): fall back to prompting.
          if (!(native && isSchemaRejection(err))) throw err;
          native = false;
          text = await call();
        }
        messages.push({ role: 'assistant', content: text });
        return text;
      };

      const { value } = await withRepairs(request.schema, send, request.prompt, 2);
      return { value, model: servedBy, usage };
    },
  };
}

function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  return /output_config|json_schema|schema/i.test(err.message);
}
