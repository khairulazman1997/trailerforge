import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmProvider } from '@trailerforge/plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, LlmConsentError, type LlmCallLog } from './client.js';
import { loadPrompt } from './prompts.js';
import { createChatHandoffProvider, type HandoffRequest } from './providers/chat-handoff.js';
import { createClaudeCodeProvider } from './providers/claude-code.js';
import { createMockProvider } from './providers/mock.js';
import { DEFAULT_ROUTES, resolveRoute, RoutesConfig } from './routes.js';
import { extractJson, LlmOutputError, withRepairs } from './structured.js';

const Hook = z.strictObject({ title: z.string().min(1), seconds: z.number().max(3) });

describe('extractJson', () => {
  it.each([
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Sure! ```\n[1,2]\n``` hope that helps', [1, 2]],
    ['Here you go: {"a": {"b": 2}} cheers', { a: { b: 2 } }],
    ['{"a":1}', { a: 1 }],
  ])('extracts from %j', (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });

  it('returns undefined when nothing parses', () => {
    expect(extractJson('no json here {oops')).toBeUndefined();
  });
});

describe('withRepairs', () => {
  it('repairs invalid output using the reported issues', async () => {
    const prompts: string[] = [];
    const replies = ['{"title": "", "seconds": 9}', '```json\n{"title":"Parry","seconds":2}\n```'];
    const { value, attempts } = await withRepairs(
      Hook,
      async (p, i) => (prompts.push(p), replies[i]),
      'make a hook',
    );
    expect(value).toEqual({ title: 'Parry', seconds: 2 });
    expect(attempts).toBe(2);
    expect(prompts[1]).toMatch(/title: Too small/);
    expect(prompts[1]).toMatch(/seconds: Too big/);
  });

  it('gives up after maxRepairs with the last issues and raw output', async () => {
    const err = await withRepairs(Hook, async () => 'nope', 'x', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).issues).toEqual(['no JSON found in the reply']);
    expect((err as LlmOutputError).raw).toBe('nope');
  });
});

describe('prompts', () => {
  it('loads the built-in trailer-craft system prompt with variables', async () => {
    const p = await loadPrompt('system.trailer-craft', { projectName: 'Ember Knight' });
    expect(p).toMatch(/Hook within the first 3 seconds/);
    expect(p).toMatch(/Project: Ember Knight/);
  });

  it('errors on missing variables, unknown prompts and unsafe names', async () => {
    await expect(loadPrompt('system.trailer-craft', {})).rejects.toThrow(
      /missing variables: projectName/,
    );
    await expect(loadPrompt('nope', {})).rejects.toThrow(/not found/);
    await expect(loadPrompt('../etc/passwd', {})).rejects.toThrow(/invalid prompt name/);
  });

  it('prefers user override directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-prompts-'));
    await writeFile(join(dir, 'system.trailer-craft.md'), 'Custom for {{projectName}}');
    expect(await loadPrompt('system.trailer-craft', { projectName: 'X' }, [dir])).toBe(
      'Custom for X',
    );
  });
});

describe('routes', () => {
  const config = RoutesConfig.parse(DEFAULT_ROUTES);
  const only =
    (...ids: string[]) =>
    async (id: string) =>
      ids.includes(id);

  it('uses the task route, then the default', async () => {
    expect(await resolveRoute(config, 'storyboard.generate', only('core/anthropic'))).toMatchObject(
      { model: 'claude-opus-5-5', effort: 'high', fellBack: false },
    );
    expect(await resolveRoute(config, 'unknown.task', only('core/anthropic'))).toMatchObject({
      model: 'claude-sonnet-5-5',
      fellBack: false,
    });
  });

  it('falls back to Claude Code, then Chat Handoff, dropping provider-specific models', async () => {
    expect(
      await resolveRoute(config, 'critique.run', only('core/claude-code', 'core/chat-handoff')),
    ).toEqual({ provider: 'core/claude-code', effort: 'high', fellBack: true });
    expect(await resolveRoute(config, 'critique.run', only('core/chat-handoff'))).toMatchObject({
      provider: 'core/chat-handoff',
    });
  });

  it('errors when nothing is available', async () => {
    await expect(resolveRoute(config, 'x', only())).rejects.toThrow(/no LLM provider available/);
  });
});

