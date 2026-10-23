import { mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandError, CommandRegistry, defineCommand } from '../commands.js';
import { coreCommands, renameProject, setProjectStatus } from '../project-commands.js';
import { ProjectLockedError } from './lock.js';
import { ProjectOpenError, ProjectStore, type ProjectStoreOptions } from './project-store.js';

let dir: string;
let clock: number;
const stores: ProjectStore[] = [];

const opts = (extra: Partial<ProjectStoreOptions> = {}): ProjectStoreOptions => ({
  commands: coreCommands(),
  autosaveMs: 0,
  now: () => new Date(clock),
  ...extra,
});

async function create(extra?: Partial<ProjectStoreOptions>) {
  const s = await ProjectStore.create(dir, sampleProject(), opts(extra));
  stores.push(s);
  return s;
}

async function open(extra?: Partial<ProjectStoreOptions>) {
  const s = await ProjectStore.open(dir, opts(extra));
  stores.push(s);
  return s;
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'tforge-')), 'Ember.tforge');
  clock = Date.parse('2026-10-23T12:00:00Z');
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
});

describe('create / open', () => {
  it('creates the folder layout and round-trips the project', async () => {
    const s = await create();
    expect((await readdir(dir)).sort()).toEqual([
      '.lock',
      'cache',
      'history',
      'logs',
      'media',
      'project.json',
    ]);
    await s.close();
    const again = await open();
    expect(again.state).toEqual(s.state);
  });

  it('refuses to create over an existing project', async () => {
    const s = await create();
    await s.close();
    await expect(ProjectStore.create(dir, sampleProject(), opts())).rejects.toThrow(
      ProjectOpenError,
    );
  });

  it('refuses invalid initial projects', async () => {
    const bad = { ...sampleProject(), name: '' };
    await expect(ProjectStore.create(dir, bad, opts())).rejects.toThrow(ProjectOpenError);
  });

  it('reports corrupt JSON and releases the lock', async () => {
    const s = await create();
    await s.close();
    await writeFile(join(dir, 'project.json'), '{"oops":');
    await expect(open()).rejects.toThrow(/not valid JSON/);
    await expect(open()).rejects.toThrow(/not valid JSON/); // not a lock error
  });

  it('reports schema problems with paths', async () => {
    const s = await create();
    await s.close();
    const json = await readJson(join(dir, 'project.json'));
    json.formatTargets[0].resolution.width = 0;
    await writeFile(join(dir, 'project.json'), JSON.stringify(json));
    const err = await open().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectOpenError);
    expect((err as ProjectOpenError).issues[0]?.path).toBe('formatTargets.0.resolution.width');
  });

  it('migrates old files and keeps a backup of the original', async () => {
    const s = await create();
    await s.close();
    const { schemaVersion: _v, ...legacy } = await readJson(join(dir, 'project.json'));
    await writeFile(join(dir, 'project.json'), JSON.stringify(legacy));
    const again = await open();
    expect(again.state.schemaVersion).toBe(1);
    expect((await readJson(join(dir, 'project.json'))).schemaVersion).toBe(1);
    const backups = (await readdir(join(dir, 'history'))).filter((n) =>
      n.startsWith('pre-migration-v0-'),
    );
    expect(backups).toHaveLength(1);
    expect((await readJson(join(dir, 'history', backups[0]!))).schemaVersion).toBeUndefined();
  });

  it('removes temp files left by a crash mid-save', async () => {
    const s = await create();
    await s.close();
    await writeFile(join(dir, 'project.json.tmp-123-abcd'), 'partial');
    await open();
    expect((await readdir(dir)).some((n) => n.includes('.tmp-'))).toBe(false);
  });
});

describe('locking', () => {
  it('prevents a second instance from opening the project', async () => {
    await create();
    await expect(ProjectStore.open(dir, opts())).rejects.toThrow(ProjectLockedError);
  });

  it('can reopen after close', async () => {
    const s = await create();
    await s.close();
    await expect(open()).resolves.toBeInstanceOf(ProjectStore);
  });

  it('takes over a stale lock from a dead process', async () => {
    const s = await create();
    await s.close();
    const { hostname } = await import('node:os');
    await writeFile(
      join(dir, '.lock'),
      JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), at: '' }),
    );
    await expect(open()).resolves.toBeInstanceOf(ProjectStore);
  });
});

