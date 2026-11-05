import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-planfields-')), 'P.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());

describe('core/project planner fields', () => {
  it('sets and clears campaign, date, platforms and status, one undo step each', () => {
    const revision = store.state.storyboard!.revision;
    store.dispatch('core/project.set-campaign', { campaignId: 'cmp_launch' });
    store.dispatch('core/project.set-schedule', { scheduledDate: '2026-12-01' });
    store.dispatch('core/project.set-platforms', {
      platformTargets: ['core/steam', 'core/steam', 'core/x'],
    });
    store.dispatch('core/project.set-status', { status: 'capturing' });
    expect(store.state).toMatchObject({
      campaignId: 'cmp_launch',
      scheduledDate: '2026-12-01',
      platformTargets: ['core/steam', 'core/x'],
      status: 'capturing',
    });
    expect(store.state.storyboard!.revision).toBe(revision);
    store.dispatch('core/project.set-campaign', { campaignId: null });
    store.dispatch('core/project.set-schedule', { scheduledDate: null });
    expect(store.state.campaignId).toBeNull();
    expect(store.state.scheduledDate).toBeNull();
    for (let i = 0; i < 6; i++) store.undo();
    expect(store.state).toMatchObject({ campaignId: null, scheduledDate: null });
    expect(store.state.platformTargets).toEqual(sampleProject().platformTargets);
  });

  it('refuses bad dates and platform ids', () => {
    expect(() =>
      store.dispatch('core/project.set-schedule', { scheduledDate: '2026-13-40' }),
    ).toThrow();
    expect(() =>
      store.dispatch('core/project.set-platforms', { platformTargets: ['YouTube'] }),
    ).toThrow();
  });
});
