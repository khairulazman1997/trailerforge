import { z } from 'zod';
import { Extensions, Id, IsoDateTime, PluginRef } from './common.js';
import { FLICKS_PER_SECOND } from './time.js';
import { ExportSettings, Storyboard } from './storyboard.js';

/**
 * Short-form marketing videos (TikToks): concepts proposed by the app's LLM or by Claude Code,
 * and the shorts made from them. A short has its own storyboard (video type
 * `game-trailer/tiktok`) and its own timeline (`shortTimelineId`); it is not a variant of the
 * trailer. The slot inputs (`SlotInput`) and voiceover takes on `VoLine` live in `storyboard.ts`.
 */

/** Where a concept came from. */
export const ConceptSource = z.enum(['app', 'claude-code', 'user']);
export type ConceptSource = z.infer<typeof ConceptSource>;

const Line = (max: number) => z.string().trim().min(1).max(max);

/** One idea for a short: what it is, how it opens, and what to film and say. */
export const Concept = z.strictObject({
  id: Id,
  source: ConceptSource,
  title: Line(120),
  /** The first one or two seconds: what the viewer sees or hears first. */
  hook: Line(300),
  /** The short-form format (a storyboard template id), e.g. `game-trailer/tiktok-montage`. */
  formatId: PluginRef,
  /** Why it fits this game. */
  pitch: z.string().trim().max(1000).default(''),
  /** What to film or gather, one line each. */
  shotList: z.array(Line(300)).max(12).default([]),
  /** Voiceover script, one line each; empty means no voiceover. */
  voiceover: z.array(Line(500)).max(20).default([]),
  /** Intended length, seconds. */
  targetSeconds: z.number().min(5).max(180),
  /** Knowledge entities (mechanics, bosses, levels…) it features. */
  entityIds: z.array(Id).max(20).default([]),
  /** The series it is an episode of, when it was proposed for one. */
  seriesId: Id.optional(),
  createdAt: IsoDateTime,
});
export type Concept = z.infer<typeof Concept>;
export type ConceptInput = z.input<typeof Concept>;

/** The app a short is made for: decides where its own interface covers the picture. */
export const ShortPlatform = z.enum(['tiktok', 'shorts', 'reels']);
export type ShortPlatform = z.infer<typeof ShortPlatform>;

/** Subtitles: the sentence (up to two lines) or a few big words with the spoken one highlighted. */
export const SubtitleStyle = z.enum(['lines', 'word-pop']);
export type SubtitleStyle = z.infer<typeof SubtitleStyle>;

const Nudge = z.int().min(-FLICKS_PER_SECOND).max(FLICKS_PER_SECOND);

/**
 * A hand change to one subtitle cue. `key` names the cue (`<voLineId>#<n>`) and `words` holds
 * its words as they were transcribed (normalised): when the voice is transcribed again and the
 * cue's words still match, the change is kept; otherwise it is dropped with a warning.
 */
export const CueEdit = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,64}#\d{1,3}$/),
  words: z.string().max(500),
  text: z.string().trim().min(1).max(200).optional(),
  /** Move the cue's start or end, flicks (at most a second either way). */
  nudgeIn: Nudge.optional(),
  nudgeOut: Nudge.optional(),
});
export type CueEdit = z.infer<typeof CueEdit>;

export const ShortSubtitles = z.strictObject({
  enabled: z.boolean().default(false),
  style: SubtitleStyle.default('lines'),
  edits: z.array(CueEdit).max(500).default([]),
});
export type ShortSubtitles = z.infer<typeof ShortSubtitles>;

/** Short ids leave room for the `tl_short_` timeline prefix within the 64-character id limit. */
export const ShortId = Id.refine((id) => id.length <= 52, 'short ids are at most 52 characters');

/**
 * A run of TikToks that belong together: the same format, subtitle style and platform, a premise
 * that each episode plays out differently. Episodes are normal shorts linked by `Short.seriesId`;
 * nothing is stored twice. `cadencePerWeek` and `extensions` are kept for the planner (M8).
 */
export const Series = z.strictObject({
  id: Id,
  name: Line(120),
  /** What every episode is about, in a sentence or two; the AI writes episodes from it. */
  premise: z.string().trim().max(1000).default(''),
  /** The short-form format (a storyboard template id) every episode uses. */
  formatId: PluginRef,
  subtitleStyle: SubtitleStyle.default('lines'),
  platform: ShortPlatform.default('tiktok'),
  /** How often the series is meant to post (the planner reads it; nothing here schedules). */
  cadencePerWeek: z.int().min(1).max(14).optional(),
  createdAt: IsoDateTime,
  extensions: Extensions.default({}),
});
export type Series = z.infer<typeof Series>;
export type SeriesInput = z.input<typeof Series>;

/** The number of episodes the AI is asked for at once. */
export const SERIES_EPISODES_MIN = 5;
export const SERIES_EPISODES_MAX = 10;

/** A hashtag without its `#`: letters, digits and underscores. */
export const Hashtag = z
  .string()
  .regex(/^[\p{L}\p{N}_]{1,60}$/u, 'a hashtag is letters, digits and underscores');

