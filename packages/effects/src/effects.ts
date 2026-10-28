import { z } from 'zod';
import { n, pad, type EffectDef } from './contract.js';

/**
 * Finishing effects on one picture item (or a whole timeline). Each builds a fragment from
 * `[in]` to `[out]`; internal labels are prefixed with the output label so several instances
 * can share one graph. `t` in expressions is seconds from the item's start.
 */

const chain = (io: { in: string; out: string }, body: string) =>
  `${pad(io.in)}${body}${pad(io.out)}`;

export const grain: EffectDef<{ strength: number }> = {
  id: 'core/grain',
  name: 'Film grain',
  kind: 'effect',
  params: z.strictObject({ strength: z.number().min(0).max(60).default(12) }),
  // A fixed seed: the same grain every render.
  filter: (p, _ctx, io) => chain(io, `noise=alls=${n(p.strength)}:allf=t+u:all_seed=20251028`),
};

export const vignette: EffectDef<{ strength: number }> = {
  id: 'core/vignette',
  name: 'Vignette',
  kind: 'effect',
  params: z.strictObject({ strength: z.number().min(0).max(1).default(0.5) }),
  filter: (p, _ctx, io) => chain(io, `vignette=angle=${n(0.15 + 0.65 * p.strength)}:eval=init`),
};

export const impactShake: EffectDef<{ intensity: number; decay: number }> = {
  id: 'core/impact-shake',
  name: 'Impact shake',
  kind: 'effect',
  params: z.strictObject({
    /** Largest offset, share of the frame (0..0.06). */
    intensity: z.number().min(0).max(0.06).default(0.02),
    /** Seconds for the shake to die down to a third. */
    decay: z.number().min(0.05).max(3).default(0.35),
  }),
  filter: (p, ctx, io) => {
    const a = p.intensity;
    const k = 1 / p.decay;
    // Crop a little inside the frame and move the window; scale back to full size.
    return chain(
      io,
      `crop=w=iw*${n(1 - 2 * a)}:h=ih*${n(1 - 2 * a)}:x='iw*${n(a)}*(1+sin(t*53)*exp(-t*${n(k)}))':y='ih*${n(a)}*(1+cos(t*47)*exp(-t*${n(k)}))',scale=${ctx.width}:${ctx.height}:flags=bicubic`,
    );
  },
};

export const lightLeak: EffectDef<{ strength: number; color: string }> = {
  id: 'core/light-leak',
  name: 'Light leak',
  kind: 'effect',
  params: z.strictObject({
    strength: z.number().min(0).max(1).default(0.6),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#ff8a3c'),
  }),
  filter: (p, ctx, io) => {
    const c = parseInt(p.color.slice(1), 16);
    const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    const d = Math.max(0.04, ctx.duration);
    // A soft warm blob drifting across the frame, added with a screen blend.
    const blob = `exp(-(pow(X-W*(0.1+0.8*T/${n(d)}),2)+pow(Y-H*0.35,2))/(2*pow(W*0.28,2)))`;
    const L = `${io.out}_lk`;
    return [
      `${pad(io.in)}format=gbrp${pad(`${L}i`)}`,
      `color=c=black:s=${ctx.width}x${ctx.height}:r=${ctx.rate.num}/${ctx.rate.den}:d=${n(d)},format=gbrp,geq=r='${r}*${blob}':g='${g}*${blob}':b='${b}*${blob}'${pad(`${L}g`)}`,
      `${pad(`${L}i`)}${pad(`${L}g`)}blend=all_mode=screen:all_opacity=${n(p.strength)}:shortest=1,format=yuv420p${pad(io.out)}`,
    ].join(';');
  },
};

export const letterbox: EffectDef<{ aspect: number }> = {
  id: 'core/letterbox',
  name: 'Letterbox',
  kind: 'effect',
  params: z.strictObject({ aspect: z.number().min(1).max(4).default(2.39) }),
  filter: (p, ctx, io) => {
    const bar = Math.max(0, Math.round((ctx.height - ctx.width / p.aspect) / 2));
    if (bar === 0) return chain(io, 'null');
    return chain(
      io,
      `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`,
    );
  },
};

export const glow: EffectDef<{ strength: number; radius: number }> = {
  id: 'core/glow',
  name: 'Glow',
  kind: 'effect',
  params: z.strictObject({
    strength: z.number().min(0).max(1).default(0.35),
    /** Blur radius, share of the frame height. */
    radius: z.number().min(0.002).max(0.1).default(0.02),
  }),
  filter: (p, ctx, io) => {
    const L = `${io.out}_gl`;
    return [
      `${pad(io.in)}format=gbrp,split${pad(`${L}a`)}${pad(`${L}b`)}`,
      `${pad(`${L}b`)}gblur=sigma=${n(p.radius * ctx.height)}${pad(`${L}c`)}`,
      `${pad(`${L}a`)}${pad(`${L}c`)}blend=all_mode=screen:all_opacity=${n(p.strength)},format=yuv420p${pad(io.out)}`,
    ].join(';');
  },
};

export const speedRamp: EffectDef<{ from: number; to: number }> = {
  id: 'core/speed-ramp',
  name: 'Speed ramp',
  kind: 'effect',
  params: z.strictObject({
    /** Speed at the start and end of the item (1 = normal, 0.25 = quarter speed). */
    from: z.number().min(0.1).max(4).default(1),
    to: z.number().min(0.1).max(4).default(0.25),
  }),
  // Speed changes evenly over the item, so the source used is the average speed × length.
  sourceSeconds: (p, out) => (out * (p.from + p.to)) / 2,
  filter: (p, ctx, io) => {
    const d = Math.max(0.04, ctx.duration);
    const rate = `${ctx.rate.num}/${ctx.rate.den}`;
    if (Math.abs(p.to - p.from) < 1e-6)
      return chain(io, `setpts=(PTS-STARTPTS)/${n(p.from)},fps=${rate}`);
    // Source time s(t) = from·t + (to−from)·t²/(2d); invert for the output time of source T.
    const k = (p.to - p.from) / d;
    const t = `(-${n(p.from)}+sqrt(${n(p.from * p.from)}+2*${n(k)}*(T-STARTT)))/${n(k)}`;
    return chain(io, `setpts='(${t})/TB',fps=${rate}`);
  },
};

export const builtinEffects = [
  grain,
  vignette,
  impactShake,
  lightLeak,
  letterbox,
  glow,
  speedRamp,
] as unknown as readonly EffectDef<never>[];
