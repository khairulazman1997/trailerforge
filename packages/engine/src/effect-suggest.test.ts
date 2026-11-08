import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectSuggestFactsOp, suggestEffectsOp } from './effect-suggest.js';
import { Engine } from './engine.js';

/** "Suggest an effect": text facts out, up to three ideas back, nothing stored. */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
let reply: unknown = { ideas: [] };
const asked: string[] = [];
const mock = createMockProvider({
  'effectcraft.suggest': (req: LlmRequest<unknown>) => {
    asked.push(req.prompt);
    return reply;
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let store: ProjectStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecsuggest-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  store = await engine.createProject(join(root, 'S.tforge'), {
    ...sampleProject(),
    id: 'proj_suggest',
  } as never);
}, 60_000);
afterAll(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});

describe('suggest an effect', { timeout: 120_000 }, () => {
  it('shows exactly what would be sent: text only, shots as keys, no ids', async () => {
    const f = await effectSuggestFactsOp(engine, store);
    expect(f.summary.join('\n')).toMatch(/shots in order/);
    expect(f.summary.join('\n')).toMatch(/0 custom effects already on the cut/);
    expect(f.summary.at(-1)).toMatch(/Never sent: footage/);
    const shots = f.wire.shots as { key: string }[];
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]!.key).toBe('shot-1');
    expect(f.wire.effectsAlready).toEqual([]);
    const text = JSON.stringify(f.wire);
    for (const s of store.state.storyboard!.sections.flatMap((x) => x.slots))
      expect(text).not.toContain(s.id);
  });

  it('maps ideas to their shots, drops unknown shots and extras, stores nothing', async () => {
    const before = store.state;
    const tl = store.state.timelines.find((t) => !t.variantId)!;
    const first = tl.tracks
      .filter((t) => t.kind === 'video' || t.kind === 'graphics')
      .flatMap((t) => t.items)
      .sort((a, b) => a.start - b.start)[0]!;
    reply = {
      ideas: [
        { about: 'shot-1', words: ' Sparks burst on the parry ', seconds: 1.5, landAt: 0.4, why: 'Sells the hit.' }, // prettier-ignore
        { about: 'shot-99', words: 'Nowhere', seconds: 2, why: '' },
        { about: 'overall', words: 'A soft vignette pulse', seconds: 2, landAt: 5, why: 'Mood.' },
        { about: 'overall', words: 'Third', seconds: 1, why: '' },
        { about: 'overall', words: 'Fourth', seconds: 1, why: '' },
      ],
    };
    const r = await suggestEffectsOp(engine, store);
    expect(r.provider).toBe('core/mock');
    expect(r.ideas).toEqual([
      {
        words: 'Sparks burst on the parry',
        seconds: 1.5,
        landAt: 0.4,
        slotId: first.slotId,
        slotLabel: expect.any(String),
        atSeconds: Math.round((first.start / FLICKS_PER_SECOND) * 10) / 10,
        why: 'Sells the hit.',
      },
      // A hit point after the end is dropped.
      { words: 'A soft vignette pulse', seconds: 2, why: 'Mood.' },
      { words: 'Third', seconds: 1, why: '' },
    ]);
    expect(r.skipped).toEqual([
      { about: 'shot-99', reason: 'unknown-shot' },
      { about: 'overall', reason: 'too-many' },
    ]);
    expect(asked.at(-1)).toContain('"key": "shot-1"');
    expect(store.state).toBe(before);
  });

  it('needs EffectCraft', async () => {
    const bare = await Engine.start({ home: join(root, 'h2'), autosaveMs: 0, loadUserPlugins: false, llm, effectcraft: null }); // prettier-ignore
    try {
      const s = await bare.createProject(join(root, 'T.tforge'), { ...sampleProject(), id: 'proj_bare' } as never); // prettier-ignore
      await expect(suggestEffectsOp(bare, s)).rejects.toMatchObject({
        code: 'usage',
        message: /need EffectCraft/,
      });
    } finally {
      await bare.close();
    }
  });
});
