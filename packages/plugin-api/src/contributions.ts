/**
 * Everything a plugin can contribute. Data-only contributions have Zod schemas and are
 * validated at registration; behavioral ones are TypeScript interfaces.
 */
import {
  AspectRatio,
  KnowledgeEntityKind,
  PluginRef,
  Rate,
  Resolution,
  Storyboard,
  type Flicks,
} from '@trailerforge/schema';
import { z } from 'zod';

// ---------------------------------------------------------------- data contributions

/** A brief field a video type needs, used by the completeness checker (M2). */
export const BriefRequirement = z.strictObject({
  /** Dotted path into the brief, e.g. `title`, `keyDates`, `extensions.game-trailer.genre`. */
  field: z.string().min(1),
  label: z.string().min(1),
  /** For arrays: minimum number of entries (e.g. 3 selling points). */
  minItems: z.int().positive().optional(),
  /** Multiple-choice options offered in the questionnaire; "suggest for me" is always added. */
  choices: z.array(z.string()).optional(),
});
export type BriefRequirement = z.infer<typeof BriefRequirement>;

export const VideoTypeDef = z.strictObject({
  id: PluginRef,
  name: z.string().min(1),
  description: z.string().default(''),
  requirements: z.array(BriefRequirement).default([]),
  defaultTemplateId: PluginRef.optional(),
  /** Typical duration range in seconds, used for defaults and critique. */
  typicalDuration: z
    .strictObject({ min: z.number().positive(), max: z.number().positive() })
    .optional(),
});
export type VideoTypeDef = z.input<typeof VideoTypeDef>;

export const SafeArea = z.strictObject({
  top: z.number().min(0).max(0.5),
  bottom: z.number().min(0).max(0.5),
  left: z.number().min(0).max(0.5),
  right: z.number().min(0).max(0.5),
});

export const PlatformProfile = z.strictObject({
  id: PluginRef,
  name: z.string().min(1),
  aspects: z.array(AspectRatio).min(1),
  maxDuration: z.number().positive().optional(),
  loudnessLufs: z.number().max(0),
  truePeakDb: z.number().max(0),
  /** Fractions of the frame covered by platform UI (captions, buttons). */
  safeArea: SafeArea,
  captionsRecommended: z.boolean().default(true),
  /** Derivation ruleset used to build this platform's storyboard variant. */
  variantRulesetId: PluginRef.optional(),
});
export type PlatformProfile = z.input<typeof PlatformProfile>;

export const ExportPreset = z.strictObject({
  id: PluginRef,
  name: z.string().min(1),
  container: z.enum(['mp4', 'mov', 'webm', 'mkv']),
  video: z.strictObject({
    codec: z.enum(['h264', 'hevc', 'prores', 'vp9', 'av1']),
    resolution: Resolution.optional(),
    frameRate: Rate.optional(),
    bitrateKbps: z.int().positive().optional(),
    /** Constant-quality value for the codec (crf/qp); used when bitrate is absent. */
    quality: z.number().optional(),
    profile: z.string().optional(),
    pixelFormat: z.string().optional(),
  }),
  audio: z.strictObject({
    codec: z.enum(['aac', 'pcm', 'opus']),
    bitrateKbps: z.int().positive().optional(),
    sampleRate: z.int().positive().default(48_000),
  }),
  platformId: PluginRef.optional(),
  /** Sidecar captions written alongside the video. */
  captions: z.array(z.enum(['srt', 'vtt'])).default([]),
});
export type ExportPreset = z.input<typeof ExportPreset>;

/** UI extension point. The shell renders `entry` lazily; the Planner uses slot `nav.planner`. */
export const UiPanel = z.strictObject({
  id: PluginRef,
  slot: z.enum([
    'nav',
    'nav.planner',
    'inspector',
    'timeline.tools',
    'storyboard.tools',
    'project.settings',
  ]),
  title: z.string().min(1),
  /** Module specifier of the panel component, resolved by the UI shell. */
  entry: z.string().min(1),
  /** Hidden unless this feature flag is on. */
  featureFlag: z.string().optional(),
});
export type UiPanel = z.input<typeof UiPanel>;

