import { FLICKS_PER_SECOND, Transform } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { pickStillMotions, stillMotion, STILL_MOTIONS, type StillMotion } from './stills.js';

const D = 3 * FLICKS_PER_SECOND;

describe('stillMotion', () => {
  it('every move is valid transform data', () => {
    for (const style of STILL_MOTIONS)
      expect(() => Transform.parse(stillMotion({ style, duration: D }))).not.toThrow();
  });

  it('push-in grows about the focus point, which stays where it is on screen', () => {
    const m = stillMotion({
      style: 'push-in',
      duration: D,
      strength: 0.2,
      focus: { x: 0.3, y: 0.6 },
    });
    expect(m).toEqual({
      scale: { keyframes: [{ at: 0, value: 1, easing: 'linear' }, { at: D, value: 1.2, easing: 'linear' }] }, // prettier-ignore
      position: [0.3, 0.6],
      anchor: [0.3, 0.6],
    });
    const out = stillMotion({ style: 'pull-out', duration: D, strength: 0.2 });
    expect(out.scale).toEqual({
      keyframes: [{ at: 0, value: 1.2, easing: 'linear' }, { at: D, value: 1, easing: 'linear' }], // prettier-ignore
    });
  });

  it('a pan zooms a little and slides to, but never past, the picture’s edge', () => {
    const left = stillMotion({ style: 'pan-left', duration: D, strength: 0.2 });
    expect(left.scale).toBe(1.2);
    expect(left.position).toEqual({
      keyframes: [{ at: 0, value: [0.6, 0.5], easing: 'linear' }, { at: D, value: [0.4, 0.5], easing: 'linear' }], // prettier-ignore
    });
    const right = stillMotion({ style: 'pan-right', duration: D, strength: 0.2 });
    expect((right.position as { keyframes: { value: number[] }[] }).keyframes.map((k) => k.value[0])).toEqual([0.4, 0.6]); // prettier-ignore
    // At scale s the edge of the picture sits at 1 - s/2 and s/2 for a centred anchor.
    for (const k of (left.position as { keyframes: { value: number[] }[] }).keyframes) {
      expect(k.value[0]!).toBeGreaterThanOrEqual(1 - 1.2 / 2 - 1e-9);
      expect(k.value[0]!).toBeLessThanOrEqual(1.2 / 2 + 1e-9);
    }
  });

  it('none stays put; strength and focus are kept in range', () => {
    expect(stillMotion({ style: 'none', duration: D })).toEqual({ scale: 1, position: [0.5, 0.5], anchor: [0.5, 0.5] }); // prettier-ignore
    const wild = stillMotion({
      style: 'push-in',
      duration: D,
      strength: 9,
      focus: { x: -2, y: 4 },
    });
    expect(wild.anchor).toEqual([0, 1]);
    expect((wild.scale as { keyframes: { value: number }[] }).keyframes[1]!.value).toBe(1.5);
  });
});

describe('pickStillMotions', () => {
  it('is stable, never repeats a move back to back and never picks none', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `short_x_item${i}`);
    const a = pickStillMotions(ids);
    expect(pickStillMotions(ids)).toEqual(a);
    expect(a).toHaveLength(40);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
    expect(a.includes('none' as StillMotion)).toBe(false);
    expect(new Set(a).size).toBe(4);
  });
});
