import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCritiqueFixOp } from './critique-ops.js';
import { createDemoOp } from './demo-ops.js';
import { Engine } from './engine.js';

/** Applying a critique fix changes the cut that drafts and exports render, not only the storyboard. */

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let engine: Engine;
let store: ProjectStore;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-critfix-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  const out = await createDemoOp(engine);
  store = [...engine.projects.values()].find((s) => s.state.id === out.projectId)!;
}, 240_000);
afterAll(async () => {
  await engine.close();
});

const cut = () => store.state.timelines.find((t) => t.id === 'tl_rough')!;
const itemsOf = (slotId: string) =>
  cut().tracks.flatMap((t) => t.items).filter((i) => i.slotId === slotId && i.kind === 'clip'); // prettier-ignore
const shots = () =>
  store.state.storyboard!.sections.flatMap((s) => s.slots).filter((s) => s.kind === 'shot');

function note(fix: Record<string, unknown>): string {
  store.dispatch('core/critique.add', {
    variantId: null,
    notes: [{ at: 0, text: 'A note', fix: { summary: 'Do it', ...fix } }],
  });
  return store.state.review.comments.find((c) => c.author === 'critique' && !c.resolved)!.id;
}

describe('applying a critique fix', { timeout: 120_000 }, () => {
  it('removing a shot takes it out of the cut, in the same undo step', async () => {
    const slotId = shots()[1]!.id;
    expect(itemsOf(slotId)).toHaveLength(1);
    const id = note({ type: 'remove-slot', slotId });
    const out = await applyCritiqueFixOp(engine, store, id);
    expect(out.rebuilt).toBe(true);
    expect(itemsOf(slotId)).toHaveLength(0);
    expect(store.state.review.comments.find((c) => c.id === id)!.resolved).toBe(true);
    store.undo();
    expect(itemsOf(slotId)).toHaveLength(1);
    expect(shots().some((s) => s.id === slotId)).toBe(true);
    expect(store.state.review.comments.find((c) => c.id === id)!.resolved).toBe(false);
  });

  it('a new length re-times the shot in the cut, even one trimmed by hand', async () => {
    const slotId = shots()[0]!.id;
    const item = itemsOf(slotId)[0]!;
    // A hand trim first: the fix is about this shot's length, so it wins.
    store.dispatch('core/timeline.trim', { timelineId: 'tl_rough', itemId: item.id, edge: 'out', delta: -FLICKS_PER_SECOND / 10 }); // prettier-ignore
    const before = itemsOf(slotId)[0]!.duration;
    const seconds = before / FLICKS_PER_SECOND + 2;
    const id = note({ type: 'slot-duration', slotId, seconds });
    await applyCritiqueFixOp(engine, store, id);
    const after = itemsOf(slotId)[0]!.duration / FLICKS_PER_SECOND;
    expect(after).toBeGreaterThan(before / FLICKS_PER_SECOND + 1);
    expect(Math.abs(after - seconds)).toBeLessThan(0.6); // on the beat grid (120 BPM)
  });
});
