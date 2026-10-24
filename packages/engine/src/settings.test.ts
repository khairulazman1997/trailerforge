import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Engine } from './engine.js';
import { HandoffCancelled, HandoffHub } from './handoff.js';
import { OpError } from './ops.js';
import { memorySecretStore, openFileSecretStore, SecretStoreError } from './secrets.js';
import {
  clearAnthropicKey,
  providerStatus,
  resetRoutes,
  routesView,
  saveRoutes,
  secretsView,
  setAnthropicKey,
} from './settings.js';

let root: string;
let savedEnv: string | undefined;
/** A stand-in Claude Code CLI, so the tests do not depend on one being installed. */
let claudeCode: { bin: string; binArgs: string[] };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-settings-'));
  const fake = join(root, 'claude.js');
  await writeFile(fake, "console.log('9.9.9 (Claude Code)');");
  claudeCode = { bin: process.execPath, binArgs: [fake] };
  savedEnv = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
});

describe('file secret store', () => {
  it('persists across reopening, and keeps the file private on macOS and Linux', async () => {
    const path = join(root, 'a', 'secrets.json');
    const s = await openFileSecretStore(path);
    expect(s.get('k')).toBeUndefined();
    await Promise.all([s.set('k', 'one'), s.set('other', 'x'), s.set('k', 'two')]); // queued, not interleaved
    expect((await openFileSecretStore(path)).get('k')).toBe('two');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'a'))).mode & 0o777).toBe(0o700);
    }
    await s.delete('k');
    const again = await openFileSecretStore(path);
    expect([again.get('k'), again.get('other')]).toEqual([undefined, 'x']);
  });

  it('refuses to overwrite a file it cannot read', async () => {
    const path = join(root, 'broken.json');
    await writeFile(path, '{ not json');
    await expect(openFileSecretStore(path)).rejects.toBeInstanceOf(SecretStoreError);
    expect(await readFile(path, 'utf8')).toBe('{ not json'); // untouched
  });
});

describe('API key and provider availability', () => {
  it('a key saved in settings makes the provider available at once, and is never echoed back', async () => {
    const engine = await Engine.start({
      home: join(root, 'h1'),
      autosaveMs: 0,
      loadUserPlugins: false,
      claudeCode,
    });
    try {
      const anthropic = async () =>
        (await providerStatus(engine)).find((p) => p.id === 'core/anthropic')!;
      expect((await anthropic()).available).toMatchObject({ ok: false });
      expect(secretsView(engine).anthropicApiKey).toEqual({ set: false, source: null });
      await expect(engine.llm.describeRoute('storyboard.generate')).resolves.toMatchObject({
        ok: true,
      }); // falls back

      const view = await setAnthropicKey(engine, '  sk-ant-secret-value  ');
      expect(view.anthropicApiKey).toEqual({ set: true, source: 'stored' });
      expect(JSON.stringify(view)).not.toContain('secret-value');
      expect((await anthropic()).available).toEqual({ ok: true });
      const route = await engine.llm.describeRoute('storyboard.generate');
      expect(route.ok && route.provider.id).toBe('core/anthropic'); // no restart, no stale cache
      expect(await readFile(join(root, 'h1', 'secrets.json'), 'utf8')).toContain(
        'sk-ant-secret-value',
      );

      const cleared = await clearAnthropicKey(engine);
      expect(cleared.anthropicApiKey.set).toBe(false);
      expect((await anthropic()).available).toMatchObject({ ok: false });
    } finally {
      await engine.close();
    }
  });

  it('rejects things that are not a key, and reports an environment key as such', async () => {
    const engine = await Engine.start({
      home: join(root, 'h2'),
      autosaveMs: 0,
      loadUserPlugins: false,
      secrets: memorySecretStore(),
    });
    try {
      for (const bad of ['', '   ', 'two words', 'x'.repeat(401), 5, null]) {
        await expect(setAnthropicKey(engine, bad)).rejects.toBeInstanceOf(OpError);
      }
      process.env.ANTHROPIC_API_KEY = 'sk-from-env';
      expect(secretsView(engine).anthropicApiKey).toEqual({ set: true, source: 'environment' });
      await setAnthropicKey(engine, 'sk-stored');
      expect(secretsView(engine).anthropicApiKey.source).toBe('stored'); // a saved key wins
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await engine.close();
    }
  });
});

