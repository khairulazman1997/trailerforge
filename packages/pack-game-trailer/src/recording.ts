import { Resolution, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { PACK_ID } from './brief-ext.js';

/**
 * Recording settings for the capture pack. Derived from the brief's game platforms, the video
 * type, the storyboard's HUD needs and the format targets; never stored. Only the user's
 * overrides are stored, at `project.extensions['game-trailer'].recording`, through the
 * `game-trailer/recording.*` commands.
 */

export const CaptureCodec = z.enum(['h264', 'hevc', 'av1']);
export const CaptureContainer = z.enum(['mkv', 'mp4', 'mov']);

export const RecordingSettings = z.strictObject({
  resolution: Resolution,
  fps: z.int().min(1).max(240),
  bitrateMbps: z.number().positive(),
  codec: CaptureCodec,
  container: CaptureContainer,
  /** `per-shot`: the storyboard mixes HUD-on and HUD-off shots; follow each checklist item. */
  hud: z.enum(['on', 'off', 'per-shot']),
  hdr: z.boolean(),
});
export type RecordingSettings = z.infer<typeof RecordingSettings>;

/** Stored per project: only the fields the user changed. */
export const RecordingOverrides = RecordingSettings.partial();
export type RecordingOverrides = z.infer<typeof RecordingOverrides>;

/** Command payload: `null` clears an override, absent leaves it alone. */
export const RecordingPatch = z.strictObject({
  resolution: Resolution.nullable().optional(),
  fps: RecordingSettings.shape.fps.nullable().optional(),
  bitrateMbps: RecordingSettings.shape.bitrateMbps.nullable().optional(),
  codec: CaptureCodec.nullable().optional(),
  container: CaptureContainer.nullable().optional(),
  hud: RecordingSettings.shape.hud.nullable().optional(),
  hdr: z.boolean().nullable().optional(),
});
export type RecordingPatch = z.infer<typeof RecordingPatch>;

export type RecordingField = keyof RecordingSettings;
export const RECORDING_FIELDS = [
  'resolution',
  'fps',
  'bitrateMbps',
  'codec',
  'container',
  'hud',
  'hdr',
] as const satisfies readonly RecordingField[];

/** Reads the stored overrides; missing or malformed data yields none. */
export function readRecordingOverrides(project: Pick<Project, 'extensions'>): RecordingOverrides {
  const ext = project.extensions[PACK_ID];
  const raw =
    ext !== null && typeof ext === 'object' && !Array.isArray(ext) ? ext['recording'] : undefined;
  const parsed = RecordingOverrides.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export interface PlatformProfile {
  /** Display name as used in the brief (`GAME_PLATFORMS`). */
  name: string;
  /** Lower-case spellings accepted from the brief. */
  aliases: string[];
  kind: 'pc' | 'console' | 'handheld' | 'mobile';
  /** Typical capture resolution and frame rate; an editable starting point, not a spec. */
  resolution: Resolution;
  fps: number;
  /** Can output HDR, so the capture chain may need to be switched to SDR. */
  hdrCapable: boolean;
  /** Pitfalls specific to capturing this platform (advice codes). */
  caveats: AdviceCode[];
}

export type AdviceCode =
  | 'no-platforms'
  | 'unknown-platform'
  | 'cfr'
  | 'console-capture'
  | 'pc-overlay'
  | 'mobile-vfr'
  | 'low-fps-platform'
  | 'aspect-16-10'
  | 'below-target-res'
  | 'below-target-fps'
  | 'reframe-headroom'
  | 'hdr-capable'
  | 'hdr-on'
  | 'bitrate-low'
  | 'hud-per-shot';

const R = (width: number, height: number): Resolution => ({ width, height });

/** Typical capture settings per platform. PC is 1440p so it downsamples cleanly to 1080p. */
export const PLATFORM_PROFILES: readonly PlatformProfile[] = [
  {
    name: 'PC (Steam)',
    aliases: ['pc', 'steam', 'windows'],
    kind: 'pc',
    resolution: R(2560, 1440),
    fps: 60,
    hdrCapable: true,
    caveats: ['pc-overlay'],
  },
  {
    name: 'PC (Epic)',
    aliases: ['epic', 'epic games store'],
    kind: 'pc',
    resolution: R(2560, 1440),
    fps: 60,
    hdrCapable: true,
    caveats: ['pc-overlay'],
  },
  {
    name: 'macOS',
    aliases: ['mac'],
    kind: 'pc',
    resolution: R(2560, 1440),
    fps: 60,
    hdrCapable: false,
    caveats: [],
  },
  {
    name: 'Steam Deck',
    aliases: ['deck'],
    kind: 'handheld',
    resolution: R(1280, 800),
    fps: 60,
    hdrCapable: false,
    caveats: ['aspect-16-10', 'pc-overlay'],
  },
  {
    name: 'PlayStation 5',
    aliases: ['ps5', 'playstation'],
    kind: 'console',
    resolution: R(3840, 2160),
    fps: 60,
    hdrCapable: true,
    caveats: ['console-capture'],
  },
  {
    name: 'Xbox Series X|S',
    aliases: ['xbox', 'xbox series x', 'xbox series s', 'xbox series x/s'],
    kind: 'console',
    resolution: R(3840, 2160),
    fps: 60,
    hdrCapable: true,
    caveats: ['console-capture'],
  },
  {
    name: 'Nintendo Switch 2',
    aliases: ['switch 2'],
    kind: 'console',
    resolution: R(1920, 1080),
    fps: 60,
    hdrCapable: true,
    caveats: ['console-capture', 'low-fps-platform'],
  },
  {
    name: 'Nintendo Switch',
    aliases: ['switch'],
    kind: 'console',
    resolution: R(1920, 1080),
    fps: 60,
    hdrCapable: false,
    caveats: ['console-capture', 'low-fps-platform'],
  },
  {
    name: 'iOS',
    aliases: ['iphone', 'ipad'],
    kind: 'mobile',
    resolution: R(1920, 1080),
    fps: 60,
    hdrCapable: false,
    caveats: ['mobile-vfr'],
  },
  {
    name: 'Android',
    aliases: [],
    kind: 'mobile',
    resolution: R(1920, 1080),
    fps: 60,
    hdrCapable: false,
    caveats: ['mobile-vfr'],
  },
];

const norm = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

const PROFILE_BY_NAME = new Map<string, PlatformProfile>(
  PLATFORM_PROFILES.flatMap((p) => [p.name, ...p.aliases].map((n) => [norm(n), p] as const)),
);

export function platformProfile(name: string): PlatformProfile | null {
  return PROFILE_BY_NAME.get(norm(name)) ?? null;
}

/** HUD default per video type when the storyboard's shots don't say. */
const VIDEO_TYPE_HUD: Record<string, 'on' | 'off'> = {
  'game-trailer/release-trailer': 'off',
  'game-trailer/announcement-trailer': 'off',
  'game-trailer/gameplay-trailer': 'on',
};
const DEFAULT_HUD = 'off';

const BASE_BITRATE_MBPS = 50; // 1080p60 H.264
const CODEC_FACTOR: Record<z.infer<typeof CaptureCodec>, number> = {
  h264: 1,
  hevc: 0.7,
  av1: 0.6,
};

/** Bitrate (Mbps) that keeps fast game motion clean: scales with pixels and fps, rounded to 5. */
export function recommendedBitrateMbps(
  s: Pick<RecordingSettings, 'resolution' | 'fps' | 'codec'>,
): number {
  const pixels = (s.resolution.width * s.resolution.height) / (1920 * 1080);
  const raw = BASE_BITRATE_MBPS * pixels * (s.fps / 60) * CODEC_FACTOR[s.codec];
  return Math.max(10, Math.round(raw / 5) * 5);
}

export interface RecordingAdvice {
  code: AdviceCode;
  severity: 'info' | 'warn';
  message: string;
}

export type RecordingInputs = Pick<
  Project,
  'brief' | 'formatTargets' | 'storyboard' | 'extensions'
>;

export interface ResolvedPlatform {
  /** As written in the brief. */
  name: string;
  profile: PlatformProfile | null;
}

export interface ResolvedRecording {
  settings: RecordingSettings;
  /** What the settings would be with no overrides. */
  derived: RecordingSettings;
  overrides: RecordingOverrides;
  sources: Record<RecordingField, 'derived' | 'override'>;
  /** Highest-spec known platform, whose profile drives resolution and fps. */
  primaryPlatform: string | null;
  platforms: ResolvedPlatform[];
  advice: RecordingAdvice[];
}

function briefPlatforms(brief: RecordingInputs['brief']): string[] {
  const ext = brief.extensions[PACK_ID];
  const raw =
    ext !== null && typeof ext === 'object' && !Array.isArray(ext) ? ext['gamePlatforms'] : [];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || !p.trim() || seen.has(norm(p))) continue;
    seen.add(norm(p));
    out.push(p.trim());
  }
  return out;
}

