import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Egress, EgressError, findForbidden, requestUserText } from './egress.js';

const body = Buffer.from('model bytes '.repeat(1000));
const sha = createHash('sha256').update(body).digest('hex');
let dir: string;
let calls: string[];
const fakeFetch = (data: Buffer = body, status = 200) =>
  (async (url: string) => {
    calls.push(String(url));
    return new Response(status === 200 ? new Uint8Array(data) : null, { status });
  }) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tforge-egress-'));
  calls = [];
});
const egress = (f = fakeFetch()) =>
  new Egress({ logFile: join(dir, 'logs', 'egress.jsonl'), fetch: f });
const log = async () =>
  (await readFile(join(dir, 'logs', 'egress.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const opts = { purpose: 'Download the test model', expectedBytes: body.length, sha256: sha };

describe('Egress.download', () => {
  it('writes a verified file and logs the request with its purpose', async () => {
    const seen: number[] = [];
    const dest = join(dir, 'models', 'm.onnx');
    await egress().download('https://example.org/m.onnx?x=1', dest, {
      ...opts,
      onProgress: (b) => seen.push(b),
    });
    expect(await readFile(dest)).toEqual(body);
    expect(seen.at(-1)).toBe(body.length);
    expect(await log()).toEqual([
      expect.objectContaining({
        purpose: 'Download the test model',
        host: 'example.org',
        path: '/m.onnx',
        ok: true,
        status: 200,
        bytes: body.length,
      }),
    ]);
  });

  it.each([
    ['checksum-mismatch', fakeFetch(Buffer.from(body).fill(65, 0, 1))],
    ['size-mismatch', fakeFetch(body.subarray(0, 100))],
    ['too-large', fakeFetch(Buffer.concat([body, body]))],
    ['http-error', fakeFetch(body, 404)],
  ] as const)('rejects %s and leaves nothing behind', async (code, f) => {
    const dest = join(dir, 'models', 'm.onnx');
    await expect(
      egress(f).download('https://example.org/m.onnx', dest, opts),
    ).rejects.toMatchObject({ code });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(dir, 'models')) ? await readdir(join(dir, 'models')) : []).toEqual([]);
    expect((await log())[0]).toMatchObject({ ok: false });
  });

  it('refuses plain HTTP without making the request', async () => {
    await expect(
      egress().download('http://example.org/m', join(dir, 'm'), opts),
    ).rejects.toBeInstanceOf(EgressError);
    expect(calls).toEqual([]);
  });

  it('reports an unreachable host as a network error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      egress(failing).download('https://example.org/m', join(dir, 'm'), opts),
    ).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('Egress for LLM requests', () => {
  const api = (status = 200) =>
    (async (url: string) => {
      calls.push(String(url));
      return new Response('{"ok":true}', { status, headers: { 'content-length': '11' } });
    }) as unknown as typeof fetch;
  const chat = (user: string) =>
    JSON.stringify({
      system: 'Write JSON. Use a key per field.',
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: 'Off we go' },
      ],
    });
  const scope = { purpose: 'AI request "brief.suggest" (Anthropic API)', forbidden: ['Ash Warden', 'Key', 'Off'] }; // prettier-ignore

  it('sends inside a purpose to an allowed host and logs size and purpose, never the text', async () => {
    const e = egress(api());
    const f = e.llmFetch({ provider: 'core/anthropic', hosts: ['api.anthropic.com'] });
    const res = await e.scope(
      scope,
      () =>
      f('https://api.anthropic.com/v1/messages', { method: 'POST', body: chat('a dark fantasy secret plot') }), // prettier-ignore
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://api.anthropic.com/v1/messages']);
    const [rec] = await log();
    expect(rec).toMatchObject({ purpose: scope.purpose, method: 'POST', host: 'api.anthropic.com', path: '/v1/messages', status: 200, bytes: 11, ok: true }); // prettier-ignore
    expect(rec!.bytesOut).toBe(Buffer.byteLength(chat('a dark fantasy secret plot')));
    expect(JSON.stringify(rec)).not.toMatch(/secret plot|dark fantasy/);
  });

  it('refuses without a purpose, to another host, over plain HTTP, or naming an excluded entity', async () => {
    const e = egress(api());
    const f = e.llmFetch({ provider: 'core/anthropic', hosts: ['api.anthropic.com'] });
    const post = (url: string, user = 'hello') => f(url, { method: 'POST', body: chat(user) });
    await expect(post('https://api.anthropic.com/v1/messages')).rejects.toMatchObject({ code: 'unscoped' }); // prettier-ignore
    await e.scope(scope, async () => {
      await expect(post('https://evil.example/v1')).rejects.toMatchObject({ code: 'host-not-allowed' }); // prettier-ignore
      await expect(post('http://api.anthropic.com/v1')).rejects.toMatchObject({
        code: 'not-https',
      });
      await expect(post('https://api.anthropic.com/v1', 'the boss is THE ASH WARDEN')).rejects.toMatchObject({ code: 'excluded' }); // prettier-ignore
      // Fixed app text and the model's own reply may contain short excluded words.
      await expect(post('https://api.anthropic.com/v1', 'a monkey and a keyboard')).resolves.toBeDefined(); // prettier-ignore
    });
    expect(calls).toHaveLength(1);
    const recs = await log();
    expect(recs.map((r) => r.ok)).toEqual([false, false, false, false, true]);
    expect(recs[3]!.error).toMatch(/keep out of AI requests/);
    expect(JSON.stringify(recs)).not.toMatch(/ash warden/i);
  });

  it('a local model may use plain HTTP to this machine only', async () => {
    const e = egress(api());
    const f = e.llmFetch({ provider: 'core/ollama', hosts: [], localhost: true });
    await e.scope(scope, async () => {
      await f('http://127.0.0.1:11434/api/chat', { method: 'POST', body: chat('hi') });
      await expect(f('http://10.0.0.5:11434/api/chat', { method: 'POST' })).rejects.toBeInstanceOf(EgressError); // prettier-ignore
    });
    expect(calls).toEqual(['http://127.0.0.1:11434/api/chat']);
  });

  it('hand-offs to a local tool are checked and logged the same way', async () => {
    const e = egress();
    await e.scope(scope, () => e.handOff({ provider: 'core/claude-code', tool: 'claude-code', text: 'plan the shots' })); // prettier-ignore
    await expect(e.scope(scope, () => e.handOff({ provider: 'core/claude-code', tool: 'claude-code', text: 'show the Ash Warden' }))).rejects.toMatchObject({ code: 'excluded' }); // prettier-ignore
    await expect(e.handOff({ provider: 'core/claude-code', tool: 'claude-code', text: 'x' })).rejects.toMatchObject({ code: 'unscoped' }); // prettier-ignore
    const recs = await log();
    expect(recs.map((r) => [r.method, r.host, r.ok, r.bytesOut])).toEqual([
      ['EXEC', 'claude-code', true, 14],
      ['EXEC', 'claude-code', false, 19],
      ['EXEC', 'claude-code', false, 1],
    ]);
  });

  it('finds whole words in any case and reads only the user turns', () => {
    expect(findForbidden('Fight the ash-warden now', ['Ash Warden'])).toBeUndefined();
    expect(findForbidden('Fight the Ash Warden.', ['ash warden'])).toBe('ash warden');
    expect(findForbidden('keyboard', ['Key'])).toBeUndefined();
    expect(requestUserText(chat('only this'))).toBe('only this');
    expect(requestUserText('plain text body')).toBe('plain text body');
    expect(requestUserText(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'parts' }] }] }))).toBe('parts'); // prettier-ignore
  });
});

describe('Egress.logSetup', () => {
  it('logs a setup step the user agreed to, with its source and result', async () => {
    const e = egress();
    await e.logSetup({ purpose: 'Create the analysis environment', tool: 'uv sync', source: 'pypi.org (via uv)', ok: true }); // prettier-ignore
    await e.logSetup({ purpose: 'Create the analysis environment', tool: 'uv sync', source: 'pypi.org (via uv)', ok: false, error: 'no network' }); // prettier-ignore
    const recs = await log();
    expect(recs.map((r) => [r.method, r.host, r.path, r.ok, r.error ?? null])).toEqual([
      ['EXEC', 'pypi.org (via uv)', 'uv sync', true, null],
      ['EXEC', 'pypi.org (via uv)', 'uv sync', false, 'no network'],
    ]);
    expect(calls).toEqual([]);
  });
});
