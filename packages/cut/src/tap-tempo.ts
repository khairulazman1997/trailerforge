import { FLICKS_PER_SECOND, type MusicGridSettings } from '@trailerforge/schema';
import { resolveMusicGrid, type MusicGrid } from './grid.js';

/**
 * Tap tempo: the beat grid for a TikTok that has no music file (the sound is added inside the
 * app later). The user taps along with the beat they have in mind; the tempo comes from the
 * spacing of the taps.
 */

export type TapTempo =
  | {
      ok: true;
      /** Beats per minute, to a tenth. */
      tempo: number;
      /** Where the first tap falls inside its beat, as a shift of the grid in flicks (at most a second either way). */
      offset: number;
      /** Intervals that were used (outliers such as a missed beat are left out). */
      used: number;
      /** 1 = perfectly even taps; below 0.9 the taps wandered. */
      steadiness: number;
    }
  | { ok: false; reason: string };

export const MIN_TAPS = 4;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** `taps` are times in seconds, in order (from any clock: only their spacing and phase count). */
export function tapTempo(taps: readonly number[]): TapTempo {
  if (taps.length < MIN_TAPS)
    return { ok: false, reason: `tap at least ${MIN_TAPS} times along with the beat` };
  const gaps: number[] = [];
  for (let i = 1; i < taps.length; i++) {
    const g = taps[i]! - taps[i - 1]!;
    if (!(g > 0)) return { ok: false, reason: 'the taps are not in order' };
    gaps.push(g);
  }
  const m = median(gaps);
  // A missed beat (about double) or a stray double tap (about half) is not the tempo.
  const kept = gaps.filter((g) => g > m * 0.6 && g < m * 1.6);
  if (kept.length < MIN_TAPS - 2)
    return { ok: false, reason: 'the taps are too uneven to find a tempo' };
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  let bpm = 60 / mean;
  let period = mean;
  while (bpm > 300) {
    bpm /= 2;
    period *= 2;
  }
  while (bpm < 30) {
    bpm *= 2;
    period /= 2;
  }
  const tempo = Math.round(bpm * 10) / 10;
  const sd = Math.sqrt(kept.reduce((a, g) => a + (g - mean) ** 2, 0) / kept.length);
  let phase = ((taps[0]! % period) + period) % period;
  if (phase > period / 2) phase -= period;
  const offset = Math.max(
    -FLICKS_PER_SECOND,
    Math.min(FLICKS_PER_SECOND, Math.round(phase * FLICKS_PER_SECOND)),
  );
  return {
    ok: true,
    tempo,
    offset,
    used: kept.length,
    steadiness: Math.max(0, Math.round((1 - sd / mean) * 100) / 100),
  };
}

/**
 * The beat grid for a given tempo with no music analysis: an even grid from the start of the
 * cut (bar 1 at 0), moved by `offset`, as long as `seconds`.
 */
export function tempoGrid(
  settings: Partial<MusicGridSettings> & { tempo: number },
  seconds: number,
): MusicGrid {
  return resolveMusicGrid(
    {
      duration: Math.round(seconds * FLICKS_PER_SECOND),
      beats: [0],
      downbeats: [0],
      beatsPerBar: 4,
      sections: [],
    },
    settings,
  );
}
