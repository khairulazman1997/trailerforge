import { defineCommand, type CommandDef } from '@trailerforge/core';
import {
  CardSlot,
  collectIds,
  DurationRange,
  Id,
  Overlay,
  PluginRef,
  ShotSlot,
  Slot,
  SlotEffect,
  TransitionRef,
  VoLine,
} from '@trailerforge/schema';
import { z } from 'zod';
import {
  cleanupRemovedSlots,
  findSlot,
  findUnlockedSection,
  requireStoryboard,
  SectionLockedError,
} from './shared.js';
import { markUserEdited } from './user-edits.js';

/**
 * Hand edits to the storyboard. Every command goes through the command bus, so each is validated
 * (the project's reference checks run after it), undoable and in version history. Locked sections
 * refuse edits; unlock first. Any change to a slot's content records `core.userEdited` on it, and
 * regenerating its section then keeps that slot.
 */

const COMMON_FIELDS = [
  'title',
  'purpose',
  'duration',
  'priority',
  'transitionIn',
  'transitionOut',
  'effects',
  'audioNotes',
  'entityIds',
  'tags',
] as const;
const SHOT_FIELDS = [
  'captureInstruction',
  'framing',
  'setup',
  'location',
  'hud',
  'alternates',
  'overlays',
] as const;
const CARD_FIELDS = ['cardKind', 'templateId', 'text', 'params', 'styleTokens'] as const;

/** Only the fields a person may edit; ids, kind and status/extension data are not here. `null` clears a transition. */
export const SlotPatch = z.strictObject({
  title: z.string().optional(),
  purpose: z.string().optional(),
  duration: DurationRange.optional(),
  priority: z.enum(['must', 'nice']).optional(),
  transitionIn: TransitionRef.nullable().optional(),
  transitionOut: TransitionRef.nullable().optional(),
  effects: z.array(SlotEffect).max(3).optional(),
  audioNotes: z.string().optional(),
  entityIds: z.array(Id).optional(),
  tags: z.array(z.string()).optional(),
  // shots
  captureInstruction: z.string().optional(),
  framing: z.string().optional(),
  setup: z.string().optional(),
  location: z.string().optional(),
  hud: ShotSlot.shape.hud.unwrap().optional(),
  alternates: z.array(z.string()).optional(),
  overlays: z.array(Overlay).optional(),
  // cards
  cardKind: CardSlot.shape.cardKind.optional(),
  templateId: PluginRef.optional(),
  text: z.string().optional(),
  params: z.record(z.string(), z.json()).optional(),
  styleTokens: z.record(z.string(), z.string()).optional(),
});
export type SlotPatch = z.infer<typeof SlotPatch>;

const bump = (sb: { revision: number }) => {
  sb.revision += 1;
};

export const updateSlot = defineCommand({
  type: 'core/storyboard.update-slot',
  payload: z.strictObject({ slotId: Id, patch: SlotPatch }),
  label: () => 'Edit slot',
  apply: (d, { slotId, patch }) => {
    const { sb, section, slot } = findSlot(d, slotId);
    if (section.locked) throw new SectionLockedError(section.id);
    const allowed = new Set<string>([
      ...COMMON_FIELDS,
      ...(slot.kind === 'shot' ? SHOT_FIELDS : CARD_FIELDS),
    ]);
    const target = slot as unknown as Record<string, unknown>;
    const changed: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!allowed.has(key)) throw new Error(`a ${slot.kind} slot has no "${key}" field`);
      if (value === null) delete target[key];
      else target[key] = value;
      changed.push(key);
    }
    if (changed.length === 0) return;
    markUserEdited(slot, changed);
    bump(sb);
  },
  merge: { key: ({ slotId }) => slotId, windowMs: 1500 },
});

export const addSlot = defineCommand({
  type: 'core/storyboard.add-slot',
  payload: z.strictObject({
    sectionId: Id,
    /** Position within the section; default: the end. */
    index: z.int().nonnegative().optional(),
    slot: Slot,
  }),
  label: ({ slot }) => `Add ${slot.title || 'slot'}`,
  apply: (d, { sectionId, index, slot }) => {
    const { sb, section } = findUnlockedSection(d, sectionId);
    if (collectIds(d).has(slot.id)) throw new Error(`id "${slot.id}" is already used`);
    const at = index ?? section.slots.length;
    if (at > section.slots.length)
      throw new RangeError(`index ${at} is past the end of "${section.name}"`);
    const added = { ...slot, extensions: { ...slot.extensions } };
    markUserEdited(added, ['added']);
    section.slots.splice(at, 0, added);
    bump(sb);
  },
});

export const removeSlot = defineCommand({
  type: 'core/storyboard.remove-slot',
  payload: z.strictObject({ slotId: Id }),
  label: () => 'Delete slot',
  apply: (d, { slotId }) => {
    const { sb, section, index } = findSlot(d, slotId);
    if (section.locked) throw new SectionLockedError(section.id);
    section.slots.splice(index, 1);
    cleanupRemovedSlots(d, new Set([slotId]));
    bump(sb);
  },
});

