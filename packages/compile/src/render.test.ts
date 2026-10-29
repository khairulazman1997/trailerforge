import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinFilters } from '@trailerforge/effects';
import { Timeline, framesToFlicks, rate } from '@trailerforge/schema';
import {
  DRAFT_ENCODE,
  compileRender,
  ffmpegArgs,
  CompileError,
  type EncodeSettings,
  type GraphicFrames,
  type SourceMedia,
} from './compile.js';

/** Plans rendered by a real FFmpeg on generated recordings: exact frames, sizes, determinism. */

const bin = (name: string) =>
  process.env.TFORGE_FFMPEG_DIR
    ? join(process.env.TFORGE_FFMPEG_DIR, process.platform === 'win32' ? `${name}.exe` : name)
    : name;
const dir = join(tmpdir(), `tforge-compile-${process.pid}`);
const R30 = rate(30);

function ff(args: string[]): Buffer {
  const r = spawnSync(bin('ffmpeg'), args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout as Buffer;
}

const RAW: EncodeSettings = {
  container: 'nut',
  threads: 1,
  video: { codec: 'rawvideo', pixFmt: 'yuv444p', args: [] },
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let ramp: SourceMedia;
let bars: SourceMedia;

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  // Each frame's grey level is twice its frame number: a decoded pixel names the frame.
  const rampPath = join(dir, 'ramp.mkv');
  if (!existsSync(rampPath))
    ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      "color=black:s=320x180:r=30:d=3,format=yuv420p,geq=lum='2*N':cb=128:cr=128",
      '-c:v', 'ffv1', rampPath]); // prettier-ignore
  const barsPath = join(dir, 'bars.mp4');
  if (!existsSync(barsPath))
    ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', barsPath]); // prettier-ignore
  const base = { width: 320, height: 180, frameRate: R30, duration: 3, hasAudio: false };
  ramp = { ...base, path: rampPath, contentHash: 'a'.repeat(64) };
  bars = { ...base, path: barsPath, contentHash: 'b'.repeat(64) };
});

function tl(items: object[], res: { width: number; height: number }, r = R30): Timeline {
  return Timeline.parse({
    id: 'tl_r',
    name: 'R',
    frameRate: r,
    resolution: res,
    tracks: [{ id: 'trk_v', kind: 'video', items }],
  });
}

/** Render a plan and decode it back to raw frames in `pix`. */
function render(
  timeline: Timeline,
  sources: Map<string, SourceMedia>,
  opt: {
    encode?: EncodeSettings;
    range?: { start: number; frames: number };
    pix?: string;
    graphics?: Map<string, GraphicFrames>;
  } = {},
) {
  const plan = compileRender({
    timeline,
    sources,
    encode: opt.encode ?? RAW,
    ...(opt.range ? { range: opt.range } : {}),
    ...(opt.graphics ? { graphics: opt.graphics } : {}),
  });
  const out = join(dir, `${plan.planHash}.${plan.encode.container}`);
  ff(ffmpegArgs(plan, out));
  const file = readFileSync(out);
  const raw = ff(['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt',
    opt.pix ?? 'yuv444p', '-']); // prettier-ignore
  return { plan, file, raw, fileHash: createHash('sha256').update(file).digest('hex') };
}

const f30 = (frames: number) => framesToFlicks(frames, R30);

