import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { parseProject, Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { buildCapturePlan, captureCommands, PACK_ID, readCaptureExt } from './index.js';

async function withStore(
  fn: (store: ProjectStore) => void | Promise<void>,
  tweak: (p: Project) => void = () => undefined,
) {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-cap-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of captureCommands) registry.register(c);
  const project = Project.parse(sampleProject());
  tweak(project);
  const store = await ProjectStore.create(dir, project, {
    commands: registry,
    autosaveMs: 0,
  });
  try {
    await fn(store);
    expect(parseProject(store.state).ok).toBe(true);
  } finally {
    await store.close();
  }
}

const shot = (store: ProjectStore, id: string): ShotSlot => {
  const slot = store.state.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === id);
  if (slot?.kind !== 'shot') throw new Error(`no shot ${id}`);
  return slot;
};
const capture = (store: ProjectStore, id: string) => readCaptureExt(shot(store, id));
const plan = (store: ProjectStore) =>
  buildCapturePlan(store.state.storyboard!, store.state.knowledge);

/** Storyboard content that capture edits must never change. */
function content(store: ProjectStore) {
  const sb = structuredClone(store.state.storyboard!);
  for (const sec of sb.sections) {
    for (const slot of sec.slots) {
      if (slot.kind === 'shot') slot.status = 'empty';
      delete slot.extensions[PACK_ID];
    }
  }
  return sb;
}

describe('capture commands', () => {
  it('marks status, notes, takes and skip, and undoes each', async () => {
    await withStore((store) => {
      const before = structuredClone(store.state);
      store.dispatch('game-trailer/capture.set-status', {
        slotId: 'shot_parry',
        status: 'recorded',
      });
      store.dispatch('game-trailer/capture.set-takes', { slotId: 'shot_parry', takes: 3 });
      store.dispatch('game-trailer/capture.set-notes', {
        slotId: 'shot_parry',
        notes: 'use take 2',
      });
      store.dispatch('game-trailer/capture.set-skipped', { slotId: 'shot_boss', skipped: true });
      expect(shot(store, 'shot_parry').status).toBe('recorded');
      expect(capture(store, 'shot_parry')).toMatchObject({ takes: 3, notes: 'use take 2' });
      expect(plan(store)).toMatchObject({ total: 1, done: 1, skippedSlotIds: ['shot_boss'] });

      for (let i = 0; i < 4; i++) store.undo();
      expect(store.state).toEqual(before);
      store.redo();
      expect(shot(store, 'shot_parry').status).toBe('recorded');
    });
  });

  it('drops capture data when it returns to defaults and keeps other slot extensions', async () => {
    await withStore((store) => {
      store.dispatch('game-trailer/capture.set-notes', { slotId: 'shot_boss', notes: 'x' });
      store.dispatch('game-trailer/capture.set-notes', { slotId: 'shot_boss', notes: '' });
      expect(shot(store, 'shot_boss').extensions).toEqual({});
      expect(() =>
        store.dispatch('game-trailer/capture.set-status', {
          slotId: 'shot_boss',
          status: 'approved',
        }),
      ).not.toThrow();
    });
  });

  it('leaves storyboard content, timing and revision unchanged', async () => {
    await withStore((store) => {
      const before = content(store);
      const rev = store.state.storyboard!.revision;
      store.dispatch('game-trailer/capture.set-status', {
        slotId: 'shot_boss',
        status: 'rejected',
      });
      store.dispatch('game-trailer/capture.set-takes', { slotId: 'shot_boss', takes: 2 });
      store.dispatch('game-trailer/capture.set-skipped', { slotId: 'shot_parry', skipped: true });
      store.dispatch('game-trailer/capture.reorder-group', { slotIds: ['shot_boss'] });
      expect(content(store)).toEqual(before);
      expect(store.state.storyboard!.revision).toBe(rev);
    });
  });

  it('works in locked sections', async () => {
    await withStore(
      (store) => {
        store.dispatch('game-trailer/capture.set-status', {
          slotId: 'shot_parry',
          status: 'approved',
        });
        store.dispatch('game-trailer/capture.set-notes', { slotId: 'shot_parry', notes: 'ok' });
        expect(shot(store, 'shot_parry').status).toBe('approved');
        expect(store.state.storyboard!.sections[0]!.locked).toBe(true);
      },
      (p) => {
        p.storyboard!.sections[0]!.locked = true;
      },
    );
  });

  it('rejects cards, unknown slots and bad values', async () => {
    await withStore((store) => {
      const run = (type: string, payload: unknown) => () => store.dispatch(type, payload as never);
      expect(
        run('game-trailer/capture.set-status', { slotId: 'card_end', status: 'recorded' }),
      ).toThrow();
      expect(run('game-trailer/capture.set-notes', { slotId: 'nope', notes: 'x' })).toThrow();
      expect(run('game-trailer/capture.set-takes', { slotId: 'shot_boss', takes: -1 })).toThrow();
      expect(
        run('game-trailer/capture.set-status', { slotId: 'shot_boss', status: 'done' }),
      ).toThrow();
    });
  });

  it('reorders within a group only, leaving the storyboard order alone', async () => {
    const together = (p: Project) => {
      p.storyboard!.sections[0]!.slots[0]!.entityIds = ['ent_warden'];
    };
    await withStore((store) => {
      const group = () => plan(store).groups.find((g) => g.items.length === 2)!;
      const before = content(store);
      expect(group().items.map((i) => i.slotId)).toEqual(['shot_parry', 'shot_boss']);

      store.dispatch('game-trailer/capture.reorder-group', {
        slotIds: ['shot_boss', 'shot_parry'],
      });
      expect(group().items.map((i) => i.slotId)).toEqual(['shot_boss', 'shot_parry']);
      expect(content(store)).toEqual(before);
      store.undo();
      expect(group().items.map((i) => i.slotId)).toEqual(['shot_parry', 'shot_boss']);

      // Not exactly one group, duplicates and unknown ids are refused and change nothing.
      const snapshot = structuredClone(store.state);
      for (const slotIds of [['shot_parry'], ['shot_boss', 'shot_boss'], ['shot_boss', 'nope']]) {
        expect(() => store.dispatch('game-trailer/capture.reorder-group', { slotIds })).toThrow();
      }
      expect(store.state).toEqual(snapshot);
    }, together);
  });
});
