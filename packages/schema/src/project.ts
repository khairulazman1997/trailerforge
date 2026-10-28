import { z } from 'zod';
import { Brand } from './brand.js';
import { Brief } from './brief.js';
import { Extensions, Id, IsoDate, IsoDateTime, PluginRef } from './common.js';
import { FormatTarget } from './format.js';
import { KnowledgeEntity, KnowledgeSource } from './knowledge.js';
import { ProjectAssetRef } from './media.js';
import { Storyboard } from './storyboard.js';
import { Timeline } from './timeline.js';

/** Current project schema version. Bump together with a step in `migrations.ts`. */
export const PROJECT_SCHEMA_VERSION = 1;

export const PackId = z.string().regex(/^[a-z0-9-]+$/, 'pack ids are lowercase kebab-case');

/** Lifecycle status, shared with the future Content Calendar Planner. */
export const ProjectStatus = z.enum([
  'idea',
  'scripted',
  'capturing',
  'editing',
  'in-review',
  'scheduled',
  'published',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.strictObject({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Domain pack that owns video types/templates for this project, e.g. `game-trailer`. */
  domainPackId: PackId,

  // Campaign fields: unused until the Planner module ships, but stable from v1.
  campaignId: Id.nullable().default(null),
  scheduledDate: IsoDate.nullable().default(null),
  platformTargets: z.array(PluginRef).default([]),
  status: ProjectStatus.default('idea'),

  brief: Brief,
  /** Colours, logo, fonts and type scale for trailer graphics; null until set. */
  brand: Brand.nullable().default(null),
  formatTargets: z.array(FormatTarget).default([]),
  storyboard: Storyboard.nullable().default(null),
  timelines: z.array(Timeline).default([]),
  assets: z.array(ProjectAssetRef).default([]),
  /** Local sources (e.g. the game repo) and the curated facts extracted from them. */
  sources: z.array(KnowledgeSource).default([]),
  knowledge: z.array(KnowledgeEntity).default([]),
  /** Plugins (and versions) that produced this project's content, for reproducible renders. */
  plugins: z.array(z.strictObject({ id: PackId, version: z.string().min(1) })).default([]),
  extensions: Extensions.default({}),
});
export type Project = z.infer<typeof Project>;
/** Shape accepted by `Project.parse` (defaults may be omitted). */
export type ProjectInput = z.input<typeof Project>;
