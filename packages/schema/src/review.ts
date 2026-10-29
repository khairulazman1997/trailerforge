import { z } from 'zod';
import { ContentHash, Id, IsoDateTime } from './common.js';
import { Flicks } from './time.js';

/**
 * Review of the versions: timestamped comments and approvals. Single user and local; these are
 * user decisions, so they live in `project.json`. A comment is anchored to a time on a version
 * (`variantId`, or null for the master cut) and, when there is one, the timeline item under it;
 * the time stays meaningful when the item goes away. An approval records the render plan hash
 * it saw: when the plan changes, the approval is stale (see `approvalState`).
 */
/**
 * A change an AI critique suggests, as data the user can apply or dismiss: never applied on its
 * own. Slots are named by their real ids here (the model only ever saw aliases).
 */
export const CritiqueFix = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('slot-duration'),
    slotId: Id,
    /** The new ideal length; the range widens to include it. */
    seconds: z.number().positive().max(600),
    summary: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    type: z.literal('remove-slot'),
    slotId: Id,
    summary: z.string().trim().min(1).max(200),
  }),
]);
export type CritiqueFix = z.infer<typeof CritiqueFix>;

export const ReviewComment = z.strictObject({
  id: Id,
  /** The version; null is the master cut. */
  variantId: Id.nullable(),
  /** Time on that version. */
  at: Flicks,
  /** The timeline item under the playhead when the comment was made, if any. */
  itemId: Id.optional(),
  text: z.string().trim().min(1).max(2000),
  resolved: z.boolean().default(false),
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.optional(),
  /** Set on notes the AI critique wrote; people's comments have no author. */
  author: z.literal('critique').optional(),
  /** What applying this critique note would change, if it has a fix. */
  fix: CritiqueFix.optional(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const Approval = z.strictObject({
  variantId: Id.nullable(),
  /** `planHash` of the render plan that was approved. */
  planHash: ContentHash,
  approvedAt: IsoDateTime,
  note: z.string().max(500).optional(),
});
export type Approval = z.infer<typeof Approval>;

export const Review = z.strictObject({
  comments: z.array(ReviewComment).default([]),
  approvals: z.array(Approval).default([]),
});
export type Review = z.infer<typeof Review>;

export type ApprovalState = 'none' | 'approved' | 'stale';

/** Whether a version's approval still holds for its current render plan. */
export function approvalState(
  review: Pick<Review, 'approvals'>,
  variantId: string | null,
  currentPlanHash: string | null,
): ApprovalState {
  const a = review.approvals.find((x) => x.variantId === variantId);
  if (!a) return 'none';
  return currentPlanHash !== null && a.planHash === currentPlanHash ? 'approved' : 'stale';
}
