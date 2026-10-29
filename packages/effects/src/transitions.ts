import { z } from 'zod';
import { n, pad, type TransitionDef } from './contract.js';

/**
 * Transitions between two adjacent picture items. Each overlaps the end of the first input
 * with the start of the second by `ctx.duration` seconds from `ctx.offset`, through FFmpeg's
 * `xfade` (which needs both inputs at the same size, rate and pixel format; the compiler
 * arranges that), with extras where the look needs them.
 */

/** The `xfade` styles offered, all available since FFmpeg 5. */
export const XFADE_STYLES = [
  'fade',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'circleopen',
  'circleclose',
  'radial',
  'pixelize',
  'hblur',
  'fadegrays',
  'zoomin',
  'distance',
  'squeezeh',
  'squeezev',
] as const;

const xfade = (style: string, ctx: { duration: number; offset: number }) =>
  `xfade=transition=${style}:duration=${n(ctx.duration)}:offset=${n(ctx.offset)}`;

const simple = (io: { a: string; b: string; out: string }, body: string) =>
  `${pad(io.a)}${pad(io.b)}${body}${pad(io.out)}`;

const Empty = z.strictObject({});

export const crossfade: TransitionDef<Record<string, never>> = {
  id: 'core/crossfade',
  name: 'Crossfade',
  kind: 'transition',
  params: Empty,
  defaultDuration: 0.5,
  filter: (_p, ctx, io) => simple(io, xfade('fade', ctx)),
};

export const xfadeTransition: TransitionDef<{ style: (typeof XFADE_STYLES)[number] }> = {
  id: 'core/xfade',
  name: 'Shape transition',
  kind: 'transition',
  params: z.strictObject({ style: z.enum(XFADE_STYLES).default('wipeleft') }),
  defaultDuration: 0.5,
  filter: (p, ctx, io) =>
    p.style === 'squeezev' ? squeezev(ctx, io) : simple(io, xfade(p.style, ctx)),
};

/**
 * `squeezev` as `squeezeh` on pictures turned on their side: FFmpeg 8.0's own `squeezev`
 * crashes (a segfault at any size), and a squeeze is symmetric about the centre.
 */
function squeezev(
  ctx: { duration: number; offset: number },
  io: { a: string; b: string; out: string },
) {
  const [a, b] = [pad(`${io.out}_sa`), pad(`${io.out}_sb`)];
  return (
    `${pad(io.a)}transpose=clock${a};${pad(io.b)}transpose=clock${b};` +
    `${a}${b}${xfade('squeezeh', ctx)},transpose=cclock${pad(io.out)}`
  );
}

export const dip: TransitionDef<{ color: 'black' | 'white' }> = {
  id: 'core/dip',
  name: 'Dip to colour',
  kind: 'transition',
  params: z.strictObject({ color: z.enum(['black', 'white']).default('black') }),
  defaultDuration: 0.6,
  filter: (p, ctx, io) => simple(io, xfade(p.color === 'white' ? 'fadewhite' : 'fadeblack', ctx)),
  // A dip to white is a bright flash in the middle of the overlap.
  flashes: (p, ctx) => (p.color === 'white' ? [ctx.duration / 2] : []),
};

export const flash: TransitionDef<Record<string, never>> = {
  id: 'core/flash',
  name: 'Flash',
  kind: 'transition',
  params: Empty,
  defaultDuration: 0.12,
  filter: (_p, ctx, io) => simple(io, xfade('fadewhite', ctx)),
  flashes: (_p, ctx) => [ctx.duration / 2],
};

type Direction = 'left' | 'right' | 'up' | 'down';
export const whip: TransitionDef<{ direction: Direction; blur: number }> = {
  id: 'core/whip',
  name: 'Whip pan',
  kind: 'transition',
  params: z.strictObject({
    direction: z.enum(['left', 'right', 'up', 'down']).default('left'),
    /** Motion blur, as a share of the frame width (0..0.1). */
    blur: z.number().min(0).max(0.1).default(0.03),
  }),
  defaultDuration: 0.25,
  filter: (p, ctx, io) => {
    const horizontal = p.direction === 'left' || p.direction === 'right';
    const sigma = Math.max(0.5, p.blur * (horizontal ? ctx.width : ctx.height));
    const [sx, sy] = horizontal ? [sigma, 0.01] : [0.01, sigma];
    const from = ctx.offset;
    const to = ctx.offset + ctx.duration;
    return simple(
      io,
      `${xfade(`slide${p.direction}`, ctx)},gblur=sigma=${n(sx)}:sigmaV=${n(sy)}:steps=2:enable='between(t,${n(from)},${n(to)})'`,
    );
  },
};

export const zoomPunch: TransitionDef<Record<string, never>> = {
  id: 'core/zoom-punch',
  name: 'Zoom punch',
  kind: 'transition',
  params: Empty,
  defaultDuration: 0.3,
  filter: (_p, ctx, io) => simple(io, xfade('zoomin', ctx)),
};

/** Moments the glitch's colour split switches on, seconds from its start. */
function glitchOn(rate: number, duration: number): number[] {
  const out: number[] = [];
  for (let k = 0; k / rate < duration - 1e-9; k++) out.push(k / rate);
  return out;
}

export const glitch: TransitionDef<{ rate: number; shift: number }> = {
  id: 'core/glitch',
  name: 'Glitch',
  kind: 'transition',
  params: z.strictObject({
    /** Flickers per second; above 3 the photosensitivity guard refuses it. */
    rate: z.number().min(0.5).max(12).default(2),
    /** Colour split, share of the frame width (0..0.05). */
    shift: z.number().min(0).max(0.05).default(0.015),
  }),
  defaultDuration: 0.4,
  filter: (p, ctx, io) => {
    const px = Math.max(1, Math.round(p.shift * ctx.width));
    const from = ctx.offset;
    const to = ctx.offset + ctx.duration;
    // On for the first half of each flicker period, during the overlap only.
    const on = `between(t,${n(from)},${n(to)})*lt(mod((t-${n(from)})*${n(p.rate)},1),0.5)`;
    return simple(io, `${xfade('pixelize', ctx)},rgbashift=rh=${px}:bh=${-px}:enable='${on}'`);
  },
  flashes: (p, ctx) => glitchOn(p.rate, ctx.duration),
};

export const builtinTransitions = [
  crossfade,
  xfadeTransition,
  dip,
  flash,
  whip,
  zoomPunch,
  glitch,
] as unknown as readonly TransitionDef<never>[];
