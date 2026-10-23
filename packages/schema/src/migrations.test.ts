import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures.js';
import { MigrationError, migrateProject, type Migration } from './migrations.js';
import { PROJECT_SCHEMA_VERSION } from './project.js';
import { parseProject } from './refs.js';

const chain: Migration[] = [
  { from: 0, description: 'stamp', up: (d) => d },
  {
    from: 1,
    description: 'rename title->name',
    up: ({ title, ...rest }) => ({ ...rest, name: title }),
  },
  { from: 2, description: 'add tags', up: (d) => ({ ...d, tags: [] }) },
];

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof MigrationError) return err.code;
    throw err;
  }
  return null;
};

describe('migrateProject', () => {
  it('is a no-op for current documents', () => {
    const doc = sampleProject();
    const r = migrateProject(doc);
    expect(r.applied).toEqual([]);
    expect(r.doc).toEqual(doc);
  });

  it('runs every step in order and stamps versions', () => {
    const r = migrateProject({ title: 'Old' }, chain, 3);
    expect(r.fromVersion).toBe(0);
    expect(r.doc).toEqual({ name: 'Old', tags: [], schemaVersion: 3 });
    expect(r.applied).toEqual(['v0->v1: stamp', 'v1->v2: rename title->name', 'v2->v3: add tags']);
  });

  it('starts from the document version', () => {
    const r = migrateProject({ schemaVersion: 2, name: 'x' }, chain, 3);
    expect(r.applied).toEqual(['v2->v3: add tags']);
  });

  it('never mutates its input', () => {
    const input = { schemaVersion: 1, title: 'Old' };
    migrateProject(input, chain, 3);
    expect(input).toEqual({ schemaVersion: 1, title: 'Old' });
  });

  it('refuses documents from a newer app version', () => {
    expect(code(() => migrateProject({ schemaVersion: 99 }, chain, 3))).toBe('too-new');
  });

  it('reports gaps in the migration chain', () => {
    expect(code(() => migrateProject({ schemaVersion: 0 }, [chain[0]!], 3))).toBe('no-path');
  });

  it('wraps failing steps', () => {
    const boom: Migration[] = [
      {
        from: 0,
        description: 'x',
        up: () => {
          throw new Error('bad');
        },
      },
    ];
    expect(code(() => migrateProject({}, boom, 1))).toBe('failed');
  });

  it.each([null, [], 'x', 3])('rejects non-object input %o', (input) => {
    expect(code(() => migrateProject(input))).toBe('not-an-object');
  });

  it('rejects malformed versions', () => {
    expect(code(() => migrateProject({ schemaVersion: '1' }))).toBe('invalid-version');
    expect(code(() => migrateProject({ schemaVersion: 1.5 }))).toBe('invalid-version');
  });
});

describe('parseProject with migrations', () => {
  it('upgrades an unversioned (v0) document', () => {
    const { schemaVersion: _v, ...legacy } = sampleProject();
    const r = parseProject(legacy);
    expect(r).toMatchObject({ ok: true, migratedFrom: 0 });
    if (r.ok) expect(r.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('reports migration errors as issues', () => {
    const r = parseProject({ ...sampleProject(), schemaVersion: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toMatch(/update the app/);
  });

  it('flags current documents as not migrated', () => {
    expect(parseProject(sampleProject())).toMatchObject({
      ok: true,
      migratedFrom: null,
      applied: [],
    });
  });
});
