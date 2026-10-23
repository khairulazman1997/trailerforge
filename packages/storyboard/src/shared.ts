import type { Project } from '@trailerforge/schema';
import type { Draft } from 'immer';

export class SectionLockedError extends Error {
  constructor(readonly sectionId: string) {
    super(`section "${sectionId}" is locked`);
    this.name = 'SectionLockedError';
  }
}

/** Timeline footage outlives the slot it filled: unlink items whose slot no longer exists. */
export function unlinkTimelineItems(d: Draft<Project>, gone: ReadonlySet<string>) {
  if (gone.size === 0) return;
  for (const tl of d.timelines)
    for (const track of tl.tracks)
      for (const item of track.items) if (item.slotId && gone.has(item.slotId)) delete item.slotId;
}

/**
 * Drop everything that pointed at slots that no longer exist: VO lines that only narrated them
 * (lines also linked elsewhere just lose the link), hit points, SFX cues, variant overrides, and
 * timeline links.
 */
export function cleanupRemovedSlots(d: Draft<Project>, gone: ReadonlySet<string>) {
  const sb = d.storyboard;
  if (!sb || gone.size === 0) return;
  sb.voLines = sb.voLines
    .filter((v) => v.linkedSlotIds.length === 0 || v.linkedSlotIds.some((id) => !gone.has(id)))
    .map((v) => ({ ...v, linkedSlotIds: v.linkedSlotIds.filter((id) => !gone.has(id)) }));
  sb.music.hitPoints = sb.music.hitPoints.filter((h) => !gone.has(h.slotId));
  sb.music.sfxCues = sb.music.sfxCues.filter((c) => !gone.has(c.slotId));
  for (const v of sb.variants) for (const id of gone) delete v.overrides[id];
  unlinkTimelineItems(d, gone);
}

export function requireStoryboard(d: Draft<Project>) {
  if (!d.storyboard) throw new Error('this project has no storyboard yet; generate one first');
  return d.storyboard;
}

export function findSection(d: Draft<Project>, sectionId: string) {
  const sb = requireStoryboard(d);
  const index = sb.sections.findIndex((s) => s.id === sectionId);
  if (index < 0) throw new Error(`no section "${sectionId}"`);
  return { sb, index, section: sb.sections[index]! };
}

/** Locked sections are the user's "do not touch" marker; hand edits respect it too. */
export function findUnlockedSection(d: Draft<Project>, sectionId: string) {
  const found = findSection(d, sectionId);
  if (found.section.locked) throw new SectionLockedError(sectionId);
  return found;
}

export function findSlot(d: Draft<Project>, slotId: string) {
  const sb = requireStoryboard(d);
  for (const section of sb.sections) {
    const index = section.slots.findIndex((s) => s.id === slotId);
    if (index >= 0) return { sb, section, index, slot: section.slots[index]! };
  }
  throw new Error(`no slot "${slotId}"`);
}

export const slotIdsOf = (sections: readonly { slots: readonly { id: string }[] }[]) =>
  new Set(sections.flatMap((s) => s.slots.map((x) => x.id)));
