import type { Animatable, Easing, Keyframe } from '@trailerforge/schema';

/**
 * The keyframe and easing evaluator shared by the renderer and the browser preview, so both
 * draw the same frame. Pure and deterministic; time is integer flicks from the item's start.
 *
 * A keyframe's `easing` shapes the segment that leaves it, up to the next keyframe. Before the
 * first keyframe the value is the first one's, after the last the last one's, and at a keyframe
 * it is exactly that keyframe's value.
 */

/** CSS's named curves as cubic Béziers. */
const NAMED: Record<
  'linear' | 'ease-in' | 'ease-out' | 'ease-in-out',
  [number, number, number, number]
> = {
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/**
 * Progress through a segment (`t` in 0..1, clamped) shaped by `easing`. Named curves stay in
 * 0..1; a custom Bézier may overshoot when its y control points do (a bounce), never in x.
 */
export function ease(easing: Easing, t: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  if (easing === 'hold') return p >= 1 ? 1 : 0;
  if (easing === 'linear') return p;
  const [x1, y1, x2, y2] = typeof easing === 'string' ? NAMED[easing] : easing.cubicBezier;
  return cubicBezier(clamp01(x1), y1, clamp01(x2), y2, p);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** y on the curve (0,0)–(x1,y1)–(x2,y2)–(1,1) where x = `x`; x is monotone for x1, x2 in 0..1. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  // Newton from a good start, then bisection if it wanders: a fixed number of steps either way.
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(s) - x;
    const d = dx(s);
    if (Math.abs(err) < 1e-7) break;
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  if (!(s >= 0 && s <= 1) || Math.abs(sx(s) - x) > 1e-6) {
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      if (sx(s) < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
  }
  return ((ay * s + by) * s + cy) * s;
}

export type Value = number | number[];

const mix = (a: Value, b: Value, k: number): Value => {
  if (typeof a === 'number') return typeof b === 'number' ? a + (b - a) * k : a;
  if (typeof b === 'number') return a;
  return a.map((v, i) => (i < b.length ? v + (b[i]! - v) * k : v));
};

/** The value of `a` at `at` flicks from the item's start. */
export function evaluate(a: Animatable, at: number): Value {
  if (typeof a === 'number' || Array.isArray(a)) return a;
  return evaluateKeyframes(a.keyframes, at);
}

export function evaluateKeyframes(ks: readonly Keyframe[], at: number): Value {
  const first = ks[0]!;
  if (at <= first.at) return first.value;
  const last = ks[ks.length - 1]!;
  if (at >= last.at) return last.value;
  // Binary search for the segment [ks[i], ks[i + 1]) holding `at`.
  let lo = 0;
  let hi = ks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ks[mid]!.at <= at) lo = mid;
    else hi = mid;
  }
  const a = ks[lo]!;
  const b = ks[hi]!;
  if (at === a.at) return a.value;
  return mix(a.value, b.value, ease(a.easing, (at - a.at) / (b.at - a.at)));
}

/** A number, whatever shape the animatable has (the first component of an array). */
export function evaluateNumber(a: Animatable, at: number): number {
  const v = evaluate(a, at);
  return typeof v === 'number' ? v : (v[0] ?? 0);
}

/** A vector of `n` components; missing ones repeat the last, a number fills every slot. */
export function evaluateVector(a: Animatable, at: number, n: number): number[] {
  const v = evaluate(a, at);
  if (typeof v === 'number') return Array.from({ length: n }, () => v);
  return Array.from({ length: n }, (_, i) => v[Math.min(i, v.length - 1)] ?? 0);
}
