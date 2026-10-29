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

  it('sets and removes the transition into an item, only where the clips touch', () => {
    const [a, b] = tl().tracks[0]!.items;
    store.dispatch('core/timeline.set-transition', {
      timelineId: 'tl_rough',
      toItemId: b!.id,
      transition: { transitionId: 'core/crossfade', duration: FLICKS_PER_SECOND * 10 },
    });
    const t = tl().tracks[0]!.transitions;
    expect(t).toEqual([
      expect.objectContaining({
        transitionId: 'core/crossfade',
        fromItemId: a!.id,
        toItemId: b!.id,
      }),
    ]);
    expect(t[0]!.duration).toBeLessThanOrEqual(Math.min(a!.duration, b!.duration)); // never longer than the clips
    expect(t[0]!.decisionId).toBeUndefined(); // by hand
    store.dispatch('core/timeline.set-transition', {
      timelineId: 'tl_rough',
      toItemId: b!.id,
      transition: { transitionId: 'core/dip', duration: 1000 },
    });
    expect(tl().tracks[0]!.transitions.map((x) => x.transitionId)).toEqual(['core/dip']); // replaced, not added
    store.dispatch('core/timeline.set-transition', {
      timelineId: 'tl_rough',
      toItemId: b!.id,
      transition: null,
    });
    expect(tl().tracks[0]!.transitions).toEqual([]);
    expect(() =>
      store.dispatch('core/timeline.set-transition', {
        timelineId: 'tl_rough',
        toItemId: a!.id,
        transition: { transitionId: 'core/dip', duration: 1000 },
      }),
    ).toThrow(/needs the clip before it/);
  });

  it('refuses a hand-set transition that would flash more than three times a second', () => {
    const [, b] = tl().tracks[0]!.items;
    const glitch = {
      transitionId: 'core/glitch',
      duration: FLICKS_PER_SECOND,
      params: { rate: 8 },
    };
    expect(() =>
      store.dispatch('core/timeline.set-transition', {
        timelineId: 'tl_rough',
        toItemId: b!.id,
        transition: glitch,
      }),
    ).toThrow(/flashes within one second/);
    store.dispatch('core/timeline.set-transition', {
      timelineId: 'tl_rough',
      toItemId: b!.id,
      transition: { ...glitch, params: { rate: 2 } },
    });
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

  it("turns a clip's own sound on with J/L offsets, marks it edited, undoes", () => {
    store.dispatch('core/timeline.set-clip-audio', {
      ...ref('rc_a'),
      enabled: true,
      gainDb: -6,
      lead: F / 4,
      lag: F / 2,
    });
    const a = it_('rc_a');
    expect(a.extensions.core).toMatchObject({
      clipAudio: { enabled: true, lead: F / 4, lag: F / 2 },
    });
    expect(a.kind === 'clip' && a.gainDb).toBe(-6);
    expect(isUserEdited(a)).toBe(true);
    store.undo();
    expect(it_('rc_a').extensions.core).toBeUndefined();
    expect(() =>
      store.dispatch('core/timeline.set-clip-audio', {
        ...ref('rc_a'),
        enabled: true,
        lead: 2 * F,
      }),
    ).toThrow();
    expect(() =>
      store.dispatch('core/timeline.set-clip-audio', { ...ref('rc_b'), enabled: true }),
    ).toThrow(/placeholder has no sound/);
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

  it('ripple trims and moves carry the items after them, each in one undo step', () => {
    store.dispatch('core/timeline.trim', { ...ref('rc_a'), edge: 'out', delta: F, ripple: true });
    expect([it_('rc_a').duration, it_('rc_b').start]).toEqual([3 * F, 3 * F]);
    expect(isUserEdited(it_('rc_b'))).toBe(true);
    store.undo();
    expect([it_('rc_a').duration, it_('rc_b').start]).toEqual([2 * F, 2 * F]);
    store.dispatch('core/timeline.trim', {
      ...ref('rc_a'),
      edge: 'in',
      delta: F / 2,
      ripple: true,
    });
    expect(it_('rc_a')).toMatchObject({ start: 0, duration: 1.5 * F, sourceIn: 1.5 * F });
    expect(it_('rc_b').start).toBe(1.5 * F);
    store.undo();
    store.dispatch('core/timeline.move', { ...ref('rc_a'), start: F / 2, ripple: true });
    expect([it_('rc_a').start, it_('rc_b').start]).toEqual([F / 2, 2.5 * F]);
    store.undo();
    expect([it_('rc_a').start, it_('rc_b').start]).toEqual([0, 2 * F]);
  });

  it('moves an item onto another track of the same kind; locked or other kinds refuse', () => {
    const t = cut();
    t.tracks.push({ id: 'trk_over', kind: 'video', name: 'Over', muted: false, locked: false, items: [], transitions: [] }); // prettier-ignore
    store.dispatch('core/timeline.set', { timeline: t });
    store.dispatch('core/timeline.move', { ...ref('rc_b'), start: 3 * F, trackId: 'trk_over', ripple: true }); // prettier-ignore
    const where = () =>
      tl().tracks.map((k) => [k.id, k.items.map((i) => `${i.id}@${i.start / F}`)]);
    expect(where()).toEqual([['trk_picture', ['rc_a@0']], ['trk_music', ['rc_m@0']], ['trk_over', ['rc_b@3']]]); // prettier-ignore
    store.undo();
    expect(where()[0]).toEqual(['trk_picture', ['rc_a@0', 'rc_b@2']]);
    expect(() => store.dispatch('core/timeline.move', { ...ref('rc_b'), start: 0, trackId: 'trk_music' })).toThrow(/locked/); // prettier-ignore
    store.dispatch('core/timeline.set-track-locked', { timelineId: 'tl_rough', trackId: 'trk_music', locked: false }); // prettier-ignore
    expect(() => store.dispatch('core/timeline.move', { ...ref('rc_b'), start: 5 * F, trackId: 'trk_music' })).toThrow(/another video track/); // prettier-ignore
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
