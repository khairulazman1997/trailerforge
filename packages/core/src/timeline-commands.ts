import type { Draft } from 'immer';
import {
  EffectInstance,
  FLICKS_PER_SECOND,
  Id,
  PluginRef,
  Flicks,
  PlaceholderItem,
  Timeline,
  type Project,
  type TimelineItem,
  type Track,
} from '@trailerforge/schema';
import {
  FlashRiskError,
  assertFlashSafe,
  builtinFilters,
  flashEvents,
  type FlashEvent,
} from '@trailerforge/effects';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Timeline edits. Every edit marks the item `extensions.core.userEdited`, so regenerating the
 * rough cut keeps it; items on a locked track cannot be edited. Overlaps and broken references
 * are refused by the store's validation of the result.
 */

type DItem = Draft<TimelineItem>;

function find(
  d: Draft<Project>,
  timelineId: string,
  itemId: string,
  type: string,
): { track: Draft<Track>; item: DItem; index: number } {
  const tl = d.timelines.find((t) => t.id === timelineId);
  if (!tl) throw new CommandError(type, `no timeline "${timelineId}"`);
  for (const track of tl.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index >= 0) {
      if (track.locked) throw new CommandError(type, `track "${track.name || track.id}" is locked`);
      return { track, item: track.items[index]!, index };
    }
  }
  throw new CommandError(type, `no item "${itemId}" in timeline "${timelineId}"`);
}

function markEdited(item: DItem): void {
  const core = (item.extensions.core as Record<string, unknown> | undefined) ?? {};
  item.extensions.core = { ...core, userEdited: true };
}

/** Whether an item was changed by hand (regenerating keeps it). */
export const isUserEdited = (item: { extensions: Record<string, unknown> }): boolean =>
  (item.extensions.core as { userEdited?: unknown } | undefined)?.userEdited === true;

/** Create or replace a whole timeline (applying a generated rough cut is one undo step). */
export const setTimeline = defineCommand({
  type: 'core/timeline.set',
  payload: z.strictObject({ timeline: Timeline }),
  label: ({ timeline }) => `Update "${timeline.name}"`,
  apply: (d, { timeline }) => {
    const i = d.timelines.findIndex((t) => t.id === timeline.id);
    if (i >= 0) d.timelines[i] = timeline;
    else d.timelines.push(timeline);
  },
});

const Ref = { timelineId: Id, itemId: Id };

/** Drop the track's transitions whose two items no longer meet exactly (after a trim or move). */
function pruneTransitions(track: Draft<Track>): void {
  const end = new Map(track.items.map((i) => [i.id, i.start + i.duration]));
  const start = new Map(track.items.map((i) => [i.id, i.start]));
  track.transitions = track.transitions.filter(
    (t) =>
      end.has(t.fromItemId) &&
      start.has(t.toItemId) &&
      end.get(t.fromItemId) === start.get(t.toItemId),
  );
}

/** Items on `track` starting at or after `from` (other than `except`), moved by `delta`. */
function shiftFollowers(track: Draft<Track>, from: number, delta: number, except: string): void {
  if (delta === 0) return;
  for (const it of track.items) {
    if (it.id === except || it.start < from) continue;
    it.start += delta;
    markEdited(it);
  }
}

/**
 * Move an edge: `in` (positive = later start, shorter) or `out` (positive = longer), in flicks.
 * With `ripple`, the item keeps its start and the items after it on the track move by the change
 * in length instead (later for longer, earlier for shorter).
 */
