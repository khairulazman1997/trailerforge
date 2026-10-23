import { z } from 'zod';

/**
 * Timeline time is stored as integer **flicks** (1/705,600,000 s). Every common video rate,
 * including NTSC 1001 rates, and every common audio sample rate is an exact integer number of
 * flicks per frame/sample, so edits stay frame-accurate with no float drift.
 */
export const FLICKS_PER_SECOND = 705_600_000;

export const Flicks = z.int().nonnegative();
export type Flicks = z.infer<typeof Flicks>;

/** Rational frame rate, e.g. 24000/1001 for 23.976. */
export const Rate = z.strictObject({
  num: z.int().positive(),
  den: z.int().positive(),
});
export type Rate = z.infer<typeof Rate>;

export const rate = (num: number, den = 1): Rate => ({ num, den });

export function secondsToFlicks(seconds: number): Flicks {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: Flicks): number {
  return flicks / FLICKS_PER_SECOND;
}

/** Flicks per single frame at `r`. Exact for all common rates. */
export function flicksPerFrame(r: Rate): number {
  return (FLICKS_PER_SECOND * r.den) / r.num;
}

export function framesToFlicks(frames: number, r: Rate): Flicks {
  return Math.round(frames * flicksPerFrame(r));
}

/** Nearest frame index for a flick position. */
export function flicksToFrames(flicks: Flicks, r: Rate): number {
  return Math.round(flicks / flicksPerFrame(r));
}

/** Snap a flick position to the nearest frame boundary at `r`. */
export function snapToFrame(flicks: Flicks, r: Rate): Flicks {
  return framesToFlicks(flicksToFrames(flicks, r), r);
}
