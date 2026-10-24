import { secondsToFlicks, type Storyboard } from '@trailerforge/schema';
import { nearestIndex, type MusicGrid } from './grid.js';

/**
 * Where each storyboard section and slot falls on the music: section boundaries on bars, slot
 * boundaries on beats, hit points resolved to the beat they land on. A first pass that the rough
 * cut refines (cutting ahead of the beat, picking in and out points); pure and deterministic.
 */

export interface LayoutSection {
  sectionId: string;
  start: number;
  end: number;
  /** Why it moved from where its slot lengths put it, if it did. */
  note?: string;
}

export interface LayoutSlot {
  slotId: string;
  sectionId: string;
  kind: 'shot' | 'card';
  start: number;
  end: number;
}

export interface LayoutHit {
  id: string;
  kind: 'cut' | 'impact' | 'drop' | 'silence';
  slotId: string;
  at: number;
  beatIndex: number;
  onBar: boolean;
}

export interface StoryboardLayout {
  sections: LayoutSection[];
  slots: LayoutSlot[];
  hits: LayoutHit[];
  /** End of the last slot. */
  end: number;
  warnings: string[];
}

export interface LayoutOptions {
  /** Slots left out of the cut (for example shots the user decided not to record). */
  omitSlotIds?: ReadonlySet<string>;
}

/** Energy rise between music sections that counts as a drop. */
const DROP_RISE = 15;

const clock = (flicks: number) => {
  const s = Math.round(flicks / secondsToFlicks(1));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function layoutOnGrid(
  sb: Pick<Storyboard, 'sections' | 'music'>,
  grid: MusicGrid,
  opts: LayoutOptions = {},
): StoryboardLayout {
  const warnings: string[] = [];
  const omit = opts.omitSlotIds ?? new Set<string>();
  const sections = sb.sections.map((s) => ({
    id: s.id,
    name: s.name,
    slots: s.slots.filter((x) => !omit.has(x.id)),
  }));
  const ideal = sections.map((s) =>
    s.slots.reduce((n, x) => n + secondsToFlicks(x.duration.ideal), 0),
  );
  const marks = grid.bars.length > 1 ? grid.bars : grid.beats;
  const markLen = marks.length > 1 ? (marks.at(-1)! - marks[0]!) / (marks.length - 1) : 0;

  // Section boundaries: cumulative slot lengths, each moved to the nearest bar, kept increasing.
  const b: number[] = [0];
  let raw = 0;
  for (let i = 0; i < sections.length; i++) {
    raw += ideal[i]!;
    const prev = b[i]!;
    let t = marks.length ? marks[nearestIndex(marks, raw)]! : raw;
    if (ideal[i]! > 0 && t <= prev) {
      const after = marks.find((m) => m > prev);
      t = after ?? prev + ideal[i]!;
    }
    if (ideal[i] === 0) t = prev;
    b.push(t);
  }

  // A section that opens a drop or climax starts on the music's energy rise when that is near.
  const notes = new Map<number, string>();
  const rises = grid.sections
    .map((s, k) => ({ at: s.start, rise: k > 0 ? s.energy - grid.sections[k - 1]!.energy : 0 }))
    .filter((r) => r.rise >= DROP_RISE);
  for (const part of sb.music.structure) {
    if (part.label !== 'drop' && part.label !== 'climax') continue;
    const s = sections.findIndex((x) => x.id === part.sectionIds[0]);
    if (s <= 0) continue;
    const near = rises
      .filter((r) => Math.abs(r.at - b[s]!) <= 2 * markLen && r.at > b[s - 1]! && r.at < b[s + 1]!)
      .sort((x, y) => Math.abs(x.at - b[s]!) - Math.abs(y.at - b[s]!))[0];
    if (near && near.at !== b[s]) {
      b[s] = near.at;
      notes.set(s, `starts on the ${part.label} in the music at ${clock(near.at)}`);
    }
  }

  const last = b.at(-1)!;
  if (last > grid.duration) {
    warnings.push(
      `the storyboard runs ${clock(last - grid.duration)} longer than the music; the end is cut off`,
    );
    for (let i = 0; i < b.length; i++) b[i] = Math.min(b[i]!, grid.duration);
  }

  const outSections: LayoutSection[] = sections.map((s, i) => ({
    sectionId: s.id,
    start: b[i]!,
    end: b[i + 1]!,
    ...(notes.has(i) ? { note: notes.get(i)! } : {}),
  }));
  for (const s of outSections) {
    const name = sections.find((x) => x.id === s.sectionId)!.name;
    if (s.end <= s.start && sections.find((x) => x.id === s.sectionId)!.slots.length > 0) {
      warnings.push(`"${name}" does not fit in the music`);
    }
  }

  // Slots: share the section's length by their ideal lengths, boundaries on the nearest beat.
  const slots: LayoutSlot[] = [];
  sections.forEach((s, i) => {
    const S = b[i]!;
    const E = b[i + 1]!;
    if (E <= S || s.slots.length === 0) return;
    const total = ideal[i]! || 1;
    let acc = 0;
    let prev = S;
    s.slots.forEach((slot, k) => {
      acc += secondsToFlicks(slot.duration.ideal);
      let t = k === s.slots.length - 1 ? E : Math.round(S + ((E - S) * acc) / total);
      if (k < s.slots.length - 1) {
        const inside = grid.beats.filter((x) => x > prev && x < E);
        if (inside.length) t = inside[nearestIndex(inside, t)]!;
        if (t <= prev) t = Math.min(E, prev + 1);
      }
      slots.push({ slotId: slot.id, sectionId: s.id, kind: slot.kind, start: prev, end: t });
      prev = t;
    });
  });

  const bySlot = new Map(slots.map((x) => [x.slotId, x]));
  const barSet = new Set(grid.bars);
  const hits: LayoutHit[] = [];
  for (const h of sb.music.hitPoints) {
    const slot = bySlot.get(h.slotId);
    if (!slot || slot.end <= slot.start) {
      warnings.push(`hit point "${h.id}" is on a slot that is not in the cut`);
      continue;
    }
    const at = h.position === 'end' ? slot.end : slot.start;
    hits.push({
      id: h.id,
      kind: h.kind,
      slotId: h.slotId,
      at,
      beatIndex: nearestIndex(grid.beats, at),
      onBar: barSet.has(at),
    });
  }

  return {
    sections: outSections,
    slots: slots.filter((x) => x.end > x.start),
    hits,
    end: slots.length ? Math.max(...slots.map((x) => x.end)) : 0,
    warnings,
  };
}
