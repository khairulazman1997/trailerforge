import { Id, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Export choices per version (preset, file name, loudness, poster frame). They are user
 * decisions, so they live on the version in `project.json`; the render plan, the files and
 * the preset's details are derived. Like the other version commands they leave the storyboard
 * revision alone and work in locked sections.
 */
function findVariant(d: { storyboard?: Project['storyboard'] }, variantId: string, type: string) {
  const v = d.storyboard?.variants.find((x) => x.id === variantId);
  if (!v) throw new CommandError(type, `no version "${variantId}"`);
  return v;
}

/** Choose or adjust a version's export; `null` clears an override back to the preset's value. */
export const setExport = defineCommand({
  type: 'core/export.set',
  payload: z.strictObject({
    variantId: Id,
    presetId: z.string().min(1).max(64).optional(),
    fileName: z.string().min(1).max(120).nullable().optional(),
    loudnessLufs: z.number().min(-30).max(-6).nullable().optional(),
    posterSeconds: z.number().min(0).max(600).nullable().optional(),
  }),
  label: () => 'Change export settings',
  apply: (d, { variantId, presetId, fileName, loudnessLufs, posterSeconds }) => {
    const type = 'core/export.set';
    const v = findVariant(d, variantId, type);
    const next = { ...(v.export ?? {}) } as Record<string, unknown>;
    if (presetId !== undefined) next.presetId = presetId;
    if (typeof next.presetId !== 'string') throw new CommandError(type, 'choose a preset first');
    for (const [key, value] of Object.entries({ fileName, loudnessLufs, posterSeconds })) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    v.export = next as NonNullable<typeof v.export>;
  },
  merge: { key: ({ variantId }) => variantId, windowMs: 1500 },
});

/** Back to the default: the preset for the version's format target. */
export const resetExport = defineCommand({
  type: 'core/export.reset',
  payload: z.strictObject({ variantId: Id }),
  label: () => 'Reset export settings',
  apply: (d, { variantId }) => {
    delete findVariant(d, variantId, 'core/export.reset').export;
  },
});

export const exportCommands = [setExport, resetExport] as unknown as readonly CommandDef<unknown>[];
