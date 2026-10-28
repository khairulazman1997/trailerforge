import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkParams, type EffectDef, type TransitionDef } from './contract.js';
import { builtinEffects } from './effects.js';
import { builtinFilters } from './registry.js';
import { XFADE_STYLES, builtinTransitions } from './transitions.js';

/**
 * Every effect and transition through a real FFmpeg on generated test pictures: the graph must
 * run, change the picture, and give the same frames (by hash) every time.
 */

const FFMPEG = process.env.TFORGE_FFMPEG_DIR
  ? join(process.env.TFORGE_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  : 'ffmpeg';
const W = 160;
const H = 90;
const RATE = { num: 24, den: 1 };
const SECS = 1.5;
const src = (pattern: string) => ['-f', 'lavfi', '-i', `${pattern}=s=${W}x${H}:r=24:d=${SECS}`];

function run(inputs: string[], graph: string, out: string): { hash: string; frames: number } {
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      ...inputs,
      '-filter_complex',
      graph,
      '-map',
      `[${out}]`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${graph}\n${r.stderr.toString()}`);
  const bytes = r.stdout as Buffer;
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    frames: bytes.length / (W * H * 3),
  };
}

const ctx = { width: W, height: H, rate: RATE, duration: SECS };
const effectGraph = (def: EffectDef<never>, params: unknown) => {
  const p = checkParams(def as unknown as EffectDef<unknown>, params);
  // Speed changes read only the source they need.
  const need = (def as unknown as EffectDef<unknown>).sourceSeconds?.(p, SECS);
  const trim = need ? `trim=duration=${need},setpts=PTS-STARTPTS,` : '';
  return graphFor(def, p, trim);
};
const graphFor = (def: EffectDef<never>, params: unknown, trim: string) =>
  `[0:v]${trim}format=yuv420p,settb=AVTB[in];${(def.filter as EffectDef<unknown>['filter'])(params, ctx, { in: 'in', out: 'out' })}`;
const transitionGraph = (def: TransitionDef<never>, params: unknown, duration = 0.5) =>
  `[0:v]format=yuv420p,settb=AVTB[a];[1:v]format=yuv420p,settb=AVTB[b];${(def.filter as TransitionDef<unknown>['filter'])(checkParams(def as unknown as TransitionDef<unknown>, params), { ...ctx, duration, offset: 0.6 }, { a: 'a', b: 'b', out: 'out' })}`;

const plain = run(src('testsrc2'), '[0:v]format=yuv420p,settb=AVTB[out]', 'out');
const cut = run(
  [...src('testsrc2'), ...src('smptebars')],
  '[0:v]format=yuv420p,settb=AVTB[a];[1:v]format=yuv420p,settb=AVTB[b];[a][b]concat=n=2:v=1:a=0[out]',
  'out',
);

describe('effects through FFmpeg', () => {
  for (const def of builtinEffects) {
    it(`${def.id}: runs, changes the picture, and is deterministic`, () => {
      const a = run(src('testsrc2'), effectGraph(def, {}), 'out');
      const b = run(src('testsrc2'), effectGraph(def, {}), 'out');
      expect(b.hash).toBe(a.hash);
      expect(a.hash).not.toBe(plain.hash);
      // A slowed-down item ends within one source frame (four output frames at quarter speed).
      expect(Math.abs(a.frames - plain.frames)).toBeLessThanOrEqual(
        def.id === 'core/speed-ramp' ? 4 : 0,
      );
    });
  }

  it('a speed ramp fills its length from the source it asks for', () => {
    const ramp = builtinFilters().get('core/speed-ramp')! as unknown as EffectDef<{
      from: number;
      to: number;
    }>;
    const p = checkParams(ramp, {});
    const need = ramp.sourceSeconds!(p, SECS); // normal speed down to a quarter: 0.94 s of source
    expect(need).toBeCloseTo(0.9375, 9);
    const graph = `[0:v]trim=duration=${need},setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[in];${ramp.filter(p, ctx, { in: 'in', out: 'out' })}`;
    const out = run(src('testsrc2'), graph, 'out');
    expect(Math.abs(out.frames - SECS * 24)).toBeLessThanOrEqual(4);
    expect(run(src('testsrc2'), graph, 'out').hash).toBe(out.hash);
  });

  it('effects with nothing to do leave the picture alone', () => {
    const letterbox = builtinFilters().get('core/letterbox')! as EffectDef<never>;
    expect(run(src('testsrc2'), effectGraph(letterbox, { aspect: W / H }), 'out').hash).toBe(
      plain.hash,
    );
    const ramp = builtinFilters().get('core/speed-ramp')! as EffectDef<never>;
    expect(run(src('testsrc2'), effectGraph(ramp, { from: 1, to: 1 }), 'out').hash).toBe(
      plain.hash,
    );
  });

  it('two effects can share one graph', () => {
    const r = builtinFilters();
    const g = (id: string) => r.get(id) as unknown as EffectDef<unknown>;
    const graph = `[0:v]format=yuv420p,settb=AVTB[v0];${g('core/glow').filter(checkParams(g('core/glow'), {}), ctx, { in: 'v0', out: 'v1' })};${g('core/light-leak').filter(checkParams(g('core/light-leak'), {}), ctx, { in: 'v1', out: 'v2' })};${g('core/glow').filter(checkParams(g('core/glow'), {}), ctx, { in: 'v2', out: 'v3' })}`;
    expect(run(src('testsrc2'), graph, 'v3').frames).toBe(plain.frames);
  });
});

describe('transitions through FFmpeg', () => {
  for (const def of builtinTransitions) {
    it(`${def.id}: runs, blends the two inputs, and is deterministic`, () => {
      const a = run([...src('testsrc2'), ...src('smptebars')], transitionGraph(def, {}), 'out');
      const b = run([...src('testsrc2'), ...src('smptebars')], transitionGraph(def, {}), 'out');
      expect(b.hash).toBe(a.hash);
      expect(a.hash).not.toBe(cut.hash);
      // xfade overlaps: 1.5 s + 1.5 s − 0.5 s from an offset of 0.6 s = 0.6 + 1.5 s.
      expect(Math.abs(a.frames - (0.6 + SECS) * 24)).toBeLessThanOrEqual(1);
    });
  }

  it('every xfade style runs', () => {
    const def = builtinFilters().get('core/xfade') as TransitionDef<never>;
    const hashes = new Set<string>();
    for (const style of XFADE_STYLES)
      hashes.add(
        run([...src('testsrc2'), ...src('smptebars')], transitionGraph(def, { style }), 'out').hash,
      );
    expect(hashes.size).toBe(XFADE_STYLES.length);
  });

  it('refuses parameters outside their range', () => {
    const def = builtinFilters().get('core/glitch') as TransitionDef<never>;
    expect(() => transitionGraph(def, { rate: 50 })).toThrow(/core\/glitch/);
    expect(() => transitionGraph(def, { colour: 'red' })).toThrow();
  });
});
