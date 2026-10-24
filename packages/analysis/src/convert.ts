import { FLICKS_PER_SECOND, framesToFlicks, secondsToFlicks } from '@trailerforge/schema';
import type { FootageAnalysis, FootageRaw, MusicAnalysis, MusicRaw } from './schemas.js';

export const MUSIC_ANALYZER = { name: 'music', version: '1' } as const;
export const FOOTAGE_ANALYZER = { name: 'footage', version: '1' } as const;

/** Sorted, unique, within [0, max]. */
function times(xs: number[], max: number): number[] {
  const out = [...new Set(xs.map((x) => Math.min(max, x)))].sort((a, b) => a - b);
  return out;
}

/**
 * The one place where sidecar seconds become flicks: `secondsToFlicks` (round to nearest) for
 * music, `framesToFlicks` for frame indices. Nothing else converts analysis times.
 */
export function toMusicAnalysis(raw: MusicRaw): MusicAnalysis {
  const duration = secondsToFlicks(raw.duration);
  const f = (xs: number[]) => times(xs.map(secondsToFlicks), duration);
  return {
    analyzer: 'music',
    version: MUSIC_ANALYZER.version,
    duration,
    tempo: raw.tempo,
    beatsPerBar: raw.beatsPerBar,
    beats: f(raw.beats),
    downbeats: f(raw.downbeats),
    onsets: f(raw.onsets),
    energy: { hop: secondsToFlicks(raw.energy.hop), values: raw.energy.values },
    sections: raw.sections
      .map((s) => ({
        start: Math.min(duration, secondsToFlicks(s.start)),
        end: Math.min(duration, secondsToFlicks(s.end)),
        energy: s.energy,
      }))
      .filter((s) => s.end > s.start),
  };
}

export function toFootageAnalysis(raw: FootageRaw): FootageAnalysis {
  const at = (frame: number) => framesToFlicks(frame, raw.rate);
  const n = raw.frameCount;
  const ranges = (rs: [number, number][]) =>
    rs
      .map(([s, e]) => ({ start: at(Math.min(s, n)), end: at(Math.min(e, n)) }))
      .filter((r) => r.end > r.start);
  return {
    analyzer: 'footage',
    version: FOOTAGE_ANALYZER.version,
    rate: raw.rate,
    frameCount: n,
    duration: at(n),
    scenes: times(raw.scenes.filter((s) => s > 0 && s < n).map(at), at(n)),
    black: ranges(raw.black),
    flashes: times(raw.flashes.filter((s) => s < n).map(at), at(n)),
    frozen: ranges(raw.frozen),
    brightness: raw.brightness,
    motion: raw.motion,
  };
}

/** Numbers about a recording that a take ranking can compare (see `TakeFacts` in the Game Trailer pack). */
export function summarizeFootage(a: FootageAnalysis) {
  const sec = (flicks: number) => flicks / FLICKS_PER_SECOND;
  const span = (rs: { start: number; end: number }[]) =>
    rs.reduce((n, r) => n + sec(r.end - r.start), 0);
  const mean = a.motion.length ? a.motion.reduce((n, m) => n + m, 0) / a.motion.length : 0;
  return {
    seconds: sec(a.duration),
    blackSeconds: span(a.black),
    frozenSeconds: span(a.frozen),
    flashFrames: a.flashes.length,
    sceneChanges: a.scenes.length,
    /** Mean luma change per frame (the series is stored x10), x4 so busy action nears 100. */
    motion: Math.min(100, (mean / 10) * 4),
  };
}
