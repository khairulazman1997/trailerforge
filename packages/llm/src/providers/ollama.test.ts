import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOllamaProvider, normalizeOllamaUrl } from './ollama.js';

/** A stand-in for the local Ollama server: /api/tags and /api/chat. */
let server: Server;
let url: string;
let models: string[];
let replies: (string | { status: number; error: string })[];
let seen: { path: string; body: Record<string, unknown> }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags')
        return void res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      const next = replies.shift() ?? '{}';
      if (typeof next !== 'string') {
        res.statusCode = next.status;
        return void res.end(JSON.stringify({ error: next.error }));
      }
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: next }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 })); // prettier-ignore
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  models = ['llama3.1:8b', 'qwen3:14b'];
  replies = [];
  seen = [];
});

const schema = z.strictObject({ title: z.string(), shots: z.int().min(1) });
const req: { task: string; system: string; prompt: string; schema: typeof schema; model?: string } = { task: 'brief.suggest', system: 'Be brief.', prompt: 'Name the trailer.', schema }; // prettier-ignore
const go = (p: ReturnType<typeof createOllamaProvider>, r = req) => p.generate(r, new AbortController().signal); // prettier-ignore

describe('Ollama provider', () => {
  it('lists the local models and reports availability with a plain reason', async () => {
    const p = createOllamaProvider({ baseUrl: url });
    expect(await p.models()).toEqual(['llama3.1:8b', 'qwen3:14b']);
    expect(await p.available()).toEqual({ ok: true });
    models = [];
    expect(await p.available()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ollama pull/),
    });
    const down = createOllamaProvider({ baseUrl: 'http://127.0.0.1:1' });
    expect(await down.available()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not reachable.*ollama\.com/),
    });
  });

  it('asks for structured output on the schema, with this machine as the only host', async () => {
    replies.push(JSON.stringify({ title: 'Ember Knight', shots: 4 }));
    const r = await go(createOllamaProvider({ baseUrl: url }), { ...req, model: 'qwen3:14b' });
    expect(r).toEqual({
      value: { title: 'Ember Knight', shots: 4 },
      model: 'qwen3:14b',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const call = seen.find((s) => s.path === '/api/chat')!.body;
    expect(call).toMatchObject({
      model: 'qwen3:14b',
      stream: false,
      options: { temperature: 0, num_ctx: 32768 },
    });
    expect((call.format as { properties: object }).properties).toHaveProperty('title');
    expect((call.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('repairs an invalid reply, keeping the conversation', async () => {
    replies.push(
      'Sure! {"title": "Ember Knight"}',
      '```json\n{"title":"Ember Knight","shots":2}\n```',
    );
    const r = await go(createOllamaProvider({ baseUrl: url, model: 'llama3.1:8b' }));
    expect(r.value).toEqual({ title: 'Ember Knight', shots: 2 });
    const chats = seen.filter((s) => s.path === '/api/chat');
    expect(chats).toHaveLength(2);
    expect((chats[1]!.body.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']); // prettier-ignore
  });

  it('falls back to plain JSON when the server rejects a schema, and says what went wrong', async () => {
    replies.push(
      { status: 400, error: 'invalid format' },
      JSON.stringify({ title: 'T', shots: 1 }),
    );
    const r = await go(createOllamaProvider({ baseUrl: url, model: 'm' }));
    expect(r.value.title).toBe('T');
    const chats = seen.filter((s) => s.path === '/api/chat');
    expect(chats[1]!.body.format).toBe('json');
    replies.push({ status: 404, error: 'model "nope" not found, try pulling it first' });
    await expect(go(createOllamaProvider({ baseUrl: url, model: 'nope' }))).rejects.toThrow(
      /not found, try pulling/,
    );
    await expect(go(createOllamaProvider({ baseUrl: url }))).rejects.toThrow(
      /no local model chosen/,
    );
  });

  it('is never a provider that sends data off the device', () => {
    expect(createOllamaProvider().sendsDataOffDevice).toBe(false);
    expect(normalizeOllamaUrl('localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeOllamaUrl(undefined)).toBe('http://127.0.0.1:11434');
  });
});