/** Move a slot within its section or into another one. Both sections must be unlocked. */
export const moveSlot = defineCommand({
  type: 'core/storyboard.move-slot',
  payload: z.strictObject({
    slotId: Id,
    toSectionId: Id,
    /** Position in the target section after the slot is taken out; default: the end. */
    index: z.int().nonnegative().optional(),
  }),
  label: () => 'Move slot',
  apply: (d, { slotId, toSectionId, index }) => {
    const from = findSlot(d, slotId);
    if (from.section.locked) throw new SectionLockedError(from.section.id);
    const { section: to } = findUnlockedSection(d, toSectionId);
    const [slot] = from.section.slots.splice(from.index, 1);
    const at = index ?? to.slots.length;
    if (at > to.slots.length) throw new RangeError(`index ${at} is past the end of "${to.name}"`);
    to.slots.splice(at, 0, slot!);
    bump(from.sb);
  },
});

export const setTargetDuration = defineCommand({
  type: 'core/storyboard.set-target-duration',
  payload: z.strictObject({ seconds: z.number().positive() }),
  label: ({ seconds }) => `Set target length to ${seconds} s`,
  apply: (d, { seconds }) => {
    const sb = requireStoryboard(d);
    sb.meta.targetDuration = seconds;
    bump(sb);
  },
  merge: { key: () => 'target', windowMs: 1500 },
});

export const addSection = defineCommand({
  type: 'core/storyboard.add-section',
  payload: z.strictObject({
    id: Id,
    name: z.string().min(1),
    role: z.string().optional(),
    purpose: z.string().default(''),
    index: z.int().nonnegative().optional(),
  }),
  label: ({ name }) => `Add section ${name}`,
  apply: (d, { id, name, role, purpose, index }) => {
    const sb = requireStoryboard(d);
    if (collectIds(d).has(id)) throw new Error(`id "${id}" is already used`);
    const at = index ?? sb.sections.length;
    if (at > sb.sections.length) throw new RangeError(`index ${at} is past the last section`);
    sb.sections.splice(at, 0, {
      id,
      name,
      ...(role ? { role } : {}),
      purpose,
      locked: false,
      slots: [],
    });
    bump(sb);
  },
});

export const updateSection = defineCommand({
  type: 'core/storyboard.update-section',
  payload: z.strictObject({
    sectionId: Id,
    patch: z.strictObject({
      name: z.string().min(1).optional(),
      /** `null` clears the role hint. */
      role: z.string().nullable().optional(),
      purpose: z.string().optional(),
    }),
  }),
  label: () => 'Edit section',
  apply: (d, { sectionId, patch }) => {
    const { sb, section } = findUnlockedSection(d, sectionId);
    if (patch.name !== undefined) section.name = patch.name;
    if (patch.purpose !== undefined) section.purpose = patch.purpose;
    if (patch.role === null) delete section.role;
    else if (patch.role !== undefined) section.role = patch.role;
    bump(sb);
  },
  merge: { key: ({ sectionId }) => sectionId, windowMs: 1500 },
});

/**
 * Locked sections keep their place (generation re-inserts them by position), so they can't be
 * moved; unlocked sections may be moved around them.
 */
export const moveSection = defineCommand({
  type: 'core/storyboard.move-section',
  payload: z.strictObject({ sectionId: Id, index: z.int().nonnegative() }),
  label: () => 'Move section',
  apply: (d, { sectionId, index }) => {
    const { sb, index: from } = findUnlockedSection(d, sectionId);
    if (index >= sb.sections.length)
      throw new RangeError(`index ${index} is past the last section`);
    const [section] = sb.sections.splice(from, 1);
    sb.sections.splice(index, 0, section!);
    bump(sb);
  },
});

export const removeSection = defineCommand({
  type: 'core/storyboard.remove-section',
  payload: z.strictObject({ sectionId: Id }),
  label: () => 'Delete section',
  apply: (d, { sectionId }) => {
    const { sb, index, section } = findUnlockedSection(d, sectionId);
    const gone = new Set(section.slots.map((s) => s.id));
    sb.sections.splice(index, 1);
    cleanupRemovedSlots(d, gone);
    for (const part of sb.music.structure)
      part.sectionIds = part.sectionIds.filter((id) => id !== sectionId);
    bump(sb);
  },
});

export const addVoLine = defineCommand({
  type: 'core/storyboard.add-vo-line',
  payload: VoLine,
  label: () => 'Add VO line',
  apply: (d, line) => {
    const sb = requireStoryboard(d);
    if (collectIds(d).has(line.id)) throw new Error(`id "${line.id}" is already used`);
    sb.voLines.push(line);
    bump(sb);
  },
});

