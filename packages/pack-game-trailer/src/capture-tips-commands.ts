import { defineCommand, type CommandDef } from '@trailerforge/core';
import { IsoDateTime } from '@trailerforge/schema';
import { z } from 'zod';
import { CaptureTipsEntry, readCaptureTips, type CaptureTipsExt } from './capture-tips.js';
import { writePackKey } from './pack-ext.js';

const Lines = z.array(z.string().trim().min(1)).max(8);

function store(extensions: Record<string, unknown>, next: CaptureTipsExt): void {
  writePackKey(extensions, 'captureTips', Object.keys(next).length > 0 ? next : undefined);
}

/** Store a generation result. Groups the user edited are kept unless `overwriteEdited`. */
export const applyCaptureTips = defineCommand({
  type: 'game-trailer/capture.apply-tips',
  payload: z.strictObject({
    generatedAt: IsoDateTime,
    overwriteEdited: z.boolean().default(false),
    groups: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          inputsHash: z.string().min(1),
          tips: Lines,
          risks: Lines,
        }),
      )
      .min(1),
  }),
  label: () => 'Add capture tips',
  apply: (d, { generatedAt, overwriteEdited, groups }) => {
    const next = { ...readCaptureTips(d) };
    for (const g of groups) {
      if (next[g.key]?.edited && !overwriteEdited) continue;
      next[g.key] = CaptureTipsEntry.parse({
        tips: g.tips,
        risks: g.risks,
        inputsHash: g.inputsHash,
        generatedAt,
        edited: false,
      });
    }
    store(d.extensions, next);
  },
});

/** Replace one group's tips by hand; regenerating then leaves them alone. */
export const editCaptureTips = defineCommand({
  type: 'game-trailer/capture.edit-tips',
  payload: z.strictObject({ key: z.string().min(1), tips: Lines, risks: Lines }),
  label: () => 'Edit capture tips',
  apply: (d, { key, tips, risks }) => {
    const next = { ...readCaptureTips(d) };
    next[key] = CaptureTipsEntry.parse({
      ...next[key],
      tips,
      risks,
      edited: true,
    });
    store(d.extensions, next);
  },
  merge: { key: ({ key }) => key, windowMs: 1500 },
});

/** Remove the tips of one group, or all of them. */
export const clearCaptureTips = defineCommand({
  type: 'game-trailer/capture.clear-tips',
  payload: z.strictObject({ key: z.string().min(1).optional() }),
  label: ({ key }) => (key ? 'Remove capture tips' : 'Remove all capture tips'),
  apply: (d, { key }) => {
    const next = { ...readCaptureTips(d) };
    if (key === undefined) store(d.extensions, {});
    else {
      delete next[key];
      store(d.extensions, next);
    }
  },
});

export const captureTipsCommands = [
  applyCaptureTips,
  editCaptureTips,
  clearCaptureTips,
] as unknown as readonly CommandDef<unknown>[];
