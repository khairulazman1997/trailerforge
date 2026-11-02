import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { OpError, refineStoryboardOp } from './ops.js';

const reply = {
  rationale: 'Did what the comments asked.',
  section: { name: 'Rewritten', slots: [{ kind: 'shot', title: 'New shot', seconds: 2 }] },
};
const mock = createMockProvider({ 'storyboard.regenerate-section': reply });
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-refine-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
});
afterAll(async () => {
  await engine.close();
});

const shot = (id: string, title: string) => ({
  id,
  kind: 'shot',
  title,
  duration: { min: 1, ideal: 2, max: 3 },
});
const section = (id: string, slots: unknown[], locked = false) => ({
  id,
  name: id,
  locked,
  slots,
});

describe('refineStoryboardOp', () => {
  it('rewrites each commented section from its comments and skips locked ones', async () => {
    const store = await engine.createProject(join(root, 'P.tforge'), {
      name: 'Ember Knight',
      brief: { videoTypeId: 'game-trailer/release-trailer' },
    });
    await expect(refineStoryboardOp(engine, store)).rejects.toThrow(OpError);
    store.dispatch('core/storyboard.set', {
      id: 'sb_main',
      meta: { videoTypeId: 'game-trailer/release-trailer', targetDuration: 6 },
      sections: [
        section('sec_a', [shot('sh_a', 'Forest')]),
        section('sec_b', [shot('sh_b', 'Boss')]),
        section('sec_c', [shot('sh_c', 'Logo')], true),
      ],
    });
    await expect(refineStoryboardOp(engine, store)).rejects.toThrow(/no open comments/);
    store.dispatch('core/storyboard.comment', { slotId: 'sh_b', text: 'Bigger boss moment' });
    store.dispatch('core/storyboard.comment', { sectionId: 'sec_c', text: 'Add the date' });

    const out = await refineStoryboardOp(engine, store);
    expect(out.sections.map((s) => s.section.id)).toEqual(['sec_b']);
    expect(out.sections[0]!.addressedCommentIds).toHaveLength(1);
    expect(out.skipped).toEqual([
      { sectionId: 'sec_c', name: 'sec_c', reason: 'the section is locked' },
    ]);
    expect(mock.calls.at(-1)!.prompt).toContain('Bigger boss moment');
    const sb = store.state.storyboard!;
    expect(sb.sections.map((s) => s.slots[0]!.title)).toEqual(['Forest', 'New shot', 'Logo']);
    expect(sb.comments.map((c) => c.resolved)).toEqual([true, false]);
    await expect(refineStoryboardOp(engine, store, { sectionIds: ['sec_nope'] })).rejects.toThrow(
      /no section/,
    );
  });
});