export const trimItem = defineCommand({
  type: 'core/timeline.trim',
  payload: z.strictObject({
    ...Ref,
    edge: z.enum(['in', 'out']),
    delta: z.int(),
    ripple: z.boolean().optional(),
  }),
  label: ({ edge, ripple }) =>
    `${ripple ? 'Ripple trim' : 'Trim'} ${edge === 'in' ? 'start' : 'end'}`,
  apply: (d, { timelineId, itemId, edge, delta, ripple }) => {
    const { item, track } = find(d, timelineId, itemId, 'core/timeline.trim');
    const oldEnd = item.start + item.duration;
    if (edge === 'in') {
      if (!ripple) item.start += delta;
      item.duration -= delta;
      if ('sourceIn' in item)
        item.sourceIn += Math.round(delta * ('speed' in item ? item.speed : 1));
    } else item.duration += delta;
    if (item.start < 0 || item.duration <= 0 || ('sourceIn' in item && item.sourceIn < 0)) {
      throw new CommandError(
        'core/timeline.trim',
        'that trim goes past the start or end of the item',
      );
    }
    if (ripple) shiftFollowers(track, oldEnd, edge === 'in' ? -delta : delta, itemId);
    markEdited(item);
    pruneTransitions(track);
  },
  merge: {
    key: ({ timelineId, itemId, edge, ripple }) =>
      `${timelineId}/${itemId}/${edge}${ripple ? '/ripple' : ''}`,
    windowMs: 1000,
  },
});

/**
 * Move an item to `start`, optionally onto another track of the same kind. With
 * `ripple`, on the same track the items after it move by the same amount; onto another track,
 * the items after it close the gap it leaves and the items from `start` on the new track make
 * room for it. Overlaps that remain are refused by the store's validation.
 */
export const moveItem = defineCommand({
  type: 'core/timeline.move',
  payload: z.strictObject({
    ...Ref,
    start: Flicks,
    trackId: Id.optional(),
    ripple: z.boolean().optional(),
  }),
  label: ({ trackId, ripple }) =>
    `${ripple ? 'Ripple move' : 'Move'} clip${trackId ? ' to another track' : ''}`,
  apply: (d, { timelineId, itemId, start, trackId, ripple }) => {
    const type = 'core/timeline.move';
    const { item, track, index } = find(d, timelineId, itemId, type);
    const oldStart = item.start;
    const oldEnd = oldStart + item.duration;
    const target =
      trackId && trackId !== track.id
        ? d.timelines.find((t) => t.id === timelineId)!.tracks.find((t) => t.id === trackId)
        : track;
    if (!target) throw new CommandError(type, `no track "${trackId}"`);
    if (target.locked)
      throw new CommandError(type, `track "${target.name || target.id}" is locked`);
    if (target.kind !== track.kind)
      throw new CommandError(type, `it can only move to another ${track.kind} track`);
    if (target === track) {
      if (ripple) shiftFollowers(track, oldEnd, start - oldStart, itemId);
      item.start = start;
      markEdited(item);
      pruneTransitions(track);
      return;
    }
    track.items.splice(index, 1);
    track.transitions = track.transitions.filter(
      (t) => t.fromItemId !== itemId && t.toItemId !== itemId,
    );
    if (ripple) {
      shiftFollowers(track, oldEnd, -item.duration, itemId);
      shiftFollowers(target, start, item.duration, itemId);
      pruneTransitions(track);
    }
    item.start = start;
    markEdited(item);
    target.items.push(item);
    target.items.sort((a, b) => a.start - b.start);
    pruneTransitions(target);
  },
  merge: {
    key: ({ timelineId, itemId, trackId, ripple }) =>
      `${timelineId}/${itemId}/${trackId ?? ''}${ripple ? '/ripple' : ''}`,
    windowMs: 1000,
  },
});

/** Fill an item from another recording (or another moment of the same one). */
export const swapTake = defineCommand({
  type: 'core/timeline.swap-take',
  payload: z.strictObject({ ...Ref, assetId: Id, sourceIn: Flicks }),
  label: () => 'Swap take',
  apply: (d, { timelineId, itemId, assetId, sourceIn }) => {
    const { track, item, index } = find(d, timelineId, itemId, 'core/timeline.swap-take');
    if (item.kind === 'clip') {
      item.assetId = assetId;
      item.sourceIn = sourceIn;
      markEdited(item);
    } else if (item.kind === 'placeholder') {
      const clip = {
        id: item.id,
        kind: 'clip' as const,
        start: item.start,
        duration: item.duration,
        ...(item.slotId ? { slotId: item.slotId } : {}),
        ...(item.label ? { label: item.label } : {}),
        assetId,
        sourceIn,
        speed: 1,
        effects: [],
        gainDb: 0,
        muted: false,
        extensions: {
          ...item.extensions,
          core: { ...((item.extensions.core as object) ?? {}), userEdited: true },
        },
      };
      track.items[index] = clip;
    } else
      throw new CommandError('core/timeline.swap-take', 'only clips and placeholders take footage');
  },
});

