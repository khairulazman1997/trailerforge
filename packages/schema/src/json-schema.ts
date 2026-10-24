import { z } from 'zod';
import { DecisionRecord } from './decision.js';
import { AssetLibrary, LibraryAsset } from './media.js';
import { Project } from './project.js';
import { Storyboard } from './storyboard.js';
import { Timeline } from './timeline.js';

/**
 * JSON Schemas (draft 2020-12) for external tools and plugin authors. They describe the
 * *input* shape (fields with defaults are optional). Cross-field rules (duration ordering,
 * overlap checks, reference integrity) are enforced by the Zod schemas and `parseProject`.
 */
export const jsonSchemaSources = {
  project: Project,
  storyboard: Storyboard,
  timeline: Timeline,
  'library-asset': LibraryAsset,
  'asset-library': AssetLibrary,
  decision: DecisionRecord,
} as const;

export type JsonSchemaName = keyof typeof jsonSchemaSources;

export function toJsonSchema(name: JsonSchemaName): Record<string, unknown> {
  return z.toJSONSchema(jsonSchemaSources[name], {
    io: 'input',
    target: 'draft-2020-12',
    reused: 'ref',
  });
}
