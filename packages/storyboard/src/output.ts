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

export const GenSlot = z.strictObject({
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
  voLine: z.strictObject({ text: z.string().min(1), direction: z.string().default('') }).optional(),
  /** Shots only; cards carry their words in `text`. */
  onScreenText: z.array(GenOnScreenText).max(2).default([]),
});
export type GenSlot = z.infer<typeof GenSlot>;

export const GenSection = z.strictObject({
  name: z.string().min(1),
  role: z.string().default(''),
  purpose: z.string().default(''),
  slots: z.array(GenSlot).min(1),
});
export type GenSection = z.infer<typeof GenSection>;

export const GenMusic = z.strictObject({
  direction: z.string().default(''),
  bpm: z.strictObject({ min: z.number().positive(), max: z.number().positive() }).optional(),
});

export const GeneratedStoryboard = z.strictObject({
  rationale: z.string().min(1),
  sections: z.array(GenSection).min(1),
  music: GenMusic.default({ direction: '' }),
});
export type GeneratedStoryboard = z.infer<typeof GeneratedStoryboard>;

export const GeneratedSection = z.strictObject({
  rationale: z.string().min(1),
  section: GenSection,
});
export type GeneratedSection = z.infer<typeof GeneratedSection>;
