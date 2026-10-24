import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { nearestIndex, resolveMusicGrid } from './grid.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;

describe('resolveMusicGrid', () => {
  it('a steady track: bars every four beats, phrases every four bars, integer flicks', () => {
    const src = steady(120, 64, 0.5);
    const g = resolveMusicGrid(src);
    expect(g.beats).toEqual(src.beats);
    expect(g.bars).toEqual(src.beats.filter((_, i) => i % 4 === 0));
    expect(g.phrases).toEqual(g.bars.filter((_, j) => j % 4 === 0));
    expect(g.tempo).toBeCloseTo(120, 3);
    expect([...g.beats, ...g.bars].every(Number.isInteger)).toBe(true);
    // music sections end up on bars
    for (const s of g.sections.slice(1)) expect(g.bars).toContain(s.start);
  });

  it('shifting the downbeat moves bar 1 by whole beats, wrapping around the bar', () => {
    const src = steady(120, 32);
    expect(resolveMusicGrid(src, { downbeatShift: 1 }).bars[0]).toBe(src.beats[1]);
    expect(resolveMusicGrid(src, { downbeatShift: -1 }).bars[0]).toBe(src.beats[3]);
    expect(resolveMusicGrid(src, { downbeatShift: 4 }).bars).toEqual(resolveMusicGrid(src).bars);
  });

  it('a pickup bar: analysis put bar 1 on the second beat, and the grid follows it', () => {
    const src = steady(100, 33, 0.3, { downAt: 1 });
    const g = resolveMusicGrid(src);
    expect(g.bars[0]).toBe(src.beats[1]);
    expect(resolveMusicGrid(src, { downbeatShift: -1 }).bars[0]).toBe(src.beats[0]);
  });

  it('a tempo change: the grid follows the detected beats', () => {
    const a = steady(120, 32);
    const tail = steady(140, 32);
    const beats = [...a.beats, ...tail.beats.map((t) => t + a.duration)];
    const g = resolveMusicGrid({
      ...a,
      beats,
      downbeats: [0],
      duration: a.duration + tail.duration,
      sections: [],
    });
    expect(g.beats).toEqual(beats);
    expect(g.bars).toEqual(beats.filter((_, i) => i % 4 === 0));
  });

  it('a tempo override replaces the beats with an even grid through the downbeat, without drift', () => {
    const src = steady(118.7, 200, 0.42);
    const g = resolveMusicGrid(src, { tempo: 120 });
    const period = (60 * F) / 120;
    const anchor = src.downbeats[0]!;
    for (const t of g.beats) {
      const k = Math.round((t - anchor) / period);
      expect(t).toBe(Math.round(anchor + k * period));
    }
    expect(g.beats[0]).toBeLessThan(period); // extends back towards the start
    expect(g.bars).toContain(anchor);
    expect(g.tempo).toBe(120);
  });

  it('an offset moves everything but keeps which beats are bars', () => {
    const src = steady(120, 32, 0.1);
    const base = resolveMusicGrid(src);
    const later = resolveMusicGrid(src, { offset: 1000 });
    expect(later.beats).toEqual(base.beats.map((t) => t + 1000));
    expect(later.bars).toEqual(base.bars.map((t) => t + 1000));
    const earlier = resolveMusicGrid(src, { offset: -Math.round(0.2 * F) }); // the first beat falls off
    expect(earlier.beats[0]).toBe(src.beats[1]! - Math.round(0.2 * F));
    expect(earlier.bars[0]).toBe(src.beats[4]! - Math.round(0.2 * F)); // still beat 4, not beat 1
  });

  it('a different number of beats per bar and bars per phrase', () => {
    const src = steady(90, 36);
    const g = resolveMusicGrid(src, { beatsPerBar: 3, barsPerPhrase: 2 });
    expect(g.bars).toEqual(src.beats.filter((_, i) => i % 3 === 0));
    expect(g.phrases).toEqual(g.bars.filter((_, j) => j % 2 === 0));
  });

  it('is deterministic and copes with no beats at all', () => {
    const src = steady(128, 50, 0.25);
    expect(resolveMusicGrid(src, { downbeatShift: 2 })).toEqual(
      resolveMusicGrid(src, { downbeatShift: 2 }),
    );
    const empty = resolveMusicGrid({
      duration: 10 * F,
      beats: [],
      downbeats: [],
      beatsPerBar: 4,
      sections: [],
    });
    expect(empty).toMatchObject({ beats: [], bars: [], phrases: [], tempo: 0 });
  });

  it('nearestIndex picks the closer neighbour and the earlier one on a tie', () => {
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 15)).toBe(1);
    expect(nearestIndex([0, 10, 20], 16)).toBe(2);
    expect(nearestIndex([0, 10, 20], -5)).toBe(0);
    expect(nearestIndex([], 3)).toBe(-1);
  });
});
