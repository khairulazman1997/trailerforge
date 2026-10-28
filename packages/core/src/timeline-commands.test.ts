import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLICKS_PER_SECOND, Timeline } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandError } from './commands.js';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';
import { isUserEdited } from './timeline-commands.js';

const F = FLICKS_PER_SECOND;
let store: ProjectStore;

const cut = () =>
  Timeline.parse({
    id: 'tl_rough',
    name: 'Rough cut',
    frameRate: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 },
    tracks: [
      {
        id: 'trk_picture',
        kind: 'video',
        items: [
          {
            id: 'rc_a',
            kind: 'clip',
            start: 0,
            duration: 2 * F,
            slotId: 'shot_parry',
            assetId: 'asset_forest',
            sourceIn: F,
          },
          {
            id: 'rc_b',
            kind: 'placeholder',
            start: 2 * F,
            duration: 2 * F,
            slotId: 'shot_boss',
            reason: 'missing-footage',
          },
        ],
      },
      {
        id: 'trk_music',
        kind: 'audio',
        locked: true,
        items: [
          {
            id: 'rc_m',
            kind: 'clip',
            start: 0,
            duration: 4 * F,
            assetId: 'asset_music',
            sourceIn: 0,
          },
        ],
      },
    ],
  });

beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-tl-')), 'T.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
  store.dispatch('core/timeline.set', { timeline: cut() });
});
afterEach(() => store.close());

const tl = () => store.state.timelines.find((t) => t.id === 'tl_rough')!;
const it_ = (id: string) =>
  tl()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.id === id)!;
const ref = (itemId: string) => ({ timelineId: 'tl_rough', itemId });

describe('core/timeline commands', () => {
  it('a trim or move that parts two items drops the transition between them', () => {
    const t = structuredClone(tl());
    const [a, b] = t.tracks[0]!.items;
    t.tracks[0]!.transitions = [
      {
        id: 'tr_x',
        transitionId: 'core/crossfade',
        fromItemId: a!.id,
        toItemId: b!.id,
        duration: 1000,
        params: {},
      },
    ];
    store.dispatch('core/timeline.set', { timeline: t });
    store.dispatch('core/timeline.trim', {
      ...ref(a!.id),
      edge: 'out',
      delta: -FLICKS_PER_SECOND / 10,
    });
    expect(tl().tracks[0]!.transitions).toEqual([]);
    store.undo();
    expect(tl().tracks[0]!.transitions).toHaveLength(1);
  });

  it('sets effects on an item by hand, marks it edited so a rebuild keeps them, and undoes', () => {
    const effects = [
      { id: 'fx_1', effectId: 'core/grain', enabled: true, params: { strength: 20 } },
    ];
    store.dispatch('core/timeline.set-effects', { ...ref('rc_a'), effects });
    const a = tl().tracks[0]!.items.find((i) => i.id === 'rc_a')!;
    expect(a.kind === 'clip' && a.effects).toEqual(effects);
    expect(isUserEdited(a)).toBe(true);
    store.undo();
    const back = tl().tracks[0]!.items.find((i) => i.id === 'rc_a')!;
    expect(back.kind === 'clip' && back.effects).toEqual([]);
    expect(() => store.dispatch('core/timeline.set-effects', { ...ref('rc_b'), effects })).toThrow(
      /placeholder cannot carry effects/,
    );
  });

  it('set creates or replaces a whole timeline in one undo step', () => {
    expect(tl().name).toBe('Rough cut');
    store.dispatch('core/timeline.set', { timeline: { ...cut(), name: 'Rough cut 2' } });
    expect(store.state.timelines.filter((t) => t.id === 'tl_rough')).toHaveLength(1);
    store.undo();
    expect(tl().name).toBe('Rough cut');
  });

  it('trims the in edge with the source and the out edge, marks the item edited, undoes', () => {
    store.dispatch('core/timeline.trim', { ...ref('rc_a'), edge: 'in', delta: F / 2 });
    expect(it_('rc_a')).toMatchObject({ start: F / 2, duration: 1.5 * F, sourceIn: 1.5 * F });
    expect(isUserEdited(it_('rc_a'))).toBe(true);
    store.dispatch('core/timeline.trim', { ...ref('rc_a'), edge: 'out', delta: -F / 2 });
    expect(it_('rc_a')).toMatchObject({ duration: F });
    store.undo();
    store.undo();
    expect(it_('rc_a')).toMatchObject({ start: 0, duration: 2 * F, sourceIn: F });
    expect(isUserEdited(it_('rc_a'))).toBe(false);
  });

  it('refuses trims past the item and moves that overlap', () => {
    expect(() =>
      store.dispatch('core/timeline.trim', { ...ref('rc_a'), edge: 'in', delta: -2 * F }),
    ).toThrow(/past the start/);
    const overlap = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as CommandError).issues.some((i) => /overlap/.test(i.message));
      }
      return false;
    };
    expect(
      overlap(() =>
        store.dispatch('core/timeline.trim', { ...ref('rc_a'), edge: 'out', delta: F }),
      ),
    ).toBe(true);
    expect(overlap(() => store.dispatch('core/timeline.move', { ...ref('rc_a'), start: F }))).toBe(
      true,
    );
  });

  it('swaps a take into a placeholder, empties a clip, and deletes', () => {
    store.dispatch('core/timeline.swap-take', {
      ...ref('rc_b'),
      assetId: 'asset_forest',
      sourceIn: 3 * F,
    });
    expect(it_('rc_b')).toMatchObject({
      kind: 'clip',
      assetId: 'asset_forest',
      sourceIn: 3 * F,
      slotId: 'shot_boss',
    });
    store.dispatch('core/timeline.to-placeholder', { ...ref('rc_a') });
    expect(it_('rc_a')).toMatchObject({
      kind: 'placeholder',
      reason: 'missing-footage',
      note: 'emptied by hand',
    });
    store.dispatch('core/timeline.delete', ref('rc_a'));
    expect(tl().tracks[0]!.items.map((i) => i.id)).toEqual(['rc_b']);
  });

  it('leaves locked tracks alone until unlocked', () => {
    expect(() =>
      store.dispatch('core/timeline.trim', { ...ref('rc_m'), edge: 'out', delta: -F }),
    ).toThrow(/locked/);
    store.dispatch('core/timeline.set-track-locked', {
      timelineId: 'tl_rough',
      trackId: 'trk_music',
      locked: false,
    });
    store.dispatch('core/timeline.trim', { ...ref('rc_m'), edge: 'out', delta: -F });
    expect(it_('rc_m').duration).toBe(3 * F);
  });
});
