import { Flicks, Rate } from '@trailerforge/schema';
import { z } from 'zod';

const secs = z.number().nonnegative();

/** What the sidecar returns for `analyze.music` (seconds). */
export const MusicRaw = z.strictObject({
  sampleRate: z.int().positive(),
  duration: secs,
  tempo: z.number().nonnegative(),
  beats: z.array(secs),
  downbeats: z.array(secs),
  beatsPerBar: z.int().positive(),
  onsets: z.array(secs),
  energy: z.strictObject({ hop: z.number().positive(), values: z.array(z.int().min(0).max(100)) }),
  sections: z.array(z.strictObject({ start: secs, end: secs, energy: z.int().min(0).max(100) })),
});
export type MusicRaw = z.infer<typeof MusicRaw>;

/** Where the movement is in a frame: centre x, y and spread sx, sy, 0..1000 of the frame. */
const FocusSample = z.tuple([
  z.int().min(0).max(1000),
  z.int().min(0).max(1000),
  z.int().min(0).max(1000),
  z.int().min(0).max(1000),
]);

const frameRange = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

/** What the sidecar returns for `analyze.footage` (frame indices at a constant rate). */
export const FootageRaw = z.strictObject({
  rate: Rate,
  frameCount: z.int().nonnegative(),
  scenes: z.array(z.int().nonnegative()),
  black: z.array(frameRange),
  flashes: z.array(z.int().nonnegative()),
  frozen: z.array(frameRange),
  brightness: z.array(z.int().min(0).max(255)),
  motion: z.array(z.int().nonnegative()),
  focus: z.array(FocusSample.nullable()).optional(),
});
export type FootageRaw = z.infer<typeof FootageRaw>;

export const FlickRange = z
  .strictObject({ start: Flicks, end: Flicks })
  .refine((r) => r.start < r.end, { message: 'range must have start < end' });
export type FlickRange = z.infer<typeof FlickRange>;

const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

/** Music analysis as cached and used by the cut: every time in integer flicks. */
export const MusicAnalysis = z.strictObject({
  analyzer: z.literal('music'),
  version: z.string(),
  duration: Flicks,
  /** Beats per minute, from the median beat interval. */
  tempo: z.number().nonnegative(),
  beatsPerBar: z.int().positive(),
  beats: z.array(Flicks).refine(ascending, 'beats must ascend'),
  /** Bar starts (a subset of `beats`); 4/4 assumed, the user can shift them. */
  downbeats: z.array(Flicks).refine(ascending, 'downbeats must ascend'),
  onsets: z.array(Flicks).refine(ascending, 'onsets must ascend'),
  /** Loudness 0–100 every `hop` flicks from the start. */
  energy: z.strictObject({ hop: Flicks, values: z.array(z.int().min(0).max(100)) }),
  sections: z.array(
    z.strictObject({ start: Flicks, end: Flicks, energy: z.int().min(0).max(100) }),
  ),
});
export type MusicAnalysis = z.infer<typeof MusicAnalysis>;

/** Footage analysis: per-frame series indexed by frame at `rate`, everything else in flicks. */
export const FootageAnalysis = z.strictObject({
  analyzer: z.literal('footage'),
  version: z.string(),
  rate: Rate,
  frameCount: z.int().nonnegative(),
  duration: Flicks,
  /** Start of each new shot inside the recording. */
  scenes: z.array(Flicks).refine(ascending, 'scenes must ascend'),
  black: z.array(FlickRange),
  /** Start of each flash frame (lasts one frame). */
  flashes: z.array(Flicks).refine(ascending, 'flashes must ascend'),
  /** Frozen picture (pause, loading screen) for half a second or more. */
  frozen: z.array(FlickRange),
  /** Mean luma 0–255 per frame. */
  brightness: z.array(z.int().min(0).max(255)),
  /** Mean absolute luma change from the previous frame, ×10, per frame. */
  motion: z.array(z.int().nonnegative()),
  /** Centre and spread of the movement per frame (0..1000), null where nothing moves. */
  focus: z.array(FocusSample.nullable()).default([]),
});
export type FootageAnalysis = z.infer<typeof FootageAnalysis>;
