import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { effectBriefOf } from '@trailerforge/storyboard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptEffectOp,
  effectBriefsOp,
  effectProposalsOp,
  generatorMotion,
} from './effectcraft-ops.js';
import { Engine } from './engine.js';
import { regenerateSectionOp } from './ops.js';

/** M10 10.4c: effect briefs from the generator become proposals; accepted effects survive regeneration. */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const good = (name: string) => ({
  name,
  summary: `${name}, in words.`,
  commands: [{ command: 'layer.newText', params: { name: 'T', text: name.toUpperCase() } }],
});
const bad = { name: 'Bad', summary: 'x', commands: [{ command: 'file.open', params: {} }] };
let replies: unknown[] = [];
const asked: string[] = [];
const mock = createMockProvider({
  'effectcraft.author': (req: LlmRequest<unknown>) => {
    asked.push(req.prompt);
    return replies.shift();
  },
  'storyboard.regenerate-section': () => ({
    rationale: 'Fresh hook.',
    section: {
      name: 'Hook',
      role: 'hook',
      slots: [{ kind: 'shot', title: 'New parry', seconds: 2 }],
    },
  }),
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let store: ProjectStore;
const slot = (id: string) =>
  store.state.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === id);
const effects = () =>
  store.state.timelines[0]!.tracks.find((t) => t.id === 'trk_user_effects')?.items ?? [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecbriefs-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  const p = sampleProject();
  const brief = (text: string) => ({ effectcraft: { brief: { text, why: 'worth it' } } });
  const sb = p.storyboard as unknown as { sections: { slots: { extensions: unknown }[] }[] };
  sb.sections[0]!.slots[0]!.extensions = brief('Sparks burst from the parry');
  sb.sections[1]!.slots[0]!.extensions = brief('The boss name slams in');
  store = await engine.createProject(join(root, 'B.tforge'), { ...p, id: 'proj_briefs' } as never);
}, 60_000);
afterAll(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});

describe('effect briefs', { timeout: 120_000 }, () => {
  it('generation is offered briefs only when EffectCraft is there', async () => {
    expect(await generatorMotion(engine)).toEqual({ motion: { templates: [], briefs: true } });
    const bare = await Engine.start({ home: join(root, 'h2'), autosaveMs: 0, loadUserPlugins: false, effectcraft: null }); // prettier-ignore
    try {
      expect(await generatorMotion(bare)).toEqual({});
    } finally {
      await bare.close();
    }
  });

  it('one proposal per brief, refused ones reported, nothing applied; accept is one undo step', async () => {
    replies = [good('Spark burst'), bad, bad];
    const before = store.state;
    const first = await effectBriefsOp(engine, store);
    expect(first.proposals.map((p) => [p.slotId, p.name, p.seconds])).toEqual([['shot_parry', 'Spark burst', 2]]); // prettier-ignore
    expect(first.skipped).toEqual([{ slotId: 'shot_boss', reason: expect.stringMatching(/could not be built/) }]); // prettier-ignore
    expect(asked[0]).toContain('Sparks burst from the parry');
    expect(store.state).toBe(before);

    // Again: the waiting proposal is not written twice; the refused brief is tried again.
    replies = [good('Boss slam')];
    const second = await effectBriefsOp(engine, store);
    expect(second.skipped).toEqual([{ slotId: 'shot_parry', reason: 'proposed' }]);
    expect(second.proposals.map((p) => p.slotId)).toEqual(['shot_boss']);
    expect((await effectProposalsOp(store)).map((p) => p.slotId).sort()).toEqual(['shot_boss', 'shot_parry']); // prettier-ignore

    // Accept the parry's: it lands where the shot starts, and its brief is marked accepted.
    const r = await acceptEffectOp(engine, store, { proposalId: first.proposals[0]!.id });
    expect(r.start).toBe(0);
    expect(effects()).toMatchObject([{ id: r.itemId, extensions: { effectcraft: { slotId: 'shot_parry' } } }]); // prettier-ignore
    expect(effectBriefOf(slot('shot_parry')!)?.accepted).toBe(true);
    store.undo();
    expect(effects()).toEqual([]);
    expect(effectBriefOf(slot('shot_parry')!)?.accepted).toBeUndefined();
    store.redo();

    const third = await effectBriefsOp(engine, store);
    expect(third.skipped).toEqual([
      { slotId: 'shot_parry', reason: 'accepted' },
      { slotId: 'shot_boss', reason: 'proposed' },
    ]);
  });

  it('regenerating a section keeps the accepted effect', async () => {
    expect(effects()).toHaveLength(1);
    await regenerateSectionOp(engine, store, { sectionId: 'sec_hook' });
    expect(slot('shot_parry')).toBeUndefined();
    expect(effects()).toHaveLength(1);
  });
});
