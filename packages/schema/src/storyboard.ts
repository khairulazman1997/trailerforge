import { z } from 'zod';
import { Extensions, Id, IsoDateTime, PluginRef, Seconds } from './common.js';
import { Resolution } from './format.js';
import { FLICKS_PER_SECOND, Flicks } from './time.js';

export const SlotStatus = z.enum(['empty', 'recorded', 'approved', 'rejected']);
export type SlotStatus = z.infer<typeof SlotStatus>;

/** min <= ideal <= max, in seconds. */
export const DurationRange = z
  .strictObject({ min: Seconds, ideal: Seconds, max: Seconds })
  .refine((d) => d.min <= d.ideal && d.ideal <= d.max, {
    message: 'duration must satisfy min <= ideal <= max',
  });
export type DurationRange = z.infer<typeof DurationRange>;

/** Reference to a transition plugin with parameters. */
export const TransitionRef = z.strictObject({
  transitionId: PluginRef,
  duration: Seconds.default(0),
  params: z.record(z.string(), z.json()).default({}),
});
export type TransitionRef = z.infer<typeof TransitionRef>;

/** A finishing effect on a slot's picture (an id from the installed effects, with its params). */
export const SlotEffect = z.strictObject({
  effectId: PluginRef,
  params: z.record(z.string(), z.json()).default({}),
});
export type SlotEffect = z.infer<typeof SlotEffect>;

/** Text or graphic placed over a shot (lower-third, caption-style callout, etc.). */
export const Overlay = z.strictObject({
  id: Id,
  templateId: PluginRef,
  text: z.string().optional(),
  params: z.record(z.string(), z.json()).default({}),
  /** Offset from slot start and on-screen time, seconds. */
  offset: Seconds.default(0),
  duration: Seconds.optional(),
});
export type Overlay = z.infer<typeof Overlay>;

const SlotBase = {
  id: Id,
  title: z.string().default(''),
  /** Why this slot exists in the edit. */
  purpose: z.string().default(''),
  duration: DurationRange,
  priority: z.enum(['must', 'nice']).default('must'),
  transitionIn: TransitionRef.optional(),
  transitionOut: TransitionRef.optional(),
  /** Finishing effects on this slot's picture; most slots have none. */
  effects: z.array(SlotEffect).max(3).default([]),
  audioNotes: z.string().default(''),
  /** Knowledge entities (levels, bosses, abilities...) this slot features. */
  entityIds: z.array(Id).default([]),
  tags: z.array(z.string()).default([]),
  extensions: Extensions.default({}),
};

/** How a recording came to be attached to a shot. */
export const TakeMatch = z.enum(['code', 'suggestion', 'vision', 'manual']);
export type TakeMatch = z.infer<typeof TakeMatch>;

/**
 * A recording attached to a shot. Only the user's decisions live here; probe data, analysis and
 * match scores are regenerable cache keyed by the asset's hash. The Game Trailer pack's manual
 * takes counter (`extensions['game-trailer'].capture.takes`) is separate: it counts takes
 * recorded but never imported.
 */
export const Take = z
  .strictObject({
    id: Id,
    /** Must be in `project.assets`. */
    assetId: Id,
    matchedBy: TakeMatch,
    rejected: z.boolean().default(false),
    /** Optional in/out hint inside the recording, flicks from the start of the file. */
    sourceIn: Flicks.optional(),
    sourceOut: Flicks.optional(),
    note: z.string().default(''),
    attachedAt: IsoDateTime,
  })
  .refine(
    (t) => t.sourceIn === undefined || t.sourceOut === undefined || t.sourceIn < t.sourceOut,
    {
      message: 'sourceIn must be before sourceOut',
    },
  );
export type Take = z.infer<typeof Take>;

/** A slot to be filled with recorded footage. */
export const ShotSlot = z.strictObject({
  ...SlotBase,
  kind: z.literal('shot'),
  /** Exactly what to do/show while recording. */
  captureInstruction: z.string().default(''),
  framing: z.string().default(''),
  /** Required state/setup before recording (level, loadout, time of day...). */
  setup: z.string().default(''),
  /** Location/scene used to group the capture checklist. */
  location: z.string().default(''),
  hud: z.enum(['on', 'off', 'any']).default('any'),
  /** Alternate ideas if the primary capture isn't possible. */
  alternates: z.array(z.string()).default([]),
  overlays: z.array(Overlay).default([]),
  status: SlotStatus.default('empty'),
  /** Recordings attached to this shot, in attach order. */
  takes: z.array(Take).default([]),
  /** The take the cut uses; unset means the cut picks the best non-rejected take. */
  chosenTakeId: Id.optional(),
});
export type ShotSlot = z.infer<typeof ShotSlot>;

/** A full-screen generated card: title, release date, laurels, logo reveal, end slate. */
export const CardSlot = z.strictObject({
  ...SlotBase,
  kind: z.literal('card'),
  cardKind: z.enum(['title', 'tagline', 'date', 'laurels', 'quote', 'logo', 'cta', 'custom']),
  templateId: PluginRef,
  text: z.string().default(''),
  params: z.record(z.string(), z.json()).default({}),
  styleTokens: z.record(z.string(), z.string()).default({}),
});
export type CardSlot = z.infer<typeof CardSlot>;

export const Slot = z.discriminatedUnion('kind', [ShotSlot, CardSlot]);
export type Slot = z.infer<typeof Slot>;

/** Act/section; slot order is array order. */
export const Section = z.strictObject({
  id: Id,
  name: z.string().min(1),
  /** Role hint for generation/critique, e.g. `hook`, `escalation`, `end-slate`. */
  role: z.string().optional(),
  purpose: z.string().default(''),
  locked: z.boolean().default(false),
  slots: z.array(Slot).default([]),
});
export type Section = z.infer<typeof Section>;

