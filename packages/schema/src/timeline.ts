import { z } from 'zod';
import { Extensions, Id, PluginRef } from './common.js';
import { Resolution } from './format.js';
import { Flicks, Rate } from './time.js';

export const Easing = z.union([
  z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']),
  z.strictObject({ cubicBezier: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
]);
export type Easing = z.infer<typeof Easing>;

export const Keyframe = z.strictObject({
  /** Offset from the item's start. */
  at: Flicks,
  value: z.union([z.number(), z.array(z.number())]),
  easing: Easing.default('linear'),
});
export type Keyframe = z.infer<typeof Keyframe>;

/** A static value or a keyframed animation. Keyframes must be in ascending `at` order. */
export const Animatable = z.union([
  z.number(),
  z.array(z.number()),
  z.strictObject({
    keyframes: z
      .array(Keyframe)
      .min(1)
      .refine((ks) => ks.every((k, i) => i === 0 || k.at > ks[i - 1]!.at), {
        message: 'keyframes must be strictly ascending by `at`',
      }),
  }),
]);
export type Animatable = z.infer<typeof Animatable>;

/** Coordinates are normalized to the frame (0..1) so they survive reframing and resolution changes. */
export const Transform = z.strictObject({
  position: Animatable.default([0.5, 0.5]),
  anchor: Animatable.default([0.5, 0.5]),
  scale: Animatable.default(1),
  rotation: Animatable.default(0),
  opacity: Animatable.default(1),
  /** left, top, right, bottom insets, 0..1. */
  crop: Animatable.default([0, 0, 0, 0]),
});
export type Transform = z.infer<typeof Transform>;

export const EffectInstance = z.strictObject({
  id: Id,
  effectId: PluginRef,
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([Animatable, z.string(), z.boolean()])).default({}),
});
export type EffectInstance = z.infer<typeof EffectInstance>;

const ItemBase = {
  id: Id,
  start: Flicks,
  duration: Flicks.refine((d) => d > 0, { message: 'duration must be > 0' }),
  label: z.string().optional(),
  /** Storyboard slot this item fills, if any. */
  slotId: Id.optional(),
  /** Entry in logs/decisions.jsonl that explains why this item is here. */
  decisionId: Id.optional(),
  extensions: Extensions.default({}),
};

export const ClipItem = z.strictObject({
  ...ItemBase,
  kind: z.literal('clip'),
  assetId: Id,
  sourceIn: Flicks,
  /** Source consumed = duration * speed. */
  speed: z.number().positive().default(1),
  transform: Transform.optional(),
  effects: z.array(EffectInstance).default([]),
  gainDb: Animatable.default(0),
  muted: z.boolean().default(false),
});
export type ClipItem = z.infer<typeof ClipItem>;

export const GraphicItem = z.strictObject({
  ...ItemBase,
  kind: z.literal('graphic'),
  templateId: PluginRef,
  params: z.record(z.string(), z.json()).default({}),
  transform: Transform.optional(),
  effects: z.array(EffectInstance).default([]),
});
export type GraphicItem = z.infer<typeof GraphicItem>;

export const CaptionItem = z.strictObject({
  ...ItemBase,
  kind: z.literal('caption'),
  text: z.string().min(1),
  styleId: PluginRef.optional(),
});
export type CaptionItem = z.infer<typeof CaptionItem>;

/** Nested sequence: another timeline in this project used as a clip. */
export const SequenceItem = z.strictObject({
  ...ItemBase,
  kind: z.literal('sequence'),
  timelineId: Id,
  sourceIn: Flicks,
  transform: Transform.optional(),
  effects: z.array(EffectInstance).default([]),
});
export type SequenceItem = z.infer<typeof SequenceItem>;

/** Rough cuts never silently drop shots: missing media becomes a visible placeholder. */
export const PlaceholderItem = z.strictObject({
  ...ItemBase,
  kind: z.literal('placeholder'),
  reason: z.enum(['missing-footage', 'missing-voiceover', 'missing-asset', 'render-failed']),
  note: z.string().default(''),
});
export type PlaceholderItem = z.infer<typeof PlaceholderItem>;

export const TimelineItem = z.discriminatedUnion('kind', [
  ClipItem,
  GraphicItem,
  CaptionItem,
  SequenceItem,
  PlaceholderItem,
]);
export type TimelineItem = z.infer<typeof TimelineItem>;

/** Transition across the cut between two adjacent items on the same track, centered on the cut. */
export const Transition = z.strictObject({
  id: Id,
  transitionId: PluginRef,
  fromItemId: Id,
  toItemId: Id,
  duration: Flicks,
  params: z.record(z.string(), z.json()).default({}),
  decisionId: Id.optional(),
});
export type Transition = z.infer<typeof Transition>;

export const TrackKind = z.enum(['video', 'audio', 'graphics', 'caption']);
export type TrackKind = z.infer<typeof TrackKind>;

export const itemEnd = (item: { start: number; duration: number }): number =>
  item.start + item.duration;

export const Track = z
  .strictObject({
    id: Id,
    kind: TrackKind,
    name: z.string().default(''),
    muted: z.boolean().default(false),
    locked: z.boolean().default(false),
    items: z.array(TimelineItem).default([]),
    transitions: z.array(Transition).default([]),
  })
  .superRefine((track, ctx) => {
    const sorted = [...track.items].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.start < itemEnd(prev)) {
        ctx.addIssue({
          code: 'custom',
          message: `items "${prev.id}" and "${cur.id}" overlap on track "${track.id}"`,
          path: ['items'],
        });
      }
    }
    const byId = new Map(track.items.map((it) => [it.id, it]));
    track.transitions.forEach((t, i) => {
      const from = byId.get(t.fromItemId);
      const to = byId.get(t.toItemId);
      if (!from || !to) {
        ctx.addIssue({
          code: 'custom',
          message: `transition "${t.id}" references an item not on track "${track.id}"`,
          path: ['transitions', i],
        });
      } else if (itemEnd(from) !== to.start) {
        ctx.addIssue({
          code: 'custom',
          message: `transition "${t.id}" requires "${from.id}" to end exactly where "${to.id}" starts`,
          path: ['transitions', i],
        });
      }
    });
  });
export type Track = z.infer<typeof Track>;

export const Marker = z.strictObject({
  id: Id,
  at: Flicks,
  kind: z.enum(['beat', 'downbeat', 'section', 'hit', 'note']),
  label: z.string().default(''),
});
export type Marker = z.infer<typeof Marker>;

/**
 * General multi-track timeline. Tracks composite in array order (first = bottom).
 * Storyboard slots are linked via `slotId`; the timeline itself is not slot-shaped, so it also
 * serves free-form editing.
 */
export const Timeline = z.strictObject({
  id: Id,
  name: z.string().min(1),
  /** Storyboard variant this timeline realizes; absent for the master or free-form edits. */
  variantId: Id.optional(),
  formatTargetId: Id.optional(),
  frameRate: Rate,
  resolution: Resolution,
  sampleRate: z.int().positive().default(48_000),
  tracks: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
  extensions: Extensions.default({}),
});
export type Timeline = z.infer<typeof Timeline>;

export function timelineDuration(tl: Pick<Timeline, 'tracks'>): number {
  let end = 0;
  for (const track of tl.tracks) for (const item of track.items) end = Math.max(end, itemEnd(item));
  return end;
}
