import { join } from 'node:path';
import { runTool } from './process.js';

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

/** `TFORGE_FFMPEG_DIR` overrides PATH lookup (e.g. a user-chosen FFmpeg build). */
export function resolveTools(env: NodeJS.ProcessEnv = process.env): FfmpegTools {
  const dir = env.TFORGE_FFMPEG_DIR;
  const exe = process.platform === 'win32' ? '.exe' : '';
  return dir
    ? { ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) }
    : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}

export type HwEncoderFamily = 'nvenc' | 'videotoolbox' | 'qsv' | 'vaapi' | 'amf';

export interface Capabilities {
  version: string;
  /** Encoders the build lists. */
  encoders: Set<string>;
  filters: Set<string>;
  /** Hardware H.264 encoders that actually work on this machine (verified by a test encode). */
  workingHwEncoders: string[];
  /** Licensing-relevant: GPL builds include libx264/libx265. */
  gpl: boolean;
}

const HW_H264: Record<HwEncoderFamily, string> = {
  nvenc: 'h264_nvenc',
  videotoolbox: 'h264_videotoolbox',
  qsv: 'h264_qsv',
  vaapi: 'h264_vaapi',
  amf: 'h264_amf',
};

/**
 * Inspect the FFmpeg build. Listed hardware encoders are verified with a tiny test encode,
 * because builds often list encoders the machine can't use (no GPU, missing driver).
 */
export async function detectCapabilities(
  tools: FfmpegTools = resolveTools(),
): Promise<Capabilities> {
  const [ver, enc, fil] = await Promise.all([
    runTool(tools.ffmpeg, ['-hide_banner', '-version']),
    runTool(tools.ffmpeg, ['-hide_banner', '-encoders']),
    runTool(tools.ffmpeg, ['-hide_banner', '-filters']),
  ]);
  const version = /ffmpeg version (\S+)/.exec(ver.stdout)?.[1] ?? 'unknown';
  const encoders = new Set(listNames(enc.stdout, /^\s*[VAS][A-Z.]{5}\s+(\S+)/));
  const filters = new Set(listNames(fil.stdout, /^\s*[TSC.]{2,3}\s+(\S+)\s/));
  const candidates = Object.values(HW_H264).filter((e) => encoders.has(e));
  const results = await Promise.all(candidates.map((e) => testEncoder(tools, e)));
  return {
    version,
    encoders,
    filters,
    workingHwEncoders: candidates.filter((_, i) => results[i]),
    gpl: /--enable-gpl/.test(ver.stdout),
  };
}

function listNames(out: string, re: RegExp): string[] {
  return out.split('\n').flatMap((line) => {
    const m = re.exec(line);
    return m?.[1] ? [m[1]] : [];
  });
}

async function testEncoder(tools: FfmpegTools, encoder: string): Promise<boolean> {
  try {
    await runTool(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:d=0.1',
        '-frames:v',
        '2',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Best H.264 encoder: a verified hardware one if allowed, else libx264. */
export function pickH264Encoder(caps: Capabilities, allowHardware = true): string {
  if (allowHardware && caps.workingHwEncoders[0]) return caps.workingHwEncoders[0];
  return 'libx264';
}
