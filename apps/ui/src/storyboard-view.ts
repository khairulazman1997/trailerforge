import type { DecisionRecord, Section, Slot, Storyboard } from '@trailerforge/schema';

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Timing {
  target: number;
  actual: number;
  /** actual - target, rounded to 0.1 s; positive means the storyboard runs long. */
  delta: number;
  sections: { id: string; seconds: number }[];
}

/** Same arithmetic as the engine's `storyboardTiming`, so the bar agrees with the server. */
export function storyboardTiming(sb: Pick<Storyboard, 'meta' | 'sections'>): Timing {
  const sections = sb.sections.map((s) => ({
    id: s.id,
    seconds: round1(s.slots.reduce((a, x) => a + x.duration.ideal, 0)),
  }));
  const actual = round1(sections.reduce((a, s) => a + s.seconds, 0));
  return {
    target: sb.meta.targetDuration,
    actual,
    delta: round1(actual - sb.meta.targetDuration),
    sections,
  };
}

export const isHandEdited = (slot: Slot): boolean => {
  const core = slot.extensions.core as { userEdited?: unknown } | undefined;
  return Array.isArray(core?.userEdited) && core.userEdited.length > 0;
};

export interface MoveTarget {
  toSectionId: string;
  /** Position in the target section after the slot is taken out (what the engine expects). */
  index: number;
}

/**
 * Where a dropped slot ends up. `beforeSlotId` null means the end of the section. Returns null
 * when nothing would change (dropped where it already is) or the target does not exist.
 */
export function dropTarget(
  sections: readonly Section[],
  slotId: string,
  toSectionId: string,
  beforeSlotId: string | null,
): MoveTarget | null {
  const from = sections.find((s) => s.slots.some((x) => x.id === slotId));
  const to = sections.find((s) => s.id === toSectionId);
  if (!from || !to || beforeSlotId === slotId) return null;
  const rest = to.slots.filter((x) => x.id !== slotId);
  const index = beforeSlotId === null ? rest.length : rest.findIndex((x) => x.id === beforeSlotId);
  if (index < 0) return null;
  if (from.id === to.id && from.slots.findIndex((x) => x.id === slotId) === index) return null;
  return { toSectionId, index };
}

/** One step up (-1) or down (+1) within the slot's own section; null at the ends. */
export function stepTarget(
  sections: readonly Section[],
  slotId: string,
  delta: -1 | 1,
): MoveTarget | null {
  const section = sections.find((s) => s.slots.some((x) => x.id === slotId));
  if (!section) return null;
  const at = section.slots.findIndex((x) => x.id === slotId);
  const index = at + delta;
  return index < 0 || index >= section.slots.length ? null : { toSectionId: section.id, index };
}

const STEP_LABEL: Record<string, string> = {
  'core/storyboard-generate': 'Generated the storyboard',
  'core/storyboard-regenerate-section': 'Rewrote a section',
};

export function describeDecision(d: DecisionRecord): string {
  if (d.step === 'core/storyboard-regenerate-section') {
    const name = (d.choice as { name?: string } | null)?.name;
    return name ? `Rewrote “${name}”` : STEP_LABEL[d.step]!;
  }
  return STEP_LABEL[d.step] ?? d.step;
}

/** Decisions relevant to one section (its own rewrites) plus whole-storyboard generations. */
export function decisionsFor(
  decisions: readonly DecisionRecord[],
  sectionId: string | null,
): DecisionRecord[] {
  return decisions
    .filter(
      (d) =>
        sectionId === null ||
        d.subject.kind === 'storyboard' ||
        (d.subject.kind === 'section' && d.subject.id === sectionId),
    )
    .slice()
    .reverse();
}
