import { defineCommand, type CommandDef } from '@trailerforge/core';
import { Id, Section, Storyboard, VoLine, type Project } from '@trailerforge/schema';
import type { Draft } from 'immer';
import { z } from 'zod';

export class SectionLockedError extends Error {
  constructor(readonly sectionId: string) {
    super(`section "${sectionId}" is locked`);
    this.name = 'SectionLockedError';
  }
}

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

/** Timeline footage outlives the slot it filled: unlink items whose slot no longer exists. */
function unlinkTimelineItems(d: Draft<Project>, gone: ReadonlySet<string>) {
  if (gone.size === 0) return;
  for (const tl of d.timelines)
    for (const track of tl.tracks)
      for (const item of track.items) if (item.slotId && gone.has(item.slotId)) delete item.slotId;
}

const slotIdsOf = (sections: readonly { slots: readonly { id: string }[] }[]) =>
  new Set(sections.flatMap((s) => s.slots.map((x) => x.id)));

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
    sb.voLines = sb.voLines
      .filter((v) => v.linkedSlotIds.length === 0 || v.linkedSlotIds.some((id) => !gone.has(id)))
      .map((v) => ({ ...v, linkedSlotIds: v.linkedSlotIds.filter((id) => !gone.has(id)) }));
    sb.voLines.push(...voLines);
    sb.music.hitPoints = sb.music.hitPoints.filter((h) => !gone.has(h.slotId));
    sb.music.sfxCues = sb.music.sfxCues.filter((c) => !gone.has(c.slotId));
    for (const v of sb.variants) for (const id of gone) delete v.overrides[id];
    unlinkTimelineItems(d, gone);
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
] as unknown as readonly CommandDef<unknown>[];