/** Empty an item back to a visible placeholder. */
export const toPlaceholder = defineCommand({
  type: 'core/timeline.to-placeholder',
  payload: z.strictObject({ ...Ref, note: z.string().optional() }),
  label: () => 'Replace with placeholder',
  apply: (d, { timelineId, itemId, note }) => {
    const { track, item, index } = find(d, timelineId, itemId, 'core/timeline.to-placeholder');
    track.items[index] = PlaceholderItem.parse({
      id: item.id,
      kind: 'placeholder',
      start: item.start,
      duration: item.duration,
      ...(item.slotId ? { slotId: item.slotId } : {}),
      ...(item.label ? { label: item.label } : {}),
      reason: 'missing-footage',
      note: note ?? 'emptied by hand',
      extensions: {
        ...item.extensions,
        core: { ...((item.extensions.core as object) ?? {}), userEdited: true },
      },
    });
    track.transitions = track.transitions.filter(
      (t) => t.fromItemId !== itemId && t.toItemId !== itemId,
    );
  },
});

/**
 * Set (or, with null, remove) the transition into a picture item from the item before it on the
 * same track. The two must meet exactly, and the overlap is at most the shorter of the two. A
 * transition set by hand has no decision behind it, so a rebuild of the cut keeps it.
 */
export const setTransition = defineCommand({
  type: 'core/timeline.set-transition',
  payload: z.strictObject({
    timelineId: Id,
    /** The item the transition leads into. */
    toItemId: Id,
    transition: z
      .strictObject({
        transitionId: PluginRef,
        duration: Flicks.refine((d) => d > 0, { message: 'duration must be > 0' }),
        params: z.record(z.string(), z.json()).default({}),
      })
      .nullable(),
  }),
  label: ({ transition }) => (transition ? 'Set transition' : 'Remove transition'),
  apply: (d, { timelineId, toItemId, transition }) => {
    const type = 'core/timeline.set-transition';
    const { track, item, index } = find(d, timelineId, toItemId, type);
    track.transitions = track.transitions.filter((t) => t.toItemId !== toItemId);
    if (!transition) return;
    const from = track.items[index - 1];
    if (!from || from.start + from.duration !== item.start)
      throw new CommandError(
        type,
        'a transition needs the clip before it on the same track, touching it',
      );
    const duration = Math.min(transition.duration, from.duration, item.duration);
    // The photosensitivity guard, as when the cut is built: refuse a transition that would take
    // the cut over three flashes in a second (installed ones this package does not know pass).
    const filters = builtinFilters();
    const flashes: FlashEvent[] = [];
    const tl = d.timelines.find((t) => t.id === timelineId)!;
    const rate = tl.frameRate;
    const add = (id: string, params: unknown, dur: number, cutAt: number, key: string) => {
      const def = filters.get(id);
      if (!def) return;
      const ctx = {
        width: tl.resolution.width,
        height: tl.resolution.height,
        rate,
        duration: dur / FLICKS_PER_SECOND,
      };
      for (const e of flashEvents(def, params, ctx, (cutAt - dur / 2) / FLICKS_PER_SECOND))
        flashes.push({ ...e, source: `${e.source} (${key})` });
    };
    for (const t of tl.tracks
      .flatMap((k) => k.transitions.map((x) => ({ k, x })))
      .filter(({ x }) => x.toItemId !== toItemId)) {
      const to = t.k.items.find((i) => i.id === t.x.toItemId);
      if (to) add(t.x.transitionId, t.x.params, t.x.duration, to.start, t.x.id);
    }
    add(transition.transitionId, transition.params, duration, item.start, 'new');
    try {
      assertFlashSafe(flashes);
    } catch (err) {
      if (err instanceof FlashRiskError)
        throw new CommandError(type, `${err.message}. Choose a calmer transition or move it.`);
      throw err;
    }
    track.transitions.push({
      id: `tr_${toItemId}`.slice(0, 64),
      transitionId: transition.transitionId,
      fromItemId: from.id,
      toItemId,
      duration,
      params: transition.params,
    });
  },
});

