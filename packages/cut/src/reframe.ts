import { flicksPerFrame, type Rate, type Resolution } from '@trailerforge/schema';

/**
 * Reframing one clip for another aspect ratio. Pure and deterministic; browser-safe.
 *
 * The crop is the largest rectangle of the target's shape inside the source frame. Its centre
 * follows the movement in the footage (the analysis' per-frame focus: centre and spread of what
 * moves) like a camera operator: smoothed over half a second, still inside a dead zone, never
 * faster than a set speed, always inside the frame. Frames where nothing moves, or everything
 * does (a pan), hold the last point. When the subject is wider than the crop's safe area, the
 * clip is shown whole over a blurred fill instead. A focus point set by hand wins.
 */

/** Normalized to the source frame, 0..1. */
export interface FocusPoint {
  x: number;
  y: number;
}

/** A crop of the source frame, normalized 0..1. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReframeResult {
  mode: 'none' | 'crop' | 'fill';
  /** Crop per keyframe, offsets in flicks from the item's start; one entry for a static crop. */
  path: { at: number; rect: CropRect }[];
  reason: string;
}

export interface ReframeInput {
  source: Resolution;
  target: Resolution;
  /** The timeline's rate: one path sample per frame. */
  rate: Rate;
  /** The clip: where it starts in the recording, how long it plays, how fast. */
  sourceIn: number;
  duration: number;
  speed?: number;
  /** The recording's analysis; `focus` is centre x, y and spread sx, sy per frame, 0..1000. */
  footage?: { rate: Rate; focus?: readonly (readonly number[] | null)[] };
  manual?: FocusPoint;
  /** `fill` never crops. */
  mode?: 'crop' | 'fill';
  options?: ReframeOptions;
}

export interface ReframeOptions {
  /** Margin of the crop kept for the subject and titles, per side (default 0.1). */
  safe?: number;
  /** Seconds of smoothing (default 0.5). */
  smoothSeconds?: number;
  /** Dead zone around the camera, share of the frame (default 0.04). */
  deadZone?: number;
  /** Fastest the crop moves, frame widths per second (default 0.5). */
  maxSpeed?: number;
  /** Largest deviation the simplified path may have from the per-frame one (default 0.003). */
  tolerance?: number;
}

/** Spread above this (of 1000) means everything moves: a pan or a cut, not a subject. */
const GLOBAL_SPREAD = 250;

/** The largest crop of the target's shape inside the source, as a share of the source frame. */
export function cropSize(source: Resolution, target: Resolution): { w: number; h: number } {
  const s = source.width / source.height;
  const t = target.width / target.height;
  return t < s ? { w: t / s, h: 1 } : { w: 1, h: s / t };
}

/** The crop of `size` centred on `focus`, moved inside the frame. */
export function placeCrop(focus: FocusPoint, size: { w: number; h: number }): CropRect {
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), Math.max(0, hi));
  return {
    x: round(clamp(focus.x - size.w / 2, 1 - size.w)),
    y: round(clamp(focus.y - size.h / 2, 1 - size.h)),
    w: round(size.w),
    h: round(size.h),
  };
}

/** The part of a crop titles and the subject should stay in. */
export function titleSafe(rect: CropRect, margin = 0.1): CropRect {
  return {
    x: rect.x + rect.w * margin,
    y: rect.y + rect.h * margin,
    w: rect.w * (1 - 2 * margin),
    h: rect.h * (1 - 2 * margin),
  };
}

/** Left, top, right, bottom insets for `Transform.crop`. */
export const cropInsets = (r: CropRect): number[] => [
  round(r.x),
  round(r.y),
  round(1 - r.x - r.w),
  round(1 - r.y - r.h),
];

const round = (v: number) => Math.round(v * 10_000) / 10_000;

