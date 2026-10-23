import type { CardSlot, Section, Slot, VoLine } from '@trailerforge/schema';
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

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'x'
  );
}

/** `prefix_slug`, suffixed `_2`, `_3`... until unused; registers the result in `taken`. */
export function mintId(prefix: string, name: string, taken: Set<string>): string {
  const base = `${prefix}_${slug(name)}`.slice(0, 56);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

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
    overlays: [],
    status: 'empty',
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

/** Every `id` string anywhere in a JSON-like value. */
export function collectIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectIds(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && typeof v === 'string') into.add(v);
      else collectIds(v, into);
    }
  }
  return into;
}

export function sectionSeconds(s: Section): number {
  return round1(s.slots.reduce((a, x) => a + x.duration.ideal, 0));
}