describe('routes', () => {
  it('saves valid routes, uses them immediately, survives a restart, and resets', async () => {
    const home = join(root, 'h3');
    const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, claudeCode });
    try {
      expect(await routesView(engine)).toMatchObject({
        custom: false,
        tasks: expect.arrayContaining(['storyboard.generate', 'brief.suggest']),
      });
      const view = await saveRoutes(engine, {
        routes: {
          'storyboard.generate': {
            provider: 'core/claude-code',
            model: 'claude-opus-5-5',
            effort: 'high',
          },
        },
        default: { provider: 'core/chat-handoff' },
        fallbacks: ['core/claude-code'],
      });
      expect(view.custom).toBe(true);
      const route = await engine.llm.describeRoute('storyboard.generate');
      expect(route.ok && [route.provider.id, route.model, route.effort]).toEqual([
        'core/claude-code',
        'claude-opus-5-5',
        'high',
      ]);
      expect(
        JSON.parse(await readFile(join(home, 'llm.routes.json'), 'utf8')).default.provider,
      ).toBe('core/chat-handoff');
    } finally {
      await engine.close();
    }
    const restarted = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false });
    try {
      expect(restarted.llm.routesConfig.default?.provider).toBe('core/chat-handoff');
      const reset = await resetRoutes(restarted);
      expect(reset.custom).toBe(false);
      expect(restarted.llm.routesConfig.default?.provider).toBe('core/anthropic');
    } finally {
      await restarted.close();
    }
  });

  it('refuses unknown providers and malformed routes without writing anything', async () => {
    const home = join(root, 'h4');
    const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false });
    try {
      await expect(saveRoutes(engine, { default: { provider: 'nope/missing' } })).rejects.toThrow(
        /unknown provider: nope\/missing/,
      );
      await expect(
        saveRoutes(engine, { routes: { t: { provider: 'core/anthropic', effort: 'extreme' } } }),
      ).rejects.toThrow(/invalid routes/);
      await expect(saveRoutes(engine, { surprise: true })).rejects.toBeInstanceOf(OpError);
      await expect(stat(join(home, 'llm.routes.json'))).rejects.toThrow();
      expect(engine.llm.routesConfig.default?.provider).toBe('core/anthropic');
    } finally {
      await engine.close();
    }
  });
});

describe('Chat Handoff', () => {
  it('relays a prompt, takes the reply, and cleans up', async () => {
    const hub = new HandoffHub();
    const changes: string[] = [];
    hub.onChange((c) =>
      changes.push(
        c.type === 'requested' ? `requested:${c.handoff.round}` : `resolved:${c.outcome}`,
      ),
    );
    const ac = new AbortController();
    const answer = hub.request({ task: 't', prompt: 'copy me', round: 0 }, ac.signal);
    expect(hub.pending()).toMatchObject([{ task: 't', prompt: 'copy me', round: 0 }]);
    const id = hub.pending()[0]!.id;
    expect(hub.reply('nope', 'x')).toBe(false);
    expect(hub.reply(id, 'the reply')).toBe(true);
    await expect(answer).resolves.toBe('the reply');
    expect(hub.reply(id, 'again')).toBe(false); // answered once
    expect(hub.pending()).toEqual([]);
    expect(changes).toEqual(['requested:0', 'resolved:replied']);
  });

  it('cancelling, or aborting the task, rejects the waiting request', async () => {
    const hub = new HandoffHub();
    const a = hub.request({ task: 't', prompt: 'p', round: 0 }, new AbortController().signal);
    hub.cancel(hub.pending()[0]!.id);
    await expect(a).rejects.toBeInstanceOf(HandoffCancelled);
    const ac = new AbortController();
    const b = hub.request({ task: 't', prompt: 'p', round: 0 }, ac.signal);
    ac.abort();
    await expect(b).rejects.toBeInstanceOf(HandoffCancelled);
    expect(hub.pending()).toEqual([]);
    await expect(
      hub.request({ task: 't', prompt: 'p', round: 0 }, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(HandoffCancelled);
  });

  it('is only offered while something can show the prompt', async () => {
    const engine = await Engine.start({
      home: join(root, 'h5'),
      autosaveMs: 0,
      loadUserPlugins: false,
    });
    try {
      const status = async () =>
        (await providerStatus(engine)).find((p) => p.id === 'core/chat-handoff')!;
      expect((await status()).available).toMatchObject({ ok: false });
      engine.handoff.available = true;
      engine.llm.invalidate();
      expect((await status()).available).toEqual({ ok: true });
    } finally {
      await engine.close();
    }
  });

  it('round-trips through the engine, including a fix-it follow-up for a reply that does not validate', async () => {
    const engine = await Engine.start({
      home: join(root, 'h6'),
      autosaveMs: 0,
      loadUserPlugins: false,
    });
    try {
      await saveRoutes(engine, { default: { provider: 'core/chat-handoff' } });
      engine.handoff.available = true;
      engine.llm.invalidate();
      const schema = z.strictObject({ title: z.string() });
      const done = engine.llm.generate('brief.suggest', {
        system: 'sys',
        prompt: 'give a title',
        schema,
      });

      const waitPending = async (round: number) => {
        for (let i = 0; i < 200; i++) {
          const p = engine.handoff.pending().find((x) => x.round === round);
          if (p) return p;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`no pending round ${round}`);
      };
      const first = await waitPending(0);
      expect(first.prompt).toContain('give a title');
      expect(first.prompt).toContain('JSON'); // self-contained: includes the output format
      engine.handoff.reply(first.id, '```json\n{"title": 5}\n```'); // wrong type

      const followUp = await waitPending(1);
      expect(followUp.prompt).toMatch(/did not validate/);
      expect(followUp.prompt).toContain('title');
      engine.handoff.reply(followUp.id, '```json\n{"title": "Ember Knight"}\n```');

      await expect(done).resolves.toMatchObject({
        value: { title: 'Ember Knight' },
        provider: 'core/chat-handoff',
      });
      expect(engine.handoff.pending()).toEqual([]);
    } finally {
      await engine.close();
    }
  });
});
