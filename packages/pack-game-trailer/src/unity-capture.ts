import { z } from 'zod';

/**
 * The sidecar the Unity package (`integrations/unity/com.trailerforge.capture`) writes next to every
 * take: `<take>.tfshot.json`. Browser-safe. The file comes from another program and later versions of
 * it may add fields, so unknown fields are ignored (the one place `looseObject` is right); a different
 * `format` or a newer `version` is refused rather than guessed at.
 */
export const UNITY_TAKE_FORMAT = 'trailerforge.unity-take';
export const UNITY_TAKE_VERSION = 1;
export const UNITY_SIDECAR_SUFFIX = '.tfshot.json';

export const UnityTakePass = z.looseObject({
  camera: z.string().default(''),
  hud: z.string().default(''),
  speed: z.number().default(1),
  width: z.number().default(0),
  height: z.number().default(0),
  fps: z.number().default(0),
  codec: z.string().default(''),
});

export const UnityTake = z.looseObject({
  format: z.literal(UNITY_TAKE_FORMAT),
  version: z.literal(UNITY_TAKE_VERSION),
  code: z.string().default(''),
  slotId: z.string().default(''),
  projectId: z.string().default(''),
  take: z.number().int().default(0),
  file: z.string().default(''),
  /** live | camera | replay */
  level: z.string().default('live'),
  pass: UnityTakePass.default(() => UnityTakePass.parse({})),
  frames: z.number().default(0),
  seconds: z.number().default(0),
  performanceId: z.string().nullish(),
});
export type UnityTake = z.infer<typeof UnityTake>;

/** `a/b/TF-XXXXX_take01.mov` → `a/b/TF-XXXXX_take01.tfshot.json` (separators of either kind). */
export function unitySidecarPath(videoPath: string): string {
  const slash = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'));
  const dot = videoPath.lastIndexOf('.');
  const stem = dot > slash ? videoPath.slice(0, dot) : videoPath;
  return stem + UNITY_SIDECAR_SUFFIX;
}

export type ParsedUnityTake =
  | { ok: true; take: UnityTake }
  | { ok: false; reason: 'not-a-take' | 'newer-version' | 'unreadable' };

export function parseUnityTake(text: string): ParsedUnityTake {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const r = UnityTake.safeParse(raw);
  if (r.success) return { ok: true, take: r.data };
  const o = raw as { format?: unknown; version?: unknown } | null;
  if (o && o.format === UNITY_TAKE_FORMAT && typeof o.version === 'number') {
    return { ok: false, reason: o.version > UNITY_TAKE_VERSION ? 'newer-version' : 'unreadable' };
  }
  return { ok: false, reason: 'not-a-take' };
}

/** What the take is called in the app, such as `Unity live · main camera · HUD off · 1280×720 @ 30`. */
export function unityTakeLabel(t: UnityTake): string {
  const level = t.level === 'live' ? 'live' : t.level === 'camera' ? 'camera shot' : t.level;
  const parts = ['Unity ' + level];
  if (t.pass.camera) parts.push(`${t.pass.camera} camera`);
  if (t.pass.hud) parts.push(`HUD ${t.pass.hud}`);
  if (t.pass.speed && t.pass.speed !== 1) parts.push(`${t.pass.speed}× speed`);
  if (t.pass.width && t.pass.height) {
    parts.push(`${t.pass.width}×${t.pass.height}${t.pass.fps ? ` @ ${t.pass.fps}` : ''}`);
  }
  return parts.join(' · ');
}
