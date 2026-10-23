import { z } from 'zod';
import { Assumption, Extensions, Id, IsoDate, PluginRef } from './common.js';

/**
 * Domain-neutral brief. Domain packs (e.g. the Game Trailer pack) add their own fields under
 * `extensions[packId]` and define per-video-type completeness rules over both.
 */
export const Brief = z.strictObject({
  /** Video type from a pack registry, e.g. `game-trailer/release-trailer`. */
  videoTypeId: PluginRef.optional(),
  /** Product / game / show name. */
  title: z.string().optional(),
  freeText: z.string().default(''),
  tone: z.array(z.string()).default([]),
  audience: z.string().optional(),
  goals: z.array(z.string()).default([]),
  keySellingPoints: z.array(z.string()).default([]),
  keyDates: z.array(z.strictObject({ label: z.string().min(1), date: IsoDate })).default([]),
  callToAction: z.string().optional(),
  links: z.array(z.strictObject({ label: z.string().min(1), url: z.url() })).default([]),
  pressQuotes: z
    .array(
      z.strictObject({
        quote: z.string().min(1),
        source: z.string().min(1),
        score: z.string().optional(),
      }),
    )
    .default([]),
  /** Reference videos analyzed for structure only (never copied). */
  referenceAssetIds: z.array(Id).default([]),
  assumptions: z.array(Assumption).default([]),
  extensions: Extensions.default({}),
});
export type Brief = z.infer<typeof Brief>;
