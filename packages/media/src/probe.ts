import { stat } from 'node:fs/promises';
import { MediaInfo } from '@trailerforge/schema';
import { MediaError } from './errors.js';
import { resolveTools, type FfmpegTools } from './detect.js';
import { runTool, type RunOptions } from './process.js';

interface FfStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_space?: string;
  color_range?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  disposition?: { attached_pic?: number };
}

interface FfProbe {
  format?: { format_name?: string; duration?: string; size?: string };
  streams?: FfStream[];
}

const ratio = (s: string | undefined): { num: number; den: number } | null => {
  const [n, d] = (s ?? '').split('/').map(Number);
  return n && d ? { num: n, den: d } : null;
};

function rotation(s: FfStream): 0 | 90 | 180 | 270 {
  const raw =
    s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
    Number(s.tags?.rotate ?? 0);
  const deg = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return deg as 0 | 90 | 180 | 270;
}

function bitDepth(s: FfStream): number | undefined {
  const raw = Number(s.bits_per_raw_sample);
  if (raw > 0) return raw;
  const m = /p(\d{2})(le|be)$/.exec(s.pix_fmt ?? '');
  return m ? Number(m[1]) : s.pix_fmt ? 8 : undefined;
}

/** Normalize ffprobe JSON into the schema's MediaInfo. Exported for unit tests. */
export function toMediaInfo(probe: FfProbe, sizeBytes: number, probedAt = new Date()): MediaInfo {
  const streams = probe.streams ?? [];
  const video = streams
    .filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.width && s.height)
    .map((s) => {
      const avg = ratio(s.avg_frame_rate);
      const r = ratio(s.r_frame_rate);
      const frameRate = avg ?? r ?? { num: 30, den: 1 };
      // r_frame_rate is the lowest rate that represents all timestamps; a mismatch with the
      // average beyond rounding means timestamps are irregular (VFR).
      const vfr =
        !!(avg && r) && Math.abs(avg.num / avg.den - r.num / r.den) > 0.01 * (r.num / r.den);
      const transfer = s.color_transfer;
      return {
        index: s.index,
        codec: s.codec_name ?? 'unknown',
        width: s.width!,
        height: s.height!,
        frameRate,
        variableFrameRate: vfr,
        ...(s.pix_fmt ? { pixelFormat: s.pix_fmt } : {}),
        ...(bitDepth(s) ? { bitDepth: bitDepth(s)! } : {}),
        ...(s.color_space ? { colorSpace: s.color_space } : {}),
        colorRange: s.color_range === 'tv' || s.color_range === 'pc' ? s.color_range : 'unknown',
        ...(transfer ? { colorTransfer: transfer } : {}),
        ...(s.color_primaries ? { colorPrimaries: s.color_primaries } : {}),
        rotation: rotation(s),
        hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
      };
    });
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      sampleRate: Number(s.sample_rate ?? 0) || 48_000,
      channels: s.channels ?? 2,
      ...(s.channel_layout ? { channelLayout: s.channel_layout } : {}),
    }));
  return MediaInfo.parse({
    container: probe.format?.format_name ?? 'unknown',
    duration: Number(probe.format?.duration ?? 0) || 0,
    sizeBytes,
    video,
    audio,
    probedAt: probedAt.toISOString(),
  });
}

/** Probe a media file. Throws MediaError (file-not-found, corrupt-file...) on failure. */
export async function probe(
  path: string,
  opts: RunOptions & { tools?: FfmpegTools } = {},
): Promise<MediaInfo> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new MediaError('file-not-found', `File not found: ${path}`);
  }
  const { stdout } = await runTool(
    (opts.tools ?? resolveTools()).ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    opts,
  );
  const info = toMediaInfo(JSON.parse(stdout) as FfProbe, size);
  if (info.video.length === 0 && info.audio.length === 0) {
    throw new MediaError('corrupt-file', `No audio or video streams in ${path}`);
  }
  return info;
}
