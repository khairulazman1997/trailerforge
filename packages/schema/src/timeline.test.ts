import { describe, expect, it } from 'vitest';
import { secondsToFlicks as s } from './time.js';
import { Animatable, Timeline, Track, timelineDuration } from './timeline.js';

const clip = (id: string, start: number, duration: number) => ({
  id,
  kind: 'clip' as const,
  assetId: 'a1',
  start: s(start),
  duration: s(duration),
  sourceIn: 0,
});

describe('Track', () => {
  it('accepts adjacent, non-overlapping items in any array order', () => {
    const r = Track.safeParse({
      id: 't',
      kind: 'video',
      items: [clip('b', 2, 1), clip('a', 0, 2)],
    });
    expect(r.success).toBe(true);
  });

  it('rejects overlapping items', () => {
    const r = Track.safeParse({
      id: 't',
      kind: 'video',
      items: [clip('a', 0, 2), clip('b', 1.5, 1)],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/overlap/);
  });

  it('rejects zero-length items', () => {
    expect(Track.safeParse({ id: 't', kind: 'video', items: [clip('a', 0, 0)] }).success).toBe(
      false,
    );
  });

  it('accepts a transition across an exact cut', () => {
    const r = Track.safeParse({
      id: 't',
      kind: 'video',
      items: [clip('a', 0, 2), clip('b', 2, 1)],
      transitions: [
        { id: 'x', transitionId: 'core/dip', fromItemId: 'a', toItemId: 'b', duration: s(0.2) },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects transitions between non-adjacent or missing items', () => {
    const gap = Track.safeParse({
      id: 't',
      kind: 'video',
      items: [clip('a', 0, 2), clip('b', 3, 1)],
      transitions: [
        { id: 'x', transitionId: 'core/dip', fromItemId: 'a', toItemId: 'b', duration: s(0.2) },
      ],
    });
    expect(gap.success).toBe(false);
    const missing = Track.safeParse({
      id: 't',
      kind: 'video',
      items: [clip('a', 0, 2)],
      transitions: [
        { id: 'x', transitionId: 'core/dip', fromItemId: 'a', toItemId: 'zz', duration: 0 },
      ],
    });
    expect(missing.success).toBe(false);
  });
});

describe('Animatable', () => {
  it('accepts static values and ascending keyframes', () => {
    expect(Animatable.safeParse(1).success).toBe(true);
    expect(Animatable.safeParse([0.5, 0.5]).success).toBe(true);
    expect(
      Animatable.safeParse({
        keyframes: [
          { at: 0, value: 0 },
          { at: 10, value: 1 },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-order or duplicate keyframe times', () => {
    expect(
      Animatable.safeParse({
        keyframes: [
          { at: 10, value: 0 },
          { at: 5, value: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      Animatable.safeParse({
        keyframes: [
          { at: 5, value: 0 },
          { at: 5, value: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('Timeline', () => {
  it('computes duration as the furthest item end across tracks', () => {
    const tl = Timeline.parse({
      id: 'tl',
      name: 'x',
      frameRate: { num: 30, den: 1 },
      resolution: { width: 1920, height: 1080 },
      tracks: [
        { id: 'v', kind: 'video', items: [clip('a', 0, 2)] },
        { id: 'a', kind: 'audio', items: [clip('m', 0, 5)] },
      ],
    });
    expect(timelineDuration(tl)).toBe(s(5));
    expect(tl.sampleRate).toBe(48_000);
  });
});
