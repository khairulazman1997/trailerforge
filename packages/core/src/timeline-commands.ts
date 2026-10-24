import type { Draft } from 'immer';
import {
  Id,
  Flicks,
  PlaceholderItem,
  Timeline,
  type Project,
  type TimelineItem,
  type Track,
} from '@trailerforge/schema';
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

/** Move an edge: `in` (positive = later start, shorter) or `out` (positive = longer), in flicks. */
export const trimItem = defineCommand({
  type: 'core/timeline.trim',
  payload: z.strictObject({ ...Ref, edge: z.enum(['in', 'out']), delta: z.int() }),
  label: ({ edge }) => `Trim ${edge === 'in' ? 'start' : 'end'}`,
  apply: (d, { timelineId, itemId, edge, delta }) => {
    const { item } = find(d, timelineId, itemId, 'core/timeline.trim');
    if (edge === 'in') {
      item.start += delta;
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
    markEdited(item);
  },
  merge: {
    key: ({ timelineId, itemId, edge }) => `${timelineId}/${itemId}/${edge}`,
    windowMs: 1000,
  },
});

export const moveItem = defineCommand({
  type: 'core/timeline.move',
  payload: z.strictObject({ ...Ref, start: Flicks }),
  label: () => 'Move clip',
  apply: (d, { timelineId, itemId, start }) => {
    const { item } = find(d, timelineId, itemId, 'core/timeline.move');
    item.start = start;
    markEdited(item);
  },
  merge: { key: ({ timelineId, itemId }) => `${timelineId}/${itemId}`, windowMs: 1000 },
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
  deleteItem,
  setTrackLocked,
] as unknown as readonly CommandDef<unknown>[];
