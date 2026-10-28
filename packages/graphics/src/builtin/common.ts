import { FLICKS_PER_SECOND, type Animatable } from '@trailerforge/schema';
import {
  fadeInOut,
  type Layer,
  type Scene,
  type TemplateContext,
  type TextLayer,
} from '../template.js';
import { layoutText, type Box } from '../text.js';

export const SEC = FLICKS_PER_SECOND;

/** How long the in and out animations take: 0.45 s and 0.35 s, never more than a quarter each. */
export function timing(duration: number) {
  return {
    inF: Math.min(Math.round(0.45 * SEC), Math.floor(duration / 4)),
    outF: Math.min(Math.round(0.35 * SEC), Math.floor(duration / 4)),
  };
}

/** Fade in and out over the item. */
export const fade = (duration: number, peak = 1): Animatable => {
  const { inF, outF } = timing(duration);
  return fadeInOut(duration, inF, outF, peak);
};

/** Rise `px` into place while fading in (and drift up as it leaves is left to the fade). */
export const rise = (duration: number, px: number): Animatable => {
  const { inF } = timing(duration);
  return {
    keyframes: [
      { at: 0, value: [0, px], easing: 'ease-out' },
      { at: Math.max(1, inF), value: [0, 0], easing: 'linear' },
    ],
  };
};

/** Grow from `from` to 1 over the in animation. */
export const grow = (duration: number, from: number): Animatable => {
  const { inF } = timing(duration);
  return {
    keyframes: [
      { at: 0, value: from, easing: 'ease-out' },
      { at: Math.max(1, inF), value: 1, easing: 'linear' },
    ],
  };
};

/** Reveal from the left over the in animation, after `delay` flicks. */
export const wipe = (duration: number, delay = 0): Animatable => {
  const { inF } = timing(duration);
  const start = Math.min(delay, Math.floor(duration / 2));
  return {
    keyframes: [
      ...(start > 0 ? [{ at: 0, value: 0, easing: 'linear' as const }] : []),
      { at: start, value: 0, easing: 'ease-out' as const },
      { at: start + Math.max(1, inF), value: 1, easing: 'linear' as const },
    ],
  };
};

export interface Line {
  id: string;
  text: string;
  /** Preferred size, px. */
  size: number;
  weight: 'heading' | 'body';
  color: string;
  uppercase?: boolean;
  letterSpacing?: number;
  maxLines?: number;
  /** Seconds after the start before this line begins to show (for staggering). */
  delay?: number;
}

/**
 * Stack text lines top to bottom, centred in `area`, each in its own band sized by its share.
 * Empty lines are skipped. Returns the text layers (animated: fade and rise) and the layout.
 */
export function stack(
  ctx: TemplateContext<unknown>,
  area: Box,
  lines: Line[],
  align: 'start' | 'middle' | 'end' = 'middle',
  gap = 0.03,
): TextLayer[] {
  const used = lines.filter((l) => l.text.trim());
  if (!used.length) return [];
  const gapPx = ctx.size.height * gap;
  const lay = (l: Line, box: Box) =>
    layoutText({
      text: l.text,
      box,
      font: ctx.brand.fonts[l.weight],
      size: l.size,
      align,
      valign: 'middle',
      maxLines: l.maxLines ?? 2,
      ...(l.uppercase ? { uppercase: true } : {}),
      ...(ctx.measure ? { measure: ctx.measure } : {}),
    });
  // Natural height of each line when it has the whole area to itself; the block is centred, and
  // squeezed (lines shrink, with a warning) only when it is taller than the area.
  const natural = used.map((l) => lay(l, area).bounds.h + 0.02); // bounds are rounded to 0.01
  const total = natural.reduce((a, b) => a + b, 0) + gapPx * (used.length - 1);
  const squeeze =
    total > area.h ? (area.h - gapPx * (used.length - 1)) / (total - gapPx * (used.length - 1)) : 1;
  const heights = natural.map((h) => h * Math.min(1, squeeze));
  const blockH = heights.reduce((a, b) => a + b, 0) + gapPx * (used.length - 1);
  let y = area.y + (area.h - blockH) / 2;
  return used.map((l, i) => {
    const box = { x: area.x, y, w: area.w, h: heights[i]! };
    y += heights[i]! + gapPx;
    const font = ctx.brand.fonts[l.weight];
    const layout = lay(l, box);
    const delay = Math.round((l.delay ?? 0) * SEC);
    return {
      id: l.id,
      kind: 'text' as const,
      box: layout.bounds,
      layout,
      font,
      fill: l.color,
      text: l.text,
      ...(l.letterSpacing ? { letterSpacing: l.letterSpacing } : {}),
      animation: {
        opacity: delayed(fade(ctx.duration), delay, ctx.duration),
        translate: delayed(rise(ctx.duration, ctx.size.height * 0.025), delay, ctx.duration),
      },
    };
  });
}

/**
 * Start an animation's in-phase `delay` flicks later, holding its first value until then. Only
 * keyframes in the first half move (at most a quarter of the item), so the fade out is untouched.
 */
function delayed(a: Animatable, delay: number, duration: number): Animatable {
  if (delay <= 0 || typeof a !== 'object' || Array.isArray(a)) return a;
  const d = Math.min(delay, Math.floor(duration / 4));
  if (d <= 0) return a;
  const [first, ...rest] = a.keyframes;
  return {
    keyframes: [
      first!,
      { at: d, value: first!.value, easing: first!.easing },
      ...rest.map((k) => (k.at < duration / 2 ? { ...k, at: k.at + d } : k)),
    ],
  };
}

export const background = (ctx: TemplateContext<unknown>): string => ctx.brand.colors.background;

export function scene(ctx: TemplateContext<unknown>, layers: Layer[], overlay = false): Scene {
  return {
    size: ctx.size,
    duration: ctx.duration,
    ...(overlay ? {} : { background: background(ctx) }),
    layers,
    warnings: [],
  };
}

/** A thin accent rule centred under (or over) text, revealed with a wipe. */
export function rule(
  ctx: TemplateContext<unknown>,
  id: string,
  x: number,
  y: number,
  w: number,
  color: string,
  delay = 0.15,
): Layer {
  return {
    id,
    kind: 'rect',
    box: { x, y, w, h: Math.max(3, ctx.size.height * 0.006) },
    fill: color,
    animation: { reveal: wipe(ctx.duration, Math.round(delay * SEC)), opacity: fade(ctx.duration) },
  };
}
