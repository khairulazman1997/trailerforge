import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { bridgeProjectStore, EventBus, type CoreEvents } from './events.js';
import { coreCommands, renameProject } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

const approved: CoreEvents['core/storyboard.approved'] = {
  projectId: 'p',
  storyboardId: 'sb',
  revision: 3,
};

describe('EventBus', () => {
  it('delivers typed events in subscription order', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('core/storyboard.approved', (e) => seen.push(`a:${e.revision}`));
    bus.on('core/storyboard.approved', (e) => seen.push(`b:${e.storyboardId}`));
    bus.emit('core/storyboard.approved', approved);
    expect(seen).toEqual(['a:3', 'b:sb']);
  });

  it('supports namespaced plugin events', () => {
    const bus = new EventBus();
    let got: unknown;
    bus.on('planner/slot.scheduled', (p) => (got = p));
    bus.emit('planner/slot.scheduled', { slotId: 's1' });
    expect(got).toEqual({ slotId: 's1' });
  });

  it('unsubscribes and cleans up empty handler sets', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on('core/storyboard.approved', () => void n++);
    bus.emit('core/storyboard.approved', approved);
    off();
    bus.emit('core/storyboard.approved', approved);
    expect(n).toBe(1);
    expect(bus.listenerCount('core/storyboard.approved')).toBe(0);
  });

  it('once fires a single time', () => {
    const bus = new EventBus();
    let n = 0;
    bus.once('core/storyboard.approved', () => void n++);
    bus.emit('core/storyboard.approved', approved);
    bus.emit('core/storyboard.approved', approved);
    expect(n).toBe(1);
  });

  it('isolates throwing and rejecting handlers and reports them', async () => {
    const errors: string[] = [];
    const bus = new EventBus({
      onError: (err, type) => errors.push(`${type}:${(err as Error).message}`),
    });
    let reached = false;
    bus.on('core/storyboard.approved', () => {
      throw new Error('sync');
    });
    bus.on('core/storyboard.approved', async () => {
      throw new Error('async');
    });
    bus.on('core/storyboard.approved', () => void (reached = true));
    bus.emit('core/storyboard.approved', approved);
    await new Promise((r) => setTimeout(r, 0));
    expect(reached).toBe(true);
    expect(errors).toEqual(['core/storyboard.approved:sync', 'core/storyboard.approved:async']);
  });

  it('applies subscription changes made during dispatch on the next emit', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const offB = bus.on('x', () => {
      seen.push('a');
      offB();
      bus.on('x', () => seen.push('late'));
    });
    bus.emit('x', null);
    bus.emit('x', null);
    expect(seen).toEqual(['a', 'late']);
  });

  it('onAny observes every event', () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.onAny((t) => types.push(t));
    bus.emit('core/storyboard.approved', approved);
    bus.emit('tools/thing', 1);
    expect(types).toEqual(['core/storyboard.approved', 'tools/thing']);
  });
});

describe('bridgeProjectStore', () => {
  it('forwards store changes as core/project.changed', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-bus-')), 'P.tforge');
    const store = await ProjectStore.create(dir, sampleProject(), {
      commands: coreCommands(),
      autosaveMs: 0,
    });
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('core/project.changed', (e) =>
      seen.push(`${e.projectId}:${e.change.kind}:${e.change.label}`),
    );
    const off = bridgeProjectStore(store, bus);
    store.run(renameProject, { name: 'Bridged' });
    store.undo();
    off();
    store.redo();
    await store.close();
    expect(seen).toEqual([
      'proj_sample:command:Rename project to "Bridged"',
      'proj_sample:undo:Undo: Rename project to "Bridged"',
    ]);
  });
});
