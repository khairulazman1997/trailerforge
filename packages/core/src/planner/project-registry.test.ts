import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry, normalizeProjectDir } from './project-registry.js';

let home: string;
let clock: number;
const now = () => new Date((clock += 1000));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-registry-'));
  clock = Date.parse('2026-11-05T09:00:00Z');
});
afterEach(() => rm(home, { recursive: true, force: true }));

async function project(name: string, id: string) {
  const dir = join(home, 'projects', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify({ id }));
  return dir;
}

describe('ProjectRegistry', () => {
  it('registers, refreshes and lists most recently opened first', async () => {
    const reg = await ProjectRegistry.open(home, { now });
    const a = await project('a', 'proj_a');
    const b = await project('b', 'proj_b');
    const first = await reg.register({ id: 'proj_a', dir: a, name: 'A' });
    await reg.register({ id: 'proj_b', dir: b, name: 'B' });
    const again = await reg.register({ id: 'proj_a', dir: a, name: 'A2' });
    expect(again.registeredAt).toBe(first.registeredAt);
    expect(reg.list().map((p) => p.name)).toEqual(['A2', 'B']);
    expect((await ProjectRegistry.open(home)).list()).toEqual(reg.list());
  });

  it('reports moved, replaced and unreadable folders without dropping them', async () => {
    const reg = await ProjectRegistry.open(home, { now });
    const a = await project('a', 'proj_a');
    const b = await project('b', 'proj_b');
    const c = await project('c', 'proj_c');
    await reg.register({ id: 'proj_a', dir: a, name: 'A' });
    await reg.register({ id: 'proj_b', dir: b, name: 'B' });
    await reg.register({ id: 'proj_c', dir: c, name: 'C' });
    await rm(a, { recursive: true });
    await writeFile(join(b, 'project.json'), JSON.stringify({ id: 'proj_other' }));
    await writeFile(join(c, 'project.json'), '{');
    const states = Object.fromEntries((await reg.views()).map((v) => [v.name, v.state]));
    expect(states).toEqual({ A: 'missing', B: 'replaced', C: 'unreadable' });
    expect(reg.list()).toHaveLength(3);
    expect(await reg.forget(a)).toBe(true);
    expect(reg.list().map((p) => p.name)).toEqual(['C', 'B']);
  });

  it('takes the most recently opened copy for an id, and renames in place', async () => {
    const reg = await ProjectRegistry.open(home, { now });
    const a = await project('a', 'proj_a');
    const copy = await project('copy', 'proj_a');
    await reg.register({ id: 'proj_a', dir: a, name: 'A' });
    await reg.register({ id: 'proj_a', dir: copy, name: 'Copy' });
    expect(reg.byId('proj_a')?.name).toBe('Copy');
    const opened = reg.byDir(a)!.lastOpenedAt;
    await reg.rename(a, 'Renamed');
    expect(reg.byDir(a)).toMatchObject({ name: 'Renamed', lastOpenedAt: opened });
  });

  it('keys one folder once', () => {
    expect(normalizeProjectDir(join(home, 'x', '..', 'y'))).toBe(
      normalizeProjectDir(join(home, 'y')),
    );
    if (process.platform === 'win32')
      expect(normalizeProjectDir('d:\\p')).toBe(normalizeProjectDir('D:\\p'));
  });
});
