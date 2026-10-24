import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import type { GridSource } from './grid.js';

const F = FLICKS_PER_SECOND;

/** Beats at a steady tempo; downbeats every `bpb` beats starting at beat `downAt`. */
export function steady(
  bpm: number,
  beatsCount: number,
  first = 0,
  opts: { bpb?: number; downAt?: number } = {},
): GridSource {
  const period = (60 * F) / bpm;
  const beats = Array.from({ length: beatsCount }, (_, k) => Math.round(first * F + k * period));
  const bpb = opts.bpb ?? 4;
  const downAt = opts.downAt ?? 0;
  const duration = Math.round(first * F + beatsCount * period);
  return {
    duration,
    beats,
    downbeats: beats.filter((_, i) => i >= downAt && (i - downAt) % bpb === 0),
    beatsPerBar: bpb,
    sections: [
      { start: 0, end: Math.round(duration / 2) + 12345, energy: 30 },
      { start: Math.round(duration / 2) + 12345, end: duration, energy: 80 },
    ],
  };
}
