import { checkParams, type FilterRegistry } from '@trailerforge/effects';
import {
  mintId,
  type CardSlot,
  type Section,
  type Slot,
  type SlotEffect,
  type Storyboard,
  type TransitionRef,
  type VoLine,
} from '@trailerforge/schema';
import type { GenSection, GenSlot } from './output.js';

type CardKind = CardSlot['cardKind'];

export interface ConvertContext {
  /** Ids already used anywhere in the project; new ids are added as they are minted. */
  taken: Set<string>;
  /** Knowledge entities the LLM may reference (excluded ones are not in here). */
  entityIds: ReadonlySet<string>;
  /** Card template per card kind, usually taken from the storyboard template. */
  cardTemplates: Partial<Record<CardKind, string>>;
  /** Installed transitions and effects, to check the model's picks and their params. */
  filters?: FilterRegistry;
}

type SfxCue = Storyboard['music']['sfxCues'][number];

/** A transition, effect or sound the model suggested for a slot, with its reason. */
export interface Suggestion {
  slotId: string;
  what: 'transition' | 'effect' | 'sound';
  id: string;
  why: string;
}

/** Suggestions on at most this share of the slots (at least one): most slots carry nothing. */
export const MAX_SUGGESTED_SHARE = 1 / 3;

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

interface Picked {
  transitionIn?: TransitionRef;
  effects: SlotEffect[];
  sound?: { kind: SfxCue['kind']; position: SfxCue['position']; why: string };
  suggestions: Omit<Suggestion, 'slotId'>[];
}

/** The slot's picks, checked: unknown ids are dropped, params that do not fit fall back to defaults. */
function pick(g: GenSlot, ctx: ConvertContext, warnings: string[]): Picked {
  const out: Picked = { effects: [], suggestions: [] };
  const params = (def: { id: string; params: unknown }, given: unknown) => {
    try {
      return checkParams(def as never, given ?? {}) as Record<string, never>;
    } catch {
      warnings.push(
        `"${g.title}": the settings suggested for ${def.id} did not fit; using its defaults`,
      );
      return checkParams(def as never, {}) as Record<string, never>;
    }
  };
  const t = g.transitionIn;
  const tDef = t && ctx.filters?.get(t.id);
  if (t && tDef?.kind === 'transition') {
    out.transitionIn = {
      transitionId: t.id,
      duration: t.seconds ?? tDef.defaultDuration,
      params: params(tDef, t.params),
    };
    out.suggestions.push({ what: 'transition', id: t.id, why: t.why });
  } else if (t) warnings.push(`"${g.title}": transition ${t.id} is not installed; left out`);
  const e = g.effect;
  const eDef = e && ctx.filters?.get(e.id);
  if (e && eDef?.kind === 'effect') {
    out.effects.push({ effectId: e.id, params: params(eDef, e.params) });
    out.suggestions.push({ what: 'effect', id: e.id, why: e.why });
  } else if (e) warnings.push(`"${g.title}": effect ${e.id} is not installed; left out`);
  const snd = g.sound;
  if (snd) {
    const kind = snd.kind as SfxCue['kind'];
    const position = snd.position ?? (kind === 'riser' || kind === 'whoosh' ? 'before' : 'start');
    out.sound = { kind, position, why: snd.why };
    out.suggestions.push({ what: 'sound', id: kind, why: snd.why });
  }
  return out;
}

function convertSlot(g: GenSlot, ideal: number, ctx: ConvertContext, picked?: Picked): Slot {
  const base = {
    title: g.title,
    purpose: g.purpose,
    duration: durationRange(ideal),
    priority: 'must' as const,
    ...(picked?.transitionIn ? { transitionIn: picked.transitionIn } : {}),
    effects: picked?.effects ?? [],
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
  /** Sounds the model suggested, as cues for `music.sfxCues`. */
  sfxCues: SfxCue[];
  suggestions: Suggestion[];
  warnings: string[];
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
  const sfxCues: SfxCue[] = [];
  const suggestions: Suggestion[] = [];
  const warnings: string[] = [];
  // Sparing by construction: picks stay on the first slots that have them, up to the share.
  const limit = Math.max(1, Math.floor(flat.length * MAX_SUGGESTED_SHARE));
  let withPicks = 0;
  let dropped = 0;
  const sections = gen.map((s): Section => {
    const id = keepId && gen.length === 1 ? keepId : mintId('sec', s.role || s.name, ctx.taken);
    const slots = s.slots.map((g) => {
      const has = !!(g.transitionIn || g.effect || g.sound);
      const keep = has && withPicks < limit;
      if (has && !keep) dropped++;
      if (keep) withPicks++;
      const picked = keep ? pick(g, ctx, warnings) : undefined;
      const slot = convertSlot(g, ideals[i++]!, ctx, picked);
      for (const x of picked?.suggestions ?? []) suggestions.push({ slotId: slot.id, ...x });
      if (picked?.sound)
        sfxCues.push({
          id: mintId('sfx', slot.id.slice(3), ctx.taken),
          kind: picked.sound.kind,
          slotId: slot.id,
          position: picked.sound.position,
        });
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
  if (dropped)
    warnings.push(
      `${dropped} more slot${dropped === 1 ? '' : 's'} had a transition, effect or sound suggested; kept to ${limit} of ${flat.length} so most slots stay plain`,
    );
  return {
    sections,
    voLines,
    sfxCues,
    suggestions,
    warnings,
    requestedSeconds: round1(flat.reduce((a, s) => a + s.seconds, 0)),
  };
}

export function sectionSeconds(s: Section): number {
  return round1(s.slots.reduce((a, x) => a + x.duration.ideal, 0));
}
