import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { generateStoryboardOp } from './ops.js';
import { localModelsView, offlineRoutes, useOfflineRoutes } from './settings.js';

/**
 * The local model path end to end: a stand-in Ollama on localhost, the "fully offline" routes
 * chosen from the model list, a whole storyboard generated, and only this machine contacted.
 */

const reply = {
  rationale: 'Opens on the parry, escalates to the Warden, ends on the title.',
  sections: [
    { name: 'Hook', role: 'hook', slots: [{ kind: 'shot', title: 'Perfect parry', seconds: 6, captureInstruction: 'Parry in phase 2.', hud: 'off' }] }, // prettier-ignore
    { name: 'Escalation', role: 'escalation', slots: [{ kind: 'shot', title: 'Forest run', seconds: 20 }, { kind: 'shot', title: 'Boss reveal', seconds: 20 }] }, // prettier-ignore
    { name: 'End slate', role: 'end-slate', slots: [{ kind: 'card', cardKind: 'title', title: 'Title', text: 'Ashfall', seconds: 14 }] }, // prettier-ignore
  ],
  music: { direction: 'Hybrid orchestral' },
};

let server: Server;
let root: string;
let engine: Engine;
const chats: { model: string; prompt: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen3:14b' }, { name: 'llama3.1:8b' }] })); // prettier-ignore
      const body = JSON.parse(raw) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      chats.push({ model: body.model, prompt: body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n') }); // prettier-ignore
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: JSON.stringify(reply) }, done: true, done_reason: 'stop' })); // prettier-ignore
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), 'tforge-ollama-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
});
afterAll(async () => {
  delete process.env.OLLAMA_HOST;
  await engine.close();
  server.close();
});

describe('fully offline', () => {
  it('lists the local models, then routes every task to the chosen one', async () => {
    const before = await localModelsView(engine);
    expect(before).toMatchObject({ available: true, models: ['llama3.1:8b', 'qwen3:14b'], offlineModel: null }); // prettier-ignore
    const view = await useOfflineRoutes(engine, 'qwen3:14b');
    expect(view.config.fallbacks).toEqual(['core/chat-handoff']);
    expect(Object.values(view.config.routes).every((r) => r.provider === 'core/ollama' && r.model === 'qwen3:14b')).toBe(true); // prettier-ignore
    expect(Object.keys(view.config.routes)).toEqual(Object.keys(view.defaults.routes));
    expect((await localModelsView(engine)).offlineModel).toBe('qwen3:14b');
    await expect(useOfflineRoutes(engine, 'gpt-nope')).rejects.toThrow(
      /not one of the local models/,
    );
    expect(offlineRoutes('m').default).toEqual({ provider: 'core/ollama', model: 'm' });
    const saved = JSON.parse(await readFile(engine.routesPath, 'utf8')) as { fallbacks: string[] };
    expect(saved.fallbacks).toEqual(['core/chat-handoff']);
  });

  it('generates a storyboard on the local model, contacting only this machine', async () => {
    const store = await engine.createProject(join(root, 'Offline.tforge'), {
      name: 'Ember Knight',
      brief: { videoTypeId: 'game-trailer/release-trailer' },
    });
    // The user's own words name an excluded fact: a model on this computer may see it.
    store.dispatch('core/brief.set-field', { path: 'brief.freeText', value: 'Beat the Secret Final Boss.' }); // prettier-ignore
    store.dispatch('core/knowledge.add-entity', { id: 'ent_final', kind: 'boss', name: 'Secret Final Boss' }); // prettier-ignore
    store.dispatch('core/knowledge.set-excluded', { id: 'ent_final', excluded: true });
    const out = await generateStoryboardOp(engine, store, { assume: true, duration: 60 });
    expect(out.sections.map((s) => s.name)).toEqual(['Hook', 'Escalation', 'End slate']);
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((c) => c.model === 'qwen3:14b')).toBe(true);
    const log = (await readFile(join(root, 'home', 'logs', 'egress.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { host: string; ok: boolean; purpose: string }); // prettier-ignore
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log.map((r) => r.host.split(':')[0]))).toEqual(new Set(['127.0.0.1']));
    expect(log.every((r) => r.ok)).toBe(true);
    expect(log.some((r) => /storyboard\.generate.*Ollama/.test(r.purpose))).toBe(true);
  });
});
