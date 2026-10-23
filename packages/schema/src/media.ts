import { z } from 'zod';
import { ContentHash, Extensions, Id, IsoDateTime, Seconds } from './common.js';
import { Rate } from './time.js';

export const VideoStreamInfo = z.strictObject({
  index: z.int().nonnegative(),
  codec: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  /** Average frame rate; `variableFrameRate` flags VFR sources (common in captures/phones). */
  frameRate: Rate,
  variableFrameRate: z.boolean(),
  pixelFormat: z.string().optional(),
  bitDepth: z.int().positive().optional(),
  colorSpace: z.string().optional(),
  colorRange: z.enum(['tv', 'pc', 'unknown']).default('unknown'),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  /** Display rotation in degrees from container metadata (phones). */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  hdr: z.boolean().default(false),
});

export const AudioStreamInfo = z.strictObject({
  index: z.int().nonnegative(),
  codec: z.string(),
  sampleRate: z.int().positive(),
  channels: z.int().positive(),
  channelLayout: z.string().optional(),
});

/** Normalized ffprobe summary. */
export const MediaInfo = z.strictObject({
  container: z.string(),
  duration: Seconds,
  sizeBytes: z.int().nonnegative(),
  video: z.array(VideoStreamInfo).default([]),
  audio: z.array(AudioStreamInfo).default([]),
  probedAt: IsoDateTime,
});
export type MediaInfo = z.infer<typeof MediaInfo>;

export const AssetKind = z.enum(['video', 'audio', 'image', 'svg', 'font', 'lottie', 'other']);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetLicense = z.strictObject({
  name: z.string().min(1),
  source: z.string().optional(),
  attributionRequired: z.boolean().default(false),
  notes: z.string().optional(),
});

/**
 * An entry in the app-level shared asset library. Projects reference library assets by id;
 * footage is never copied into projects unless the user asks.
 */
export const LibraryAsset = z.strictObject({
  id: Id,
  kind: AssetKind,
  /** Absolute path or `file://` URI on the user's machine. */
  uri: z.string().min(1),
  contentHash: ContentHash,
  originalName: z.string().min(1),
  media: MediaInfo.optional(),
  tags: z.array(z.string()).default([]),
  /** Campaign-level themes used for footage reuse across videos ("cutdowns"). */
  themes: z.array(z.string()).default([]),
  reuseHistory: z
    .array(
      z.strictObject({
        projectId: Id,
        slotId: Id.optional(),
        usedAt: IsoDateTime,
      }),
    )
    .default([]),
  license: AssetLicense.optional(),
  addedAt: IsoDateTime,
  extensions: Extensions.default({}),
});
export type LibraryAsset = z.infer<typeof LibraryAsset>;

export const AssetRole = z.enum([
  'footage',
  'voiceover',
  'music',
  'sfx',
  'logo',
  'key-art',
  'font',
  'badge',
  'graphic',
  'reference',
  'other',
]);
export type AssetRole = z.infer<typeof AssetRole>;

/** A project's reference to a library asset. */
export const ProjectAssetRef = z.strictObject({
  assetId: Id,
  role: AssetRole,
  addedAt: IsoDateTime,
});
export type ProjectAssetRef = z.infer<typeof ProjectAssetRef>;
