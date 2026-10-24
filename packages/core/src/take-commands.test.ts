import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
const T = '2026-10-24T10:00:00.000Z';
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-takes-')), 'T.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());

const shot = (id = 'shot_parry') => {
  const s = store.state.storyboard!.sections.flatMap((x) => x.slots).find((x) => x.id === id)!;
  if (s.kind !== 'shot') throw new Error('not a shot');
  return s;
};

describe('core/takes commands', () => {
  it('attaching a recording adds the asset, the take, and marks an empty shot recorded; undo restores all', () => {
    expect(shot().status).toBe('empty');
    store.dispatch('core/takes.attach', {
      slotId: 'shot_parry',
      assetId: 'asset_rec1',
      matchedBy: 'code',
      attachedAt: T,
    });
    expect(shot().takes).toEqual([
      {
        id: 'take_rec1',
        assetId: 'asset_rec1',
        matchedBy: 'code',
        rejected: false,
        note: '',
        attachedAt: T,
      },
    ]);
    expect(shot().status).toBe('recorded');
    expect(store.state.assets.find((a) => a.assetId === 'asset_rec1')?.role).toBe('footage');
    store.undo();
    expect(shot().takes).toEqual([]);
    expect(shot().status).toBe('empty');
    expect(store.state.assets.some((a) => a.assetId === 'asset_rec1')).toBe(false);
  });

  it('attach-many is one undo step and mints unique take ids', () => {
    store.dispatch('core/takes.attach-many', {
      items: [
        { slotId: 'shot_parry', assetId: 'asset_a', matchedBy: 'suggestion', attachedAt: T },
        { slotId: 'shot_boss', assetId: 'asset_a', matchedBy: 'vision', attachedAt: T },
        { slotId: 'shot_parry', assetId: 'asset_b', matchedBy: 'code', attachedAt: T },
      ],
    });
    expect(shot().takes.map((t) => t.id)).toEqual(['take_a', 'take_b']);
    expect(shot('shot_boss').takes.map((t) => t.id)).toEqual(['take_a_2']);
    store.undo();
    expect(shot().takes).toEqual([]);
    expect(shot('shot_boss').takes).toEqual([]);
  });

  it('refuses the same recording twice on one shot, and unknown shots', () => {
    store.dispatch('core/takes.attach', {
      slotId: 'shot_parry',
      assetId: 'asset_a',
      matchedBy: 'manual',
    });
    expect(() =>
      store.dispatch('core/takes.attach', {
        slotId: 'shot_parry',
        assetId: 'asset_a',
        matchedBy: 'manual',
      }),
    ).toThrow(/already a take/);
    expect(() =>
      store.dispatch('core/takes.attach', {
        slotId: 'nope',
        assetId: 'asset_a',
        matchedBy: 'manual',
      }),
    ).toThrow(/no shot/);
  });

  it('choose, reject and detach keep the chosen take valid', () => {
    store.dispatch('core/takes.attach-many', {
      items: [
        { slotId: 'shot_parry', assetId: 'asset_a', matchedBy: 'code' },
        { slotId: 'shot_parry', assetId: 'asset_b', matchedBy: 'code' },
      ],
    });
    store.dispatch('core/takes.choose', { slotId: 'shot_parry', takeId: 'take_b' });
    expect(shot().chosenTakeId).toBe('take_b');
    store.dispatch('core/takes.reject', { slotId: 'shot_parry', takeId: 'take_b', rejected: true });
    expect(shot().chosenTakeId).toBeUndefined();
    expect(() =>
      store.dispatch('core/takes.choose', { slotId: 'shot_parry', takeId: 'take_b' }),
    ).toThrow(/rejected/);
    store.dispatch('core/takes.choose', { slotId: 'shot_parry', takeId: 'take_a' });
    store.dispatch('core/takes.detach', { slotId: 'shot_parry', takeId: 'take_a' });
    expect(shot().chosenTakeId).toBeUndefined();
    expect(shot().takes.map((t) => t.id)).toEqual(['take_b']);
    store.dispatch('core/takes.choose', { slotId: 'shot_parry', takeId: null });
    expect(store.state.assets.some((a) => a.assetId === 'asset_a')).toBe(true); // asset stays
  });

  it('works in locked sections (a lock guards content, not recordings)', async () => {
    const p = sampleProject();
    for (const s of p.storyboard!.sections ?? []) s.locked = true;
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-takes-')), 'L.tforge');
    const locked = await ProjectStore.create(dir, p, { commands: coreCommands(), autosaveMs: 0 });
    try {
      locked.dispatch('core/takes.attach', {
        slotId: 'shot_parry',
        assetId: 'asset_l',
        matchedBy: 'manual',
      });
      locked.dispatch('core/takes.choose', { slotId: 'shot_parry', takeId: 'take_l' });
      const s = locked.state
        .storyboard!.sections.flatMap((x) => x.slots)
        .find((x) => x.id === 'shot_parry')!;
      expect(s.kind === 'shot' && s.chosenTakeId).toBe('take_l');
    } finally {
      await locked.close();
    }
  });
});