// ---------------------------------------------------------------- behavioral contributions

export interface StoryboardTemplate {
  id: string;
  videoTypeId: string;
  name: string;
  description?: string;
  /** Build a starting storyboard; validated against the Storyboard schema by the caller. */
  build(input: { targetDuration: number }): z.input<typeof Storyboard>;
}

/** Shared shape for transitions and effects rendered through FFmpeg filtergraphs. */
export interface FilterContribution<P> {
  id: string;
  name: string;
  params: z.ZodType<P>;
  /** Filtergraph fragment for the render compiler (M4+). Must be deterministic. */
  ffmpeg?: (params: P, ctx: { duration: Flicks; width: number; height: number }) => string;
}

export interface TransitionDef<P = unknown> extends FilterContribution<P> {
  defaultDuration: Flicks;
}

export type EffectDef<P = unknown> = FilterContribution<P>;

/** A step in the footage-analysis pipeline (M4). Python steps run in the analysis sidecar. */
export interface AnalysisStep {
  id: string;
  name: string;
  appliesTo: ('video' | 'audio')[];
  runtime: 'ts' | 'python';
  /** For python steps: JSON-RPC method exposed by the sidecar. */
  pythonMethod?: string;
  /** Other steps whose results this one needs. */
  after?: string[];
}

/** Entity produced by a knowledge extractor before it is merged into `project.knowledge`. */
export interface ExtractedEntity {
  kind: z.infer<typeof KnowledgeEntityKind>;
  name: string;
  description?: string;
  sourcePaths: string[];
  confidence: number;
}

export interface KnowledgeExtractorContext {
  /** Repo root (read-only). */
  root: string;
  /** Repo-relative paths after .gitignore, include/exclude globs and secret filtering. */
  files: readonly string[];
  /** Reads a text file under `root`; refuses paths outside it and files over the size cap. */
  readText(path: string): Promise<string>;
  signal: AbortSignal;
}

/** Reads a local game repo and returns facts for the Game Knowledge digest. Never writes. */
export interface KnowledgeExtractor {
  id: string;
  name: string;
  /** 0..1: how likely this extractor applies to the repo (e.g. Unity: ProjectSettings/ exists). */
  detect(ctx: Pick<KnowledgeExtractorContext, 'root' | 'files'>): Promise<number>;
  extract(ctx: KnowledgeExtractorContext): Promise<ExtractedEntity[]>;
}

export interface MotionRenderJob {
  templateId: string;
  params: Record<string, unknown>;
  duration: Flicks;
  resolution: z.infer<typeof Resolution>;
  frameRate: z.infer<typeof Rate>;
  /** Output file; renderers write video with alpha (e.g. ProRes 4444). */
  outPath: string;
}

/** Renders graphics/motion segments. Built-in canvas renderer by default; EffectCraft optional. */
export interface MotionRenderer {
  id: string;
  name: string;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  supports(templateId: string): boolean;
  render(job: MotionRenderJob, signal: AbortSignal): Promise<{ outPath: string }>;
}

export interface LlmRequest<T> {
  /** Routing key from llm.routes.json, e.g. `storyboard.generate`. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LlmResult<T> {
  value: T;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * LLM backend. `api` providers call a service; `local-cli` runs a local tool (Claude Code);
 * `interactive` providers (Chat Handoff) round-trip through the user.
 */
export interface LlmProvider {
  id: string;
  name: string;
  kind: 'api' | 'local-cli' | 'interactive' | 'mock';
  /** Whether requests leave the machine (shown in the disclosure UI). */
  sendsDataOffDevice: boolean;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  generate<T>(request: LlmRequest<T>, signal: AbortSignal): Promise<LlmResult<T>>;
}