describe('commands', () => {
  it('applies, marks dirty, saves and persists', async () => {
    const s = await create();
    s.run(renameProject, { name: 'Renamed' });
    expect(s.state.name).toBe('Renamed');
    expect(s.isDirty).toBe(true);
    await s.save();
    expect(s.isDirty).toBe(false);
    expect((await readJson(join(dir, 'project.json'))).name).toBe('Renamed');
  });

  it('keeps state frozen', async () => {
    const s = await create();
    expect(() => {
      (s.state as { name: string }).name = 'hack';
    }).toThrow();
  });

  it('rejects unknown commands and invalid payloads without changing state', async () => {
    const s = await create();
    const before = s.state;
    expect(() => s.dispatch('core/nope', {})).toThrow(/unknown command/);
    expect(() => s.dispatch('core/project.set-status', { status: 'shipped' })).toThrow(
      CommandError,
    );
    expect(s.state).toBe(before);
    expect(s.isDirty).toBe(false);
  });

  it('rejects results that fail validation, have missing defaults or break references', async () => {
    const registry = coreCommands(new CommandRegistry());
    const breakName = defineCommand({
      type: 'test/break-name',
      payload: z.strictObject({}),
      label: () => 'x',
      apply: (d) => {
        d.name = '';
      },
    });
    const rawEntity = defineCommand({
      type: 'test/raw-entity',
      payload: z.strictObject({}),
      label: () => 'x',
      apply: (d) => {
        d.knowledge.push({ id: 'ent_raw', kind: 'item', name: 'Sword' } as never);
      },
    });
    const dangling = defineCommand({
      type: 'test/dangling',
      payload: z.strictObject({}),
      label: () => 'x',
      apply: (d) => {
        d.assets = [];
      },
    });
    registry.register(breakName).register(rawEntity).register(dangling);
    const s = await create({ commands: registry });
    const before = s.state;
    expect(() => s.run(breakName, {})).toThrow(/failed validation/);
    expect(() => s.run(rawEntity, {})).toThrow(/missing defaults/);
    expect(() => s.run(dangling, {})).toThrow(/broken references/);
    expect(s.state).toBe(before);
    expect(s.canUndo).toBe(false);
  });

  it('ignores no-op commands', async () => {
    const s = await create();
    s.run(setProjectStatus, { status: s.state.status });
    expect(s.canUndo).toBe(false);
    expect(s.isDirty).toBe(false);
  });

  it('notifies subscribers and survives a throwing subscriber', async () => {
    const s = await create();
    const seen: string[] = [];
    s.subscribe(() => {
      throw new Error('bad listener');
    });
    const off = s.subscribe((e) => seen.push(`${e.kind}:${e.label}`));
    s.run(renameProject, { name: 'A' });
    s.undo();
    off();
    s.redo();
    expect(seen).toEqual(['command:Rename project to "A"', 'undo:Undo: Rename project to "A"']);
  });
});

describe('undo / redo', () => {
  it('walks back and forward through changes', async () => {
    const s = await create();
    const original = s.state.status;
    s.run(setProjectStatus, { status: 'scripted' });
    s.run(setProjectStatus, { status: 'capturing' });
    expect(s.undo()).toBe(true);
    expect(s.state.status).toBe('scripted');
    expect(s.undo()).toBe(true);
    expect(s.state.status).toBe(original);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(true);
    expect(s.state.status).toBe('scripted');
  });

  it('clears redo after a new command', async () => {
    const s = await create();
    s.run(setProjectStatus, { status: 'scripted' });
    s.undo();
    s.run(setProjectStatus, { status: 'editing' });
    expect(s.canRedo).toBe(false);
  });

  it('merges rapid repeated commands into one undo step', async () => {
    const s = await create();
    const original = s.state.name;
    s.run(renameProject, { name: 'E' });
    clock += 300;
    s.run(renameProject, { name: 'Em' });
    clock += 300;
    s.run(renameProject, { name: 'Emb' });
    clock += 5000;
    s.run(renameProject, { name: 'Ember' });
    s.undo();
    expect(s.state.name).toBe('Emb');
    s.undo();
    expect(s.state.name).toBe(original);
    expect(s.canUndo).toBe(false);
  });
});

describe('autosave', () => {
  it('saves after the debounce window', async () => {
    const s = await create({ autosaveMs: 20 });
    s.run(renameProject, { name: 'Autosaved' });
    await new Promise((r) => setTimeout(r, 120));
    expect(s.isDirty).toBe(false);
    expect((await readJson(join(dir, 'project.json'))).name).toBe('Autosaved');
  });

  it('flushes on close', async () => {
    const s = await create({ autosaveMs: 60_000 });
    s.run(renameProject, { name: 'Flushed' });
    await s.close();
    expect((await readJson(join(dir, 'project.json'))).name).toBe('Flushed');
  });
});

describe('version history', () => {
  it('lists versions and reconstructs any of them', async () => {
    const s = await create({ snapshotEvery: 2 });
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      clock += 5000; // avoid merging
      s.run(renameProject, { name });
      await s.save();
    }
    const versions = await s.listVersions();
    expect(versions.map((v) => v.label)).toEqual([
      'create',
      'Rename project to "One"',
      'Rename project to "Two"',
      'Rename project to "Three"',
      'Rename project to "Four"',
      'Rename project to "Five"',
    ]);
    for (const [i, name] of ['One', 'Two', 'Three', 'Four', 'Five'].entries()) {
      expect((await s.readVersion(versions[i + 1]!.seq)).name).toBe(name);
    }
    expect((await s.readVersion(versions[0]!.seq)).name).toBe(sampleProject().name);
  });

  it('records undo as its own history entry and continues sequence numbers across sessions', async () => {
    const s = await create();
    s.run(renameProject, { name: 'X' });
    s.undo();
    await s.close();
    const again = await open();
    const versions = await again.listVersions();
    expect(versions.map((v) => v.type)).toEqual([
      'core/open',
      'core/project.rename',
      'core/undo',
      'core/open',
    ]);
    expect(versions.map((v) => v.seq)).toEqual([1, 2, 3, 4]);
  });

  it('tolerates a torn last line in the patch log', async () => {
    const s = await create();
    s.run(renameProject, { name: 'Kept' });
    await s.close();
    await appendFile(join(dir, 'history', 'patches.jsonl'), '{"seq": 99, "at": "tor');
    const again = await open();
    expect(again.state.name).toBe('Kept');
    expect((await again.listVersions()).at(-1)?.label).toBe('open');
  });
});
