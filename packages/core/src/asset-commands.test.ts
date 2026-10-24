import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError } from './commands.js';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
const T = '2026-10-24T10:00:00.000Z';

beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-assets-')), 'A.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());

const roles = () => store.state.assets.map((a) => `${a.assetId}:${a.role}`);

describe('core/assets commands', () => {
  it('adds, re-roles and removes an unused asset, all undoable', () => {
    store.dispatch('core/assets.add', { assetId: 'asset_new', role: 'footage', addedAt: T });
    expect(roles()).toContain('asset_new:footage');
    store.dispatch('core/assets.add', { assetId: 'asset_new', role: 'footage' }); // no-op
    expect(roles().filter((r) => r.startsWith('asset_new'))).toHaveLength(1);
    store.dispatch('core/assets.set-role', { assetId: 'asset_new', role: 'sfx' });
    expect(roles()).toContain('asset_new:sfx');
    store.dispatch('core/assets.remove', { assetId: 'asset_new' });
    expect(roles().some((r) => r.startsWith('asset_new'))).toBe(false);
    store.undo();
    expect(roles()).toContain('asset_new:sfx');
    store.undo();
    store.undo();
    expect(roles().some((r) => r.startsWith('asset_new'))).toBe(false);
  });

  it('refuses adding the same asset with another role', () => {
    expect(() =>
      store.dispatch('core/assets.add', { assetId: 'asset_music', role: 'sfx' }),
    ).toThrow(/set-role/);
  });

  it('refuses removing an asset that is still used, and says where', () => {
    try {
      store.dispatch('core/assets.remove', { assetId: 'asset_music' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      const paths = (err as CommandError).issues.map((i) => i.path);
      expect(paths).toContain('storyboard.music.trackAssetId');
      expect(paths.some((p) => p.startsWith('timelines['))).toBe(true);
    }
    expect(roles()).toContain('asset_music:music');
  });

  it('refuses unknown assets for remove and set-role', () => {
    expect(() => store.dispatch('core/assets.remove', { assetId: 'nope' })).toThrow(
      /not in the project/,
    );
    expect(() => store.dispatch('core/assets.set-role', { assetId: 'nope', role: 'sfx' })).toThrow(
      /not in the project/,
    );
  });
});
