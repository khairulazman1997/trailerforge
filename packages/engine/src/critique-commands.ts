import { CommandError, defineCommand, type CommandDef } from '@trailerforge/core';
import { CritiqueFix, Flicks, Id, IsoDateTime, mintId } from '@trailerforge/schema';
import { removeSlot, updateSlot } from '@trailerforge/storyboard';
import { z } from 'zod';

/**
 * AI critique notes live in `project.review.comments` (author "critique"), so they show up with
 * everyone's comments and go through the same undo history. Adding a batch and applying a note's
 * fix are each one undo step: applying runs the storyboard edit and resolves the note together.
 */

export const CritiqueNote = z.strictObject({
  at: Flicks,
  itemId: Id.optional(),
  text: z.string().trim().min(1).max(2000),
  fix: CritiqueFix.optional(),
});
export type CritiqueNote = z.infer<typeof CritiqueNote>;

type Draft = Parameters<CommandDef<unknown>['apply']>[0];

const takenIds = (d: Draft) =>
  new Set([
    ...d.review.comments.map((c) => c.id),
    ...(d.storyboard?.variants.map((v) => v.id) ?? []),
  ]);

/** Replace a version's open critique notes with a new batch (people's comments are untouched). */
export const addCritique = defineCommand({
  type: 'core/critique.add',
  payload: z.strictObject({
    variantId: Id.nullable(),
    notes: z.array(CritiqueNote).max(20),
    createdAt: IsoDateTime.optional(),
  }),
  label: ({ notes }) => `Add ${notes.length} critique note${notes.length === 1 ? '' : 's'}`,
  apply: (d, { variantId, notes, createdAt }) => {
    const type = 'core/critique.add';
    if (variantId !== null && !d.storyboard?.variants.some((v) => v.id === variantId))
      throw new CommandError(type, `no version "${variantId}"`);
    d.review.comments = d.review.comments.filter(
      (c) => !(c.author === 'critique' && c.variantId === variantId && !c.resolved),
    );
    const taken = takenIds(d);
    for (const n of notes) {
      const id = mintId('cmt', n.text.slice(0, 24), taken);
      taken.add(id);
      d.review.comments.push({
        id,
        variantId,
        at: n.at,
        ...(n.itemId ? { itemId: n.itemId } : {}),
        text: n.text,
        resolved: false,
        createdAt: createdAt ?? new Date().toISOString(),
        author: 'critique',
        ...(n.fix ? { fix: n.fix } : {}),
      });
    }
  },
});

/** Do what a critique note suggests, and mark the note resolved: one undo step. */
export const applyCritiqueFix = defineCommand({
  type: 'core/critique.apply-fix',
  payload: z.strictObject({ commentId: Id }),
  label: () => 'Apply a critique suggestion',
  apply: (d, { commentId }) => {
    const type = 'core/critique.apply-fix';
    const c = d.review.comments.find((x) => x.id === commentId);
    if (!c) throw new CommandError(type, `no comment "${commentId}"`);
    if (c.author !== 'critique' || !c.fix) throw new CommandError(type, 'this note has no fix');
    if (c.resolved) throw new CommandError(type, 'this note is already resolved');
    const fix = c.fix;
    const slot = d.storyboard?.sections.flatMap((s) => s.slots).find((s) => s.id === fix.slotId);
    if (!slot)
      throw new CommandError(type, 'that shot is no longer in the storyboard; the note is stale');
    if (fix.type === 'remove-slot') removeSlot.apply(d, { slotId: fix.slotId });
    else {
      const old = slot.duration;
      updateSlot.apply(d, {
        slotId: fix.slotId,
        patch: {
          duration: {
            min: Math.min(old.min, fix.seconds),
            ideal: fix.seconds,
            max: Math.max(old.max, fix.seconds),
          },
        },
      });
    }
    const note = d.review.comments.find((x) => x.id === commentId);
    if (note) note.resolved = true;
  },
});

export const critiqueCommands = [
  addCritique,
  applyCritiqueFix,
] as unknown as readonly CommandDef<unknown>[];
