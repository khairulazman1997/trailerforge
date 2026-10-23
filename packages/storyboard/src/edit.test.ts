import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { parseProject, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { storyboardCommands } from './commands.js';
import { regenerateSection } from './generate.js';
import { storyboardTiming } from './timing.js';
import { userEditedFields } from './user-edits.js';

async function openStore() {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-edit-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of storyboardCommands) registry.register(c);
  return ProjectStore.create(dir, Project.parse(sampleProject()), {
    commands: registry,
    autosaveMs: 0,
  });
}

/** Runs `fn` with a fresh store and checks the project is still valid afterwards. */
async function withStore(fn: (store: ProjectStore) => void | Promise<void>) {
  const store = await openStore();
  try {
    await fn(store);
    expect(parseProject(store.state).ok).toBe(true);
  } finally {
    await store.close();
  }
}

const sb = (store: ProjectStore) => store.state.storyboard!;
const slot = (store: ProjectStore, id: string) =>
  sb(store)
    .sections.flatMap((s) => s.slots)
    .find((s) => s.id === id)!;
const newShot = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'shot',
  title: id,
  duration: { min: 1, ideal: 2, max: 3 },
  ...extra,
});

describe('editing slots', () => {
  it('edits fields, records what changed, and bumps the revision', async () => {
    await withStore((store) => {
      const rev = sb(store).revision;
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_parry',
        patch: {
          captureInstruction: 'Parry twice.',
          duration: { min: 2, ideal: 3, max: 4 },
          hud: 'on',
        },
      });
      expect(slot(store, 'shot_parry')).toMatchObject({
        captureInstruction: 'Parry twice.',
        hud: 'on',
        duration: { min: 2, ideal: 3, max: 4 },
      });
      expect(userEditedFields(slot(store, 'shot_parry'))).toEqual([
        'captureInstruction',
        'duration',
        'hud',
      ]);
      expect(sb(store).revision).toBe(rev + 1);
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_parry',
        patch: { title: 'Parry!' },
      });
      expect(userEditedFields(slot(store, 'shot_parry'))).toEqual([
        'captureInstruction',
        'duration',
        'hud',
        'title',
      ]);
    });
  });

  it('edits card text and clears a transition with null', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.set-section-locked', { sectionId: 'sec_end', locked: false });
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'card_end',
        patch: { text: 'Out now' },
      });
      expect(slot(store, 'card_end')).toMatchObject({ text: 'Out now' });
      expect(slot(store, 'shot_parry')).toHaveProperty('transitionOut');
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_boss',
        patch: { transitionOut: null },
      });
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_parry',
        patch: { transitionOut: null },
      });
      expect(slot(store, 'shot_parry')).not.toHaveProperty('transitionOut');
    });
  });

  it('rejects bad edits without changing anything', async () => {
    await withStore((store) => {
      const before = store.state;
      const patch = (p: object) => () =>
        store.dispatch('core/storyboard.update-slot', { slotId: 'shot_parry', patch: p });
      expect(patch({ text: 'cards only' })).toThrow(/shot slot has no "text"/);
      expect(patch({ duration: { min: 3, ideal: 2, max: 4 } })).toThrow(/invalid payload/);
      expect(patch({ entityIds: ['ent_made_up'] })).toThrow(/broken references/);
      expect(patch({ kind: 'card' })).toThrow(/invalid payload/);
      expect(() =>
        store.dispatch('core/storyboard.update-slot', { slotId: 'nope', patch: { title: 'x' } }),
      ).toThrow(/no slot/);
      expect(store.state).toBe(before);
    });
  });

  it('refuses every edit inside a locked section', async () => {
    await withStore((store) => {
      const before = store.state;
      const locked = [
        () =>
          store.dispatch('core/storyboard.update-slot', {
            slotId: 'card_end',
            patch: { text: 'x' },
          }),
        () =>
          store.dispatch('core/storyboard.add-slot', {
            sectionId: 'sec_end',
            slot: newShot('shot_x'),
          }),
        () => store.dispatch('core/storyboard.remove-slot', { slotId: 'card_end' }),
        () =>
          store.dispatch('core/storyboard.move-slot', {
            slotId: 'card_end',
            toSectionId: 'sec_hook',
          }),
        () =>
          store.dispatch('core/storyboard.move-slot', {
            slotId: 'shot_parry',
            toSectionId: 'sec_end',
          }),
        () =>
          store.dispatch('core/storyboard.update-section', {
            sectionId: 'sec_end',
            patch: { name: 'x' },
          }),
        () => store.dispatch('core/storyboard.move-section', { sectionId: 'sec_end', index: 0 }),
        () => store.dispatch('core/storyboard.remove-section', { sectionId: 'sec_end' }),
      ];
      for (const attempt of locked) expect(attempt).toThrow(/locked/);
      expect(store.state).toBe(before);
    });
  });

  it('collapses rapid edits of one field into a single undo step', async () => {
    await withStore((store) => {
      for (const title of ['P', 'Pa', 'Par', 'Parry']) {
        store.dispatch('core/storyboard.update-slot', { slotId: 'shot_parry', patch: { title } });
      }
      expect(slot(store, 'shot_parry').title).toBe('Parry');
      store.undo();
      expect(slot(store, 'shot_parry').title).toBe('Perfect parry');
      expect(userEditedFields(slot(store, 'shot_parry'))).toEqual([]);
    });
  });
});

