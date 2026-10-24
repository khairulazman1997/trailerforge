import { flicksPerFrame, type Timeline } from '@trailerforge/schema';
import type { MusicGrid } from './grid.js';

/**
 * Numbers the evaluation loop tracks for a cut, so a change to the cut logic shows up as a
 * regression: how many cuts land on the beat (allowing the lead frames), how much is still
 * placeholder, and whether any item is a flash frame.
 */
export interface CutMetrics {
  items: number;
  cuts: number;
  /** Share of cuts within `leadFrames` + 1 frame before a beat (0–1). */
  onBeat: number;
  /** Share of cuts on a bar (same tolerance). */
  onBar: number;
  placeholders: number;
  /** Share of picture time that is placeholder (0–1). */
  placeholderShare: number;
  /** Picture items shorter than six frames. */
  flashItems: number;
  /** Picture length in seconds. */
  seconds: number;
}

export function cutMetrics(
  timeline: Timeline,
  grid: Pick<MusicGrid, 'beats' | 'bars'>,
  leadFrames = 1,
): CutMetrics {
  const fpf = flicksPerFrame(timeline.frameRate);
  const pic = timeline.tracks
    .filter((t) => t.kind === 'video' || t.kind === 'graphics')
    .flatMap((t) => t.items)
    .sort((a, b) => a.start - b.start);
  const cuts = pic.slice(1).map((i) => i.start);
  const near = (marks: readonly number[], c: number) =>
    marks.some((m) => m - c >= -fpf / 2 && m - c <= (leadFrames + 1) * fpf);
  const total = pic.length ? pic.at(-1)!.start + pic.at(-1)!.duration : 0;
  const ph = pic.filter((i) => i.kind === 'placeholder');
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    items: pic.length,
    cuts: cuts.length,
    onBeat: cuts.length ? round(cuts.filter((c) => near(grid.beats, c)).length / cuts.length) : 1,
    onBar: cuts.length ? round(cuts.filter((c) => near(grid.bars, c)).length / cuts.length) : 1,
    placeholders: ph.length,
    placeholderShare: total ? round(ph.reduce((n, i) => n + i.duration, 0) / total) : 0,
    flashItems: pic.filter((i) => i.duration < 6 * fpf).length,
    seconds: round(total / 705_600_000),
  };
}
