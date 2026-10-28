import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-export-')), 'E.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());
const exp = () => store.state.storyboard!.variants.find((v) => v.id === 'var_tt')!.export;

describe('core/export commands', () => {
  it('chooses a preset, adjusts details, clears them, resets, and undoes each step', () => {
    const revision = store.state.storyboard!.revision;
    expect(exp()).toBeUndefined();
    expect(() => store.dispatch('core/export.set', { variantId: 'var_tt', fileName: 'x' })).toThrow(
      /choose a preset first/,
    );
    store.dispatch('core/export.set', { variantId: 'var_tt', presetId: 'core/vertical' });
    store.dispatch('core/export.set', {
      variantId: 'var_tt',
      fileName: '{project}-shorts',
      loudnessLufs: -16,
      posterSeconds: 3,
    });
    expect(exp()).toEqual({
      presetId: 'core/vertical',
      fileName: '{project}-shorts',
      loudnessLufs: -16,
      posterSeconds: 3,
    });
    store.dispatch('core/export.set', { variantId: 'var_tt', loudnessLufs: null });
    expect(exp()).not.toHaveProperty('loudnessLufs');
    store.dispatch('core/export.reset', { variantId: 'var_tt' });
    expect(exp()).toBeUndefined();
    store.undo();
    expect(exp()).toMatchObject({ presetId: 'core/vertical', posterSeconds: 3 });
    expect(store.state.storyboard!.revision).toBe(revision);
    expect(() =>
      store.dispatch('core/export.set', { variantId: 'var_gone', presetId: 'core/youtube' }),
    ).toThrow(/no version/);
    expect(() =>
      store.dispatch('core/export.set', { variantId: 'var_tt', presetId: 'a', loudnessLufs: 3 }),
    ).toThrow();
  });
});