/** Set the effects on a picture item by hand; a rebuild of the cut keeps them. */
export const setItemEffects = defineCommand({
  type: 'core/timeline.set-effects',
  payload: z.strictObject({ ...Ref, effects: z.array(EffectInstance).max(8) }),
  label: ({ effects }) => (effects.length ? 'Change effects' : 'Remove effects'),
  apply: (d, { timelineId, itemId, effects }) => {
    const { item } = find(d, timelineId, itemId, 'core/timeline.set-effects');
    if (item.kind === 'caption' || item.kind === 'placeholder')
      throw new CommandError('core/timeline.set-effects', `a ${item.kind} cannot carry effects`);
    item.effects = effects;
    markEdited(item);
  },
});

/** J and L offsets are capped at one second (the compiler caps them too). */
const AudioOffset = Flicks.max(FLICKS_PER_SECOND);

/**
 * A clip's own sound: off by default (music and sound effects carry a trailer). On, it plays at
 * `gainDb`, and may start `lead` before the picture (J cut) or run `lag` past it (L cut).
 */
export const setClipAudio = defineCommand({
  type: 'core/timeline.set-clip-audio',
  payload: z.strictObject({
    ...Ref,
    enabled: z.boolean(),
    gainDb: z.number().min(-60).max(12).optional(),
    lead: AudioOffset.default(0),
    lag: AudioOffset.default(0),
  }),
  label: ({ enabled }) => (enabled ? "Use the clip's sound" : "Mute the clip's sound"),
  apply: (d, { timelineId, itemId, enabled, gainDb, lead, lag }) => {
    const type = 'core/timeline.set-clip-audio';
    const { track, item } = find(d, timelineId, itemId, type);
    if (item.kind !== 'clip') throw new CommandError(type, `a ${item.kind} has no sound`);
    if (track.kind !== 'video')
      throw new CommandError(type, 'only clips on a picture track have their own sound setting');
    const core = (item.extensions.core as Record<string, unknown> | undefined) ?? {};
    item.extensions.core = { ...core, clipAudio: { enabled, lead, lag } };
    if (gainDb !== undefined) item.gainDb = gainDb;
    markEdited(item);
  },
});

export const deleteItem = defineCommand({
  type: 'core/timeline.delete',
  payload: z.strictObject(Ref),
  label: () => 'Delete clip',
  apply: (d, { timelineId, itemId }) => {
    const { track, index } = find(d, timelineId, itemId, 'core/timeline.delete');
    track.items.splice(index, 1);
    track.transitions = track.transitions.filter(
      (t) => t.fromItemId !== itemId && t.toItemId !== itemId,
    );
  },
});

export const setTrackLocked = defineCommand({
  type: 'core/timeline.set-track-locked',
  payload: z.strictObject({ timelineId: Id, trackId: Id, locked: z.boolean() }),
  label: ({ locked }) => (locked ? 'Lock track' : 'Unlock track'),
  apply: (d, { timelineId, trackId, locked }) => {
    const track = d.timelines
      .find((t) => t.id === timelineId)
      ?.tracks.find((t) => t.id === trackId);
    if (!track) throw new CommandError('core/timeline.set-track-locked', `no track "${trackId}"`);
    track.locked = locked;
  },
});

export const timelineCommands = [
  setTimeline,
  trimItem,
  moveItem,
  swapTake,
  toPlaceholder,
  setItemEffects,
  setTransition,
  setClipAudio,
  deleteItem,
  setTrackLocked,
] as unknown as readonly CommandDef<unknown>[];