describe('adding, removing and moving slots', () => {
  it('adds a slot at a position, marks it as added, and rejects reused ids', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.add-slot', {
        sectionId: 'sec_hook',
        index: 0,
        slot: newShot('shot_new'),
      });
      expect(sb(store).sections[0]!.slots.map((s) => s.id)).toEqual(['shot_new', 'shot_parry']);
      expect(userEditedFields(slot(store, 'shot_new'))).toEqual(['added']);
      expect(slot(store, 'shot_new')).toMatchObject({ status: 'empty', hud: 'any' }); // defaults applied
      expect(() =>
        store.dispatch('core/storyboard.add-slot', {
          sectionId: 'sec_hook',
          slot: newShot('shot_new'),
        }),
      ).toThrow(/already used/);
      expect(() =>
        store.dispatch('core/storyboard.add-slot', {
          sectionId: 'sec_hook',
          slot: newShot('shot_y'),
          index: 9,
        }),
      ).toThrow(/past the end/);
      expect(() =>
        store.dispatch('core/storyboard.add-slot', {
          sectionId: 'sec_hook',
          slot: newShot('shot_z', { entityIds: ['ent_nope'] }),
        }),
      ).toThrow(/broken references/);
    });
  });

  it('deleting a slot cleans up everything that pointed at it', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.remove-slot', { slotId: 'shot_boss' });
      expect(sb(store).sections[1]!.slots).toEqual([]);
      expect(sb(store).music.hitPoints).toEqual([]);
      expect(sb(store).music.sfxCues).toEqual([]);
      expect(sb(store).variants[0]!.overrides).toEqual({});
      const linked = store.state.timelines
        .flatMap((t) => t.tracks.flatMap((k) => k.items))
        .filter((i) => i.slotId);
      expect(linked.map((i) => i.slotId)).not.toContain('shot_boss');

      store.dispatch('core/storyboard.remove-slot', { slotId: 'shot_parry' });
      expect(sb(store).voLines).toEqual([]); // vo_1 only narrated that slot
      store.undo();
      store.undo();
      expect(slot(store, 'shot_boss')).toBeDefined();
      expect(sb(store).music.hitPoints).toHaveLength(1);
    });
  });

  it('moves a slot within and between sections', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.move-slot', {
        slotId: 'shot_boss',
        toSectionId: 'sec_hook',
        index: 0,
      });
      expect(sb(store).sections[0]!.slots.map((s) => s.id)).toEqual(['shot_boss', 'shot_parry']);
      expect(sb(store).sections[1]!.slots).toEqual([]);
      store.dispatch('core/storyboard.move-slot', { slotId: 'shot_boss', toSectionId: 'sec_hook' });
      expect(sb(store).sections[0]!.slots.map((s) => s.id)).toEqual(['shot_parry', 'shot_boss']);
      expect(() =>
        store.dispatch('core/storyboard.move-slot', {
          slotId: 'shot_boss',
          toSectionId: 'sec_hook',
          index: 5,
        }),
      ).toThrow(/past the end/);
      // Moving doesn't count as rewriting the slot.
      expect(userEditedFields(slot(store, 'shot_boss'))).toEqual([]);
    });
  });
});

