import type { MediaInfo } from '@trailerforge/schema';
import { resolveTools, type FfmpegTools } from './detect.js';
import { FilterGraph } from './filtergraph.js';
import { runTool } from './process.js';

export interface OpOptions {
  tools?: FfmpegTools;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 0..1 */
  onProgress?: (fraction: number) => void;
}

const BASE = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];

/** Run ffmpeg with machine-readable progress mapped to 0..1 of `durationSec`. */
export async function ffmpeg(
  args: string[],
  durationSec: number,
  opts: OpOptions = {},
): Promise<void> {
  const tools = opts.tools ?? resolveTools();
  await runTool(tools.ffmpeg, [...BASE, '-progress', 'pipe:1', '-nostats', ...args], {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    onProgressBlock: (f) => {
      if (!opts.onProgress) return;
      if (f.progress === 'end') return opts.onProgress(1);
      const us = Number(f.out_time_us ?? f.out_time_ms);
      if (durationSec > 0 && Number.isFinite(us))
        opts.onProgress(Math.min(0.999, us / 1e6 / durationSec));
    },
  });
}

export interface ProxyOptions extends OpOptions {
  /** Output height; width follows aspect. Default 540. */
  height?: number;
}

/**
 * Edit-friendly proxy: small H.264 with a keyframe every second for fast scrubbing,
 * display rotation applied, AAC audio. Proxies are cache, so speed beats quality.
 */
export async function makeProxy(
  input: string,
  info: MediaInfo,
  output: string,
  opts: ProxyOptions = {},
): Promise<void> {
  const v = info.video[0];
  const fps = v ? Math.min(60, Math.round(v.frameRate.num / v.frameRate.den)) || 30 : 30;
  const args = ['-i', input];
  if (v) {
    const g = new FilterGraph().chain(
      ['0:v:0'],
      [
        {
          name: 'scale',
          args: { w: -2, h: Math.min(opts.height ?? 540, v.height - (v.height % 2)) },
        },
        { name: 'format', args: { pix_fmts: 'yuv420p' } },
      ],
      ['v'],
    );
    args.push(
      '-filter_complex',
      g.toString(),
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-g',
      String(fps),
      '-r',
      String(fps),
    );
  }
  if (info.audio.length)
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  args.push('-movflags', '+faststart', output);
  await ffmpeg(args, info.duration, opts);
}

/** Single JPEG/PNG frame at `atSec` (format from the output extension). */
export async function extractThumbnail(
  input: string,
  atSec: number,
  output: string,
  width = 320,
  opts: OpOptions = {},
): Promise<void> {
  const g = new FilterGraph().chain(
    ['0:v:0'],
    [{ name: 'scale', args: { w: width, h: -2 } }],
    ['v'],
  );
  await ffmpeg(
    [
      '-ss',
      atSec.toFixed(3),
      '-i',
      input,
      '-filter_complex',
      g.toString(),
      '-map',
      '[v]',
      '-frames:v',
      '1',
      output,
    ],
    0,
    opts,
  );
}

/** `count` evenly spaced frames tiled into one horizontal strip for the timeline. */
export async function makeFilmstrip(
  input: string,
  info: MediaInfo,
  output: string,
  count = 10,
  frameWidth = 160,
  opts: OpOptions = {},
): Promise<void> {
  const rate = info.duration > 0 ? count / info.duration : 1;
  const g = new FilterGraph().chain(
    ['0:v:0'],
    [
      { name: 'fps', args: { fps: rate.toFixed(6) } },
      { name: 'scale', args: { w: frameWidth, h: -2 } },
      { name: 'tile', args: { layout: `${count}x1` } },
    ],
    ['v'],
  );
  await ffmpeg(
    ['-i', input, '-filter_complex', g.toString(), '-map', '[v]', '-frames:v', '1', output],
    info.duration,
    opts,
  );
}
