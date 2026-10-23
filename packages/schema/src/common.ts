import { z } from 'zod';

/** Stable identifier for any entity in a project. URL/filename safe. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ids are 1-64 chars of [A-Za-z0-9_-]');

/** Plugin-qualified identifier, e.g. `game-trailer/release-trailer` or `core/hard-cut`. */
export const PluginRef = z
  .string()
  .regex(/^[a-z0-9-]+(\/[a-z0-9._-]+)+$/, 'plugin refs look like `pack-id/item-id`');

export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();

/** Human-facing duration in seconds (storyboard level; the timeline uses flicks). */
export const Seconds = z.number().nonnegative();

/** sha256 hex digest of file content; used to reference media without copying it. */
export const ContentHash = z.string().regex(/^[a-f0-9]{64}$/, 'expected sha256 hex');

/**
 * Plugin-owned data, keyed by plugin id. The core stores it verbatim; each plugin validates
 * its own slice. Must be JSON so projects stay portable and diff-able.
 */
export const Extensions = z.record(z.string(), z.json());

/** A value the AI or a user assumed because the brief was incomplete. Always shown in the UI. */
export const Assumption = z.strictObject({
  field: z.string().min(1),
  value: z.json(),
  reason: z.string().min(1),
  source: z.enum(['user', 'ai', 'template']),
  createdAt: IsoDateTime,
});

export type Id = z.infer<typeof Id>;
export type PluginRef = z.infer<typeof PluginRef>;
export type Extensions = z.infer<typeof Extensions>;
export type Assumption = z.infer<typeof Assumption>;
