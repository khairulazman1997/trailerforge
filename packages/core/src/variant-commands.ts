import type { Draft } from 'immer';
import {
  DurationRange,
  Id,
  ReframeSettings,
  SlotOverride,
  StoryboardVariant,
  mintId,
  type Project,
} from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Variants: versions of the trailer (aspect ratio, length) derived from the master cut on
 * demand (`deriveVariant` in `@trailerforge/cut`). Only their rules and sparse per-slot
 * overrides are stored, never a timeline. Overrides are keyed by slot id, so they survive a
 * rebuild of the master cut. Variants say how to cut a version, not what the storyboard says, so
 * they leave the storyboard revision alone and work in locked sections.
 */
function storyboard(d: Draft<Project>, type: string) {
  if (!d.storyboard) throw new CommandError(type, 'the project has no storyboard');
  return d.storyboard;
}

function findVariant(d: Draft<Project>, variantId: string, type: string) {
  const v = storyboard(d, type).variants.find((x) => x.id === variantId);
  if (!v) throw new CommandError(type, `no variant "${variantId}"`);
  return v;
}

function requireFormat(d: Draft<Project>, formatTargetId: string, type: string) {
  const f = d.formatTargets.find((x) => x.id === formatTargetId);
  if (!f) throw new CommandError(type, `no format target "${formatTargetId}"`);
  return f;
}

const TargetDuration = z.number().positive().max(600);

/** Add a version for a format target; without a length it keeps the master's. */
export const addVariant = defineCommand({
  type: 'core/variants.add',
  payload: z.strictObject({
    /** Optional; minted from the name (or the format's) when absent. */
    id: Id.optional(),
    formatTargetId: Id,
    name: z.string().optional(),
    targetDuration: TargetDuration.optional(),
    reframe: ReframeSettings.optional(),
  }),
  label: ({ name, targetDuration }) =>
    `Add version${name ? ` "${name}"` : ''}${targetDuration ? ` (${targetDuration} s)` : ''}`,
  apply: (d, p) => {
    const type = 'core/variants.add';
    const sb = storyboard(d, type);
    const format = requireFormat(d, p.formatTargetId, type);
    const taken = new Set(sb.variants.map((v) => v.id));
    if (p.id && taken.has(p.id)) throw new CommandError(type, `variant id "${p.id}" is used`);
    const name = p.name ?? '';
    const id =
      p.id ??
      mintId(
        'var',
        `${name || format.name}${p.targetDuration ? ` ${p.targetDuration}s` : ''}`,
        taken,
      );
    sb.variants.push(
      StoryboardVariant.parse({
        id,
        name,
        formatTargetId: p.formatTargetId,
        ...(p.targetDuration !== undefined ? { targetDuration: p.targetDuration } : {}),
        ...(p.reframe ? { reframe: p.reframe } : {}),
      }),
    );
  },
});

export const removeVariant = defineCommand({
  type: 'core/variants.remove',
  payload: z.strictObject({ variantId: Id }),
  label: () => 'Remove version',
  apply: (d, { variantId }) => {
    const type = 'core/variants.remove';
    const sb = storyboard(d, type);
    findVariant(d, variantId, type);
    sb.variants = sb.variants.filter((v) => v.id !== variantId);
  },
});

/** Change a version's rules; null clears the length (back to the master's). */
export const setVariant = defineCommand({
  type: 'core/variants.set',
  payload: z.strictObject({
    variantId: Id,
    patch: z.strictObject({
      name: z.string().optional(),
      formatTargetId: Id.optional(),
      targetDuration: TargetDuration.nullable().optional(),
      reframe: ReframeSettings.optional(),
    }),
  }),
  label: () => 'Change version',
  apply: (d, { variantId, patch }) => {
    const type = 'core/variants.set';
    const v = findVariant(d, variantId, type);
    if (patch.formatTargetId !== undefined) {
      requireFormat(d, patch.formatTargetId, type);
      v.formatTargetId = patch.formatTargetId;
    }
    if (patch.name !== undefined) v.name = patch.name;
    if (patch.targetDuration === null) delete v.targetDuration;
    else if (patch.targetDuration !== undefined) v.targetDuration = patch.targetDuration;
    if (patch.reframe) v.reframe = patch.reframe;
  },
  merge: { key: ({ variantId }) => variantId, windowMs: 1500 },
});

const OverridePatch = z.strictObject({
  /** true drops the slot, false keeps it through cutdowns; null back to automatic. */
  excluded: z.boolean().nullable().optional(),
  /** Retime the slot in this version; null back to the storyboard's range. */
  duration: DurationRange.nullable().optional(),
  /** Use this take of the shot; null back to the master's. */
  takeId: Id.nullable().optional(),
  /** Manual focus point for reframing; null back to automatic. */
  cropCenter: z
    .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable()
    .optional(),
});

/** Keep or drop a slot, retime it, swap its take or set its focus point in one version. */
export const overrideVariantSlot = defineCommand({
  type: 'core/variants.override',
  payload: z.strictObject({ variantId: Id, slotId: Id, patch: OverridePatch }),
  label: ({ patch }) =>
    patch.excluded === true
      ? 'Drop shot from version'
      : patch.excluded === false
        ? 'Keep shot in version'
        : patch.takeId
          ? 'Use another take in version'
          : patch.duration
            ? 'Retime shot in version'
            : 'Change shot in version',
  apply: (d, { variantId, slotId, patch }) => {
    const type = 'core/variants.override';
    const v = findVariant(d, variantId, type);
    const slot = d.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === slotId);
    if (!slot) throw new CommandError(type, `no slot "${slotId}"`);
    if (patch.takeId) {
      const take = slot.kind === 'shot' ? slot.takes.find((t) => t.id === patch.takeId) : undefined;
      if (!take) throw new CommandError(type, `no take "${patch.takeId}" on "${slotId}"`);
      if (take.rejected) throw new CommandError(type, `take "${patch.takeId}" is rejected`);
    }
    const next: Record<string, unknown> = { ...(v.overrides[slotId] ?? {}) };
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) delete next[k];
      else if (val !== undefined) next[k] = val;
    }
    if (Object.keys(next).length === 0) delete v.overrides[slotId];
    else v.overrides[slotId] = SlotOverride.parse(next);
  },
  merge: { key: ({ variantId, slotId }) => `${variantId}|${slotId}`, windowMs: 1500 },
});

/** Forget one slot's overrides in a version, or all of them when no slot is given. */
export const clearVariantOverride = defineCommand({
  type: 'core/variants.clear-override',
  payload: z.strictObject({ variantId: Id, slotId: Id.optional() }),
  label: ({ slotId }) => (slotId ? 'Reset shot in version' : 'Reset version to automatic'),
  apply: (d, { variantId, slotId }) => {
    const v = findVariant(d, variantId, 'core/variants.clear-override');
    if (slotId === undefined) v.overrides = {};
    else delete v.overrides[slotId];
  },
});

/** Drop variant overrides that pick a take no longer on its shot. */
export function forgetTakeOverrides(d: Draft<Project>, slotId: string, takeId: string): void {
  for (const v of d.storyboard?.variants ?? []) {
    const o = v.overrides[slotId];
    if (o?.takeId !== takeId) continue;
    delete o.takeId;
    if (Object.keys(o).length === 0) delete v.overrides[slotId];
  }
}

export const variantCommands = [
  addVariant,
  removeVariant,
  setVariant,
  overrideVariantSlot,
  clearVariantOverride,
] as unknown as readonly CommandDef<unknown>[];