describe('rendered plans', { timeout: 60_000 }, () => {
  it('starts each clip on its exact source frame, at any speed, and in a range', () => {
    const items = [
      { id: 'c1', kind: 'clip', start: 0, duration: f30(10), assetId: 'r', sourceIn: f30(15) },
      { id: 'c2', kind: 'clip', start: f30(10), duration: f30(5), assetId: 'r', sourceIn: f30(40), speed: 2 },
      { id: 'c3', kind: 'clip', start: f30(15), duration: f30(5), assetId: 'r', sourceIn: f30(86) },
    ]; // prettier-ignore
    const sources = new Map([['r', ramp]]);
    const { raw, plan } = render(tl(items, { width: 320, height: 180 }), sources);
    const px = 320 * 180;
    // Planar 4:4:4: the luma plane comes first in each frame.
    const level = (frame: number) => raw[frame * 3 * px + 90 * 320 + 160]!;
    const frames = raw.length / (3 * px);
    expect(frames).toBe(20);
    const got = Array.from({ length: frames }, (_, i) => level(i));
    // c3 asks for 5 frames from frame 86 of a 90-frame recording: the last one is held.
    const want = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 40, 42, 44, 46, 48, 86, 87, 88, 89, 89];
    // Grey 2N, ±1 for the 4:2:0 to 10-bit round trip; neighbouring frames are 2 apart.
    for (let i = 0; i < frames; i++)
      expect(Math.abs(got[i]! - 2 * want[i]!), `frame ${i}`).toBeLessThanOrEqual(1);
    expect(plan.warnings.some((w) => w.includes('c3') && w.includes('last frame held'))).toBe(true);

    const part = render(tl(items, { width: 320, height: 180 }), sources, {
      range: { start: 8, frames: 9 },
    });
    expect(part.raw.equals(raw.subarray(8 * 3 * px, 17 * 3 * px))).toBe(true);
  });

  it('gives byte-identical H.264 twice, with placeholders and rate conversion', () => {
    const R24 = rate(24);
    const f24 = (n: number) => framesToFlicks(n, R24);
    const items = [
      { id: 'c1', kind: 'clip', start: 0, duration: f24(12), assetId: 'b', sourceIn: f24(3) },
      { id: 'p1', kind: 'placeholder', start: f24(12), duration: f24(6), reason: 'missing-footage' },
      { id: 'c2', kind: 'clip', start: f24(18), duration: f24(12), assetId: 'b', sourceIn: 0 },
    ]; // prettier-ignore
    const sources = new Map([['b', bars]]);
    const enc = { ...DRAFT_ENCODE, threads: 2 };
    const a = render(tl(items, { width: 160, height: 90 }, R24), sources, { encode: enc });
    const b = render(tl(items, { width: 160, height: 90 }, R24), sources, { encode: enc });
    expect(a.raw.length).toBe(30 * 3 * 160 * 90);
    expect(b.fileHash).toBe(a.fileHash);
    const probe = spawnSync(bin('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,r_frame_rate,color_primaries,nb_frames', '-of', 'json', a.plan.planHash ? join(dir, `${a.plan.planHash}.mp4`) : '']); // prettier-ignore
    const s = JSON.parse(probe.stdout.toString()).streams[0];
    expect(s).toMatchObject({
      width: 160,
      height: 90,
      r_frame_rate: '24/1',
      color_primaries: 'bt709',
    });
    // The slate is a flat dark grey.
    const slate = a.raw[14 * 3 * 160 * 90 + 45 * 160 + 80]!;
    expect(slate).toBeGreaterThan(20);
    expect(slate).toBeLessThan(60);
  });

  it('follows a moving reframe crop in 9:16 and draws a blurred fill', () => {
    const crop = {
      keyframes: [
        { at: 0, value: [0, 0, 0.684, 0] },
        { at: f30(9), value: [0.684, 0, 0, 0] },
      ],
    };
    const items = [
      { id: 'c1', kind: 'clip', start: 0, duration: f30(10), assetId: 'b', sourceIn: 0, transform: { crop } },
      { id: 'c2', kind: 'clip', start: f30(10), duration: f30(5), assetId: 'b', sourceIn: 0,
        extensions: { core: { reframe: { mode: 'fill', background: 'blur' } } } },
    ]; // prettier-ignore
    const sources = new Map([['b', bars]]);
    const res = { width: 90, height: 160 };
    const { raw, plan } = render(tl(items, res), sources, { pix: 'rgb24' });
    const fb = 90 * 160 * 3;
    expect(raw.length).toBe(15 * fb);
    expect(plan.filtergraph).toContain(
      'crop=w=101:h=180:x=if(lt(n\\,9)\\,0+(n-0)*24.333333\\,219)',
    );
    // A static source panned left to right: first and ninth frames show different picture.
    const frame = (i: number) => raw.subarray(i * fb, (i + 1) * fb);
    expect(frame(0).equals(frame(9))).toBe(false);
    // Fill: the band above the fitted picture is blurred picture, not black.
    const top = frame(12).subarray(5 * 90 * 3, 6 * 90 * 3);
    expect(Math.max(...top)).toBeGreaterThan(40);
    expect(spawnSync(bin('ffmpeg'), ['-version']).status).toBe(0);
  });
});