export const VoLine = z.strictObject({
  id: Id,
  speaker: z.string().default('Narrator'),
  text: z.string().min(1),
  direction: z.string().default(''),
  targetDuration: Seconds.optional(),
  linkedSlotIds: z.array(Id).default([]),
  status: SlotStatus.default('empty'),
});
export type VoLine = z.infer<typeof VoLine>;

/**
 * The user's corrections to the beat grid found in the music track. Only these nudges are
 * stored; the beats themselves are analysis (cache) and the grid is computed from both.
 */
export const MusicGridSettings = z.strictObject({
  /** Which beat starts a bar, shifted by this many beats from what analysis found. */
  downbeatShift: z.int().min(-11).max(11).default(0),
  /** Replace the detected beats with an even grid at this tempo (BPM), anchored on a downbeat. */
  tempo: z.number().min(30).max(300).optional(),
  /** Beats in a bar; analysis assumes 4. */
  beatsPerBar: z.int().min(1).max(12).optional(),
  barsPerPhrase: z.int().min(1).max(16).default(4),
  /** Move the whole grid later (positive) or earlier, in flicks; at most one second. */
  offset: z.int().min(-FLICKS_PER_SECOND).max(FLICKS_PER_SECOND).default(0),
});
export type MusicGridSettings = z.infer<typeof MusicGridSettings>;

export const MusicPlan = z.strictObject({
  trackAssetId: Id.optional(),
  /** Nudges to the analysed beat grid of `trackAssetId`; reset when the track changes. */
  grid: MusicGridSettings.optional(),
  direction: z.string().default(''),
  bpm: z
    .strictObject({ min: z.number().positive(), max: z.number().positive() })
    .refine((b) => b.min <= b.max, { message: 'bpm.min must be <= bpm.max' })
    .optional(),
  structure: z
    .array(
      z.strictObject({
        id: Id,
        label: z.enum(['intro', 'build', 'drop', 'break', 'climax', 'outro', 'custom']),
        sectionIds: z.array(Id).default([]),
      }),
    )
    .default([]),
  /** Moments a cut, impact or silence should land on. */
  hitPoints: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.enum(['cut', 'impact', 'drop', 'silence']),
        slotId: Id,
        position: z.enum(['start', 'end']).default('start'),
        note: z.string().default(''),
      }),
    )
    .default([]),
  sfxCues: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.enum(['whoosh', 'impact', 'riser', 'sub-drop', 'custom']),
        slotId: Id,
        position: z.enum(['before', 'start', 'end']).default('start'),
        assetId: Id.optional(),
      }),
    )
    .default([]),
});
export type MusicPlan = z.infer<typeof MusicPlan>;

/** Per-slot override in a variant (sparse: only what differs from the master). */
export const SlotOverride = z.strictObject({
  /** true drops the slot from this variant; false keeps it even when a cutdown would drop it. */
  excluded: z.boolean().optional(),
  /** Retime: the slot's length range in this variant; its ideal is the length to start from. */
  duration: DurationRange.optional(),
  /** Use this take of the shot instead of the one the master cut uses. */
  takeId: Id.optional(),
  /** Normalized crop center (0..1) for reframing, before keyframed crops in the timeline. */
  cropCenter: z
    .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .optional(),
  overlays: z.array(Overlay).optional(),
});
export type SlotOverride = z.infer<typeof SlotOverride>;

/** How a variant fits the master's picture into its aspect ratio. */
export const ReframeSettings = z.strictObject({
  /** `crop` follows each shot's focus point (blurred fill when it cannot fit); `fill` never crops. */
  mode: z.enum(['crop', 'fill']).default('crop'),
});
export type ReframeSettings = z.infer<typeof ReframeSettings>;

/**
 * A version of the trailer (aspect ratio, length) derived from the master cut on demand. Only
 * its rules and sparse per-slot overrides are stored, never a timeline, so edits to the master
 * flow into every variant.
 */
export const StoryboardVariant = z.strictObject({
  id: Id,
  name: z.string().default(''),
  formatTargetId: Id,
  /** Length to cut down to, seconds; unset keeps the master's length. */
  targetDuration: z.number().positive().optional(),
  reframe: ReframeSettings.default({ mode: 'crop' }),
  /** Derivation ruleset from a platform profile; reserved, not used yet. */
  rulesetId: PluginRef.optional(),
  overrides: z.record(Id, SlotOverride).default({}),
});
export type StoryboardVariant = z.infer<typeof StoryboardVariant>;
export const Variant = StoryboardVariant;
export type Variant = StoryboardVariant;

export const StoryboardMeta = z.strictObject({
  videoTypeId: PluginRef,
  templateId: PluginRef.optional(),
  tone: z.array(z.string()).default([]),
  targetDuration: Seconds,
  /** Resolution the master is designed at; variants reframe from it. */
  masterResolution: Resolution.optional(),
});

export const Storyboard = z.strictObject({
  id: Id,
  /** Incremented on every committed change; used for review links and A/B compare. */
  revision: z.int().nonnegative().default(0),
  meta: StoryboardMeta,
  sections: z.array(Section).default([]),
  voLines: z.array(VoLine).default([]),
  music: MusicPlan.default({
    direction: '',
    structure: [],
    hitPoints: [],
    sfxCues: [],
  }),
  variants: z.array(StoryboardVariant).default([]),
  extensions: Extensions.default({}),
});
export type Storyboard = z.infer<typeof Storyboard>;
