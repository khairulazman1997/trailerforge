import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_ENCODE, type SourceMedia } from '@trailerforge/compile';
import { MediaError } from '@trailerforge/media';
import { Timeline, framesToFlicks, rate } from '@trailerforge/schema';
import { EXPORT_PRESETS, posterTime, resolveExport } from '@trailerforge/compile';
import { measureLoudness } from '@trailerforge/media';
import { planSegments, renderVideo, writePoster, type RenderSpec } from './video.js';

/** Resumable renders on real FFmpeg: interrupted runs finish byte-identical to clean ones. */

const root = mkdtempSync(join(tmpdir(), 'tforge-video-'));
const R = rate(24);
const f = (n: number) => framesToFlicks(n, R);
let spec: (out: string) => RenderSpec;

beforeAll(() => {
  const ff = (args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const clip = join(root, 'clip.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]); // prettier-ignore
  const music = join(root, 'music.wav');
  ff(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=4', '-ac', '2', music]);
  const base = { width: 320, height: 180, frameRate: rate(30), duration: 4 };
  const sources: [string, SourceMedia][] = [
    ['c', { ...base, path: clip, contentHash: 'c'.repeat(64), hasAudio: true }],
    ['m', { ...base, path: music, contentHash: 'm'.repeat(64), hasAudio: true }],
  ];
  const timeline = Timeline.parse({
    id: 'tl_v',
    name: 'V',
    frameRate: R,
    resolution: { width: 160, height: 90 },
    tracks: [
      { id: 'trk_v', kind: 'video', items: [
        { id: 'a', kind: 'clip', start: 0, duration: f(30), assetId: 'c', sourceIn: 0 },
        { id: 'p', kind: 'placeholder', start: f(30), duration: f(12), reason: 'missing-footage' },
        { id: 'b', kind: 'clip', start: f(42), duration: f(30), assetId: 'c', sourceIn: f(10) },
      ], transitions: [] },
      { id: 'trk_m', kind: 'audio', items: [{ id: 'mu', kind: 'clip', start: 0, duration: f(72), assetId: 'm', sourceIn: 0 }] },
    ],
  }); // prettier-ignore
  spec = (output) => ({
    timeline,
    sources,
    encode: { ...DRAFT_ENCODE, threads: 2 },
    loudness: { lufs: -14, truePeakDb: -1 },
    segmentSeconds: 1,
    output,
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('renderVideo', { timeout: 120_000 }, () => {
  it('cuts the render into whole-frame segments', () => {
    expect(planSegments(72, R, 1)).toEqual([
      { start: 0, frames: 24 },
      { start: 24, frames: 24 },
      { start: 48, frames: 24 },
    ]);
    expect(planSegments(50, rate(30000, 1001), 1).map((s) => s.frames)).toEqual([30, 20]);
  });

  it('resumes after a cancel with only the missing segments, to the same bytes', async () => {
    const clean = await renderVideo(spec(join(root, 'out', 'clean.mp4')), {
      workRoot: join(root, 'work-a'),
    });
    expect(clean.rendered).toBe(3);
    expect(clean.manifest.reproducible).toBe(true);

    const out = join(root, 'out', 'resumed.mp4');
    const workRoot = join(root, 'work-b');
    const ctl = new AbortController();
    await expect(
      renderVideo(spec(out), {
        workRoot,
        signal: ctl.signal,
        onProgress: (p) => p.segmentsDone === 1 && ctl.abort(),
      }),
    ).rejects.toBeInstanceOf(MediaError);
    expect(existsSync(out)).toBe(false);
    const work = join(workRoot, clean.planHash);
    expect(readdirSync(work).filter((x) => x.includes('.tmp'))).toEqual([]);
    // A crashed process may leave a half-written temp file behind.
    writeFileSync(join(work, 'seg_00001.mkv.tmp-99999'), 'torn');

    const resumed = await renderVideo(spec(out), { workRoot });
    expect(resumed.reused).toBe(1);
    expect(resumed.rendered).toBe(2);
    expect(resumed.sha256).toBe(clean.sha256);
    expect(readdirSync(work).filter((x) => x.includes('.tmp'))).toEqual([]);

    // A damaged segment is not trusted: it is rendered again.
    truncateSync(join(work, 'seg_00002.mkv'), 100);
    const again = await renderVideo(spec(out), { workRoot });
    expect([again.reused, again.rendered]).toEqual([2, 1]);
    expect(again.sha256).toBe(clean.sha256);
  });

  it('writes a file with the picture and the mastered sound', async () => {
    const out = join(root, 'out', 'probe.mp4');
    await renderVideo(spec(out), { workRoot: join(root, 'work-a') });
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries',
        'stream=codec_type,width,height,nb_read_packets,sample_rate', '-of', 'json', out]).toString(),
    ) as { streams: Record<string, unknown>[] }; // prettier-ignore
    const v = probe.streams.find((s) => s.codec_type === 'video')!;
    const a = probe.streams.find((s) => s.codec_type === 'audio')!;
    expect(v).toMatchObject({ width: 160, height: 90, nb_read_packets: '72' });
    expect(a).toMatchObject({ sample_rate: '48000' });
  });
});

describe('export presets, rendered', { timeout: 300_000 }, () => {
  const sizes: Record<string, [number, number]> = {
    'core/youtube': [640, 360],
    'core/steam': [1920, 1080],
    'core/vertical': [360, 640],
    'core/x': [640, 360],
    'core/master': [640, 360],
  };

  it.each(EXPORT_PRESETS.map((p) => p.id))(
    '%s renders a 2 s file that probes as specified',
    async (id) => {
      const [width, height] = sizes[id]!;
      const base = spec('');
      const timeline = Timeline.parse({
      ...base.timeline,
      resolution: { width, height },
      tracks: [
        { id: 'trk_v', kind: 'video', items: [{ id: 'a', kind: 'clip', start: 0, duration: f(48), assetId: 'c', sourceIn: 0 }] },
        { id: 'trk_m', kind: 'audio', items: [{ id: 'mu', kind: 'clip', start: 0, duration: f(48), assetId: 'm', sourceIn: 0 }] },
      ],
    }); // prettier-ignore
      const r = resolveExport(id, { resolution: { width, height }, frameRate: R });
      expect(r.issues).toEqual([]);
      const out = join(root, 'presets', `${id.replace('/', '-')}.${r.extension}`);
      await renderVideo(
      { ...base, timeline, encode: r.encode, audioCodec: r.audioCodec, loudness: r.loudness, segmentSeconds: 1, output: out },
      { workRoot: join(root, 'work-presets') },
    ); // prettier-ignore
      const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries',
        'stream=codec_type,codec_name,width,height,pix_fmt,sample_rate,bit_rate,nb_read_packets,duration:format=format_name,duration',
        '-of', 'json', out]).toString(),
    ) as { streams: Record<string, string>[]; format: { format_name: string; duration: string } }; // prettier-ignore
      const v = probe.streams.find((s) => s.codec_type === 'video')!;
      const a = probe.streams.find((s) => s.codec_type === 'audio')!;
      const p = r.preset;
      expect(v).toMatchObject({
        codec_name: p.id === 'core/master' ? 'prores' : 'h264',
        width,
        height,
        nb_read_packets: '48',
        pix_fmt: p.video.pixFmt,
      });
      expect(a).toMatchObject({
        codec_name: p.id === 'core/master' ? 'pcm_s24le' : 'aac',
        sample_rate: '48000',
      });
      expect(probe.format.format_name).toContain(p.container === 'mov' ? 'mov' : 'mp4');
      expect(Number(probe.format.duration)).toBeGreaterThan(1.95);
      expect(Number(probe.format.duration)).toBeLessThan(2.1);
      if (id === 'core/steam') expect(Number(v.bit_rate)).toBeLessThanOrEqual(14_000_000 * 1.1);
      const loud = await measureLoudness(out);
      expect(Math.abs(loud.integratedLufs - p.loudness.lufs)).toBeLessThanOrEqual(1);
      expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
      // Web files start fast: the index (moov) comes before the media data.
      if (p.container === 'mp4') {
        const head = readFileSync(out).subarray(0, 4096).toString('latin1');
        expect(head.indexOf('moov')).toBeGreaterThan(-1);
      }
    },
  );

  it('writes a poster frame', async () => {
    const png = join(root, 'out', 'poster.png');
    await writePoster(join(root, 'out', 'probe.mp4'), posterTime(3), png);
    const head = readFileSync(png).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readdirSync(join(root, 'out')).filter((x) => x.includes('.tmp'))).toEqual([]);
  });
});
