import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
let clock = 0;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-music-')), 'M.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
    now: () => new Date(Date.parse('2026-10-24T10:00:00Z') + clock),
  });
});
afterEach(() => store.close());
const music = () => store.state.storyboard!.music;

describe('core/music commands', () => {
  it('nudges persist, merge into one undo step when quick, and reset', () => {
    const revision = store.state.storyboard!.revision;
    store.dispatch('core/music.set-grid', { patch: { downbeatShift: 1 } });
    clock += 200;
    store.dispatch('core/music.set-grid', { patch: { offset: 5000, tempo: 121.5 } });
    expect(music().grid).toEqual({
      downbeatShift: 1,
      offset: 5000,
      tempo: 121.5,
      barsPerPhrase: 4,
    });
    expect(store.state.storyboard!.revision).toBe(revision); // the storyboard content did not change
    store.undo();
    expect(music().grid).toBeUndefined(); // both nudges were one step
    store.redo();
    store.dispatch('core/music.set-grid', { patch: { tempo: null } });
    expect(music().grid?.tempo).toBeUndefined();
    store.dispatch('core/music.reset-grid', {});
    expect(music().grid).toBeUndefined();
  });

  it('rejects out-of-range nudges', () => {
    expect(() => store.dispatch('core/music.set-grid', { patch: { offset: 10 ** 12 } })).toThrow();
    expect(() => store.dispatch('core/music.set-grid', { patch: { tempo: 500 } })).toThrow();
  });

  it('choosing another track adds it as music and drops the old nudges; null removes it', () => {
    store.dispatch('core/music.set-grid', { patch: { downbeatShift: 2 } });
    clock += 5000;
    store.dispatch('core/music.set-track', { assetId: 'asset_song2' });
    expect(music().trackAssetId).toBe('asset_song2');
    expect(music().grid).toBeUndefined();
    expect(store.state.assets.find((a) => a.assetId === 'asset_song2')?.role).toBe('music');
    store.dispatch('core/music.set-track', { assetId: null });
    expect(music().trackAssetId).toBeUndefined();
    expect(() => store.dispatch('core/music.set-grid', { patch: { downbeatShift: 1 } })).toThrow(
      /music track first/,
    );
    store.undo();
    store.undo();
    expect(music().trackAssetId).toBe('asset_music');
    expect(music().grid?.downbeatShift).toBe(2);
  });
});