/** Tidy a list of hashtags: strip `#` and anything else that is not part of one, drop empties and repeats. */
export function normalizeHashtags(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = raw
      .replace(/^[#\s]+/, '')
      .replace(/[^\p{L}\p{N}_]/gu, '')
      .slice(0, 60);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** What goes with the video when it is posted. Limits follow the apps' own (the caption's is cautious). */
export const PostCopy = z.strictObject({
  caption: z.string().trim().max(2200).default(''),
  hashtags: z.array(Hashtag).max(30).default([]),
  /** The first comment to pin under the post (150 characters, the apps' limit). */
  pinnedComment: z.string().trim().max(150).default(''),
});
export type PostCopy = z.infer<typeof PostCopy>;

/** The cover: a frame of the video (seconds into it; unset = the poster frame) with a title over it. */
export const ShortCover = z.strictObject({
  seconds: z.number().min(0).max(600).optional(),
  title: z.string().trim().max(60).default(''),
});
export type ShortCover = z.infer<typeof ShortCover>;

/** The text file written beside an export: caption, hashtags, pinned comment and cover title; '' if there is none. */
export function formatPostText(post: PostCopy, cover: ShortCover): string {
  const parts: string[] = [];
  if (post.caption) parts.push(post.caption);
  if (post.hashtags.length) parts.push(post.hashtags.map((t) => `#${t}`).join(' '));
  if (post.pinnedComment) parts.push(`Pinned comment:\n${post.pinnedComment}`);
  if (cover.title) parts.push(`Cover title:\n${cover.title}`);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/** The kinds of opening a hook version can be (the label helps the AI and the user; nothing branches on it). */
export const HookKind = z.enum(['cold-open', 'text', 'question', 'custom']);
export type HookKind = z.infer<typeof HookKind>;

/**
 * An alternative opening for a TikTok, for A/B testing: the same body with a different first shot
 * or on-screen text. It changes only the opening shot's recording and its caption, never the
 * length, so the rest of the cut (and the voice, music and subtitles) stays where it is. A hook
 * version renders and exports as its own file, with its own review and approval.
 */
export const ShortHook = z.strictObject({
  /** `a`, `b`, `c`…: lower-case, at most 8 characters, unique within the short. */
  id: z.string().regex(/^[a-z0-9]{1,8}$/),
  name: Line(60),
  kind: HookKind.default('custom'),
  /** On-screen text over the opening shot; empty means no text over it. */
  caption: z.string().trim().max(120).default(''),
  /** Use this take of the opening shot instead of the chosen one. */
  takeId: Id.optional(),
  /** Why it might work (from the AI, or the user's note). */
  why: z.string().trim().max(300).default(''),
});
export type ShortHook = z.infer<typeof ShortHook>;
export type ShortHookInput = z.input<typeof ShortHook>;

export const MAX_HOOKS = 3;

export const Short = z.strictObject({
  id: ShortId,
  name: Line(120),
  createdAt: IsoDateTime,
  /** The picked concept, copied so later edits to the concept list do not change the short. */
  concept: Concept,
  /** The format target it renders at (normally 9:16); unset means the storyboard's resolution. */
  formatTargetId: Id.optional(),
  /** Null until a template is built from the concept (10.3). */
  storyboard: Storyboard.nullable().default(null),
  export: ExportSettings.optional(),
  /** The series this is an episode of, and its number in it (1, 2, 3…). */
  seriesId: Id.optional(),
  episode: z.int().min(1).optional(),
  hooks: z.array(ShortHook).max(MAX_HOOKS).default([]),
  post: PostCopy.default({ caption: '', hashtags: [], pinnedComment: '' }),
  cover: ShortCover.default({ title: '' }),
  platform: ShortPlatform.default('tiktok'),
  subtitles: ShortSubtitles.default({ enabled: false, style: 'lines', edits: [] }),
  /** Clean up the voiceover at render (high-pass, noise reduction, de-esser, compression, level); the files are untouched. */
  voiceClean: z.boolean().default(true),
  extensions: Extensions.default({}),
});
export type Short = z.infer<typeof Short>;

/** The version id of a hook version (`<short id>_hk_<hook id>`): ids stay within 64 characters. */
export const hookVersionId = (shortId: string, hookId: string): string => `${shortId}_hk_${hookId}`;

/**
 * What a version id of a short names: the short itself (its own opening), or one of its hook
 * versions. Undefined for anything else.
 */
export function shortVersionOf(
  project: { shorts: readonly Short[] },
  id: string | null,
): { short: Short; hook?: ShortHook } | undefined {
  if (id === null) return undefined;
  for (const short of project.shorts) {
    if (short.id === id) return { short };
    const hook = short.hooks.find((h) => hookVersionId(short.id, h.id) === id);
    if (hook) return { short, hook };
  }
  return undefined;
}

/** Every version id a short owns: itself and its hook versions. */
export const shortVersionIds = (s: Pick<Short, 'id' | 'hooks'>): string[] => [
  s.id,
  ...s.hooks.map((h) => hookVersionId(s.id, h.id)),
];

/** The id of a short's timeline in `project.timelines`. */
export function shortTimelineId(shortId: string): string {
  return `tl_short_${shortId}`;
}

/** Whether a timeline is a short's (see `shortTimelineId`). */
export const isShortTimeline = (t: { id: string }): boolean => t.id.startsWith('tl_short_');

/** Whether a timeline is the trailer's master cut: `tl_rough`, or a timeline of no version and no short. */
export const isMasterTimeline = (t: { id: string; variantId?: string | undefined }): boolean =>
  t.id === 'tl_rough' || (!t.variantId && !isShortTimeline(t));
