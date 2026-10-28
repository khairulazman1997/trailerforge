import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalState, parseProject } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-review-')), 'R.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());
const comments = () => store.state.review.comments;
const F = 705_600_000;
const H = 'a'.repeat(64);

describe('core/review commands', () => {
  it('adds, edits, resolves, reopens and deletes comments, each undoable', () => {
    const revision = store.state.storyboard!.revision;
    store.dispatch('core/review.comment', {
      variantId: 'var_tt',
      at: 3 * F,
      itemId: 'it_boss',
      text: '  Boss reveal lands late  ',
      createdAt: '2026-10-28T12:00:00.000Z',
    });
    expect(comments()).toEqual([
      {
        id: 'cmt_boss_reveal_lands_late',
        variantId: 'var_tt',
        at: 3 * F,
        itemId: 'it_boss',
        text: 'Boss reveal lands late',
        resolved: false,
        createdAt: '2026-10-28T12:00:00.000Z',
      },
    ]);
    const id = comments()[0]!.id;
    store.dispatch('core/review.edit', { commentId: id, text: 'Lands 2 frames late', editedAt: '2026-10-28T12:01:00.000Z' });
    store.dispatch('core/review.resolve', { commentId: id });
    expect(comments()[0]).toMatchObject({ text: 'Lands 2 frames late', resolved: true, editedAt: '2026-10-28T12:01:00.000Z' });
    store.dispatch('core/review.reopen', { commentId: id });
    expect(comments()[0]!.resolved).toBe(false);
    store.dispatch('core/review.delete', { commentId: id });
    expect(comments()).toEqual([]);
    store.undo();
    store.undo();
    expect(comments()[0]!.resolved).toBe(true);
    expect(store.state.storyboard!.revision).toBe(revision);
    expect(() => store.dispatch('core/review.comment', { variantId: 'var_gone', at: 0, text: 'x' })).toThrow(/no version/);
    expect(() => store.dispatch('core/review.comment', { variantId: null, at: 0, text: '   ' })).toThrow();
    expect(() => store.dispatch('core/review.edit', { commentId: 'cmt_nope', text: 'x' })).toThrow(/no comment/);
  }); // prettier-ignore

  it('a comment keeps its time when the item under it is deleted', () => {
    store.dispatch('core/review.comment', { variantId: null, at: 2.5 * F, itemId: 'it_boss', text: 'Needs a take' });
    store.dispatch('core/timeline.delete', { timelineId: 'tl_master', itemId: 'it_boss' });
    expect(comments()[0]).toMatchObject({ at: 2.5 * F, itemId: 'it_boss' });
    expect(parseProject(store.state).ok).toBe(true);
  }); // prettier-ignore

  it('approves with a plan hash, replaces and withdraws approvals', () => {
    store.dispatch('core/review.approve', { variantId: 'var_tt', planHash: H, approvedAt: '2026-10-28T12:00:00.000Z' });
    expect(approvalState(store.state.review, 'var_tt', H)).toBe('approved');
    expect(approvalState(store.state.review, 'var_tt', 'b'.repeat(64))).toBe('stale');
    expect(approvalState(store.state.review, null, H)).toBe('none');
    store.dispatch('core/review.approve', { variantId: 'var_tt', planHash: 'b'.repeat(64), note: 'final' });
    expect(store.state.review.approvals).toHaveLength(1);
    expect(store.state.review.approvals[0]).toMatchObject({ planHash: 'b'.repeat(64), note: 'final' });
    store.dispatch('core/review.revoke', { variantId: 'var_tt' });
    expect(store.state.review.approvals).toEqual([]);
    expect(() => store.dispatch('core/review.revoke', { variantId: 'var_tt' })).toThrow(/not approved/);
    expect(() => store.dispatch('core/review.approve', { variantId: 'var_tt', planHash: 'short' })).toThrow();
  }); // prettier-ignore

  it('removing a version drops its review; undo brings it back', () => {
    store.dispatch('core/review.comment', { variantId: 'var_tt', at: 0, text: 'Hook too slow' });
    store.dispatch('core/review.approve', { variantId: 'var_tt', planHash: H });
    store.dispatch('core/variants.remove', { variantId: 'var_tt' });
    expect(store.state.review).toEqual({ comments: [], approvals: [] });
    expect(parseProject(store.state).ok).toBe(true);
    store.undo();
    expect(comments()).toHaveLength(1);
    expect(store.state.review.approvals).toHaveLength(1);
  });

  it('cross-reference checks refuse review data for an unknown version or a second approval', () => {
    const p = sampleProject();
    const bad = {
      ...p,
      review: {
        comments: [{ id: 'cmt_a', variantId: 'var_gone', at: 0, text: 'x', createdAt: '2026-10-28T12:00:00.000Z' }],
        approvals: [
          { variantId: null, planHash: H, approvedAt: '2026-10-28T12:00:00.000Z' },
          { variantId: null, planHash: H, approvedAt: '2026-10-28T12:00:00.000Z' },
        ],
      },
    };
    const r = parseProject(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message)).toEqual(['unknown variant "var_gone"', 'two approvals for "(master)"']);
  }); // prettier-ignore
});
