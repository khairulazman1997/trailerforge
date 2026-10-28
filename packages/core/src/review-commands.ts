import type { Draft } from 'immer';
import { ContentHash, Flicks, Id, IsoDateTime, mintId, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Review: timestamped comments on a version and approvals stamped with the render plan hash.
 * They are user decisions (undoable, in `project.json`) and leave the storyboard revision alone;
 * a comment never changes the render plan, so it never makes an approval stale. Times come in
 * the payload when the caller has them (tests, imports), else the wall clock.
 */

const Version = Id.nullable();

function requireVersion(d: Draft<Project>, variantId: string | null, type: string) {
  if (variantId === null) return;
  if (!d.storyboard?.variants.some((v) => v.id === variantId))
    throw new CommandError(type, `no version "${variantId}"`);
}

function findComment(d: Draft<Project>, commentId: string, type: string) {
  const c = d.review.comments.find((x) => x.id === commentId);
  if (!c) throw new CommandError(type, `no comment "${commentId}"`);
  return c;
}

const allIds = (d: Draft<Project>) =>
  new Set([
    ...d.review.comments.map((c) => c.id),
    ...(d.storyboard?.variants.map((v) => v.id) ?? []),
  ]);

export const addComment = defineCommand({
  type: 'core/review.comment',
  payload: z.strictObject({
    id: Id.optional(),
    variantId: Version,
    at: Flicks,
    itemId: Id.optional(),
    text: z.string().trim().min(1).max(2000),
    createdAt: IsoDateTime.optional(),
  }),
  label: () => 'Add comment',
  apply: (d, p) => {
    const type = 'core/review.comment';
    requireVersion(d, p.variantId, type);
    const taken = allIds(d);
    if (p.id && taken.has(p.id)) throw new CommandError(type, `id "${p.id}" is used`);
    d.review.comments.push({
      id: p.id ?? mintId('cmt', p.text.slice(0, 24), taken),
      variantId: p.variantId,
      at: p.at,
      ...(p.itemId ? { itemId: p.itemId } : {}),
      text: p.text,
      resolved: false,
      createdAt: p.createdAt ?? new Date().toISOString(),
    });
  },
});

export const editComment = defineCommand({
  type: 'core/review.edit',
  payload: z.strictObject({
    commentId: Id,
    text: z.string().trim().min(1).max(2000),
    editedAt: IsoDateTime.optional(),
  }),
  label: () => 'Edit comment',
  apply: (d, { commentId, text, editedAt }) => {
    const c = findComment(d, commentId, 'core/review.edit');
    c.text = text;
    c.editedAt = editedAt ?? new Date().toISOString();
  },
  merge: { key: ({ commentId }) => commentId, windowMs: 1500 },
});

const setResolved = (type: string, resolved: boolean) =>
  defineCommand({
    type,
    payload: z.strictObject({ commentId: Id }),
    label: () => (resolved ? 'Resolve comment' : 'Reopen comment'),
    apply: (d, { commentId }) => {
      findComment(d, commentId, type).resolved = resolved;
    },
  });
export const resolveComment = setResolved('core/review.resolve', true);
export const reopenComment = setResolved('core/review.reopen', false);

export const deleteComment = defineCommand({
  type: 'core/review.delete',
  payload: z.strictObject({ commentId: Id }),
  label: () => 'Delete comment',
  apply: (d, { commentId }) => {
    findComment(d, commentId, 'core/review.delete');
    d.review.comments = d.review.comments.filter((c) => c.id !== commentId);
  },
});

/** Approve a version as rendered by the plan with `planHash` (replaces an earlier approval). */
export const approve = defineCommand({
  type: 'core/review.approve',
  payload: z.strictObject({
    variantId: Version,
    planHash: ContentHash,
    note: z.string().max(500).optional(),
    approvedAt: IsoDateTime.optional(),
  }),
  label: () => 'Approve version',
  apply: (d, p) => {
    requireVersion(d, p.variantId, 'core/review.approve');
    d.review.approvals = d.review.approvals.filter((a) => a.variantId !== p.variantId);
    d.review.approvals.push({
      variantId: p.variantId,
      planHash: p.planHash,
      approvedAt: p.approvedAt ?? new Date().toISOString(),
      ...(p.note ? { note: p.note } : {}),
    });
  },
});

export const revoke = defineCommand({
  type: 'core/review.revoke',
  payload: z.strictObject({ variantId: Version }),
  label: () => 'Withdraw approval',
  apply: (d, { variantId }) => {
    if (!d.review.approvals.some((a) => a.variantId === variantId))
      throw new CommandError('core/review.revoke', 'the version is not approved');
    d.review.approvals = d.review.approvals.filter((a) => a.variantId !== variantId);
  },
});

/** Forget a removed version's comments and approval (the version commands call this). */
export function dropVersionReview(d: Draft<Project>, variantId: string): void {
  d.review.comments = d.review.comments.filter((c) => c.variantId !== variantId);
  d.review.approvals = d.review.approvals.filter((a) => a.variantId !== variantId);
}

export const reviewCommands = [
  addComment,
  editComment,
  resolveComment,
  reopenComment,
  deleteComment,
  approve,
  revoke,
] as unknown as readonly CommandDef<unknown>[];