/** The profile with most pixels, then higher fps, then name: deterministic. */
function pickPrimary(platforms: ResolvedPlatform[]): PlatformProfile | null {
  const known = platforms.flatMap((p) => (p.profile ? [p.profile] : []));
  known.sort(
    (a, b) =>
      b.resolution.width * b.resolution.height - a.resolution.width * a.resolution.height ||
      b.fps - a.fps ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return known[0] ?? null;
}

function hudNeed(storyboard: RecordingInputs['storyboard']): {
  hud: RecordingSettings['hud'];
  mixed: boolean;
} {
  const huds = new Set<string>();
  for (const sec of storyboard?.sections ?? []) {
    for (const slot of sec.slots) {
      if (slot.kind === 'shot' && slot.hud !== 'any') huds.add(slot.hud);
    }
  }
  if (huds.has('on') && huds.has('off')) return { hud: 'per-shot', mixed: true };
  if (huds.has('on')) return { hud: 'on', mixed: false };
  if (huds.has('off')) return { hud: 'off', mixed: false };
  const type = storyboard?.meta.videoTypeId;
  return { hud: (type && VIDEO_TYPE_HUD[type]) || DEFAULT_HUD, mixed: false };
}

const is169 = (r: Resolution): boolean => Math.abs(r.width / r.height - 16 / 9) < 0.02;

function derive(
  inputs: RecordingInputs,
  primary: PlatformProfile | null,
  overrides: RecordingOverrides,
): RecordingSettings {
  const targets = inputs.formatTargets;
  let resolution = primary?.resolution ?? R(1920, 1080);
  let fps = primary?.fps ?? 60;
  if (!primary || primary.kind === 'pc') {
    // A PC can render at the delivery resolution, so never capture below the largest target.
    for (const t of targets) {
      if (t.resolution.width * t.resolution.height > resolution.width * resolution.height) {
        resolution = t.resolution;
      }
    }
  }
  resolution = overrides.resolution ?? resolution;
  fps = overrides.fps ?? fps;
  const pixels = resolution.width * resolution.height;
  const codec = overrides.codec ?? (pixels > 2560 * 1440 ? 'hevc' : 'h264');
  return {
    resolution,
    fps,
    codec,
    // MKV survives a crash mid-recording; remux to MP4 afterwards if a tool needs it.
    container: overrides.container ?? 'mkv',
    bitrateMbps: overrides.bitrateMbps ?? recommendedBitrateMbps({ resolution, fps, codec }),
    hud: overrides.hud ?? hudNeed(inputs.storyboard).hud,
    hdr: overrides.hdr ?? false,
  };
}

const ADVICE_TEXT: Record<AdviceCode, { severity: 'info' | 'warn'; message: string }> = {
  'no-platforms': {
    severity: 'info',
    message:
      'No game platforms in the brief; assuming a PC capture at 1080p or the largest delivery size.',
  },
  'unknown-platform': { severity: 'warn', message: '' },
  cfr: {
    severity: 'warn',
    message:
      'Record at a constant frame rate (CFR). Variable frame rate drifts out of sync with audio and makes cuts land between frames.',
  },
  'console-capture': {
    severity: 'info',
    message:
      "Use an HDMI capture card at full quality. A console's built-in share or clip feature is heavily compressed and not suited to trailer footage.",
  },
  'pc-overlay': {
    severity: 'warn',
    message:
      'Xbox Game Bar and GPU overlay recorders often capture variable frame rate; prefer OBS with a fixed FPS.',
  },
  'mobile-vfr': {
    severity: 'warn',
    message:
      'Phone screen recorders produce variable frame rate. Capture over USB (for example QuickTime on a Mac) or convert to constant frame rate before editing.',
  },
  'low-fps-platform': {
    severity: 'info',
    message:
      'Many games on this platform run at 30 fps. Set fps to the rate the game really renders, or the recording will contain duplicated frames.',
  },
  'aspect-16-10': {
    severity: 'info',
    message: 'This display is 16:10; crop or letterbox to 16:9 when editing.',
  },
  'below-target-res': { severity: 'warn', message: '' },
  'below-target-fps': { severity: 'warn', message: '' },
  'reframe-headroom': {
    severity: 'info',
    message:
      'Vertical or square cuts crop into the 16:9 frame. Capture at 4K if you can, so the crop stays sharp.',
  },
  'hdr-capable': {
    severity: 'info',
    message:
      'A listed platform can output HDR. Record SDR unless you deliver HDR; HDR footage looks washed out unless tone-mapped to SDR.',
  },
  'hdr-on': {
    severity: 'warn',
    message:
      'HDR recording is on. Footage must be tone-mapped to SDR before editing or it will look washed out.',
  },
  'bitrate-low': { severity: 'warn', message: '' },
  'hud-per-shot': {
    severity: 'info',
    message:
      'Shots differ on HUD; follow the HUD setting on each checklist item instead of one global setting.',
  },
};

/**
 * Resolves the recording settings for a project: derived defaults, then the user's overrides,
 * plus the warnings that apply. Pure and deterministic.
 */
export function resolveRecordingSettings(inputs: RecordingInputs): ResolvedRecording {
  const names = briefPlatforms(inputs.brief);
  const platforms: ResolvedPlatform[] = names.map((name) => ({
    name,
    profile: platformProfile(name),
  }));
  const primary = pickPrimary(platforms);
  const overrides = readRecordingOverrides(inputs);
  const derived = derive(inputs, primary, {});
  const settings = derive(inputs, primary, overrides);

  const sources = Object.fromEntries(
    RECORDING_FIELDS.map((f) => [f, overrides[f] === undefined ? 'derived' : 'override']),
  ) as ResolvedRecording['sources'];

  const advice: RecordingAdvice[] = [];
  const add = (code: AdviceCode, message?: string): void => {
    const base = ADVICE_TEXT[code];
    advice.push({ code, severity: base.severity, message: message ?? base.message });
  };

  if (names.length === 0) add('no-platforms');
  for (const p of platforms) {
    if (!p.profile) {
      add(
        'unknown-platform',
        `"${p.name}" has no capture profile; settings ignore it. Adjust them by hand.`,
      );
    }
  }
  add('cfr');
  const caveats = new Set<AdviceCode>(platforms.flatMap((p) => p.profile?.caveats ?? []));
  for (const code of [
    'console-capture',
    'pc-overlay',
    'mobile-vfr',
    'low-fps-platform',
    'aspect-16-10',
  ] as const) {
    if (caveats.has(code)) add(code);
  }

  const px = settings.resolution.width * settings.resolution.height;
  const bigger = inputs.formatTargets.filter((t) => t.resolution.width * t.resolution.height > px);
  if (bigger.length > 0) {
    const t = bigger.reduce((a, b) =>
      b.resolution.width * b.resolution.height > a.resolution.width * a.resolution.height ? b : a,
    );
    add(
      'below-target-res',
      `Recording at ${settings.resolution.width}×${settings.resolution.height} is below the ${t.name} target (${t.resolution.width}×${t.resolution.height}); the export will be upscaled.`,
    );
  }
  const fast = inputs.formatTargets.filter(
    (t) => t.frameRate.num / t.frameRate.den > settings.fps + 0.01,
  );
  if (fast.length > 0) {
    add(
      'below-target-fps',
      `Recording at ${settings.fps} fps is below the ${fast[0]!.name} target (${Math.round(fast[0]!.frameRate.num / fast[0]!.frameRate.den)} fps).`,
    );
  }
  if (inputs.formatTargets.some((t) => !is169(t.resolution)) && settings.resolution.height < 2160) {
    add('reframe-headroom');
  }

  if (settings.hdr) add('hdr-on');
  else if (platforms.some((p) => p.profile?.hdrCapable)) add('hdr-capable');

  if (hudNeed(inputs.storyboard).mixed && settings.hud === 'per-shot') add('hud-per-shot');

  const rec = recommendedBitrateMbps(settings);
  if (settings.bitrateMbps < rec * 0.6) {
    add(
      'bitrate-low',
      `${settings.bitrateMbps} Mbps is well below the ~${rec} Mbps suggested for ${settings.resolution.width}×${settings.resolution.height} at ${settings.fps} fps; fast motion will look blocky.`,
    );
  }

  return {
    settings,
    derived,
    overrides,
    sources,
    primaryPlatform: primary?.name ?? null,
    platforms,
    advice,
  };
}
