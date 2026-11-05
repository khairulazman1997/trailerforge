import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine.js';

describe('Engine planner and project list', () => {
  it('registers created and opened projects, follows renames, reports planner changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tforge-planreg-'));
    const engine = await Engine.start({ home, autosaveMs: 0 });
    const changes: string[] = [];
    engine.bus.on('core/planner.changed', (c) => changes.push(`${c.kind} ${c.type}`));
    try {
      const dir = join(home, 'P.tforge');
      const store = await engine.createProject(dir, { name: 'Pilot' });
      expect(engine.registry.byId(store.state.id)).toMatchObject({ name: 'Pilot' });
      store.dispatch('core/project.rename', { name: 'Pilot 2' });
      await store.save();
      await engine.closeProject(dir);
      await engine.openProject(dir);
      expect(engine.registry.list().map((p) => p.name)).toEqual(['Pilot 2']);
      expect((await engine.registry.views())[0]!.state).toBe('ok');

      await engine.planner.dispatch('planner/slot.add', { date: '2026-12-01', title: 'Teaser' });
      await engine.planner.undo();
      expect(changes).toEqual(['command planner/slot.add', 'undo planner/slot.add']);
    } finally {
      await engine.close();
    }
  });
});
