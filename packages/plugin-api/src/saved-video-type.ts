/**
 * A video type the user saved from one of their storyboards, kept as a data file in
 * `<home>/video-types/` and loaded next to the plugin-provided types. Only structure is kept:
 * section names and roles, slot kinds and their share of the length. No shot text, footage or
 * game facts.
 */
import { CardSlot, IsoDateTime, PluginRef } from '@trailerforge/schema';
import { z } from 'zod';
import { BriefRequirement } from './contributions.js';

export const SAVED_VIDEO_TYPE_PREFIX = 'user/';

export const SavedSlot = z.strictObject({
  kind: z.enum(['shot', 'card']),
  /** Relative share of the running time. */
  share: z.number().positive(),
  priority: z.enum(['must', 'nice']).default('must'),
  cardKind: CardSlot.shape.cardKind.optional(),
  templateId: PluginRef.optional(),
});
export type SavedSlot = z.output<typeof SavedSlot>;

export const SavedSection = z.strictObject({
  name: z.string().trim().min(1).max(80),
  role: z.string().min(1).optional(),
  slots: z.array(SavedSlot).min(1).max(40),
});
export type SavedSection = z.output<typeof SavedSection>;

export const SavedVideoType = z.strictObject({
  version: z.literal(1),
  id: PluginRef.refine((id) => id.startsWith(SAVED_VIDEO_TYPE_PREFIX), {
    message: `saved video type ids start with "${SAVED_VIDEO_TYPE_PREFIX}"`,
  }),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  /** The video type the storyboard was made with. */
  basedOn: PluginRef.optional(),
  requirements: z.array(BriefRequirement).default([]),
  typicalDuration: z
    .strictObject({ min: z.number().positive(), max: z.number().positive() })
    .optional(),
  music: z.string().max(500).default(''),
  sections: z.array(SavedSection).min(1).max(30),
  savedAt: IsoDateTime,
});
export type SavedVideoType = z.output<typeof SavedVideoType>;
export type SavedVideoTypeInput = z.input<typeof SavedVideoType>;

export const isSavedVideoTypeId = (id: string) => id.startsWith(SAVED_VIDEO_TYPE_PREFIX);
