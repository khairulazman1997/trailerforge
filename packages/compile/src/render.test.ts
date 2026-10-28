import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Timeline, framesToFlicks, rate } from '@trailerforge/schema';
import {
  DRAFT_ENCODE,
  compileRender,
  ffmpegArgs,
  type EncodeSettings,
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
  opt: { encode?: EncodeSettings; range?: { start: number; frames: number }; pix?: string } = {},
) {
  const plan = compileRender({
    timeline,
    sources,
    encode: opt.encode ?? RAW,
    ...(opt.range ? { range: opt.range } : {}),
  });
  const out = join(dir, `${plan.planHash}.${plan.encode.container}`);
  ff(ffmpegArgs(plan, out));
  const file = readFileSync(out);
  const raw = ff(['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt',
    opt.pix ?? 'yuv444p', '-']); // prettier-ignore
  return { plan, file, raw, fileHash: createHash('sha256').update(file).digest('hex') };
}

const f30 = (frames: number) => framesToFlicks(frames, R30);

describe('rendered plans', () => {
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