export function reframeClip(input: ReframeInput): ReframeResult {
  const size = cropSize(input.source, input.target);
  const o = input.options ?? {};
  const safe = o.safe ?? 0.1;
  if (Math.abs(size.w - 1) < 1e-6 && Math.abs(size.h - 1) < 1e-6)
    return { mode: 'none', path: [], reason: 'same shape as the master' };
  if (input.mode === 'fill')
    return { mode: 'fill', path: [], reason: 'this version shows every shot whole' };
  if (input.manual)
    return {
      mode: 'crop',
      path: [{ at: 0, rect: placeCrop(input.manual, size) }],
      reason: 'focus point set by hand',
    };

  const fpf = flicksPerFrame(input.rate);
  const n = Math.max(1, Math.round(input.duration / fpf));
  const focus = input.footage?.focus;
  const srcFpf = input.footage ? flicksPerFrame(input.footage.rate) : 0;
  const speed = input.speed ?? 1;
  const raw: (readonly number[] | null)[] = [];
  for (let k = 0; k < n; k++) {
    const j = focus ? Math.round((input.sourceIn + k * fpf * speed) / srcFpf) : -1;
    const f = focus?.[j];
    raw.push(f && f[2]! <= GLOBAL_SPREAD && f[3]! <= GLOBAL_SPREAD ? f : null);
  }
  const seen = raw.filter((f): f is readonly number[] => f !== null);
  if (!seen.length)
    return {
      mode: 'crop',
      path: [{ at: 0, rect: placeCrop({ x: 0.5, y: 0.5 }, size) }],
      reason: focus ? 'no clear subject moving: centred' : 'not analysed yet: centred',
    };

  // Too wide for the crop most of the time: show it whole.
  const widths = seen.map((f) => (2 * Math.sqrt(3) * f[2]!) / 1000).sort((a, b) => a - b);
  const heights = seen.map((f) => (2 * Math.sqrt(3) * f[3]!) / 1000).sort((a, b) => a - b);
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
  if (median(widths) > size.w * (1 - 2 * safe) || median(heights) > size.h * (1 - 2 * safe))
    return {
      mode: 'fill',
      path: [],
      reason: 'the subject is wider than the crop: shown whole over a blurred fill',
    };

  // Hold through gaps (and back-fill the start), then smooth.
  let last = seen[0]!;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of raw) {
    if (f) last = f;
    xs.push(last[0]! / 1000);
    ys.push(last[1]! / 1000);
  }
  const fps = input.rate.num / input.rate.den;
  const half = Math.max(0, Math.round(((o.smoothSeconds ?? 0.5) * fps) / 2));
  const smooth = (v: number[]) =>
    v.map((_, k) => {
      let s = 0;
      let c = 0;
      for (let i = Math.max(0, k - half); i <= Math.min(v.length - 1, k + half); i++) {
        s += v[i]!;
        c++;
      }
      return s / c;
    });
  const sx = smooth(xs);
  const sy = smooth(ys);

  // A camera with a dead zone and a speed limit.
  const dz = o.deadZone ?? 0.04;
  const step = (o.maxSpeed ?? 0.5) / fps;
  const follow = (v: number[]) => {
    const out: number[] = [];
    let cam = v[0]!;
    for (const t of v) {
      const d = t - cam;
      if (Math.abs(d) > dz) cam += Math.sign(d) * Math.min(Math.abs(d) - dz, step);
      out.push(cam);
    }
    return out;
  };
  const cx = follow(sx);
  const cy = follow(sy);
  const rects = cx.map((x, k) => placeCrop({ x, y: cy[k]! }, size));

  const keep = simplify(rects, o.tolerance ?? 0.003);
  return {
    mode: 'crop',
    path: keep.map((k) => ({ at: Math.round(k * fpf), rect: rects[k]! })),
    reason:
      keep.length > 1 ? 'follows the movement in the shot' : 'subject holds still: a fixed crop',
  };
}

/** Indices of the frames a linear path needs (Ramer–Douglas–Peucker on x and y). */
function simplify(rects: CropRect[], tol: number): number[] {
  const last = rects.length - 1;
  if (last <= 0) return [0];
  const keep = new Set([0, last]);
  const stack: [number, number][] = [[0, last]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      const dx = Math.abs(rects[i]!.x - (rects[a]!.x + t * (rects[b]!.x - rects[a]!.x)));
      const dy = Math.abs(rects[i]!.y - (rects[a]!.y + t * (rects[b]!.y - rects[a]!.y)));
      const d = Math.max(dx, dy);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep.add(at);
      stack.push([a, at], [at, b]);
    }
  }
  const out = [...keep].sort((x, y) => x - y);
  // A path that never moves is one static crop.
  return out.length === 2 && rects[0]!.x === rects[last]!.x && rects[0]!.y === rects[last]!.y
    ? [0]
    : out;
}
