import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Timeline, framesToFlicks, rate } from '@trailerforge/schema';
import { compileRender, ffmpegArgs, type EncodeSettings, type SourceMedia } from './compile.js';

/** Images on the timeline, rendered by a real FFmpeg on generated pictures. */

const bin = (name: string) =>
  process.env.TFORGE_FFMPEG_DIR
    ? join(process.env.TFORGE_FFMPEG_DIR, process.platform === 'win32' ? `${name}.exe` : name)
    : name;
const dir = join(tmpdir(), `tforge-stills-${process.pid}`);
const R30 = rate(30);
const f = (frames: number) => framesToFlicks(frames, R30);

function ff(args: string[]): Buffer {
  const r = spawnSync(bin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout as Buffer;
}
const RAW: EncodeSettings = {
  container: 'nut',
  threads: 1,
  video: { codec: 'rawvideo', pixFmt: 'yuv444p', args: [] },
};

let wide: SourceMedia; // 1280×720, grey level rises left to right
let tall: SourceMedia; // 720×1280, grey level rises top to bottom
let clipSrc: SourceMedia;
beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  const gradient = (name: string, s: string, expr: string) => {
    const out = join(dir, name);
    if (!existsSync(out))
      ff(['-f', 'lavfi', '-i', `color=black:s=${s}:r=1:d=1,format=gray,geq=lum='${expr}'`, '-frames:v', '1', out]); // prettier-ignore
    return out;
  };
  const base = { frameRate: R30, duration: 3600, hasAudio: false, still: true };
  wide = { ...base, path: gradient('wide.png', '1280x720', '255*X/W'), contentHash: 'a'.repeat(64), width: 1280, height: 720 }; // prettier-ignore
  tall = { ...base, path: gradient('tall.png', '720x1280', '255*Y/H'), contentHash: 'b'.repeat(64), width: 720, height: 1280 }; // prettier-ignore
  const clipPath = join(dir, 'clip.mp4');
  if (!existsSync(clipPath))
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clipPath]); // prettier-ignore
  clipSrc = { path: clipPath, contentHash: 'c'.repeat(64), width: 320, height: 180, frameRate: R30, duration: 2, hasAudio: false }; // prettier-ignore
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const timeline = (items: object[], W = 360, H = 640, transitions: object[] = []) =>
  Timeline.parse({
    id: 'tl_s',
    name: 'S',
    frameRate: R30,
    resolution: { width: W, height: H },
    tracks: [{ id: 'trk_v', kind: 'video', items, transitions }],
  });
const still = (id: string, start: number, frames: number, extra: object = {}) => ({
  id,
  kind: 'clip',
  assetId: 'img',
  start: f(start),
  duration: f(frames),
  sourceIn: 0,
  ...extra,
});
const keys = (...ks: [number, number | number[]][]) => ({
  keyframes: ks.map(([frames, value]) => ({ at: f(frames), value })),
});