export const updateVoLine = defineCommand({
  type: 'core/storyboard.update-vo-line',
  payload: z.strictObject({
    id: Id,
    patch: z.strictObject({
      speaker: z.string().optional(),
      text: z.string().min(1).optional(),
      direction: z.string().optional(),
      /** `null` clears the target. */
      targetDuration: z.number().nonnegative().nullable().optional(),
      linkedSlotIds: z.array(Id).optional(),
      status: VoLine.shape.status.optional(),
    }),
  }),
  label: () => 'Edit VO line',
  apply: (d, { id, patch }) => {
    const sb = requireStoryboard(d);
    const line = sb.voLines.find((v) => v.id === id);
    if (!line) throw new Error(`no VO line "${id}"`);
    if (patch.speaker !== undefined) line.speaker = patch.speaker;
    if (patch.text !== undefined) line.text = patch.text;
    if (patch.direction !== undefined) line.direction = patch.direction;
    if (patch.targetDuration === null) delete line.targetDuration;
    else if (patch.targetDuration !== undefined) line.targetDuration = patch.targetDuration;
    if (patch.linkedSlotIds !== undefined) line.linkedSlotIds = patch.linkedSlotIds;
    if (patch.status !== undefined) line.status = patch.status;
    bump(sb);
  },
  merge: { key: ({ id }) => id, windowMs: 1500 },
});

export const removeVoLine = defineCommand({
  type: 'core/storyboard.remove-vo-line',
  payload: z.strictObject({ id: Id }),
  label: () => 'Delete VO line',
  apply: (d, { id }) => {
    const sb = requireStoryboard(d);
    if (!sb.voLines.some((v) => v.id === id)) throw new Error(`no VO line "${id}"`);
    sb.voLines = sb.voLines.filter((v) => v.id !== id);
    bump(sb);
  },
});

export const updateMusic = defineCommand({
  type: 'core/storyboard.update-music',
  payload: z.strictObject({
    patch: z.strictObject({
      direction: z.string().optional(),
      /** `null` clears the tempo range. */
      bpm: z
        .strictObject({ min: z.number().positive(), max: z.number().positive() })
        .refine((b) => b.min <= b.max, { message: 'bpm.min must be <= bpm.max' })
        .nullable()
        .optional(),
      /** `null` detaches the track. */
      trackAssetId: Id.nullable().optional(),
    }),
  }),
  label: () => 'Edit music plan',
  apply: (d, { patch }) => {
    const sb = requireStoryboard(d);
    if (patch.direction !== undefined) sb.music.direction = patch.direction;
    if (patch.bpm === null) delete sb.music.bpm;
    else if (patch.bpm !== undefined) sb.music.bpm = patch.bpm;
    if (patch.trackAssetId === null) delete sb.music.trackAssetId;
    else if (patch.trackAssetId !== undefined) sb.music.trackAssetId = patch.trackAssetId;
    bump(sb);
  },
  merge: { key: () => 'music', windowMs: 1500 },
});

/** Kinds of sound cue a slot can carry (the storyboard schema's list). */
const SfxCueKind = z.enum(['whoosh', 'impact', 'riser', 'sub-drop', 'custom']);

/** Put a sound on a slot: before it (leading in), at its start or at its end. */
export const addSfxCue = defineCommand({
  type: 'core/storyboard.add-sfx-cue',
  payload: z.strictObject({
    slotId: Id,
    kind: SfxCueKind,
    position: z.enum(['before', 'start', 'end']).default('start'),
  }),
  label: ({ kind }) => `Add ${kind} sound`,
  apply: (d, { slotId, kind, position }) => {
    const { sb, section } = findSlot(d, slotId);
    if (section.locked) throw new SectionLockedError(section.id);
    const taken = collectIds(d);
    let id = `sfx_${slotId}`.slice(0, 60);
    for (let n = 2; taken.has(id); n++) id = `sfx_${slotId}`.slice(0, 56) + `_${n}`;
    sb.music.sfxCues.push({ id, kind, slotId, position });
  },
});

/** Take a sound off its slot (a suggested one, or one added by hand). */
export const removeSfxCue = defineCommand({
  type: 'core/storyboard.remove-sfx-cue',
  payload: z.strictObject({ cueId: Id }),
  label: () => 'Remove sound',
  apply: (d, { cueId }) => {
    const sb = requireStoryboard(d);
    const cue = sb.music.sfxCues.find((c) => c.id === cueId);
    if (!cue) throw new Error(`no sound cue "${cueId}"`);
    const { section } = findSlot(d, cue.slotId);
    if (section.locked) throw new SectionLockedError(section.id);
    sb.music.sfxCues = sb.music.sfxCues.filter((c) => c.id !== cueId);
  },
});

export const storyboardEditCommands = [
  updateSlot,
  addSlot,
  removeSlot,
  moveSlot,
  setTargetDuration,
  addSection,
  updateSection,
  moveSection,
  removeSection,
  addVoLine,
  updateVoLine,
  removeVoLine,
  updateMusic,
  addSfxCue,
  removeSfxCue,
] as unknown as readonly CommandDef<unknown>[];
