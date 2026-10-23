import { z } from 'zod';
import { ContentHash, Extensions, Id, IsoDateTime, PluginRef } from './common.js';

/**
 * A local source TrailerForge reads (never writes) to learn about the product, e.g. a Unity
 * game repository. Raw scan output lives in `cache/`; curated entities live in the project.
 */
export const KnowledgeSource = z.strictObject({
  id: Id,
  kind: z.enum(['local-repo', 'local-folder']),
  /** Absolute path on the user's machine. */
  path: z.string().min(1),
  /** Extractor plugins to run, e.g. `core/generic`, `game-trailer/unity`. */
  extractorIds: z.array(PluginRef).min(1),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  lastScannedAt: IsoDateTime.nullable().default(null),
  /** Hash of the last digest, to detect when a re-scan changed anything. */
  digestHash: ContentHash.nullable().default(null),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeEntityKind = z.enum([
  'title',
  'level',
  'character',
  'enemy',
  'boss',
  'ability',
  'item',
  'mechanic',
  'quest',
  'cutscene',
  'achievement',
  'music',
  'art',
  'other',
]);
export type KnowledgeEntityKind = z.infer<typeof KnowledgeEntityKind>;

/** One fact about the product, extracted from a source or added by the user. */
export const KnowledgeEntity = z.strictObject({
  id: Id,
  kind: KnowledgeEntityKind,
  name: z.string().min(1),
  description: z.string().default(''),
  /** Absent for user-added entities. */
  sourceId: Id.optional(),
  /** Repo-relative paths the entity was derived from (shown in the review panel). */
  sourcePaths: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  /** `user` entities and user edits survive re-scans. */
  origin: z.enum(['extracted', 'user']).default('extracted'),
  /** Excluded entities are never sent to an LLM. */
  excludedFromLlm: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  extensions: Extensions.default({}),
});
export type KnowledgeEntity = z.infer<typeof KnowledgeEntity>;
