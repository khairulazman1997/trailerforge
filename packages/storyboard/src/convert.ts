import { mintId, type CardSlot, type Section, type Slot, type VoLine } from '@trailerforge/schema';
import type { GenSection, GenSlot } from './output.js';

type CardKind = CardSlot['cardKind'];

export interface ConvertContext {
  /** Ids already used anywhere in the project; new ids are added as they are minted. */
  taken: Set<string>;
  /** Knowledge entities the LLM may reference (excluded ones are not in here). */
  entityIds: ReadonlySet<string>;
  /** Card template per card kind, usually taken from the storyboard template. */
  cardTemplates: Partial<Record<CardKind, string>>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Scale positive values so they sum to `budget`, in 0.1 s steps, each at least 0.1 s. Rounding
 * drift goes to the largest value so the total is exact.
 */
export function fitToBudget(values: readonly number[], budget: number): number[] {
  if (values.length === 0) return [];
  const floor = 0.1;
  if (budget < floor * values.length) {
    throw new RangeError(`budget ${budget}s is too short for ${values.length} slots`);
  }
  const total = values.reduce((a, b) => a + b, 0);
  const out = values.map((v) => Math.max(floor, round1((v / total) * budget)));
  const drift = round1(budget - out.reduce((a, b) => a + b, 0));
  let big = 0;
  out.forEach((v, i) => {
    if (v > out[big]!) big = i;
  });
  out[big] = round1(out[big]! + drift);
  return out;
}

export function durationRange(ideal: number) {
  return { min: round1(ideal * 0.7), ideal, max: round1(ideal * 1.4) };
}

function convertSlot(g: GenSlot, ideal: number, ctx: ConvertContext): Slot {
  const base = {
    title: g.title,
    purpose: g.purpose,
    duration: durationRange(ideal),
    priority: 'must' as const,
    audioNotes: g.audioNotes,
    entityIds: [...new Set(g.entityIds.filter((id) => ctx.entityIds.has(id)))],
    tags: [],
    extensions: {},
  };
  if (g.kind === 'card') {
    const cardKind = g.cardKind ?? 'custom';
    return {
      ...base,
      id: mintId('cd', g.title, ctx.taken),
      kind: 'card',
      cardKind,
      templateId: ctx.cardTemplates[cardKind] ?? `core/${cardKind}-card`,
      text: g.text || g.title,
      params: {},
      styleTokens: {},
    };
  }
  return {
    ...base,
    id: mintId('sh', g.title, ctx.taken),
    kind: 'shot',
    captureInstruction: g.captureInstruction,
    framing: g.framing,
    setup: g.setup,
    location: g.location,
    hud: g.hud,
    alternates: g.alternates,
    // Starts are kept inside the shot as rescaled; the cut trims anything past its end.
    overlays: g.onScreenText.map((t) => ({
      id: mintId('ov', t.text, ctx.taken),
      templateId: t.style === 'name' ? 'core/lower-third' : 'core/caption',
      text: t.text.trim(),
      params: {},
      offset: Math.floor(Math.min(t.fromSeconds, ideal / 2) * 10) / 10,
      ...(t.seconds !== undefined ? { duration: t.seconds } : {}),
    })),
    status: 'empty',
    takes: [],
  };
}

export interface ConvertedSections {
  sections: Section[];
  voLines: VoLine[];
  /** Sum of the seconds the LLM asked for, before fitting; reported in the decision log. */
  requestedSeconds: number;
}

/**
 * Convert generated sections, fitting all their slots jointly to `budget` seconds. `keepId`
 * reuses an existing section id (regenerating one section keeps its identity).
 */
export function convertSections(
  gen: readonly GenSection[],
  budget: number,
  ctx: ConvertContext,
  keepId?: string,
): ConvertedSections {
  const flat = gen.flatMap((s) => s.slots);
  const ideals = fitToBudget(
    flat.map((s) => s.seconds),
    budget,
  );
  let i = 0;
  const voLines: VoLine[] = [];
  const sections = gen.map((s): Section => {
    const id = keepId && gen.length === 1 ? keepId : mintId('sec', s.role || s.name, ctx.taken);
    const slots = s.slots.map((g) => {
      const slot = convertSlot(g, ideals[i++]!, ctx);
      if (g.voLine) {
        voLines.push({
          id: mintId('vo', slot.id.slice(3), ctx.taken),
          speaker: 'Narrator',
          text: g.voLine.text,
          direction: g.voLine.direction,
          linkedSlotIds: [slot.id],
          status: 'empty',
        });
      }
      return slot;
    });
    return {
      id,
      name: s.name,
      ...(s.role && { role: s.role }),
      purpose: s.purpose,
      locked: false,
      slots,
    };
  });
  return { sections, voLines, requestedSeconds: round1(flat.reduce((a, s) => a + s.seconds, 0)) };
}

export function sectionSeconds(s: Section): number {
  return round1(s.slots.reduce((a, x) => a + x.duration.ideal, 0));
}
