import { Timeline, type TimelineItem } from '@trailerforge/schema';
import type { TakeSource } from './rough-cut.js';

/**
 * Regenerating a rough cut over one the user has worked on. Locked tracks stay exactly as they
 * were. On the picture (video and cards together) every item the user edited is kept as they left
 * it, for the same slot, at the place the sequence reaches; the next generated item absorbs the
 * difference so the cuts after it stay where the new cut put them (on the beat), as long as its
 * take has the footage for it; otherwise the rest of the picture shifts.
 */

const edited = (i: { extensions: Record<string, unknown> }) =>
  (i.extensions.core as { userEdited?: unknown } | undefined)?.userEdited === true;

export interface MergeResult {
  timeline: Timeline;
  /** Edited items kept, by id. */
  kept: string[];
  warnings: string[];
}

const PICTURE = new Set(['video', 'graphics']);

export function mergeRoughCut(
  previous: Timeline | undefined,
  generated: Timeline,
  sources: ReadonlyMap<string, TakeSource> = new Map(),
): MergeResult {
  if (!previous) return { timeline: generated, kept: [], warnings: [] };
  const warnings: string[] = [];
  const prevTracks = new Map(previous.tracks.map((t) => [t.id, t]));
  const locked = new Set(previous.tracks.filter((t) => t.locked).map((t) => t.id));

  // Edited picture items by slot, from unlocked tracks (locked ones are kept whole below).
  const editedBySlot = new Map<string, { item: TimelineItem; trackId: string }[]>();
  for (const t of previous.tracks) {
    if (!PICTURE.has(t.kind) || locked.has(t.id)) continue;
    for (const item of [...t.items].sort((a, b) => a.start - b.start)) {
      if (!edited(item) || !item.slotId) continue;
      editedBySlot.set(item.slotId, [
        ...(editedBySlot.get(item.slotId) ?? []),
        { item, trackId: t.id },
      ]);
    }
  }

  // The generated picture as one sequence, in time order.
  const seq = generated.tracks
    .filter((t) => PICTURE.has(t.kind) && !locked.has(t.id))
    .flatMap((t) => t.items.map((item) => ({ item, trackId: t.id })))
    .sort((a, b) => a.item.start - b.item.start);
  const slotsInCut = new Set(seq.map((s) => s.item.slotId).filter(Boolean));
  for (const [slotId, items] of editedBySlot) {
    if (!slotsInCut.has(slotId))
      warnings.push(`an edited clip for "${slotId}" was dropped: the shot is no longer in the cut`);
    void items;
  }

  const out: { item: TimelineItem; trackId: string }[] = [];
  const kept: string[] = [];
  const done = new Set<string>();
  let cursor = 0;
  let absorbNext = false;
  for (const { item, trackId } of seq) {
    const slot = item.slotId;
    if (slot && editedBySlot.has(slot)) {
      if (done.has(slot)) continue; // the slot's generated pieces are replaced as a whole
      done.add(slot);
      for (const e of editedBySlot.get(slot)!) {
        out.push({ item: { ...e.item, start: cursor }, trackId: e.trackId });
        kept.push(e.item.id);
        cursor += e.item.duration;
      }
      absorbNext = true;
      continue;
    }
    const genEnd = item.start + item.duration;
    let next: TimelineItem = { ...item, start: cursor };
    if (absorbNext && genEnd > cursor) {
      const duration = genEnd - cursor;
      const shift = cursor - item.start; // >0: starts later, <0: earlier
      if (next.kind === 'clip') {
        const src = sources.get(next.assetId);
        const sourceIn = next.sourceIn + shift;
        if (src && sourceIn >= 0 && sourceIn + duration <= src.duration)
          next = { ...next, duration, sourceIn };
        // else: not enough footage known to stretch it; keep its length and let the rest shift
      } else next = { ...next, duration };
    }
    absorbNext = false;
    out.push({ item: next, trackId });
    cursor = next.start + next.duration;
  }

  const tracks = generated.tracks.map((t) => {
    if (locked.has(t.id)) return prevTracks.get(t.id)!;
    if (!PICTURE.has(t.kind)) return t;
    const items = out.filter((o) => o.trackId === t.id).map((o) => o.item);
    return {
      ...t,
      items,
      // A transition needs its two items to still meet exactly.
      transitions: t.transitions.filter((x) => {
        const a = items.find((i) => i.id === x.fromItemId);
        const b = items.find((i) => i.id === x.toItemId);
        return !!a && !!b && a.start + a.duration === b.start;
      }),
    };
  });
  // Edited items on a track the new cut does not have (e.g. the cards track went away).
  for (const o of out) {
    if (!tracks.some((t) => t.id === o.trackId)) {
      const prev = prevTracks.get(o.trackId)!;
      tracks.push({
        ...prev,
        items: out.filter((x) => x.trackId === o.trackId).map((x) => x.item),
        transitions: [],
      });
    }
  }
  // Locked tracks the new cut does not produce are kept too.
  for (const id of locked) if (!tracks.some((t) => t.id === id)) tracks.push(prevTracks.get(id)!);

  return { timeline: Timeline.parse({ ...generated, tracks }), kept, warnings };
}
