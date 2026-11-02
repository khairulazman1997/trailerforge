import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTool } from './process.js';

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * `TFORGE_FFMPEG_DIR` overrides PATH lookup (e.g. a user-chosen FFmpeg build). On Windows, an
 * `ffmpeg` on PATH that is a package manager's launcher (Chocolatey's or Scoop's shim) is replaced
 * by the real program behind it: Chocolatey's shim crashes when several FFmpeg processes run at
 * once, as renders do.
 */
export function resolveTools(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): FfmpegTools {
  const dir = env.TFORGE_FFMPEG_DIR;
  const exe = platform === 'win32' ? '.exe' : '';
  if (dir) return { ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) };
  const real = platform === 'win32' ? realBehindShim(env) : null;
  return real
    ? { ffmpeg: join(real, 'ffmpeg.exe'), ffprobe: join(real, 'ffprobe.exe') }
    : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}

const both = (d: string) => existsSync(join(d, 'ffmpeg.exe')) && existsSync(join(d, 'ffprobe.exe'));
const subdirs = (d: string): string[] => {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, e.name))
      .sort();
  } catch {
    return [];
  }
};

/** The folder of the real ffmpeg.exe when the first one on PATH is a known shim, else null. */
export function realBehindShim(env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? env.Path ?? '';
  const found = path
    .split(';')
    .filter(Boolean)
    .find((d) => existsSync(join(d, 'ffmpeg.exe')));
  if (!found) return null;
  const norm = found.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm.endsWith('/chocolatey/bin')) {
    // <choco>/lib/<package>/tools/.../ffmpeg.exe, usually tools/ffmpeg/bin
    for (const pkg of subdirs(join(dirname(found), 'lib'))) {
      const tools = join(pkg, 'tools');
      const hit = [tools, join(tools, 'bin'), ...subdirs(tools).flatMap((d) => [join(d, 'bin'), d])].find(both); // prettier-ignore
      if (hit) return hit;
    }
  }
  if (norm.endsWith('/scoop/shims')) {
    const hit = subdirs(join(dirname(found), 'apps'))
      .map((app) => join(app, 'current', 'bin'))
      .find(both);
    if (hit) return hit;
  }
  return null;
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
