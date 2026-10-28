import type { Rate, Resolution } from '@trailerforge/schema';
import type { EncodeSettings } from './compile.js';
import type { LoudnessTarget } from './audio.js';

/**
 * Export presets: what a platform wants from a file. Pure data plus three helpers (turn a preset
 * into render settings, check a version against it, name the file). The picture is never
 * resized by a preset: a version's size comes from its format target, and a mismatch is reported
 * so the Quality Gate (6.7) can block it. Finals use software encoders; hardware encoders are
 * for review drafts only (see `draftEncode`).
 */

export interface ExportPreset {
  /** `core/<name>`; stored on a version as `export.presetId`. */
  id: string;
  name: string;
  platform: string;
  description: string;
  container: EncodeSettings['container'];
  video: { codec: string; pixFmt: string; args: readonly string[] };
  /** FFmpeg audio arguments for the muxed file. */
  audio: readonly string[];
  loudness: LoudnessTarget;
  /** Sizes the platform accepts; unset means any. */
  size?: { aspect?: [number, number]; maxWidth?: number; maxHeight?: number; exact?: Resolution };
  /** Highest frame rate accepted, frames per second. */
  maxFps?: number;
}

const X264 = ['-profile:v', 'high', '-preset', 'slow'];

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'core/youtube',
    name: 'YouTube',
    platform: 'YouTube',
    description: 'H.264 High, constant quality, AAC 320k, −14 LUFS; any size up to 4K.',
    container: 'mp4',
    video: { codec: 'libx264', pixFmt: 'yuv420p', args: [...X264, '-crf', '16'] },
    audio: ['-c:a', 'aac', '-b:a', '320k'],
    loudness: { lufs: -14, truePeakDb: -1 },
    size: { maxWidth: 3840, maxHeight: 2160 },
    maxFps: 60,
  },
  {
    id: 'core/steam',
    name: 'Steam',
    platform: 'Steam store page',
    description: 'Full HD 16:9, H.264 High at about 12 Mbit/s, AAC 192k, −14 LUFS.',
    container: 'mp4',
    video: {
      codec: 'libx264',
      pixFmt: 'yuv420p',
      args: [...X264, '-b:v', '12M', '-maxrate', '14M', '-bufsize', '24M'],
    },
    audio: ['-c:a', 'aac', '-b:a', '192k'],
    loudness: { lufs: -14, truePeakDb: -1 },
    size: { exact: { width: 1920, height: 1080 } },
    maxFps: 60,
  },
  {
    id: 'core/vertical',
    name: 'Vertical social',
    platform: 'Shorts, Reels, TikTok',
    description: '9:16, H.264 High, constant quality, AAC 256k, −14 LUFS.',
    container: 'mp4',
    video: { codec: 'libx264', pixFmt: 'yuv420p', args: [...X264, '-crf', '18'] },
    audio: ['-c:a', 'aac', '-b:a', '256k'],
    loudness: { lufs: -14, truePeakDb: -1 },
    size: { aspect: [9, 16], maxWidth: 1080, maxHeight: 1920 },
    maxFps: 60,
  },
  {
    id: 'core/x',
    name: 'X (Twitter)',
    platform: 'X',
    description: '16:9 or 1:1, H.264 High, capped at 25 Mbit/s, AAC 256k, −14 LUFS.',
    container: 'mp4',
    video: {
      codec: 'libx264',
      pixFmt: 'yuv420p',
      args: [...X264, '-crf', '18', '-maxrate', '25M', '-bufsize', '50M'],
    },
    audio: ['-c:a', 'aac', '-b:a', '256k'],
    loudness: { lufs: -14, truePeakDb: -1 },
    size: { maxWidth: 1920, maxHeight: 1200 },
    maxFps: 60,
  },
  {
    id: 'core/master',
    name: 'Master (ProRes)',
    platform: 'Archive and editors',
    description: 'ProRes 422 HQ 10-bit in .mov, 24-bit PCM, −16 LUFS; any size.',
    container: 'mov',
    video: {
      codec: 'prores_ks',
      pixFmt: 'yuv422p10le',
      args: ['-profile:v', '3', '-vendor', 'apl0'],
    },
    audio: ['-c:a', 'pcm_s24le'],
    loudness: { lufs: -16, truePeakDb: -1 },
  },
];

