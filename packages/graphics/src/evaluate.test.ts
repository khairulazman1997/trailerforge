import type { Easing, Keyframe } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { ease, evaluate, evaluateNumber, evaluateVector } from './evaluate.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMED: Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'];

function randomKeyframes(r: () => number, vector: boolean): Keyframe[] {
  const n = 1 + Math.floor(r() * 6);
  let at = Math.floor(r() * 1000);
  return Array.from({ length: n }, () => {
    at += 1 + Math.floor(r() * 10_000_000);
    const value = vector ? [r() * 100 - 50, r() * 100 - 50] : r() * 100 - 50;
    const easing =
      r() < 0.2
        ? { cubicBezier: [r(), r(), r(), r()] as [number, number, number, number] }
        : NAMED[Math.floor(r() * NAMED.length)]!;
    return { at, value, easing };
  });
}

describe('ease', () => {
  it('starts at 0, ends at 1, stays in range and rises for every named curve and in-range Bézier', () => {
    const r = rng(1);
    const curves: Easing[] = [...NAMED];
    for (let i = 0; i < 100; i++) curves.push({ cubicBezier: [r(), r(), r(), r()] });
    for (const c of curves) {
      expect(ease(c, 0)).toBe(0);
      expect(ease(c, 1)).toBe(1);
      let prev = 0;
      for (let k = 0; k <= 200; k++) {
        const v = ease(c, k / 200);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-6); // y control points in 0..1: monotone
        prev = v;
      }
    }
  });

  it('matches known values and clamps progress', () => {
    expect(ease('linear', 0.25)).toBe(0.25);
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 6);
    expect(ease('ease-in', 0.5)).toBeCloseTo(0.315, 2);
    expect(ease('ease-out', 0.5)).toBeCloseTo(0.685, 2);
    expect(ease('hold', 0.999)).toBe(0);
    expect(ease('linear', -3)).toBe(0);
    expect(ease('linear', 7)).toBe(1);
    expect(ease('linear', Number.NaN)).toBe(0);
    // A Bézier with y outside 0..1 overshoots (a bounce), but x is clamped so it stays a function.
    expect(ease({ cubicBezier: [0.3, 1.6, 0.6, 1] }, 0.5)).toBeGreaterThan(1);
  });
});

describe('evaluate', () => {
  it('is exact at keyframes, holds outside them, and is deterministic', () => {
    const r = rng(2);
    for (let n = 0; n < 500; n++) {
      const ks = randomKeyframes(r, n % 2 === 0);
      const a = { keyframes: ks };
      for (const k of ks) expect(evaluate(a, k.at)).toEqual(k.value);
      expect(evaluate(a, ks[0]!.at - 1)).toEqual(ks[0]!.value);
      expect(evaluate(a, ks.at(-1)!.at + 12345)).toEqual(ks.at(-1)!.value);
      for (let i = 0; i < 20; i++) {
        const at = ks[0]!.at + Math.floor(r() * (ks.at(-1)!.at - ks[0]!.at + 1));
        expect(evaluate(a, at)).toEqual(evaluate({ keyframes: structuredClone(ks) }, at));
      }
    }
  });

  it('stays between the two keyframes of a segment for in-range curves', () => {
    const r = rng(3);
    for (let n = 0; n < 300; n++) {
      const ks = randomKeyframes(r, false).map((k) =>
        typeof k.easing === 'object' ? { ...k, easing: 'ease-in-out' as const } : k,
      );
      for (let i = 0; i + 1 < ks.length; i++) {
        const a = ks[i]!;
        const b = ks[i + 1]!;
        const at = a.at + Math.floor(r() * (b.at - a.at));
        const v = evaluateNumber({ keyframes: ks }, at);
        const lo = Math.min(a.value as number, b.value as number);
        const hi = Math.max(a.value as number, b.value as number);
        expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(v).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('interpolates vectors per component and passes static values through', () => {
    const a = {
      keyframes: [
        { at: 0, value: [0, 10], easing: 'linear' as const },
        { at: 100, value: [10, 20], easing: 'linear' as const },
      ],
    };
    expect(evaluate(a, 50)).toEqual([5, 15]);
    expect(evaluate(3, 99)).toBe(3);
    expect(evaluateVector(2, 0, 3)).toEqual([2, 2, 2]);
    expect(evaluateVector([1, 2], 0, 4)).toEqual([1, 2, 2, 2]);
    expect(evaluateNumber([7, 8], 0)).toBe(7);
  });
});
