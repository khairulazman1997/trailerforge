import type { PlatformProfile } from '@trailerforge/plugin-api';
import type { FormatTarget, PluginRef } from '@trailerforge/schema';
import type { z } from 'zod';

const HD = { width: 1920, height: 1080 };
const TALL = { width: 1080, height: 1920 };
const fps = (num: number) => ({ num, den: 1 });
const loud = { loudnessLufs: -14, truePeakDb: -1 };
const TALL_SAFE = { top: 0.12, bottom: 0.2, left: 0.06, right: 0.14 };

/**
 * The platforms a planned video can target. Each brings the shape, size, rate and length of
 * its version and the export preset that version uses (presets in `@trailerforge/compile`).
 * Plugins add more through `ctx.platforms`.
 */
export const BUILTIN_PLATFORMS: PlatformProfile[] = [
  {
    id: 'core/youtube',
    name: 'YouTube',
    aspects: ['16:9'],
    ...loud,
    safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
    format: { resolution: HD, frameRate: fps(60), targetDuration: 60 },
    exportPresetId: 'core/youtube',
  },
  {
    id: 'core/youtube-shorts',
    name: 'YouTube Shorts',
    aspects: ['9:16'],
    maxDuration: 180,
    ...loud,
    safeArea: TALL_SAFE,
    format: { resolution: TALL, frameRate: fps(30), targetDuration: 30 },
    exportPresetId: 'core/vertical',
  },
  {
    id: 'core/steam',
    name: 'Steam store page',
    aspects: ['16:9'],
    ...loud,
    safeArea: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
    captionsRecommended: false,
    format: { resolution: HD, frameRate: fps(60), targetDuration: 60 },
    exportPresetId: 'core/steam',
  },
  {
    id: 'core/tiktok',
    name: 'TikTok',
    aspects: ['9:16'],
    maxDuration: 600,
    ...loud,
    safeArea: TALL_SAFE,
    format: { resolution: TALL, frameRate: fps(30), targetDuration: 30 },
    exportPresetId: 'core/vertical',
  },
  {
    id: 'core/instagram-reels',
    name: 'Instagram Reels',
    aspects: ['9:16'],
    maxDuration: 180,
    ...loud,
    safeArea: { top: 0.1, bottom: 0.22, left: 0.06, right: 0.14 },
    format: { resolution: TALL, frameRate: fps(30), targetDuration: 30 },
    exportPresetId: 'core/vertical',
  },
  {
    id: 'core/x',
    name: 'X',
    aspects: ['16:9'],
    maxDuration: 140,
    ...loud,
    safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
    format: { resolution: HD, frameRate: fps(30), targetDuration: 30 },
    exportPresetId: 'core/x',
  },
];

type Profile = Pick<PlatformProfile, 'id' | 'name' | 'aspects' | 'format' | 'maxDuration'>;

const aspectLabel = (a: PlatformProfile['aspects'][number]) =>
  typeof a === 'string' ? a : `${a.w}:${a.h}`;

/** The format target a planned video for this platform starts with (one per platform). */
export function platformFormat(profile: Profile): z.input<typeof FormatTarget> {
  const aspect = profile.aspects[0]!;
  const tall =
    typeof aspect === 'string' ? aspect === '9:16' || aspect === '4:5' : aspect.h > aspect.w;
  const f = profile.format ?? {
    resolution: tall ? TALL : HD,
    frameRate: fps(30),
    targetDuration: 30,
  };
  const duration = Math.min(f.targetDuration, profile.maxDuration ?? Infinity);
  const slug = profile.id.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 56);
  return {
    id: `fmt_${slug}`,
    name: `${profile.name} ${aspectLabel(aspect)} · ${duration} s`,
    aspect,
    resolution: f.resolution,
    frameRate: f.frameRate,
    targetDuration: duration,
    platformIds: [profile.id as PluginRef],
  };
}

/** The preset a version uses by default: its format's first platform that names one. */
export function presetForPlatforms(
  platforms: readonly Pick<PlatformProfile, 'id' | 'exportPresetId'>[],
  platformIds: readonly string[] | undefined,
): string | undefined {
  for (const id of platformIds ?? []) {
    const preset = platforms.find((p) => p.id === id)?.exportPresetId;
    if (preset) return preset;
  }
  return undefined;
}
