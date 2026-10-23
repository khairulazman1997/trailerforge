import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAnthropicProvider,
  LlmRefusalError,
  LlmTruncatedError,
  type AnthropicLike,
  type AnthropicMessage,
} from './anthropic.js';

const schema = z.strictObject({ title: z.string(), n: z.number() });
const text = (s: string, extra: Partial<AnthropicMessage> = {}): AnthropicMessage => ({
  content: [{ type: 'text', text: s }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
  model: 'claude-sonnet-5-5',
  ...extra,
});

/** A stub client that replays responses (or throws errors) and records every request. */
function stub(replies: (AnthropicMessage | Error)[], viaBeta = true) {
  const requests: Record<string, unknown>[] = [];
  let i = 0;
  const create = async (params: Record<string, unknown>) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  };
  const client: AnthropicLike = { messages: { create }, beta: { messages: { create } } };
  return { client, requests, viaBeta };
}

const req = { task: 'brief.suggest', system: 'sys', prompt: 'go', schema };
const sig = new AbortController().signal;

describe('Anthropic provider', () => {
  it('sends structured output config and returns validated, parsed output', async () => {
    const { client, requests } = stub([text('{"title":"A","n":1}')]);
    const p = createAnthropicProvider({ client });
    const r = await p.generate({ ...req, model: 'claude-opus-5-5', effort: 'high' }, sig);
    expect(r).toEqual({
      value: { title: 'A', n: 1 },
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const sent = requests[0]!;
    expect(sent).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const oc = sent.output_config as {
      effort: string;
      format: { type: string; schema: { type: string } };
    };
    expect(oc.effort).toBe('high');
    expect(oc.format.type).toBe('json_schema');
    expect(oc.format.schema.type).toBe('object');
    // Parameters current models reject must never be sent.
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice'])
      expect(sent).not.toHaveProperty(k);
  });

  it('defaults the model and can turn fallbacks off', async () => {
    const { client, requests } = stub([text('{"title":"A","n":1}')]);
    await createAnthropicProvider({ client, fallbacks: false }).generate(req, sig);
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(requests[0]).not.toHaveProperty('fallbacks');
  });

  it('repairs invalid replies, keeping the conversation so far', async () => {
    const { client, requests } = stub([
      text('{"title":1}'),
      text('```json\n{"title":"A","n":2}\n```'),
    ]);
    const r = await createAnthropicProvider({ client }).generate(req, sig);
    expect(r.value).toEqual({ title: 'A', n: 2 });
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const msgs = requests[1]!.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]!.content).toBe('{"title":1}');
    expect(msgs[2]!.content).toMatch(/did not validate/);
  });

  it('surfaces refusals with their category, without retrying', async () => {
    const { client, requests } = stub([
      text('', {
        stop_reason: 'refusal',
        content: [],
        stop_details: { category: 'cyber', explanation: 'no' },
      }),
    ]);
    const err = await createAnthropicProvider({ client })
      .generate(req, sig)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect(err).toMatchObject({ category: 'cyber', explanation: 'no' });
    expect(requests).toHaveLength(1);
  });

  it('reports truncation instead of validating half a JSON document', async () => {
    const { client } = stub([text('{"title":"A","n', { stop_reason: 'max_tokens' })]);
    const err = await createAnthropicProvider({ client, maxTokens: 100 })
      .generate(req, sig)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTruncatedError);
  });

  it('falls back to prompted JSON when the API rejects the schema, then stays there', async () => {
    const reject = new Anthropic.BadRequestError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'output_config.format.schema: unsupported',
        },
      },
      'output_config.format.schema: unsupported',
      new Headers(),
    );
    const { client, requests } = stub([reject, text('{"title":"A","n":1}')]);
    const r = await createAnthropicProvider({ client }).generate(req, sig);
    expect(r.value).toEqual({ title: 'A', n: 1 });
    expect(requests[0]).toHaveProperty('output_config.format');
    expect(requests[1]).not.toHaveProperty('output_config');
    expect(requests[1]!.system).toMatch(/JSON Schema/);
  });

  it('does not swallow unrelated errors', async () => {
    const { client } = stub([new Error('boom')]);
    await expect(createAnthropicProvider({ client }).generate(req, sig)).rejects.toThrow('boom');
  });

  it('is available only with a client or key, and it leaves the machine', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const p = createAnthropicProvider();
      expect(await p.available()).toMatchObject({ ok: false });
      expect(await createAnthropicProvider({ apiKey: 'k' }).available()).toEqual({ ok: true });
      expect(p).toMatchObject({ id: 'core/anthropic', kind: 'api', sendsDataOffDevice: true });
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

// Real call: costs a few tokens. Run with ANTHROPIC_LIVE=1 and ANTHROPIC_API_KEY set.
describe.skipIf(!process.env.ANTHROPIC_LIVE || !process.env.ANTHROPIC_API_KEY)('live API', () => {
  it('returns schema-valid output', async () => {
    const p = createAnthropicProvider({ model: 'claude-haiku-5-5' });
    const r = await p.generate(
      { task: 'live', system: 'Reply with JSON only.', prompt: 'title "Hello", n 3', schema },
      sig,
    );
    expect(r.value).toEqual({ title: 'Hello', n: 3 });
  }, 60_000);
});
