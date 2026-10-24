import { defineCommand, type CommandDef } from '@trailerforge/core';
import { Id, SlotStatus, type Project, type ShotSlot } from '@trailerforge/schema';
import { z } from 'zod';
import { PACK_ID } from './brief-ext.js';
import { buildCapturePlan, readCaptureExt, type CaptureSlotExt } from './capture.js';

/**
 * Capture edits: status, notes, takes, skip and order within a group. They touch only the shot's
 * `status` and `extensions['game-trailer'].capture`, never its content, timing or the storyboard
 * revision, and they work in locked sections (a lock guards the edit, not the recording). Every
 * command is undoable through the command bus.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function findShot(d: Project, slotId: string): ShotSlot {
  for (const section of d.storyboard?.sections ?? []) {
    for (const slot of section.slots) {
      if (slot.id !== slotId) continue;
      if (slot.kind !== 'shot') throw new Error(`"${slotId}" is a card, not a shot to record`);
      return slot;
    }
  }
  throw new Error(`no slot "${slotId}"`);
}

/** Writes the capture state, dropping it (and an emptied pack object) when it is all defaults. */
function storeCapture(slot: ShotSlot, next: CaptureSlotExt): void {
  const current = slot.extensions[PACK_ID];
  const pack: Json = isObject(current) ? { ...current } : {};
  const clean: Json = {};
  if (next.notes !== '') clean['notes'] = next.notes;
  if (next.takes !== 0) clean['takes'] = next.takes;
  if (next.order !== undefined) clean['order'] = next.order;
  if (next.skipped) clean['skipped'] = true;
  if (Object.keys(clean).length > 0) pack['capture'] = clean;
  else delete pack['capture'];
  if (Object.keys(pack).length > 0) slot.extensions[PACK_ID] = pack as never;
  else delete slot.extensions[PACK_ID];
}

function editCapture(
  d: Project,
  slotId: string,
  change: (c: CaptureSlotExt) => CaptureSlotExt,
): void {
  const slot = findShot(d, slotId);
  storeCapture(slot, change(readCaptureExt(slot)));
}

export const setShotStatus = defineCommand({
  type: 'game-trailer/capture.set-status',
  payload: z.strictObject({ slotId: Id, status: SlotStatus }),
  label: ({ status }) => `Mark shot ${status}`,
  apply: (d, { slotId, status }) => {
    findShot(d, slotId).status = status;
  },
});

export const setCaptureNotes = defineCommand({
  type: 'game-trailer/capture.set-notes',
  payload: z.strictObject({ slotId: Id, notes: z.string() }),
  label: () => 'Edit capture notes',
  apply: (d, { slotId, notes }) => editCapture(d, slotId, (c) => ({ ...c, notes })),
  merge: { key: ({ slotId }) => slotId, windowMs: 1500 },
});

export const setCaptureTakes = defineCommand({
  type: 'game-trailer/capture.set-takes',
  payload: z.strictObject({ slotId: Id, takes: z.int().nonnegative() }),
  label: () => 'Change take count',
  apply: (d, { slotId, takes }) => editCapture(d, slotId, (c) => ({ ...c, takes })),
});

export const setShotSkipped = defineCommand({
  type: 'game-trailer/capture.set-skipped',
  payload: z.strictObject({ slotId: Id, skipped: z.boolean() }),
  label: ({ skipped }) => (skipped ? 'Skip shot' : 'Restore shot'),
  apply: (d, { slotId, skipped }) => editCapture(d, slotId, (c) => ({ ...c, skipped })),
});

/**
 * Put one capture group's shots in a new order. `slotIds` must be exactly the shots of one group
 * as the plan shows it; the storyboard order is left alone.
 */
export const reorderCaptureGroup = defineCommand({
  type: 'game-trailer/capture.reorder-group',
  payload: z.strictObject({ slotIds: z.array(Id).min(1) }),
  label: () => 'Reorder shots in group',
  apply: (d, { slotIds }) => {
    if (new Set(slotIds).size !== slotIds.length) throw new Error('slotIds must be unique');
    if (!d.storyboard) throw new Error('the project has no storyboard');
    const plan = buildCapturePlan(d.storyboard, d.knowledge);
    const group = plan.groups.find((g) => g.items.some((i) => i.slotId === slotIds[0]));
    const members = new Set(group?.items.map((i) => i.slotId));
    if (!group || members.size !== slotIds.length || !slotIds.every((id) => members.has(id))) {
      throw new Error('slotIds must be exactly the shots of one capture group');
    }
    slotIds.forEach((id, order) => editCapture(d, id, (c) => ({ ...c, order })));
  },
});

export const captureCommands = [
  setShotStatus,
  setCaptureNotes,
  setCaptureTakes,
  setShotSkipped,
  reorderCaptureGroup,
] as unknown as readonly CommandDef<unknown>[];
