import type { Rate } from '@trailerforge/schema';
import type { z } from 'zod';

/**
 * Transitions and finishing effects as FFmpeg filtergraph fragments. Each definition has a
 * Zod param schema (checked before use), builds a fragment between the labels the render
 * compiler gives it, and says when it flashes so the photosensitivity guard can check the cut.
 * Fragments must be deterministic: no wall clock, fixed seeds for noise.
 */

export interface FilterContext {
  width: number;
  height: number;
  rate: Rate;
  /** Length of the effect (or of the transition overlap), seconds. */
  duration: number;
  /**
   * How a speed change makes frames at the output rate: repeat/drop the nearest (default),
   * blend neighbouring frames, or motion-interpolate (optical flow; slow).
   */
  retime?: 'drop' | 'blend' | 'optical-flow';
}

/** The filter that brings retimed frames to the output rate, per `FilterContext.retime`. */
export function retimeFilter(ctx: FilterContext): string {
  const rate = `${ctx.rate.num}/${ctx.rate.den}`;
  switch (ctx.retime ?? 'drop') {
    case 'blend':
      return `framerate=fps=${rate}:interp_start=0:interp_end=255:scene=100`;
    case 'optical-flow':
      return `minterpolate=fps=${rate}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none`;
    default:
      return `fps=${rate}`;
  }
}

export interface TransitionContext extends FilterContext {
  /** Where the overlap starts in the first input's timeline, seconds. */
  offset: number;
}

/** Labels without brackets, e.g. `{ in: 'v0', out: 'v0fx' }`. */
export interface EffectIo {
  in: string;
  out: string;
}

export interface TransitionIo {
  a: string;
  b: string;
  out: string;
}

interface DefBase<P> {
  /** Plugin-qualified id, e.g. `core/vignette`. */
  id: string;
  name: string;
  params: z.ZodType<P>;
  /** Moments it flashes, seconds from its start (for the flash-rate guard). */
  flashes?: (params: P, ctx: FilterContext) => number[];
}

export interface EffectDef<P = unknown> extends DefBase<P> {
  kind: 'effect';
  filter(params: P, ctx: FilterContext, io: EffectIo): string;
  /** Source seconds needed for `ctx.duration` of output, when it is not the same (speed changes). */
  sourceSeconds?: (params: P, outSeconds: number) => number;
}

export interface TransitionDef<P = unknown> extends DefBase<P> {
  kind: 'transition';
  /** Default overlap, seconds. */
  defaultDuration: number;
  filter(params: P, ctx: TransitionContext, io: TransitionIo): string;
}

export type FilterDef = EffectDef<never> | TransitionDef<never>;

export class EffectParamsError extends Error {
  constructor(
    readonly effectId: string,
    message: string,
  ) {
    super(message);
    this.name = 'EffectParamsError';
  }
}

/** Check params against the definition's schema; returns them with defaults filled in. */
export function checkParams<P>(def: { id: string; params: z.ZodType<P> }, params: unknown): P {
  const r = def.params.safeParse(params ?? {});
  if (!r.success)
    throw new EffectParamsError(
      def.id,
      `${def.id}: ${r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
    );
  return r.data;
}

/** A number as FFmpeg reads it: at most 6 decimals, no exponent, no `-0`. */
export function n(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** A label as a pad reference. */
export const pad = (label: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(label)) throw new Error(`bad filter label "${label}"`);
  return `[${label}]`;
};
