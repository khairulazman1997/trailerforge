import { z } from 'zod';
import { Extensions, Id, IsoDateTime, PluginRef } from './common.js';
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
  createdAt: IsoDateTime,
});
export type Concept = z.infer<typeof Concept>;
export type ConceptInput = z.input<typeof Concept>;

/** Short ids leave room for the `tl_short_` timeline prefix within the 64-character id limit. */
export const ShortId = Id.refine((id) => id.length <= 52, 'short ids are at most 52 characters');

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
  extensions: Extensions.default({}),
});
export type Short = z.infer<typeof Short>;

/** The id of a short's timeline in `project.timelines`. */
export function shortTimelineId(shortId: string): string {
  return `tl_short_${shortId}`;
}
