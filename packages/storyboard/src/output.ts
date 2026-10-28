import { SFX_KINDS, builtinFilters } from '@trailerforge/effects';
import { CardSlot, ShotSlot } from '@trailerforge/schema';
import { z } from 'zod';

/**
 * What the LLM returns. Deliberately smaller than the storyboard schema: no ids, no duration
 * ranges, no plugin refs. `convert.ts` turns it into a valid storyboard, so the model can't
 * produce dangling references or colliding ids.
 */
/** Text shown over a shot: a short caption, or a name label (lower third) for a character. */
export const GenOnScreenText = z.strictObject({
  text: z.string().min(1).max(80),
  style: z.enum(['caption', 'name']).default('caption'),
  /** Seconds after the shot starts. */
  fromSeconds: z.number().min(0).max(30).default(0),
  /** How long it stays; omit to keep it until the shot ends. */
  seconds: z.number().positive().max(30).optional(),
});
export type GenOnScreenText = z.infer<typeof GenOnScreenText>;

export const GenMusic = z.strictObject({
  direction: z.string().default(''),
  bpm: z.strictObject({ min: z.number().positive(), max: z.number().positive() }).optional(),
});

/**
 * Ids the model may pick from: the transitions, effects and sounds installed right now. The
 * output schema is built from these lists, so an id that is not installed fails validation.
 */
export interface InstalledPicks {
  transitions: readonly string[];
  effects: readonly string[];
  sounds: readonly string[];
}

/** The built-in transitions, effects and generated sounds. */
export function builtinPicks(): InstalledPicks {
  const f = builtinFilters();
  return { transitions: f.ids('transition'), effects: f.ids('effect'), sounds: [...SFX_KINDS] };
}

/** Plain params for a pick; checked against the effect's own schema on conversion. */
const PickParams = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));
const Why = z.string().min(1).max(160);

const oneOf = (ids: readonly string[]) => z.enum(ids as [string, ...string[]]);

/** The optional picks on a slot. Each needs a reason; most slots carry none. */
function picksShape(installed: InstalledPicks) {
  return {
    ...(installed.transitions.length > 0
      ? {
          /** A transition into this slot from the one before it. */
          transitionIn: z
            .strictObject({
              id: oneOf(installed.transitions),
              seconds: z.number().min(0.05).max(1.5).optional(),
              params: PickParams.optional(),
              why: Why,
            })
            .optional(),
        }
      : {}),
    ...(installed.effects.length > 0
      ? {
          /** One finishing effect on this slot's picture. */
          effect: z
            .strictObject({ id: oneOf(installed.effects), params: PickParams.optional(), why: Why })
            .optional(),
        }
      : {}),
    ...(installed.sounds.length > 0
      ? {
          /** One sound effect, leading into the slot, at its start or at its end. */
          sound: z
            .strictObject({
              kind: oneOf(installed.sounds),
              position: z.enum(['before', 'start', 'end']).optional(),
              why: Why,
            })
            .optional(),
        }
      : {}),
  };
}

/** Generator output schemas for a set of installed ids. */
export function generationSchemas(installed: InstalledPicks) {
  const GenSlot = z.strictObject({
    kind: z.enum(['shot', 'card']),
    title: z.string().min(1),
    purpose: z.string().default(''),
    /** On-screen seconds; rescaled to the section budget on conversion. */
    seconds: z.number().positive().max(60),
    captureInstruction: z.string().default(''),
    framing: z.string().default(''),
    setup: z.string().default(''),
    location: z.string().default(''),
    hud: ShotSlot.shape.hud.unwrap().default('any'),
    alternates: z.array(z.string()).default([]),
    cardKind: CardSlot.shape.cardKind.optional(),
    text: z.string().default(''),
    audioNotes: z.string().default(''),
    entityIds: z.array(z.string()).default([]),
    voLine: z
      .strictObject({ text: z.string().min(1), direction: z.string().default('') })
      .optional(),
    /** Shots only; cards carry their words in `text`. */
    onScreenText: z.array(GenOnScreenText).max(2).default([]),
    ...picksShape(installed),
  });
  const GenSection = z.strictObject({
    name: z.string().min(1),
    role: z.string().default(''),
    purpose: z.string().default(''),
    slots: z.array(GenSlot).min(1),
  });
  const GeneratedStoryboard = z.strictObject({
    rationale: z.string().min(1),
    sections: z.array(GenSection).min(1),
    music: GenMusic.default({ direction: '' }),
  });
  const GeneratedSection = z.strictObject({ rationale: z.string().min(1), section: GenSection });
  return { GenSlot, GenSection, GeneratedStoryboard, GeneratedSection };
}

const builtin = generationSchemas(builtinPicks());
/** The schemas for the built-in set (what the draft-07 test checks). */
export const GenSlot = builtin.GenSlot;
export const GenSection = builtin.GenSection;
export const GeneratedStoryboard = builtin.GeneratedStoryboard;
export const GeneratedSection = builtin.GeneratedSection;

/** A pick as the converter reads it: any installed id. */
export interface GenPicks {
  transitionIn?: {
    id: string;
    seconds?: number;
    params?: Record<string, number | string | boolean>;
    why: string;
  };
  effect?: { id: string; params?: Record<string, number | string | boolean>; why: string };
  sound?: { kind: string; position?: 'before' | 'start' | 'end'; why: string };
}
export type GenSlot = Omit<z.infer<typeof GenSlot>, keyof GenPicks> & GenPicks;
export type GenSection = Omit<z.infer<typeof GenSection>, 'slots'> & { slots: GenSlot[] };
export type GeneratedStoryboard = Omit<z.infer<typeof GeneratedStoryboard>, 'sections'> & {
  sections: GenSection[];
};
export type GeneratedSection = Omit<z.infer<typeof GeneratedSection>, 'section'> & {
  section: GenSection;
};
