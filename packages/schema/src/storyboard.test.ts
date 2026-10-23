import { describe, expect, it } from 'vitest';
import { DurationRange, MusicPlan, Slot, Storyboard } from './storyboard.js';

describe('DurationRange', () => {
  it('accepts min <= ideal <= max', () => {
    expect(DurationRange.safeParse({ min: 1, ideal: 2, max: 3 }).success).toBe(true);
    expect(DurationRange.safeParse({ min: 2, ideal: 2, max: 2 }).success).toBe(true);
  });

  it.each([
    { min: 3, ideal: 2, max: 4 },
    { min: 1, ideal: 5, max: 4 },
    { min: -1, ideal: 1, max: 2 },
  ])('rejects %o', (d) => {
    expect(DurationRange.safeParse(d).success).toBe(false);
  });
});

describe('Slot', () => {
  it('fills shot defaults', () => {
    const slot = Slot.parse({ id: 's1', kind: 'shot', duration: { min: 1, ideal: 2, max: 3 } });
    expect(slot).toMatchObject({ status: 'empty', hud: 'any', priority: 'must', overlays: [] });
  });

  it('requires card fields on card slots', () => {
    const base = { id: 'c1', kind: 'card', duration: { min: 1, ideal: 2, max: 3 } };
    expect(Slot.safeParse(base).success).toBe(false);
    expect(
      Slot.safeParse({ ...base, cardKind: 'title', templateId: 'core/title-card' }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict objects)', () => {
    const r = Slot.safeParse({
      id: 's1',
      kind: 'shot',
      duration: { min: 1, ideal: 2, max: 3 },
      captureInstructions: 'typo',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown slot kinds', () => {
    expect(
      Slot.safeParse({ id: 'x', kind: 'gif', duration: { min: 1, ideal: 1, max: 1 } }).success,
    ).toBe(false);
  });
});

describe('MusicPlan', () => {
  it('rejects inverted bpm ranges', () => {
    expect(MusicPlan.safeParse({ bpm: { min: 140, max: 120 } }).success).toBe(false);
  });
});

describe('Storyboard', () => {
  it('parses a minimal storyboard with defaults', () => {
    const sb = Storyboard.parse({
      id: 'sb',
      meta: { videoTypeId: 'game-trailer/gameplay-trailer', targetDuration: 30 },
    });
    expect(sb.revision).toBe(0);
    expect(sb.sections).toEqual([]);
    expect(sb.music.hitPoints).toEqual([]);
  });

  it('rejects malformed plugin refs', () => {
    const r = Storyboard.safeParse({
      id: 'sb',
      meta: { videoTypeId: 'Release Trailer', targetDuration: 30 },
    });
    expect(r.success).toBe(false);
  });
});
