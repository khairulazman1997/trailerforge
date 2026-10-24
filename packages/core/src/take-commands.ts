import type { Draft } from 'immer';
import {
  Flicks,
  Id,
  IsoDateTime,
  ProjectAssetRef,
  Take,
  TakeMatch,
  type Project,
  type ShotSlot,
} from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Recordings attached to shots. These touch only a shot's takes, chosen take and (when a first
 * recording arrives) its status, never its content, so they work in locked sections too: a lock
 * guards what the storyboard says, not which recording fills it.
 */
function findShot(d: Draft<Project>, slotId: string, type: string): Draft<ShotSlot> {
  for (const s of d.storyboard?.sections ?? [])
    for (const slot of s.slots) if (slot.id === slotId && slot.kind === 'shot') return slot;
  throw new CommandError(type, `no shot "${slotId}"`);
}

function allIds(d: Draft<Project>): Set<string> {
  const ids = new Set<string>();
  for (const s of d.storyboard?.sections ?? [])
    for (const slot of s.slots) if (slot.kind === 'shot') for (const t of slot.takes) ids.add(t.id);
  return ids;
}

const AttachItem = z.strictObject({
  slotId: Id,
  assetId: Id,
  matchedBy: TakeMatch,
  /** Optional; minted from the asset id when absent. */
  takeId: Id.optional(),
  sourceIn: Flicks.optional(),
  sourceOut: Flicks.optional(),
  note: z.string().optional(),
  attachedAt: IsoDateTime.optional(),
});
type AttachItem = z.infer<typeof AttachItem>;

function attach(d: Draft<Project>, item: AttachItem, type: string, taken: Set<string>): void {
  const shot = findShot(d, item.slotId, type);
  if (shot.takes.some((t) => t.assetId === item.assetId)) {
    throw new CommandError(type, `that recording is already a take of "${item.slotId}"`);
  }
  if (!d.assets.some((a) => a.assetId === item.assetId)) {
    d.assets.push(
      ProjectAssetRef.parse({
        assetId: item.assetId,
        role: 'footage',
        addedAt: item.attachedAt ?? new Date().toISOString(),
      }),
    );
  }
  let id = item.takeId ?? `take_${item.assetId.replace(/^asset_/, '')}`.slice(0, 56);
  if (taken.has(id)) {
    if (item.takeId) throw new CommandError(type, `take id "${id}" is already used`);
    const base = id;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  }
  taken.add(id);
  shot.takes.push(
    Take.parse({
      id,
      assetId: item.assetId,
      matchedBy: item.matchedBy,
      ...(item.sourceIn !== undefined ? { sourceIn: item.sourceIn } : {}),
      ...(item.sourceOut !== undefined ? { sourceOut: item.sourceOut } : {}),
      ...(item.note ? { note: item.note } : {}),
      attachedAt: item.attachedAt ?? new Date().toISOString(),
    }),
  );
  if (shot.status === 'empty') shot.status = 'recorded';
}

export const attachTake = defineCommand({
  type: 'core/takes.attach',
  payload: AttachItem,
  label: () => 'Attach recording',
  apply: (d, item) => attach(d, item, 'core/takes.attach', allIds(d)),
});

/** Several attachments as one undo step ("accept all suggestions"). */
export const attachTakes = defineCommand({
  type: 'core/takes.attach-many',
  payload: z.strictObject({ items: z.array(AttachItem).min(1).max(1000) }),
  label: ({ items }) => `Attach ${items.length} recording${items.length === 1 ? '' : 's'}`,
  apply: (d, { items }) => {
    const taken = allIds(d);
    for (const item of items) attach(d, item, 'core/takes.attach-many', taken);
  },
});

/** Remove a take from a shot (the recording stays in the library and the project's assets). */
export const detachTake = defineCommand({
  type: 'core/takes.detach',
  payload: z.strictObject({ slotId: Id, takeId: Id }),
  label: () => 'Detach recording',
  apply: (d, { slotId, takeId }) => {
    const shot = findShot(d, slotId, 'core/takes.detach');
    const i = shot.takes.findIndex((t) => t.id === takeId);
    if (i < 0) throw new CommandError('core/takes.detach', `no take "${takeId}" on "${slotId}"`);
    shot.takes.splice(i, 1);
    if (shot.chosenTakeId === takeId) delete shot.chosenTakeId;
  },
});

/** Pick the take the cut uses; null lets the cut choose. */
export const chooseTake = defineCommand({
  type: 'core/takes.choose',
  payload: z.strictObject({ slotId: Id, takeId: Id.nullable() }),
  label: ({ takeId }) => (takeId ? 'Choose take' : 'Let the cut choose the take'),
  apply: (d, { slotId, takeId }) => {
    const shot = findShot(d, slotId, 'core/takes.choose');
    if (takeId === null) {
      delete shot.chosenTakeId;
      return;
    }
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) throw new CommandError('core/takes.choose', `no take "${takeId}" on "${slotId}"`);
    if (take.rejected)
      throw new CommandError('core/takes.choose', 'a rejected take cannot be chosen');
    shot.chosenTakeId = takeId;
  },
});

/** Mark a take unusable (or usable again); a rejected take is never chosen. */
export const rejectTake = defineCommand({
  type: 'core/takes.reject',
  payload: z.strictObject({ slotId: Id, takeId: Id, rejected: z.boolean() }),
  label: ({ rejected }) => (rejected ? 'Reject take' : 'Restore take'),
  apply: (d, { slotId, takeId, rejected }) => {
    const shot = findShot(d, slotId, 'core/takes.reject');
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) throw new CommandError('core/takes.reject', `no take "${takeId}" on "${slotId}"`);
    take.rejected = rejected;
    if (rejected && shot.chosenTakeId === takeId) delete shot.chosenTakeId;
  },
});

export const takeCommands = [
  attachTake,
  attachTakes,
  detachTake,
  chooseTake,
  rejectTake,
] as unknown as readonly CommandDef<unknown>[];
