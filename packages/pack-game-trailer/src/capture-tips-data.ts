import { IsoDateTime, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { readPackKey } from './pack-ext.js';

/** Stored capture tips (browser-safe: the UI reads them straight from the project). */

export const CaptureTipsEntry = z.strictObject({
  tips: z.array(z.string().min(1)).max(8).default([]),
  risks: z.array(z.string().min(1)).max(8).default([]),
  /** Hash of the prompt inputs this was written from; empty for entries typed by hand. */
  inputsHash: z.string().default(''),
  generatedAt: IsoDateTime.optional(),
  /** The user changed it; regenerating leaves it alone unless asked. */
  edited: z.boolean().default(false),
});
export type CaptureTipsEntry = z.infer<typeof CaptureTipsEntry>;

export const CaptureTipsExt = z.record(z.string().min(1), CaptureTipsEntry);
export type CaptureTipsExt = z.infer<typeof CaptureTipsExt>;

export function readCaptureTips(project: Pick<Project, 'extensions'>): CaptureTipsExt {
  const parsed = CaptureTipsExt.safeParse(readPackKey(project.extensions, 'captureTips') ?? {});
  return parsed.success ? parsed.data : {};
}