describe('editing sections', () => {
  it('adds, renames, reorders and deletes sections', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.add-section', {
        id: 'sec_mid',
        name: 'Interlude',
        role: 'beat',
        index: 1,
      });
      expect(sb(store).sections.map((s) => s.id)).toEqual([
        'sec_hook',
        'sec_mid',
        'sec_escalation',
        'sec_end',
      ]);
      store.dispatch('core/storyboard.update-section', {
        sectionId: 'sec_mid',
        patch: { name: 'Breather', role: null },
      });
      expect(sb(store).sections[1]).toMatchObject({ name: 'Breather' });
      expect(sb(store).sections[1]).not.toHaveProperty('role');
      store.dispatch('core/storyboard.move-section', { sectionId: 'sec_escalation', index: 0 });
      expect(sb(store).sections.map((s) => s.id)).toEqual([
        'sec_escalation',
        'sec_hook',
        'sec_mid',
        'sec_end',
      ]);
      expect(() =>
        store.dispatch('core/storyboard.add-section', { id: 'sec_mid', name: 'Dup' }),
      ).toThrow(/already used/);
      expect(() =>
        store.dispatch('core/storyboard.move-section', { sectionId: 'sec_hook', index: 9 }),
      ).toThrow(/past the last/);

      store.dispatch('core/storyboard.remove-section', { sectionId: 'sec_escalation' });
      expect(sb(store).music.structure[0]!.sectionIds).toEqual(['sec_hook']); // music plan no longer points at it
      expect(sb(store).music.hitPoints).toEqual([]);
      expect(sb(store).sections.map((s) => s.id)).toEqual(['sec_hook', 'sec_mid', 'sec_end']);
    });
  });
});

describe('VO, music and length', () => {
  it('edits VO lines and the music plan', async () => {
    await withStore((store) => {
      store.dispatch('core/storyboard.add-vo-line', {
        id: 'vo_2',
        text: 'Rise.',
        linkedSlotIds: ['shot_boss'],
      });
      store.dispatch('core/storyboard.update-vo-line', {
        id: 'vo_2',
        patch: { text: 'Rise, knight.', targetDuration: 2 },
      });
      expect(sb(store).voLines.find((v) => v.id === 'vo_2')).toMatchObject({
        text: 'Rise, knight.',
        targetDuration: 2,
      });
      store.dispatch('core/storyboard.update-vo-line', {
        id: 'vo_2',
        patch: { targetDuration: null },
      });
      expect(sb(store).voLines.find((v) => v.id === 'vo_2')).not.toHaveProperty('targetDuration');
      expect(() =>
        store.dispatch('core/storyboard.update-vo-line', {
          id: 'vo_2',
          patch: { linkedSlotIds: ['shot_nope'] },
        }),
      ).toThrow(/broken references/);
      store.dispatch('core/storyboard.remove-vo-line', { id: 'vo_2' });
      expect(sb(store).voLines.map((v) => v.id)).toEqual(['vo_1']);

      store.dispatch('core/storyboard.update-music', {
        patch: { direction: 'Quiet piano', bpm: null, trackAssetId: null },
      });
      expect(sb(store).music).toMatchObject({ direction: 'Quiet piano' });
      expect(sb(store).music).not.toHaveProperty('bpm');
      expect(sb(store).music).not.toHaveProperty('trackAssetId');
      expect(() =>
        store.dispatch('core/storyboard.update-music', { patch: { trackAssetId: 'asset_nope' } }),
      ).toThrow(/broken references/);
      expect(() =>
        store.dispatch('core/storyboard.update-music', { patch: { bpm: { min: 150, max: 100 } } }),
      ).toThrow(/invalid payload/);
    });
  });

  it('reports timing against the target without changing the target', async () => {
    await withStore((store) => {
      const before = storyboardTiming(sb(store));
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_parry',
        patch: { duration: { min: 5, ideal: 8, max: 9 } },
      });
      const after = storyboardTiming(sb(store));
      expect(after.target).toBe(before.target);
      expect(after.actual).toBe(Math.round((before.actual + 6) * 10) / 10);
      expect(after.delta).toBe(Math.round((after.actual - after.target) * 10) / 10);
      store.dispatch('core/storyboard.set-target-duration', { seconds: 45 });
      expect(storyboardTiming(sb(store)).target).toBe(45);
      expect(() => store.dispatch('core/storyboard.set-target-duration', { seconds: 0 })).toThrow(
        /invalid payload/,
      );
    });
  });
});

