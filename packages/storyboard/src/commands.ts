import { defineCommand, type CommandDef } from '@trailerforge/core';
import { Id, Section, Storyboard, VoLine } from '@trailerforge/schema';
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
    d.storyboard = sb;
  },
});

/**
 * Swap one unlocked section, keeping its id, and drop references to the slots it no longer has
 * (VO lines that only narrated them, hit points, SFX cues, variant overrides).
 */
export const replaceSection = defineCommand({
  type: 'core/storyboard.replace-section',
  payload: z.strictObject({
    sectionId: Id,
    section: Section,
    voLines: z.array(VoLine).default([]),
  }),
  label: ({ section }) => `Regenerate ${section.name}`,
  apply: (d, { sectionId, section, voLines }) => {
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
] as unknown as readonly CommandDef<unknown>[];
