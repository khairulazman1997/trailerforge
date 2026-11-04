import { FLICKS_PER_SECOND as F } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { tapTempo, tempoGrid } from './tap-tempo.js';

const taps = (bpm: number, n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => start + (i * 60) / bpm);

describe('tapTempo', () => {
  it('finds the tempo and the phase of even taps', () => {
    const r = tapTempo(taps(120, 8, 0.1));
    expect(r).toMatchObject({ ok: true, tempo: 120, offset: Math.round(0.1 * F) });
  });
  it('shrugs off a missed beat and slightly uneven taps', () => {
    const t = taps(100, 10)
      .filter((_, i) => i !== 4)
      .map((x, i) => x + (i % 2 ? 0.01 : -0.01));
    const r = tapTempo(t);
    expect(r.ok && Math.abs(r.tempo - 100) < 2).toBe(true);
  });
  it('asks for more taps, or in order', () => {
    expect(tapTempo([0, 1, 2]).ok).toBe(false);
    expect(tapTempo([0, 1, 0.5, 2]).ok).toBe(false);
  });
  it('folds a very fast or slow tapping into the 30–300 range', () => {
    expect(tapTempo(taps(400, 8))).toMatchObject({ tempo: 200 });
  });
  it('makes an even grid from a tempo alone', () => {
    const g = tempoGrid({ tempo: 120 }, 10);
    expect(g.beats.slice(0, 3)).toEqual([0, F / 2, F]);
    expect(g.bars[1]).toBe(2 * F);
  });
});
