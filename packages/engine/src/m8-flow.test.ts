import dns from 'node:dns';
import net from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDecisions } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemoOp } from './demo-ops.js';
import { acceptEffectOp, authorEffectOp } from './effectcraft-ops.js';
import { Engine } from './engine.js';
import { buildVersion, exportVersionOp } from './render-ops.js';

/**
 * M8 whole flow: the demo project, a custom EffectCraft title written by the (mock) AI, accepted
 * onto the cut, exported twice from scratch to identical bytes; not one network connection.
 * EffectCraft is the stand-in CLI here (the real one is checked by the Windows run).
 */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};
const mock = createMockProvider({
  'effectcraft.author': {
    name: 'Ember title',
    summary: 'EMBER KNIGHT snaps in on the hit.',
    commands: [
      { command: 'layer.newText', params: { name: 'Title', text: 'EMBER KNIGHT', size: 96, fill: '#ff7a1a' } }, // prettier-ignore
      { command: 'prop.addKey', params: { layer: 'Title', path: 'transform/opacity', time: 0, value: 0 } }, // prettier-ignore
      { command: 'prop.addKey', params: { layer: 'Title', path: 'transform/opacity', time: 0.5, value: 100 } }, // prettier-ignore
    ],
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let engine: Engine;
let store: Awaited<ReturnType<Engine['openProject']>>;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-m8-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  const demo = await createDemoOp(engine);
  store = await engine.openProject(demo.dir);
}, 240_000);
afterAll(async () => engine.close());

describe('M8 whole flow', { timeout: 300_000 }, () => {
  it('demo → custom EffectCraft title → export, the same bytes twice, no network', async () => {
    const p = await authorEffectOp(engine, store, { words: 'Our title on the boss reveal', seconds: 2, landAt: 0.5 }); // prettier-ignore
    const r = await acceptEffectOp(engine, store, { proposalId: p.id, at: 1 });

    const build = await buildVersion(engine, store, null);
    expect(build.motion.map((m) => m.itemId)).toEqual([r.itemId]);

    const first = await exportVersionOp(engine, store, null);
    for (const dir of ['render', 'render-out', 'frames', 'render-frames', 'quality'])
      rmSync(join(store.paths.cache, dir), { recursive: true, force: true });
    const again = await exportVersionOp(engine, store, null);
    expect(again.sha256).toBe(first.sha256);
    expect(readFileSync(again.poster).equals(readFileSync(first.poster))).toBe(true);

    const log = await readDecisions(store.paths.decisions);
    expect(log.some((d) => d.step === 'effectcraft/author')).toBe(true);
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
