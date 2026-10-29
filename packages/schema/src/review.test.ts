import { describe, expect, it } from 'vitest';
import { CritiqueFix, ReviewComment } from './review.js';

const base = { id: 'cmt_a', variantId: null, at: 0, text: 'Shorter hook.', createdAt: '2026-10-29T10:00:00.000Z' }; // prettier-ignore

describe('critique notes in review comments', () => {
  it('a person’s comment has no author or fix; a critique note can carry one fix', () => {
    expect(ReviewComment.parse(base)).toMatchObject({ resolved: false });
    expect(ReviewComment.parse(base).author).toBeUndefined();
    const note = ReviewComment.parse({ ...base, author: 'critique', fix: { type: 'slot-duration', slotId: 'shot_a', seconds: 1.5, summary: 'Cut it' } }); // prettier-ignore
    expect(note.fix).toMatchObject({ type: 'slot-duration', seconds: 1.5 });
  });

  it('refuses fixes that are not one of the two kinds, or have extra or missing parts', () => {
    expect(CritiqueFix.safeParse({ type: 'delete-everything', slotId: 'a' }).success).toBe(false);
    expect(CritiqueFix.safeParse({ type: 'remove-slot', slotId: 'shot_a', summary: 'x', extra: 1 }).success).toBe(false); // prettier-ignore
    expect(CritiqueFix.safeParse({ type: 'slot-duration', slotId: 'shot_a', seconds: 0, summary: 'x' }).success).toBe(false); // prettier-ignore
    expect(CritiqueFix.safeParse({ type: 'remove-slot', slotId: 'shot_a', summary: '' }).success).toBe(false); // prettier-ignore
    expect(ReviewComment.safeParse({ ...base, author: 'someone' }).success).toBe(false);
  });
});