describe('LlmClient.describeRoute', () => {
  const fake = (id: string, ok: boolean, offDevice: boolean) =>
    ({
      id,
      name: id,
      kind: 'api',
      sendsDataOffDevice: offDevice,
      available: async () => (ok ? { ok: true } : { ok: false, reason: 'nope' }),
      generate: async () => {
        throw new Error('describeRoute must not send anything');
      },
    }) as never;
  const client = (providers: Record<string, ReturnType<typeof fake>>) =>
    new LlmClient({
      providers: (id) => providers[id],
      routes: RoutesConfig.parse({
        routes: { 'a.b': { provider: 'x/api', model: 'big', effort: 'high' } },
        fallbacks: ['x/local'],
      }),
    });

  it('names the provider, model and effort a task would use, without sending', async () => {
    const r = await client({
      'x/api': fake('x/api', true, true),
      'x/local': fake('x/local', true, false),
    }).describeRoute('a.b');
    expect(r).toMatchObject({ ok: true, model: 'big', effort: 'high', fellBack: false });
    expect(r.ok && r.provider.sendsDataOffDevice).toBe(true);
  });

  it('shows a fallback as a fallback, and says why when nothing is available', async () => {
    const down = client({
      'x/api': fake('x/api', false, true),
      'x/local': fake('x/local', true, false),
    });
    const r = await down.describeRoute('a.b');
    expect(r).toMatchObject({ ok: true, fellBack: true });
    expect(r.ok && r.provider.id).toBe('x/local');
    const none = await client({
      'x/api': fake('x/api', false, true),
      'x/local': fake('x/local', false, false),
    }).describeRoute('a.b');
    expect(none).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no LLM provider available/),
    });
  });
});

describe('mock provider', () => {
  it('replays replies in order and records calls', async () => {
    const mock = createMockProvider({ 'hook.make': ['garbage', { title: 'Parry', seconds: 1.5 }] });
    const r = await mock.generate(
      { task: 'hook.make', system: '', prompt: 'p', schema: Hook },
      new AbortController().signal,
    );
    expect(r.value.title).toBe('Parry');
    expect(mock.calls).toHaveLength(2);
  });
});

describe('chat handoff provider', () => {
  it('sends a self-contained prompt, then short follow-ups until the reply validates', async () => {
    const seen: HandoffRequest[] = [];
    const replies = ['{"title":"Parry"}', '```json\n{"title":"Parry","seconds":2}\n```'];
    const provider = createChatHandoffProvider({
      request: async (req) => (seen.push(req), replies[req.round]!),
    });
    const r = await provider.generate(
      { task: 'hook.make', system: 'You edit trailers.', prompt: 'Make a hook', schema: Hook },
      new AbortController().signal,
    );
    expect(r.value).toEqual({ title: 'Parry', seconds: 2 });
    expect(seen[0]?.prompt).toMatch(/You edit trailers\.[\s\S]*Make a hook[\s\S]*JSON Schema/);
    expect(seen[1]?.round).toBe(1);
    expect(seen[1]?.prompt).toMatch(/did not validate[\s\S]*seconds/);
    expect(provider.sendsDataOffDevice).toBe(false);
  });
});