describe('transitions, effects and graphics', { timeout: 120_000 }, () => {
  const RES = { width: 160, height: 90 };
  const FB = 160 * 90 * 3; // yuv444p frame
  const frames = (raw: Buffer) =>
    Array.from({ length: raw.length / FB }, (_, i) => raw.subarray(i * FB, (i + 1) * FB));
  const luma = (fr: Buffer) => fr[45 * 160 + 80]!;
  const cuts = [
    { id: 'c1', kind: 'clip', start: 0, duration: f30(12), assetId: 'r', sourceIn: f30(20) },
    { id: 'c2', kind: 'clip', start: f30(12), duration: f30(12), assetId: 'r', sourceIn: f30(60) },
    { id: 'c3', kind: 'clip', start: f30(24), duration: f30(12), assetId: 'r', sourceIn: f30(5) },
  ]; // prettier-ignore
  const withTransition = (transitionId: string, frames = 6, params = {}) =>
    Timeline.parse({
      ...tl(cuts, RES),
      tracks: [{ id: 'trk_v', kind: 'video', items: cuts, transitions: [
        { id: 'tr1', transitionId, fromItemId: 'c1', toItemId: 'c2', duration: f30(frames), params },
      ] }],
    }); // prettier-ignore

  it('a crossfade overlaps both sides of the cut with handles and keeps the length', () => {
    const sources = new Map([['r', ramp]]);
    const hard = frames(render(tl(cuts, RES), sources).raw);
    const soft = frames(render(withTransition('core/crossfade'), sources).raw);
    expect(soft).toHaveLength(36);
    // Overlap of 6 frames centred on the cut at 12: frames 9..14 blend, the rest is untouched.
    for (let i = 0; i < 36; i++) {
      if (i >= 9 && i < 15) continue;
      expect(soft[i]!.equals(hard[i]!), `frame ${i}`).toBe(true);
    }
    // Handles: at the cut both sides are mid-blend (c1 runs on to its frame 32, c2 starts at 57).
    const mid = luma(soft[12]!);
    expect(mid).toBeGreaterThan(2 * 33);
    expect(mid).toBeLessThan(2 * 60);
    // A range starting inside the overlap gives the same frames as the full render.
    const part = frames(
      render(withTransition('core/crossfade'), sources, { range: { start: 11, frames: 8 } }).raw,
    );
    part.forEach((fr, i) => expect(fr.equals(soft[11 + i]!), `range frame ${i}`).toBe(true));
  });

  it('renders every built-in transition and effect inside a timeline', () => {
    const sources = new Map([['b', bars]]);
    const reg = builtinFilters();
    for (const id of reg.ids('transition')) {
      const t = Timeline.parse({
        ...tl([], RES),
        tracks: [{ id: 'trk_v', kind: 'video', items: [
          { id: 'c1', kind: 'clip', start: 0, duration: f30(15), assetId: 'b', sourceIn: 0 },
          { id: 'c2', kind: 'clip', start: f30(15), duration: f30(15), assetId: 'b', sourceIn: f30(45) },
        ], transitions: [{ id: 'tr1', transitionId: id, fromItemId: 'c1', toItemId: 'c2', duration: f30(8) }] }],
      }); // prettier-ignore
      const { raw, plan } = render(t, sources);
      expect(raw.length, id).toBe(30 * FB);
      expect(plan.warnings, id).toEqual([]);
    }
    for (const id of reg.ids('effect')) {
      const items = [{ id: 'c1', kind: 'clip', start: 0, duration: f30(20), assetId: 'b', sourceIn: 0,
        effects: [{ id: 'e1', effectId: id }] }]; // prettier-ignore
      const plain = render(tl([{ ...items[0], effects: [] }], RES), sources).raw;
      const { raw, plan } = render(tl(items, RES), sources);
      expect(raw.length, id).toBe(20 * FB);
      expect(plan.warnings, id).toEqual([]);
      expect(raw.equals(plain), `${id} changes the picture`).toBe(false);
    }
  });

  it('a speed ramp reads exactly its source span, slowing evenly, frames blended', () => {
    const sources = new Map([['r', ramp]]);
    const items = [{ id: 'c1', kind: 'clip', start: 0, duration: f30(20), assetId: 'r', sourceIn: f30(10),
      effects: [{ id: 'e1', effectId: 'core/speed-ramp', params: { from: 1, to: 0.25 } }] }]; // prettier-ignore
    const { raw, plan } = render(tl(items, RES), sources);
    expect(plan.warnings).toEqual([]);
    expect(plan.filtergraph).toContain('framerate=fps=30/1');
    // 20 frames at a speed falling 1 → 0.25 read 20 × 0.625 = 12.5 source frames from frame 10.
    expect(plan.inputs[0]).toMatchObject({ seek: '0.316666' });
    const lv = frames(raw).map((fr) => luma(fr) / 2);
    expect(lv).toHaveLength(20);
    expect(lv[0]).toBeCloseTo(10, 0);
    expect(lv[19]!).toBeGreaterThan(21);
    expect(lv[19]!).toBeLessThan(23.5);
    for (let i = 1; i < 20; i++)
      expect(lv[i]! + 0.6, `frame ${i}`).toBeGreaterThanOrEqual(lv[i - 1]!);
    // Slowing down: the second half moves through less source than the first.
    expect(lv[19]! - lv[10]!).toBeLessThan(lv[10]! - lv[0]!);
    const flow = compileRender({ timeline: tl(items, RES), sources, retime: 'optical-flow' });
    expect(flow.filtergraph).toContain('minterpolate=fps=30/1');
    expect(flow.planHash).not.toBe(plan.planHash);
  });

  function cardFrames(name: string, count: number): GraphicFrames {
    const out = join(dir, name);
    mkdirSync(out, { recursive: true });
    if (!existsSync(join(out, 'frame_000000.png')))
      ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=red:s=80x90:r=30,format=rgba,pad=160:90:0:0:color=black@0',
        '-frames:v', String(count), join(out, 'frame_%06d.png')]); // prettier-ignore
    return { pattern: join(out, 'frame_%06d.png'), contentHash: 'c'.repeat(64), frames: count };
  }

  it('overlays a card with alpha on exactly its frames', () => {
    const t = Timeline.parse({
      ...tl([], RES),
      tracks: [
        { id: 'trk_v', kind: 'video', items: [{ id: 'c1', kind: 'clip', start: 0, duration: f30(30), assetId: 'r', sourceIn: 0 }] },
        { id: 'trk_g', kind: 'graphics', items: [{ id: 'g1', kind: 'graphic', start: f30(10), duration: f30(10), templateId: 'core/title-card' }] },
      ],
    }); // prettier-ignore
    const { raw } = render(t, new Map([['r', ramp]]), {
      pix: 'rgb24',
      graphics: new Map([['g1', cardFrames('half-red', 10)]]),
    });
    const px = (f: number, x: number) =>
      raw.subarray(f * FB + (45 * 160 + x) * 3, f * FB + (45 * 160 + x) * 3 + 3);
    const red = (b: Buffer) => b[0]! > 200 && b[1]! < 40 && b[2]! < 40;
    expect(red(px(9, 20))).toBe(false);
    expect(red(px(10, 20))).toBe(true);
    expect(red(px(19, 20))).toBe(true);
    expect(red(px(20, 20))).toBe(false);
    // The right half of the card is transparent: the picture shows through.
    expect(red(px(15, 140))).toBe(false);
  });

  it('a shot can cross into a card on another track', () => {
    const t = Timeline.parse({
      ...tl([], RES),
      tracks: [
        { id: 'trk_v', kind: 'video', items: [{ id: 'c1', kind: 'clip', start: 0, duration: f30(12), assetId: 'b', sourceIn: 0 }] },
        { id: 'trk_g', kind: 'graphics', items: [{ id: 'g1', kind: 'graphic', start: f30(12), duration: f30(12), templateId: 'core/title-card' }] },
      ],
      extensions: { core: { crossTransitions: [{ id: 'x1', transitionId: 'core/crossfade', fromItemId: 'c1', toItemId: 'g1', duration: f30(6) }] } },
    }); // prettier-ignore
    const { raw, plan } = render(t, new Map([['b', bars]]), {
      pix: 'rgb24',
      graphics: new Map([['g1', cardFrames('half-red-12', 12)]]),
    });
    expect(plan.warnings).toEqual([]);
    expect(raw.length).toBe(24 * FB);
    expect(plan.filtergraph).toContain('xfade');
    // Mid-overlap the card's red half is partly there; after it, fully; the other half is black.
    const at = (f: number, x: number) => raw[f * FB + (45 * 160 + x) * 3]!;
    expect(at(12, 20)).toBeGreaterThan(60);
    expect(at(12, 20)).toBeLessThan(at(18, 20));
    expect(at(18, 140)).toBeLessThan(20);
  });

  it('refuses a plan that would flash more than three times a second', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`, kind: 'clip', start: f30(i * 5), duration: f30(5), assetId: 'b', sourceIn: 0,
    })); // prettier-ignore
    const transitions = items.slice(1).map((it, i) => ({
      id: `t${i}`, transitionId: 'core/flash', fromItemId: items[i]!.id, toItemId: it.id, duration: f30(2),
    })); // prettier-ignore
    const t = Timeline.parse({
      ...tl([], RES),
      tracks: [{ id: 'trk_v', kind: 'video', items, transitions }],
    });
    expect(() => compileRender({ timeline: t, sources: new Map([['b', bars]]) })).toThrow(
      CompileError,
    );
  });
});

describe('clip transforms', { timeout: 120_000 }, () => {
  const RES = { width: 160, height: 90 };
  const FB = 160 * 90 * 3; // yuv444p frame: Y plane first
  const Y = (raw: Buffer, f: number, x: number, y: number) => raw[f * FB + y * 160 + x]!;
  // From source frame 60 of the ramp: flat grey, luma 120 + 2 per frame.
  const clip = (transform: object, extra: object = {}) => ({
    id: 'c1', kind: 'clip', start: 0, duration: f30(16), assetId: 'r', sourceIn: f30(60), transform, ...extra,
  }); // prettier-ignore
  const sources = () =>
    new Map([
      ['r', ramp],
      ['b', bars],
    ]);
  /** Columns of row `y` brighter than the black around the picture. */
  const lit = (raw: Buffer, f: number, y = 45) => {
    const xs = Array.from({ length: 160 }, (_, x) => x).filter((x) => Y(raw, f, x, y) > 40);
    return { left: xs[0], width: xs.length };
  };

  it('places and scales a still picture about its anchor, over black', () => {
    const { raw, plan } = render(
      tl([clip({ position: [0.25, 0.25], scale: 0.5 })], RES),
      sources(),
    );
    expect(plan.warnings).toEqual([]);
    expect(Y(raw, 3, 20, 20)).toBeGreaterThan(100); // top-left quarter: the picture
    expect(Y(raw, 3, 120, 70)).toBeLessThan(20); // elsewhere black
    expect(lit(raw, 3, 20)).toEqual({ left: 0, width: 80 });
  });

  it('moves and grows frame by frame, exactly on the keyframes and between them', () => {
    const moving = clip({
      position: {
        keyframes: [
          { at: 0, value: [0.25, 0.5] },
          { at: f30(10), value: [0.75, 0.5] },
        ],
      },
      scale: 0.5,
    });
    const a = render(tl([moving], RES), sources()).raw;
    for (const f of [0, 3, 5, 10, 14]) expect(lit(a, f).left).toBe(Math.round(8 * Math.min(f, 10)));
    const growing = clip({
      scale: {
        keyframes: [
          { at: 0, value: 0.5 },
          { at: f30(10), value: 1 },
        ],
      },
    });
    const b = render(tl([growing], RES), sources()).raw;
    for (const f of [0, 4, 10]) {
      const w = Math.round(160 * (0.5 + 0.05 * Math.min(f, 10)));
      expect(lit(b, f)).toEqual({ left: Math.round(80 - w / 2), width: w });
    }
  });

  it('fades by its opacity; at full opacity the frames are untouched', () => {
    const plain = render(tl([clip({})], RES), sources()).raw;
    const half = render(tl([clip({ opacity: 0.5 })], RES), sources()).raw;
    const mid = (f: number) => (Y(plain, f, 80, 45) + 16) / 2;
    expect(Math.abs(Y(half, 2, 80, 45) - mid(2))).toBeLessThanOrEqual(1);
    const fade = clip({
      opacity: {
        keyframes: [
          { at: 0, value: 0 },
          { at: f30(10), value: 1 },
        ],
      },
    });
    const { raw, plan } = render(tl([fade], RES), sources());
    expect(plan.filtergraph).toContain('blend=');
    expect(Y(raw, 0, 80, 45)).toBe(16);
    expect(Math.abs(Y(raw, 5, 80, 45) - mid(5))).toBeLessThanOrEqual(1);
    for (const f of [10, 15])
      expect(raw.subarray(f * FB, (f + 1) * FB).equals(plain.subarray(f * FB, (f + 1) * FB))).toBe(
        true,
      );
  });

  it('above the picture track it is transparent around the picture; a range equals the full render', () => {
    const t = Timeline.parse({
      ...tl([], RES),
      tracks: [
        { id: 'trk_v', kind: 'video', items: [{ id: 'b1', kind: 'clip', start: 0, duration: f30(16), assetId: 'b', sourceIn: 0 }] },
        { id: 'trk_v2', kind: 'video', items: [clip({
          position: { keyframes: [{ at: 0, value: [0.25, 0.5] }, { at: f30(10), value: [0.75, 0.5] }] },
          scale: 0.5,
          opacity: { keyframes: [{ at: 0, value: 0.2 }, { at: f30(8), value: 1 }] },
        })] },
      ],
    }); // prettier-ignore
    const below = render(Timeline.parse({ ...t, tracks: [t.tracks[0]] }), sources()).raw;
    const full = render(t, sources()).raw;
    // Outside the picture: the bars below (within the 10-bit blend's rounding).
    expect(Math.abs(Y(full, 3, 150, 5) - Y(below, 3, 150, 5))).toBeLessThanOrEqual(2);
    // Inside, at full opacity: the grey clip.
    expect(Y(full, 12, 100, 45)).toBe(120 + 2 * 12);
    const part = render(t, sources(), { range: { start: 4, frames: 6 } }).raw;
    expect(part.equals(full.subarray(4 * FB, 10 * FB))).toBe(true);
  });

  it('an identity transform changes nothing; rotation is warned as not rendered', () => {
    const plain = compileRender({ timeline: tl([clip({})], RES), sources: sources(), encode: RAW });
    const none = compileRender({
      timeline: tl([{ ...clip({}), transform: undefined }], RES),
      sources: sources(),
      encode: RAW,
    });
    expect(plain.planHash).toBe(none.planHash);
    const turned = compileRender({ timeline: tl([clip({ rotation: 10 })], RES), sources: sources(), encode: RAW }); // prettier-ignore
    expect(turned.warnings).toEqual(['clip "c1": rotation is not rendered']);
  });
});
