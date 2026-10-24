import { FLICKS_PER_SECOND, type MusicGridSettings } from '@trailerforge/schema';

/**
 * The beat grid the cut lands on: analysed beats corrected by the user's nudges. Pure,
 * deterministic and browser-safe; every time is integer flicks from the start of the track.
 */

/** What the grid needs from a music analysis (`MusicAnalysis` in `@trailerforge/analysis`). */
export interface GridSource {
  duration: number;
  beats: readonly number[];
  downbeats: readonly number[];
  beatsPerBar: number;
  sections: readonly { start: number; end: number; energy: number }[];
}

export interface MusicGrid {
  duration: number;
  /** Beats per minute of the grid actually used (override, or from the median beat interval). */
  tempo: number;
  beatsPerBar: number;
  barsPerPhrase: number;
  beats: number[];
  /** Bar starts: a subset of `beats`. */
  bars: number[];
  /** Phrase starts: a subset of `bars`, counted from the first bar. */
  phrases: number[];
  /** Music sections from analysis, with boundaries moved to the nearest bar. */
  sections: { start: number; end: number; energy: number }[];
}

/** Index of the value in sorted `xs` nearest to `t` (the earlier one on a tie); -1 if empty. */
export function nearestIndex(xs: readonly number[], t: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - xs[lo - 1]! <= xs[lo]! - t) return lo - 1;
  return lo;
}

export const nearest = (xs: readonly number[], t: number): number | undefined =>
  xs[nearestIndex(xs, t)];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0
    ? 0
    : s.length % 2
      ? s[(s.length - 1) / 2]!
      : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export function resolveMusicGrid(
  src: GridSource,
  settings: Partial<MusicGridSettings> = {},
): MusicGrid {
  const duration = src.duration;
  const bpb = settings.beatsPerBar ?? src.beatsPerBar;
  const barsPerPhrase = settings.barsPerPhrase ?? 4;
  const offset = settings.offset ?? 0;

  // Where bar 1 falls before any shift: the first analysed downbeat (else the first beat).
  const firstDown = src.downbeats[0] ?? src.beats[0] ?? 0;
  let beats: number[];
  let anchorIndex: number;
  if (settings.tempo) {
    // An even grid at the given tempo through the anchor, each beat rounded on its own (no drift).
    const period = (60 * FLICKS_PER_SECOND) / settings.tempo;
    const kMin = -Math.floor(firstDown / period);
    const kMax = Math.ceil((duration - firstDown) / period);
    beats = [];
    for (let k = kMin; k <= kMax; k++) {
      const t = Math.round(firstDown + k * period);
      if (t >= 0 && t < duration) beats.push(t);
    }
    anchorIndex = beats.indexOf(Math.round(firstDown));
  } else {
    beats = [...src.beats];
    anchorIndex = nearestIndex(beats, firstDown);
  }
  if (anchorIndex < 0) anchorIndex = 0;

  // Shift the whole grid, keeping beat indices so the bar phase does not move with it.
  const shifted = beats.map((t) => t + offset);
  const firstKept = shifted.findIndex((t) => t >= 0);
  const kept = firstKept < 0 ? [] : shifted.slice(firstKept).filter((t) => t < duration);
  const phaseBase = anchorIndex - Math.max(0, firstKept);
  const phase = (((phaseBase + (settings.downbeatShift ?? 0)) % bpb) + bpb) % bpb;
  const bars = kept.filter((_, i) => (i - phase) % bpb === 0);
  const phrases = bars.filter((_, j) => j % barsPerPhrase === 0);

  const tempo =
    settings.tempo ??
    (kept.length > 1
      ? (60 * FLICKS_PER_SECOND) / median(kept.slice(1).map((t, i) => t - kept[i]!))
      : 0);

  const snapBar = (t: number) => (t <= 0 ? 0 : t >= duration ? duration : (nearest(bars, t) ?? t));
  const sections = src.sections
    .map((s) => ({ start: snapBar(s.start), end: snapBar(s.end), energy: s.energy }))
    .filter((s, i, all) => s.end > s.start && (i === 0 || s.start >= all[i - 1]!.end));

  return {
    duration,
    tempo: Math.round(tempo * 1000) / 1000,
    beatsPerBar: bpb,
    barsPerPhrase,
    beats: kept,
    bars,
    phrases,
    sections,
  };
}