describe('claude code provider', () => {
  /** A fake `claude` that records argv/stdin and replies from a script. */
  async function fakeClaude(replies: object[]) {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-fake-claude-'));
    const bin = join(dir, 'claude');
    await writeFile(join(dir, 'replies.json'), JSON.stringify(replies));
    await writeFile(
      bin,
      `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(dir)};
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let stdin = ''; process.stdin.on('data', d => stdin += d).on('end', () => {
  const n = fs.readdirSync(dir).filter(f => f.startsWith('call-')).length;
  fs.writeFileSync(path.join(dir, 'call-' + n + '.json'), JSON.stringify({ argv: process.argv.slice(2), stdin }));
  const replies = JSON.parse(fs.readFileSync(path.join(dir, 'replies.json'), 'utf8'));
  console.log(JSON.stringify(replies[Math.min(n, replies.length - 1)]));
});`,
    );
    await chmod(bin, 0o755);
    const call = async (n: number) =>
      JSON.parse(await readFile(join(dir, `call-${n}.json`), 'utf8')) as {
        argv: string[];
        stdin: string;
      };
    return { bin, call };
  }

  it('reports unavailability when the CLI is missing', async () => {
    const r = await createClaudeCodeProvider({ bin: '/nonexistent/claude' }).available();
    expect(r.ok).toBe(false);
  });

  it('runs headless with tools off, prompt on stdin and a JSON schema', async () => {
    const fake = await fakeClaude([
      {
        type: 'result',
        is_error: false,
        result: '',
        structured_output: { title: 'Parry', seconds: 2 },
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ]);
    const provider = createClaudeCodeProvider({ bin: fake.bin });
    expect(await provider.available()).toEqual({ ok: true });
    const r = await provider.generate(
      {
        task: 'hook.make',
        system: 'You edit trailers.',
        prompt: 'Make a hook',
        schema: Hook,
        model: 'claude-opus-5-5',
        effort: 'high',
      },
      new AbortController().signal,
    );
    expect(r.value).toEqual({ title: 'Parry', seconds: 2 });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    const { argv, stdin } = await fake.call(0);
    expect(stdin).toBe('Make a hook');
    expect(argv).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
      ]),
    );
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You edit trailers.');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!).properties).toHaveProperty(
      'seconds',
    );
  });

  it('repairs from text results and surfaces CLI errors', async () => {
    const fake = await fakeClaude([
      { is_error: false, result: '{"title":"Parry","seconds":10}' },
      { is_error: false, result: '```json\n{"title":"Parry","seconds":2}\n```' },
    ]);
    const r = await createClaudeCodeProvider({ bin: fake.bin }).generate(
      { task: 't', system: 's', prompt: 'Make a hook', schema: Hook },
      new AbortController().signal,
    );
    expect(r.value.seconds).toBe(2);
    expect((await fake.call(1)).stdin).toMatch(/^Make a hook\n\n[\s\S]*seconds: Too big/);

    const failing = await fakeClaude([{ is_error: true, result: 'Not logged in' }]);
    await expect(
      createClaudeCodeProvider({ bin: failing.bin }).generate(
        { task: 't', system: 's', prompt: 'p', schema: Hook },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Not logged in/);
  });
});

describe('LlmClient', () => {
  const offDevice = (id: string): LlmProvider => ({
    ...createMockProvider({ t: { title: 'Cloud', seconds: 1 } }, id),
    kind: 'api',
    sendsDataOffDevice: true,
  });

  it('routes, logs and asks before sending data off the device', async () => {
    const logs: LlmCallLog[] = [];
    const asked: string[] = [];
    const cloud = offDevice('core/anthropic');
    const client = new LlmClient({
      providers: (id) => (id === 'core/anthropic' ? cloud : undefined),
      routes: RoutesConfig.parse({ default: { provider: 'core/anthropic', model: 'm' } }),
      approveSend: ({ provider }) => (asked.push(provider.id), true),
      log: (e) => logs.push(e),
    });
    const r = await client.generate('t', { system: 's', prompt: 'p', schema: Hook });
    expect(r).toMatchObject({
      value: { title: 'Cloud' },
      provider: 'core/anthropic',
      fellBack: false,
    });
    expect(asked).toEqual(['core/anthropic']);
    expect(logs[0]).toMatchObject({ task: 't', provider: 'core/anthropic', fellBack: false });
  });

  it('blocks when the user declines, and falls back when the routed provider is unavailable', async () => {
    const cloud = offDevice('core/anthropic');
    const local = createMockProvider({ t: { title: 'Local', seconds: 1 } }, 'core/chat-handoff');
    const routes = RoutesConfig.parse({
      default: { provider: 'core/anthropic' },
      fallbacks: ['core/chat-handoff'],
    });
    const declined = new LlmClient({
      providers: (id) => (id === 'core/anthropic' ? cloud : undefined),
      routes,
      approveSend: () => false,
    });
    await expect(
      declined.generate('t', { system: 's', prompt: 'p', schema: Hook }),
    ).rejects.toThrow(LlmConsentError);

    const fallback = new LlmClient({
      providers: (id) => (id === 'core/chat-handoff' ? local : undefined),
      routes,
    });
    expect(await fallback.generate('t', { system: 's', prompt: 'p', schema: Hook })).toMatchObject({
      value: { title: 'Local' },
      fellBack: true,
    });
  });
});
