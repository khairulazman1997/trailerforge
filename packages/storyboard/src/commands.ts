import { defineCommand, type CommandDef } from '@trailerforge/core';
import {
  Id,
  IsoDateTime,
  MusicPlan,
  Section,
  Storyboard,
  VoLine,
  type StoryboardComment,
} from '@trailerforge/schema';
import { storyboardCommentCommands } from './comments.js';
import { z } from 'zod';
import { storyboardEditCommands } from './edit.js';
import {
  cleanupRemovedSlots,
  SectionLockedError,
  slotIdsOf,
  unlinkTimelineItems,
} from './shared.js';

export { SectionLockedError };

/** Key-order-independent JSON, so a locked section compares equal however it was built. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Replace the whole storyboard. Every locked section must come through unchanged. */
export const setStoryboard = defineCommand({
  type: 'core/storyboard.set',
  payload: Storyboard,
  label: () => 'Generate storyboard',
  apply: (d, sb) => {
    for (const locked of d.storyboard?.sections.filter((s) => s.locked) ?? []) {
      const next = sb.sections.find((s) => s.id === locked.id);
      if (!next || canonical(next) !== canonical(locked)) throw new SectionLockedError(locked.id);
    }
    const next = slotIdsOf(sb.sections);
    unlinkTimelineItems(
      d,
      new Set([...slotIdsOf(d.storyboard?.sections ?? [])].filter((id) => !next.has(id))),
    );
    d.storyboard = { ...sb, comments: carriedComments(d.storyboard?.comments ?? [], sb) };
  },
});

/**
 * Comments survive a new storyboard while their section does (locked sections keep their ids);
 * a comment whose slot is gone stays on the section. Comments the payload brings win.
 */
function carriedComments(old: readonly StoryboardComment[], sb: Storyboard): StoryboardComment[] {
  const own = new Set(sb.comments.map((c) => c.id));
  const kept = old
    .filter((c) => !own.has(c.id) && sb.sections.some((s) => s.id === c.sectionId))
    .map((c) => {
      const home = sb.sections.find((s) => s.id === c.sectionId)!;
      if (!c.slotId || home.slots.some((x) => x.id === c.slotId)) return { ...c };
      const { slotId: _, ...rest } = c;
      return rest;
    });
  return [...sb.comments, ...kept];
}

/**
 * Swap one unlocked section, keeping its id, and drop references to the slots it no longer has
 * (VO lines that only narrated them, hit points, SFX cues, variant overrides).
 */
const SfxCue = MusicPlan.shape.sfxCues.unwrap().element;

export const replaceSection = defineCommand({
  type: 'core/storyboard.replace-section',
  payload: z.strictObject({
    sectionId: Id,
    section: Section,
    voLines: z.array(VoLine).default([]),
    /** Sounds suggested for the new section's slots. */
    sfxCues: z.array(SfxCue).default([]),
    /** Comments the rewrite took into account: resolved, stamped with `addressedAt`. */
    addressedCommentIds: z.array(Id).default([]),
    addressedAt: IsoDateTime.optional(),
  }),
  label: ({ section }) => `Regenerate ${section.name}`,
  apply: (d, { sectionId, section, voLines, sfxCues, addressedCommentIds, addressedAt }) => {
    const sb = d.storyboard;
    const idx = sb?.sections.findIndex((s) => s.id === sectionId) ?? -1;
    if (!sb || idx < 0) throw new Error(`no section "${sectionId}"`);
    const old = sb.sections[idx]!;
    if (old.locked) throw new SectionLockedError(sectionId);
    const kept = new Set(section.slots.map((s) => s.id));
    const gone = new Set(old.slots.map((s) => s.id).filter((id) => !kept.has(id)));

    sb.sections[idx] = { ...section, id: sectionId, locked: false };
    cleanupRemovedSlots(d, gone);
    sb.voLines.push(...voLines);
    sb.music.sfxCues.push(...sfxCues);
    const addressed = new Set(addressedCommentIds);
    for (const c of sb.comments)
      if (addressed.has(c.id) && c.sectionId === sectionId) {
        c.resolved = true;
        c.addressedAt = addressedAt ?? new Date().toISOString();
      }
    sb.revision += 1;
  },
});

export const setSectionLocked = defineCommand({
  type: 'core/storyboard.set-section-locked',
  payload: z.strictObject({ sectionId: Id, locked: z.boolean() }),
  label: ({ locked }) => (locked ? 'Lock section' : 'Unlock section'),
  apply: (d, { sectionId, locked }) => {
    const s = d.storyboard?.sections.find((x) => x.id === sectionId);
    if (!s) throw new Error(`no section "${sectionId}"`);
    s.locked = locked;
  },
});

/** Registered by the core plugin. Payloads are validated at dispatch, so the list is type-erased. */
export const storyboardCommands = [
  setStoryboard,
  replaceSection,
  setSectionLocked,
  ...storyboardEditCommands,
  ...storyboardCommentCommands,
] as unknown as readonly CommandDef<unknown>[];
