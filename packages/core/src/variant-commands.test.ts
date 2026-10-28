import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
let dir: string;
let clock = 0;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'tforge-variants-')), 'V.tforge');
  const p = sampleProject();
  const boss = p.storyboard!.sections![1]!.slots![0]!;
  if (boss.kind === 'shot') {
    p.assets = [
      ...(p.assets ?? []),
      ...['a', 'b'].map((n) => ({
        assetId: `asset_boss_${n}`,
        role: 'footage' as const,
        addedAt: '2026-10-28T10:00:00.000Z',
      })),
    ];
    boss.takes = ['a', 'b'].map((n) => ({
      id: `take_boss_${n}`,
      assetId: `asset_boss_${n}`,
      matchedBy: 'code' as const,
      attachedAt: '2026-10-28T10:00:00.000Z',
    }));
  }
  store = await ProjectStore.create(dir, p, {
    commands: coreCommands(),
    autosaveMs: 0,
    now: () => new Date(Date.parse('2026-10-28T10:00:00Z') + clock),
  });
});
afterEach(() => store.close());
const variants = () => store.state.storyboard!.variants;
const variant = (id: string) => variants().find((v) => v.id === id)!;

describe('core/variants commands', () => {
  it('adds a version with a minted id, without touching the storyboard revision', () => {
    const revision = store.state.storyboard!.revision;
    store.dispatch('core/variants.add', { formatTargetId: 'fmt_tt', targetDuration: 15 });
    expect(variants().at(-1)).toEqual({
      id: 'var_tiktok_9_16_15s',
      name: '',
      formatTargetId: 'fmt_tt',
      targetDuration: 15,
      reframe: { mode: 'crop' },
      overrides: {},
    });
    expect(store.state.storyboard!.revision).toBe(revision);
    store.undo();
    expect(variants().map((v) => v.id)).toEqual(['var_tt']);
    expect(() => store.dispatch('core/variants.add', { formatTargetId: 'fmt_gone' })).toThrow(
      /no format target/,
    );
    expect(() =>
      store.dispatch('core/variants.add', { id: 'var_tt', formatTargetId: 'fmt_tt' }),
    ).toThrow(/is used/);
  });

  it('changes rules; null goes back to the master length', () => {
    store.dispatch('core/variants.set', {
      variantId: 'var_tt',
      patch: { name: 'Shorts', targetDuration: 30, reframe: { mode: 'fill' } },
    });
    expect(variant('var_tt')).toMatchObject({
      name: 'Shorts',
      targetDuration: 30,
      reframe: { mode: 'fill' },
    });
    store.dispatch('core/variants.set', { variantId: 'var_tt', patch: { targetDuration: null } });
    expect(variant('var_tt').targetDuration).toBeUndefined();
  });

  it('keeps, drops, retimes and swaps takes per slot; quick edits are one undo step', () => {
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_parry',
      patch: { excluded: false },
    });
    clock += 300;
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_parry',
      patch: { duration: { min: 1, ideal: 1.5, max: 2 } },
    });
    expect(variant('var_tt').overrides.shot_parry).toEqual({
      excluded: false,
      duration: { min: 1, ideal: 1.5, max: 2 },
    });
    store.undo();
    expect(variant('var_tt').overrides.shot_parry).toBeUndefined();

    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_boss',
      patch: { takeId: 'take_boss_b', excluded: true },
    });
    expect(variant('var_tt').overrides.shot_boss).toEqual({
      cropCenter: { x: 0.6, y: 0.5 },
      takeId: 'take_boss_b',
      excluded: true,
    });
    clock += 5000;
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_boss',
      patch: { excluded: null, cropCenter: null },
    });
    expect(variant('var_tt').overrides.shot_boss).toEqual({ takeId: 'take_boss_b' });

    expect(() =>
      store.dispatch('core/variants.override', {
        variantId: 'var_tt',
        slotId: 'shot_boss',
        patch: { takeId: 'take_nope' },
      }),
    ).toThrow(/no take/);
    expect(() =>
      store.dispatch('core/variants.override', {
        variantId: 'var_tt',
        slotId: 'shot_nope',
        patch: { excluded: true },
      }),
    ).toThrow(/no slot/);
  });

  it('forgets a swapped take when the take is detached', () => {
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_boss',
      patch: { takeId: 'take_boss_b', cropCenter: null },
    });
    store.dispatch('core/takes.detach', { slotId: 'shot_boss', takeId: 'take_boss_b' });
    expect(variant('var_tt').overrides.shot_boss).toBeUndefined();
  });

  it('clears one slot or all, and removes a version', () => {
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'card_end',
      patch: { excluded: false },
    });
    store.dispatch('core/variants.clear-override', { variantId: 'var_tt', slotId: 'card_end' });
    expect(Object.keys(variant('var_tt').overrides)).toEqual(['shot_boss']);
    store.dispatch('core/variants.clear-override', { variantId: 'var_tt' });
    expect(variant('var_tt').overrides).toEqual({});
    store.dispatch('core/variants.remove', { variantId: 'var_tt' });
    expect(variants()).toEqual([]);
    expect(() => store.dispatch('core/variants.remove', { variantId: 'var_tt' })).toThrow();
  });

  it('overrides survive a rebuild of the master cut, and no derived timeline is saved', async () => {
    store.dispatch('core/variants.override', {
      variantId: 'var_tt',
      slotId: 'shot_parry',
      patch: { excluded: true },
    });
    const before = structuredClone(variant('var_tt'));
    const master = structuredClone(store.state.timelines[0]!);
    master.name = 'Rebuilt';
    store.dispatch('core/timeline.set', { timeline: master });
    expect(variant('var_tt')).toEqual(before);
    await store.save();
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as {
      timelines: { id: string; variantId?: string }[];
      storyboard: { variants: unknown[] };
    };
    expect(saved.timelines.map((t) => t.id)).toEqual([master.id]);
    expect(saved.timelines.some((t) => t.variantId)).toBe(false);
    expect(saved.storyboard.variants).toEqual([before]);
  });
});
