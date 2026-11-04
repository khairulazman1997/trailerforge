import type { Animatable, Flicks } from '@trailerforge/schema';

/**
 * Slow moves for still images (the "Ken Burns" look), as transform keyframes a clip carries:
 * the compiler and the preview both animate `scale` and `position` frame by frame, so a move
 * is nothing but data and renders the same everywhere. A push-in or pull-out zooms about the
 * focus point, which stays where it is on screen; a pan zooms a little and slides across the
 * picture, never past its edges. Pure and browser-safe.
 */

export const STILL_MOTIONS = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'none'] as const;
export type StillMotion = (typeof STILL_MOTIONS)[number];

/** The moves a series of images rotates through when nobody picked (no `none`). */
const ROTATION: readonly StillMotion[] = ['push-in', 'pan-left', 'pull-out', 'pan-right'];

export const DEFAULT_STILL_STRENGTH = 0.18;
const MIN_STRENGTH = 0.04;
const MAX_STRENGTH = 0.5;

export interface StillMotionOptions {
  style: StillMotion;
  /** The clip's length, flicks: the move lasts exactly this long. */
  duration: Flicks;
  /** How much the picture grows or travels, as a share of the frame (default 0.18). */
  strength?: number;
  /** The point to zoom about, 0..1 across and down the frame (default the centre). */
  focus?: { x: number; y: number };
}

export interface StillTransform {
  scale: Animatable;
  position: Animatable;
  anchor: Animatable;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Transform fields for a move; pass them to `core/timeline.set-transform`. */
export function stillMotion(o: StillMotionOptions): StillTransform {
  const strength = clamp(o.strength ?? DEFAULT_STILL_STRENGTH, MIN_STRENGTH, MAX_STRENGTH);
  const fx = clamp(o.focus?.x ?? 0.5, 0, 1);
  const fy = clamp(o.focus?.y ?? 0.5, 0, 1);
  const end = o.duration;
  const s = round(1 + strength);
  const at = (frac: number, value: number | number[]) => ({
    at: frac === 0 ? 0 : end,
    value,
    easing: 'linear' as const,
  });
  switch (o.style) {
    case 'none':
      return { scale: 1, position: [0.5, 0.5], anchor: [0.5, 0.5] };
    case 'push-in':
    case 'pull-out': {
      const [from, to] = o.style === 'push-in' ? [1, s] : [s, 1];
      return {
        scale: { keyframes: [at(0, from), at(1, to)] },
        position: [round(fx), round(fy)],
        anchor: [round(fx), round(fy)],
      };
    }
    case 'pan-left':
    case 'pan-right': {
      // At scale s the picture can slide s/2 - 0.5 of a frame either way before an edge shows.
      const lo = round(1 - s / 2);
      const hi = round(s / 2);
      const [from, to] = o.style === 'pan-left' ? [hi, lo] : [lo, hi];
      return {
        scale: s,
        position: { keyframes: [at(0, [from, 0.5]), at(1, [to, 0.5])] },
        anchor: [0.5, 0.5],
      };
    }
  }
}

/** FNV-1a: a small stable hash for choosing moves. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * A move for each image in a series, chosen from the ids so the same cut always gets the same
 * moves, and never the same move twice in a row.
 */
export function pickStillMotions(seeds: readonly string[]): StillMotion[] {
  const out: StillMotion[] = [];
  for (const seed of seeds) {
    let i = hash(seed) % ROTATION.length;
    if (ROTATION[i] === out.at(-1)) i = (i + 1) % ROTATION.length;
    out.push(ROTATION[i]!);
  }
  return out;
}