describe('regenerating around hand edits', () => {
  const reply = {
    rationale: 'Fresh take.',
    section: {
      name: 'Escalation v2',
      slots: [
        { kind: 'shot', title: 'Forest run', seconds: 1 },
        { kind: 'shot', title: 'Warden lands', seconds: 1 },
      ],
    },
  };
  const llmFor = (mock: ReturnType<typeof createMockProvider>) =>
    new LlmClient({
      providers: (id) => (id === 'core/mock' ? mock : undefined),
      routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
    });

  it('keeps edited and added slots in place and writes only the rest, in the time left', async () => {
    await withStore(async (store) => {
      store.dispatch('core/storyboard.add-slot', {
        sectionId: 'sec_escalation',
        slot: newShot('shot_mine', { title: 'My own shot', captureInstruction: 'Do my thing' }),
      });
      const mine = slot(store, 'shot_mine');
      const sectionBefore = sb(store).sections[1]!;
      const total = sectionBefore.slots.reduce((a, s) => a + s.duration.ideal, 0);

      const mock = createMockProvider({ 'storyboard.regenerate-section': reply });
      const { payload, decisions } = await regenerateSection({ llm: llmFor(mock) }, store.state, {
        sectionId: 'sec_escalation',
      });
      expect(mock.calls[0]!.prompt).toMatch(/Fixed slots:\n- #2 My own shot/);
      expect(mock.calls[0]!.prompt).toMatch(/fill 2\.5 seconds/); // 4.5 - the 2 s kept
      expect(payload.section.slots.map((s) => s.title)).toEqual([
        'Forest run',
        'My own shot',
        'Warden lands',
      ]);
      expect(payload.section.slots[1]).toEqual(mine);
      expect(payload.section.slots.reduce((a, s) => a + s.duration.ideal, 0)).toBeCloseTo(total, 9);
      expect(decisions[0]!.reasons.pinnedSlotIds).toEqual(['shot_mine']);

      store.dispatch('core/storyboard.replace-section', payload);
      expect(slot(store, 'shot_mine')).toEqual(mine);
      expect(slot(store, 'shot_boss')).toBeUndefined(); // the untouched old slot was replaced
    });
  });

  it('can rewrite everything on request, and explains when nothing is left to rewrite', async () => {
    await withStore(async (store) => {
      store.dispatch('core/storyboard.update-slot', {
        slotId: 'shot_boss',
        patch: { title: 'Boss, my way' },
      });
      const mock = createMockProvider({ 'storyboard.regenerate-section': reply });
      const deps = { llm: llmFor(mock) };
      await expect(
        regenerateSection(deps, store.state, { sectionId: 'sec_escalation' }),
      ).rejects.toThrow(/edited by hand/);
      expect(mock.calls).toHaveLength(0);
      const all = await regenerateSection(deps, store.state, {
        sectionId: 'sec_escalation',
        keepEdited: false,
      });
      expect(all.payload.section.slots.map((s) => s.title)).toEqual(['Forest run', 'Warden lands']);
      expect(all.decisions[0]!.reasons.pinnedSlotIds).toEqual([]);
    });
  });
});