function render(
  tlm: Timeline,
  sources: Map<string, SourceMedia>,
  range?: { start: number; frames: number },
) {
  const plan = compileRender({ timeline: tlm, sources, encode: RAW, ...(range ? { range } : {}) });
  const out = join(dir, `${plan.planHash}.nut`);
  ff(ffmpegArgs(plan, out).slice(5)); // ff() adds the leading -hide_banner -nostdin -y -loglevel error
  const raw = ff(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-']);
  const [W, H] = [plan.width, plan.height];
  const frames = raw.length / (3 * W * H);
  return {
    plan,
    raw,
    frames,
    /** Luma at (x, y) of a frame. */
    luma: (n: number, x: number, y: number) => raw[n * 3 * W * H + y * W + x]!,
    frame: (n: number) =>
      createHash('sha256')
        .update(raw.subarray(n * 3 * W * H, (n + 1) * 3 * W * H))
        .digest('hex'),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
}
const limited = (v: number) => 16 + (219 * v) / 255; // full-range grey → BT.709 limited luma
const near = (got: number, want: number, tol = 3) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tol); // prettier-ignore

describe('an image on the timeline', { timeout: 60_000 }, () => {
  it('covers a vertical frame from a wide picture: the centre window, exactly the clip’s length', () => {
    const r = render(timeline([still('s1', 0, 12)]), new Map([['img', wide]]));
    expect(r.frames).toBe(12);
    expect(r.plan.warnings).toEqual([]);
    // The 9:16 window is 405 px wide, centred: grey ≈ 437/1280 on the left, 842/1280 on the right.
    near(r.luma(0, 2, 320), limited((437 / 1280) * 255), 4);
    near(r.luma(0, 357, 320), limited((842 / 1280) * 255), 4);
    // Still: every frame is the same picture.
    expect(new Set(Array.from({ length: 12 }, (_, i) => r.frame(i))).size).toBe(1);
  });

  it('covers a wide frame from a tall picture, and fills the frame when shapes already match', () => {
    const r = render(timeline([still('s1', 0, 3)], 640, 360), new Map([['img', tall]]));
    // Centre window of a 720×1280 picture in 16:9 is 720×405 around y = 437..842 of 1280.
    near(r.luma(0, 320, 2), limited((437 / 1280) * 255), 4);
    near(r.luma(0, 320, 357), limited((842 / 1280) * 255), 4);
    const same = render(timeline([still('s1', 0, 3)], 640, 360), new Map([['img', wide]]));
    near(same.luma(0, 2, 180), limited(0), 3);
    near(same.luma(0, 637, 180), limited(255), 4);
  });

  it('follows the focus point when the picture is cropped', () => {
    const left = render(
      timeline([
        still('s1', 0, 3, { extensions: { core: { still: { focus: { x: 0, y: 0.5 } } } } }),
      ]),
      new Map([['img', wide]]),
    );
    near(left.luma(0, 2, 320), limited(0), 3); // window at the picture's left edge
    near(left.luma(0, 357, 320), limited((405 / 1280) * 255), 4);
  });

  it('a push-in keyframed on scale moves frame by frame, ends where it says, and is sharp-edged', () => {
    const item = still('s1', 0, 30, {
      transform: { scale: keys([0, 1], [30, 1.25]) },
    });
    const r = render(timeline([item]), new Map([['img', wide]]));
    expect(r.frames).toBe(30);
    // Zooming about the centre: the left edge moves right, steadily, and never shows black.
    const left = Array.from({ length: 30 }, (_, i) => r.luma(i, 1, 320));
    for (let i = 1; i < 30; i++) expect(left[i]!).toBeGreaterThanOrEqual(left[i - 1]!);
    expect(left[29]! - left[0]!).toBeGreaterThanOrEqual(5);
    near(r.luma(0, 1, 320), limited((437 / 1280) * 255), 4);
    for (let i = 0; i < 30; i++) expect(r.luma(i, 0, 5)).toBeGreaterThan(40);
  });

  it('a pan stays inside the picture, and a range renders exactly the same frames', () => {
    const item = still('s1', 0, 30, {
      transform: { scale: 1.2, position: keys([0, [0.6, 0.5]], [30, [0.4, 0.5]]) },
    });
    const src = new Map([['img', wide]]);
    const full = render(timeline([item]), src);
    const first = full.luma(0, 1, 320);
    const last = full.luma(29, 1, 320);
    expect(Math.abs(last - first)).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 30; i++) {
      expect(full.luma(i, 0, 5)).toBeGreaterThan(40);
      expect(full.luma(i, 359, 5)).toBeGreaterThan(40);
    }
    const part = render(timeline([item]), src, { start: 9, frames: 12 });
    expect(part.frames).toBe(12);
    for (let i = 0; i < 12; i++) expect(part.frame(i)).toBe(full.frame(9 + i));
    expect(render(timeline([item]), src).hash).toBe(full.hash);
  });

  it('works with a transition into a recording, in a full render and in a range', () => {
    const items = [
      still('s1', 0, 20, { transform: { scale: keys([0, 1], [20, 1.1]) } }),
      { id: 'c1', kind: 'clip', assetId: 'vid', start: f(20), duration: f(20), sourceIn: 0 },
    ];
    const transitions = [
      {
        id: 'tr1',
        transitionId: 'core/crossfade',
        fromItemId: 's1',
        toItemId: 'c1',
        duration: f(6),
      },
    ];
    const src = new Map([
      ['img', wide],
      ['vid', clipSrc],
    ]);
    const full = render(timeline(items, 360, 640, transitions), src);
    expect(full.frames).toBe(40);
    const part = render(timeline(items, 360, 640, transitions), src, { start: 14, frames: 10 });
    for (let i = 0; i < 10; i++) expect(part.frame(i)).toBe(full.frame(14 + i));
  });

  it('fill mode keeps the whole picture over a blurred copy', () => {
    const r = render(
      timeline([still('s1', 0, 3, { extensions: { core: { reframe: { mode: 'fill' } } } })]),
      new Map([['img', wide]]),
    );
    expect(r.frames).toBe(3);
    // The whole width of the picture is inside the frame: darkest to the left, brightest right,
    // at the middle height, with the blurred copy above it.
    near(r.luma(0, 2, 320), limited(0), 8);
    near(r.luma(0, 357, 320), limited(255), 8);
  });

  it('says what does not apply to an image, and draws a slate when it has no size', () => {
    const item = still('s1', 0, 6, {
      sourceIn: f(5),
      effects: [{ id: 'e1', effectId: 'core/speed-ramp', params: {} }],
    });
    const r = render(timeline([item]), new Map([['img', wide]]));
    expect(r.frames).toBe(6);
    expect(r.plan.warnings.join('\n')).toMatch(/an image has no source time/);
    expect(r.plan.warnings.join('\n')).toMatch(/a speed change does not apply to an image/);
    const blank = render(timeline([still('s1', 0, 6)]), new Map([['img', { ...wide, width: 0, height: 0 }]])); // prettier-ignore
    expect(blank.plan.warnings.join('\n')).toMatch(/the image has no size/);
    expect(blank.frames).toBe(6);
  });

  it('hashes the plan without the path, so moving the picture keeps the render', () => {
    const a = compileRender({ timeline: timeline([still('s1', 0, 6)]), sources: new Map([['img', wide]]) }); // prettier-ignore
    const b = compileRender({ timeline: timeline([still('s1', 0, 6)]), sources: new Map([['img', { ...wide, path: '/elsewhere/wide.png' }]]) }); // prettier-ignore
    const c = compileRender({ timeline: timeline([still('s1', 0, 6)]), sources: new Map([['img', { ...wide, contentHash: 'd'.repeat(64) }]]) }); // prettier-ignore
    expect(a.planHash).toBe(b.planHash);
    expect(a.planHash).not.toBe(c.planHash);
  });
});
