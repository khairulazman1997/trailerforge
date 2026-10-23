import { z } from 'zod';
import { Id, PluginRef, Seconds } from './common.js';
import { Rate } from './time.js';

export const AspectRatio = z.union([
  z.enum(['16:9', '9:16', '1:1', '4:5']),
  z.strictObject({ w: z.int().positive(), h: z.int().positive() }),
]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const Resolution = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
});
export type Resolution = z.infer<typeof Resolution>;

/** One deliverable: an aspect/resolution/duration combination for one or more platforms. */
export const FormatTarget = z.strictObject({
  id: Id,
  name: z.string().min(1),
  aspect: AspectRatio,
  resolution: Resolution,
  frameRate: Rate,
  targetDuration: Seconds,
  /** Platform profiles (plugin registry), e.g. `core/youtube`, `core/tiktok`. */
  platformIds: z.array(PluginRef).default([]),
});
export type FormatTarget = z.infer<typeof FormatTarget>;
