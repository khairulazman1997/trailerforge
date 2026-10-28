import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRender, type SourceMedia } from '@trailerforge/compile';
import { ProjectStore, coreCommands } from '@trailerforge/core';
import { deriveVariant } from '@trailerforge/cut';
import { approvalState, rate } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** An approval holds while the version's render plan is unchanged: comments never move it. */

let store: ProjectStore;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-approve-')), 'A.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());

const source: SourceMedia = {
  path: '/media/forest.mp4',
  contentHash: 'f'.repeat(64),
  width: 1920,
  height: 1080,
  frameRate: rate(60),
  duration: 120,
  hasAudio: true,
};
const planHash = () => {
  const d = deriveVariant({
    project: store.state,
    variantId: 'var_tt',
    masterTimelineId: 'tl_master',
  });
  return compileRender({ timeline: d.timeline, sources: new Map([['asset_forest', source]]) })
    .planHash;
};

describe('approval and the render plan', () => {
  it('stays approved through comments and goes stale on an edit', () => {
    const h = planHash();
    store.dispatch('core/review.approve', { variantId: 'var_tt', planHash: h });
    store.dispatch('core/review.comment', { variantId: 'var_tt', at: 0, itemId: 'it_parry', text: 'Love this' });
    store.dispatch('core/review.resolve', { commentId: store.state.review.comments[0]!.id });
    expect(planHash()).toBe(h);
    expect(approvalState(store.state.review, 'var_tt', planHash())).toBe('approved');

    store.dispatch('core/timeline.trim', { timelineId: 'tl_master', itemId: 'it_parry', edge: 'in', delta: 705_600_000 / 60 });
    expect(planHash()).not.toBe(h);
    expect(approvalState(store.state.review, 'var_tt', planHash())).toBe('stale');
    store.undo();
    expect(approvalState(store.state.review, 'var_tt', planHash())).toBe('approved');
  }); // prettier-ignore
});
