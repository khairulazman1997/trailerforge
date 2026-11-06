import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { FLICKS_PER_SECOND, type Timeline } from '@trailerforge/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCritiqueFixOp } from './critique-ops.js';
import { createDemoOp } from './demo-ops.js';
import { Engine } from './engine.js';
import { generateCutOp } from './footage-ops.js';

/**
 * Applying a critique fix reaches the cut: the storyboard changes and the rough cut is rebuilt in
 * the same undo step, and a shot the fix changed is made again even when its clip was hand-edited.
 */

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let engine: Engine;
let store: ProjectStore;

const cut = (): Timeline => store.state.timelines.find((t) => t.id === 'tl_rough')!;
const itemOf = (slotId: string) =>
  cut()
    .tracks.filter((t) => t.kind === 'video')
    .flatMap((t) => t.items)
    .find((i) => i.slotId === slotId)!;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-critique-apply-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  const out = await createDemoOp(engine);
  store = [...engine.projects.values()].find((s) => s.state.id === out.projectId)!;
}, 240_000);
afterAll(async () => engine.close());

function addFix(slotId: string, seconds: number) {
  store.dispatch('core/critique.add', {
    variantId: null,
    notes: [
      {
        at: 0,
        text: 'This shot runs long.',
        fix: { type: 'slot-duration', slotId, seconds, summary: `Make it ${seconds} s` },
      },
    ],
  });
  return store.state.review.comments.find((c) => c.author === 'critique' && !c.resolved)!;
}

describe('applying a critique fix', { timeout: 120_000 }, () => {
  it('rebuilds the cut over a hand edit of that shot, in one undo step', async () => {
    const slot = store.state.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.kind === 'shot')!; // prettier-ignore
    const original = itemOf(slot.id);
    // The user trims the clip by hand (half a second shorter) and the trim is kept on a rebuild.
    store.dispatch('core/timeline.trim', {
      timelineId: 'tl_rough',
      itemId: original.id,
      edge: 'out',
      delta: -FLICKS_PER_SECOND / 2,
    });
    const trimmed = itemOf(slot.id).duration;
    expect(trimmed).toBeLessThan(original.duration);
    const again = await generateCutOp(engine, store);
    expect(again.keptEdits).toContain(original.id);
    expect(again.replacedEdits).toEqual([]);
    expect(itemOf(slot.id).duration).toBe(trimmed);

    // A critique fix asks for a much longer shot: the cut follows the storyboard.
    const note = addFix(slot.id, slot.duration.ideal * 2);
    const depth = store.undoDepth;
    const before = cut();
    const r = await applyCritiqueFixOp(engine, store, note.id);
    expect(r.rebuilt).toBe(true);
    expect(r.cut!.replacedEdits.map((x) => x.slotId)).toEqual([slot.id]);
    expect(itemOf(slot.id).duration).toBeGreaterThan(original.duration);
    expect(store.state.review.comments.find((c) => c.id === note.id)!.resolved).toBe(true);
    expect(store.undoDepth).toBe(depth + 1);

    // One Undo takes back the fix and the rebuild together.
    store.undo();
    expect(cut()).toEqual(before);
    expect(store.state.review.comments.find((c) => c.id === note.id)!.resolved).toBe(false);
    expect(itemOf(slot.id).duration).toBe(trimmed);
  });
});