export const presetById = (id: string): ExportPreset | undefined =>
  EXPORT_PRESETS.find((p) => p.id === id);

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The preset that suits a version's shape when the user has not chosen one. */
export function defaultPresetFor(resolution: Resolution): ExportPreset {
  const r = resolution.width / resolution.height;
  if (r < 0.7) return presetById('core/vertical')!;
  return presetById('core/youtube')!;
}

export interface ResolvedExport {
  preset: ExportPreset;
  encode: EncodeSettings;
  audioCodec: string[];
  loudness: LoudnessTarget;
  extension: string;
  /** Why this is not the preset asked for, or what does not fit it. */
  issues: string[];
}

/** Render settings for a preset, with the version's loudness override applied. */
export function resolveExport(
  presetId: string | undefined,
  version: { resolution: Resolution; frameRate: Rate },
  overrides: { loudnessLufs?: number } = {},
): ResolvedExport {
  const issues: string[] = [];
  let preset = presetId ? presetById(presetId) : undefined;
  if (presetId && !preset)
    issues.push(`export preset ${presetId} is not installed; using the default for this shape`);
  preset ??= defaultPresetFor(version.resolution);
  issues.push(...presetIssues(preset, version));
  return {
    preset,
    encode: {
      container: preset.container,
      threads: 4,
      video: { codec: preset.video.codec, pixFmt: preset.video.pixFmt, args: preset.video.args },
    },
    audioCodec: [...preset.audio],
    loudness: {
      lufs: overrides.loudnessLufs ?? preset.loudness.lufs,
      truePeakDb: preset.loudness.truePeakDb,
    },
    extension: preset.container,
    issues,
  };
}

/** What about a version does not fit the preset (size, shape, frame rate). */
export function presetIssues(
  preset: ExportPreset,
  v: { resolution: Resolution; frameRate: Rate },
): string[] {
  const out: string[] = [];
  const { width: w, height: h } = v.resolution;
  const s = preset.size;
  if (s?.exact && (w !== s.exact.width || h !== s.exact.height))
    out.push(`${preset.name} wants ${s.exact.width}×${s.exact.height}; this version is ${w}×${h}`);
  if (s?.aspect) {
    const [aw, ah] = s.aspect;
    const g = gcd(w, h);
    if (Math.abs(w / h - aw / ah) > 0.01)
      out.push(`${preset.name} wants ${aw}:${ah}; this version is ${w / g}:${h / g}`);
  }
  if ((s?.maxWidth && w > s.maxWidth) || (s?.maxHeight && h > s.maxHeight))
    out.push(
      `${preset.name} accepts up to ${s.maxWidth}×${s.maxHeight}; this version is ${w}×${h}`,
    );
  const fps = v.frameRate.num / v.frameRate.den;
  if (preset.maxFps && fps > preset.maxFps + 0.01)
    out.push(
      `${preset.name} accepts up to ${preset.maxFps} fps; this version is ${fps.toFixed(2)}`,
    );
  return out;
}

/** A quick software H.264 for review drafts at 720p-class quality. */
export function draftEncode(hardware?: { codec: string; args: readonly string[] }): EncodeSettings {
  return hardware
    ? {
        container: 'mp4',
        threads: 4,
        video: { codec: hardware.codec, pixFmt: 'yuv420p', args: hardware.args, hardware: true },
      }
    : {
        container: 'mp4',
        threads: 4,
        video: {
          codec: 'libx264',
          pixFmt: 'yuv420p',
          args: ['-profile:v', 'high', '-preset', 'veryfast', '-crf', '24'],
        },
      };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name safe on Windows, macOS and Linux (no extension). */
export function safeFileName(name: string): string {
  let s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (RESERVED.test(s)) s = `${s}_`;
  return (s || 'trailer').slice(0, 120);
}

export const DEFAULT_FILE_NAME = '{project}-{version}-{preset}';

/** The output file name for a version: the template filled in, made safe, with its extension. */
export function exportFileName(
  template: string | undefined,
  vars: { project: string; version: string; format: string; preset: string },
  extension: string,
): string {
  const slug = (v: string) => v.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  const filled = (template ?? DEFAULT_FILE_NAME).replace(
    /\{(project|version|format|preset)\}/g,
    (_, k: keyof typeof vars) => slug(vars[k]),
  );
  return `${safeFileName(filled)}.${extension}`;
}

/** Where the poster frame is taken: the setting, else early in the version (never past its end). */
export function posterTime(duration: number, setting?: number): number {
  const t = setting ?? Math.min(2, duration / 2);
  return Math.max(0, Math.min(t, Math.max(0, duration - 0.05)));
}
