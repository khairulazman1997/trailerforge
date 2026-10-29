import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureLoudness } from '@trailerforge/media';
import { Timeline, framesToFlicks, rate, secondsToFlicks } from '@trailerforge/schema';
import {
  clipAudioOf,
  compileAudio,
  ffmpegAudioArgs,
  masterFor,
  type MasterSettings,
} from './audio.js';
import type { SourceMedia } from './compile.js';

/** Mixes rendered by a real FFmpeg: sample-exact placement, ducks, clip audio, loudness. */

const FF = process.env.TFORGE_FFMPEG_DIR
  ? join(process.env.TFORGE_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  : 'ffmpeg';
const dir = join(tmpdir(), `tforge-audio-${process.pid}`);
const R30 = rate(30);
const s = secondsToFlicks;

function ff(args: string[]): Buffer {
  const r = spawnSync(FF, args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout as Buffer;
}

const base = { width: 320, height: 180, frameRate: R30, variableFrameRate: false };
let music: SourceMedia;
let sfx: SourceMedia;
let clip: SourceMedia;

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  const make = (name: string, args: string[]) => {
    const out = join(dir, name);
    if (!existsSync(out)) ff(['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
    return out;
  };
  const m = make('music.wav', [
    '-f',
    'lavfi',
    '-i',
    'sine=f=220:r=48000:d=4',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
  ]);
  const x = make('sfx.wav', [
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=0.3:a=0.9:seed=7:r=48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
  ]);
  const c = make('clip.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-f', 'lavfi', '-i',
    'sine=f=880:r=48000:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', '-shortest']); // prettier-ignore
  music = { ...base, path: m, contentHash: '1'.repeat(64), duration: 4, hasAudio: true };
  sfx = { ...base, path: x, contentHash: '2'.repeat(64), duration: 0.3, hasAudio: true };
  clip = { ...base, path: c, contentHash: '3'.repeat(64), duration: 3, hasAudio: true };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tl(tracks: object[]): Timeline {
  return Timeline.parse({
    id: 'tl_a',
    name: 'A',
    frameRate: R30,
    resolution: { width: 320, height: 180 },
    tracks,
  });
}
const audioTrack = (id: string, items: object[]) => ({ id, kind: 'audio', items });
const aclip = (id: string, assetId: string, start: number, duration: number, extra = {}) => ({
  id,
  kind: 'clip',
  start,
  duration,
  assetId,
  sourceIn: 0,
  ...extra,
});

function mix(timeline: Timeline, sources: Map<string, SourceMedia>, master?: MasterSettings) {
  const plan = compileAudio({ timeline, sources, ...(master ? { master } : {}) });
  const out = join(dir, `${plan.planHash}.wav`);
  ff(ffmpegAudioArgs(plan, out));
  const pcm = ff(['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'f32le', '-ac', '1', '-']);
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  return { plan, out, samples, hash: createHash('sha256').update(readFileSync(out)).digest('hex') };
}

const firstSound = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-5);
const peak = (x: Float32Array, from: number, to: number) =>
  x.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rmsDb = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) sum += x[i]! ** 2;
  return 10 * Math.log10(sum / Math.round((to - from) * 48000));
};

describe('audio mix', { timeout: 60_000 }, () => {
  it('places sounds on the exact sample and keeps the length', () => {
    const at = framesToFlicks(31, R30); // 31 frames = 49600 samples
    const t = tl([audioTrack('trk_sfx', [aclip('x1', 'x', at, s(0.3))]), {
      id: 'trk_v', kind: 'video', items: [{ id: 'v', kind: 'placeholder', start: 0, duration: s(2), reason: 'missing-footage' }],
    }]); // prettier-ignore
    const { samples, plan } = mix(t, new Map([['x', sfx]]));
    expect(plan.samples).toBe(96000);
    expect(samples.length).toBe(96000);
    expect(firstSound(samples)).toBe(49600);
  });

  it('follows the gain keyframes (ducks and fades) within a block', () => {
    const gainDb = {
      keyframes: [
        { at: s(1), value: 0 },
        { at: s(1.05), value: -12 },
        { at: s(1.5), value: -12 },
        { at: s(1.55), value: 0 },
        { at: s(3.5), value: 0 },
        { at: s(4), value: -60 },
      ],
    };
    const t = tl([audioTrack('trk_m', [aclip('m', 'm', 0, s(4), { gainDb })])]);
    const { samples } = mix(t, new Map([['m', music]]));
    const full = rmsDb(samples, 0.5, 0.9);
    expect(rmsDb(samples, 1.1, 1.4) - full).toBeCloseTo(-12, 0);
    // Mid-ramp (1.02-1.03 s) the gain is near -6 dB.
    expect(Math.abs(rmsDb(samples, 1.02, 1.03) - full + 6)).toBeLessThan(1.2);
    expect(rmsDb(samples, 1.6, 2.0) - full).toBeCloseTo(0, 0);
    expect(rmsDb(samples, 3.9, 3.99) - full).toBeLessThan(-40);
  });

  it('leaves clip audio out unless the clip turns it on, with a J-cut lead', () => {
    const v = (extensions = {}) =>
      tl([{ id: 'trk_v', kind: 'video', items: [aclip('c', 'c', s(1), s(1), { sourceIn: s(1), extensions })] }]); // prettier-ignore
    const sources = new Map([['c', clip]]);
    const off = mix(v(), sources);
    expect(firstSound(off.samples)).toBe(-1);
    const on = mix(
      v({ core: { clipAudio: { enabled: true, lead: s(0.25), lag: s(0.5) } } }),
      sources,
    );
    // Sound from 0.75 s (a quarter second before the picture), on past its end. The tone crosses
    // zero exactly there (880 Hz at source 0.75 s), and FFmpeg builds differ on whether that first
    // sample is 0 or a hair off, so check silence before it and sound by the next sample.
    expect(peak(on.samples, 0, 36000)).toBeLessThan(1e-5);
    expect(peak(on.samples, 36000, 36002)).toBeGreaterThan(0.005);
    expect(on.plan.samples).toBe(96000);
    expect(rmsDb(on.samples, 1.9, 1.99)).toBeGreaterThan(-30);
  });

  it('is byte-identical twice, and its hash ignores paths', () => {
    const t = tl([
      audioTrack('trk_m', [aclip('m', 'm', 0, s(3))]),
      audioTrack('trk_sfx', [aclip('x1', 'x', s(1), s(0.3))]),
    ]);
    const sources = new Map([
      ['m', music],
      ['x', sfx],
    ]);
    const a = mix(t, sources);
    const b = mix(t, sources);
    expect(b.hash).toBe(a.hash);
    const moved = new Map([...sources].map(([k, v]) => [k, { ...v, path: `${v.path}.moved` }]));
    expect(compileAudio({ timeline: t, sources: moved }).planHash).toBe(a.plan.planHash);
  });

  it('two passes land on the loudness target with true peaks under the ceiling', async () => {
    const t = tl([
      audioTrack('trk_m', [aclip('m', 'm', 0, s(4))]),
      audioTrack('trk_sfx', [aclip('x1', 'x', s(1), s(0.3)), aclip('x2', 'x', s(2.5), s(0.3))]),
    ]);
    const sources = new Map([
      ['m', music],
      ['x', sfx],
    ]);
    const target = { lufs: -14, truePeakDb: -1 };
    const raw = mix(t, sources);
    const first = await measureLoudness(raw.out);
    const master = masterFor(first, target);
    const done = mix(t, sources, master);
    const m = await measureLoudness(done.out);
    expect(Math.abs(m.integratedLufs - target.lufs)).toBeLessThanOrEqual(0.5);
    expect(m.truePeakDb).toBeLessThanOrEqual(-1);
    expect(done.samples.length).toBe(raw.samples.length);
  });
});

describe('audio helpers', () => {
  it('master gain leaves silence alone and is clamped', () => {
    const target = { lufs: -14, truePeakDb: -1 };
    expect(masterFor({ integratedLufs: -Infinity }, target)).toEqual({ gainDb: 0, truePeakDb: -1 });
    expect(masterFor({ integratedLufs: -20.004 }, target).gainDb).toBe(6);
    expect(masterFor({ integratedLufs: -90 }, target).gainDb).toBe(40);
  });

  it('reads clip audio settings, capping J/L offsets at a second', () => {
    const item = (clipAudio: unknown) =>
      ({ id: 'c', extensions: { core: { clipAudio } } }) as unknown as Parameters<
        typeof clipAudioOf
      >[0];
    expect(clipAudioOf(item(undefined))).toBeUndefined();
    expect(clipAudioOf(item({ enabled: false, lead: 5 }))).toBeUndefined();
    expect(clipAudioOf(item({ enabled: true, lead: s(3), lag: -4 }))).toEqual({
      enabled: true,
      lead: s(1),
      lag: 0,
    });
  });
});
