import { PROJECT_SCHEMA_VERSION } from './project.js';

export type JsonObject = Record<string, unknown>;

/**
 * Upgrades a project document from `from` to `from + 1`. Migrations work on plain JSON (they
 * must not import current schemas, which describe only the latest shape) and must be pure:
 * the framework passes a private copy and stamps `schemaVersion` afterwards.
 */
export interface Migration {
  from: number;
  description: string;
  up(doc: JsonObject): JsonObject;
}

export const migrations: readonly Migration[] = [
  {
    from: 0,
    description: 'Unversioned document: stamp schemaVersion 1',
    up: (doc) => doc,
  },
];

export type MigrationErrorCode =
  'not-an-object' | 'invalid-version' | 'too-new' | 'no-path' | 'failed';

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  doc: JsonObject;
  fromVersion: number;
  /** Descriptions of applied steps, in order; empty when already current. */
  applied: string[];
}

/** Missing `schemaVersion` means a pre-versioning (v0) document. */
export function detectVersion(doc: JsonObject): number {
  const v = doc.schemaVersion;
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new MigrationError(
      'invalid-version',
      `schemaVersion must be a non-negative integer, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

export function migrateProject(
  input: unknown,
  registry: readonly Migration[] = migrations,
  target: number = PROJECT_SCHEMA_VERSION,
): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MigrationError('not-an-object', 'project document must be a JSON object');
  }
  const fromVersion = detectVersion(input as JsonObject);
  if (fromVersion > target) {
    throw new MigrationError(
      'too-new',
      `project uses schema v${fromVersion}, this TrailerForge supports up to v${target}; update the app`,
    );
  }
  let doc = structuredClone(input) as JsonObject;
  const applied: string[] = [];
  for (let v = fromVersion; v < target; v++) {
    const step = registry.find((m) => m.from === v);
    if (!step) throw new MigrationError('no-path', `no migration from schema v${v}`);
    try {
      doc = { ...step.up(doc), schemaVersion: v + 1 };
    } catch (err) {
      throw new MigrationError('failed', `migration v${v}->v${v + 1} failed: ${String(err)}`);
    }
    applied.push(`v${v}->v${v + 1}: ${step.description}`);
  }
  return { doc, fromVersion, applied };
}
