import { defineCommand, type CommandDef } from '@trailerforge/core';
import {
  collectIds,
  Id,
  IsoDateTime,
  mintId,
  type Project,
  type Storyboard,
  type StoryboardComment,
} from '@trailerforge/schema';
import type { Draft } from 'immer';
import { z } from 'zod';
import { findSection, findSlot, requireStoryboard } from './shared.js';

/**
 * Comments on storyboard sections and slots: notes for the next AI rewrite of the section
 * (`regenerateSection` sends the open ones and the rewrite resolves them). They are user input,
 * undoable and in `project.json`, and work on locked sections too (a note does not change the
 * section). They leave the storyboard revision alone. Times come in the payload when the caller
 * has them (tests, imports), else the wall clock.
 */

const Text = z.string().trim().min(1).max(2000);

function findComment(d: Draft<Project>, commentId: string) {
  const c = requireStoryboard(d).comments.find((x) => x.id === commentId);
  if (!c) throw new Error(`no storyboard comment "${commentId}"`);
  return c;
}

export const addStoryboardComment = defineCommand({
  type: 'core/storyboard.comment',
  payload: z.strictObject({
    id: Id.optional(),
    /** The section; optional when `slotId` is given (its section is used). */
    sectionId: Id.optional(),
    slotId: Id.optional(),
    text: Text,
    createdAt: IsoDateTime.optional(),
  }),
  label: () => 'Add storyboard comment',
  apply: (d, p) => {
    let sectionId = p.sectionId;
    let slotLabel: string | undefined;
    if (p.slotId) {
      const found = findSlot(d, p.slotId);
      if (sectionId && found.section.id !== sectionId)
        throw new Error(`slot "${p.slotId}" is not in section "${sectionId}"`);
      sectionId = found.section.id;
      slotLabel = (found.slot.title || `#${found.index + 1}`).slice(0, 200);
    }
    if (!sectionId) throw new Error('say which section or slot the comment is on');
    const { sb } = findSection(d, sectionId);
    const taken = collectIds(d);
    if (p.id && taken.has(p.id)) throw new Error(`id "${p.id}" is already used`);
    sb.comments.push({
      id: p.id ?? mintId('sbc', p.text.slice(0, 24), taken),
      sectionId,
      ...(p.slotId ? { slotId: p.slotId } : {}),
      ...(slotLabel !== undefined ? { slotLabel } : {}),
      text: p.text,
      resolved: false,
      createdAt: p.createdAt ?? new Date().toISOString(),
    });
  },
});

export const editStoryboardComment = defineCommand({
  type: 'core/storyboard.edit-comment',
  payload: z.strictObject({ commentId: Id, text: Text, editedAt: IsoDateTime.optional() }),
  label: () => 'Edit storyboard comment',
  apply: (d, { commentId, text, editedAt }) => {
    const c = findComment(d, commentId);
    c.text = text;
    c.editedAt = editedAt ?? new Date().toISOString();
  },
  merge: { key: ({ commentId }) => commentId, windowMs: 1500 },
});

const setResolved = (type: string, resolved: boolean) =>
  defineCommand({
    type,
    payload: z.strictObject({ commentId: Id }),
    label: () => (resolved ? 'Resolve storyboard comment' : 'Reopen storyboard comment'),
    apply: (d, { commentId }) => {
      const c = findComment(d, commentId);
      c.resolved = resolved;
      if (!resolved) delete c.addressedAt;
    },
  });
export const resolveStoryboardComment = setResolved('core/storyboard.resolve-comment', true);
export const reopenStoryboardComment = setResolved('core/storyboard.reopen-comment', false);

export const deleteStoryboardComment = defineCommand({
  type: 'core/storyboard.delete-comment',
  payload: z.strictObject({ commentId: Id }),
  label: () => 'Delete storyboard comment',
  apply: (d, { commentId }) => {
    findComment(d, commentId);
    const sb = requireStoryboard(d);
    sb.comments = sb.comments.filter((c) => c.id !== commentId);
  },
});

export const storyboardCommentCommands = [
  addStoryboardComment,
  editStoryboardComment,
  resolveStoryboardComment,
  reopenStoryboardComment,
  deleteStoryboardComment,
] as unknown as readonly CommandDef<unknown>[];

/** The open comments on a section and its slots, in the order they were made. */
export function openComments(
  sb: Pick<Storyboard, 'comments'>,
  sectionId: string,
): StoryboardComment[] {
  return sb.comments.filter((c) => c.sectionId === sectionId && !c.resolved);
}

/** Sections with open comments, in storyboard order. */
export function commentedSectionIds(sb: Pick<Storyboard, 'comments' | 'sections'>): string[] {
  return sb.sections.filter((s) => openComments(sb, s.id).length > 0).map((s) => s.id);
}
