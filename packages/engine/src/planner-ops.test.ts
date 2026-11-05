import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExport } from '@trailerforge/compile';
import { FormatTarget } from '@trailerforge/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { OpError } from './ops.js';
import { createFromCalendarSlotOp, plannerViewOp } from './planner-ops.js';
import { BUILTIN_PLATFORMS, platformFormat, presetForPlatforms } from './platforms.js';

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

let home: string;
let engine: Engine;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-planops-'));
  engine = await Engine.start({ home, autosaveMs: 0 });
  await engine.planner.dispatch('planner/campaign.add', { id: 'cmp_launch', name: 'Launch!' });
  await engine.planner.dispatch('planner/slot.add', {
    id: 'cal_1',
    date: '2026-12-01',
    title: 'Release trailer',
    campaignId: 'cmp_launch',
    platformTargets: ['core/tiktok', 'core/youtube'],
    videoTypeId: 'game-trailer/release-trailer',
  });
});
afterEach(() => engine.close());

describe('platforms', () => {
  it('every built-in platform gives a valid format that fits its preset', () => {
    const ids = engine.plugins.registries.platforms.list().map((p) => p.id);
    expect(ids).toEqual(BUILTIN_PLATFORMS.map((p) => p.id).sort());
    for (const p of engine.plugins.registries.platforms.list()) {
      const f = FormatTarget.parse(platformFormat(p));
      const preset = presetForPlatforms([p], f.platformIds);
      expect(preset, p.id).toBeTruthy();
      const r = resolveExport(preset, f);
      expect(r.preset.id).toBe(preset);
      expect(r.issues, p.id).toEqual([]);
    }
  });
});

describe('createFromCalendarSlot', () => {
  it('makes the project with a version format per platform and links the slot', async () => {
    const out = await engine.createFromCalendarSlot('cal_1');
    expect(out.dir).toBe(join(home, 'projects', 'Launch', 'Release trailer.tforge'));
    expect(out.warnings).toEqual([]);
    const store = engine.projects.get(out.dir)!;
    expect(store.state).toMatchObject({
      name: 'Release trailer',
      campaignId: 'cmp_launch',
      scheduledDate: '2026-12-01',
      platformTargets: ['core/tiktok', 'core/youtube'],
      status: 'idea',
      brief: { videoTypeId: 'game-trailer/release-trailer' },
    });
    const formats = store.state.formatTargets;
    expect(formats.map((f) => [f.aspect, f.resolution, f.platformIds])).toEqual([
      ['9:16', { width: 1080, height: 1920 }, ['core/tiktok']],
      ['16:9', { width: 1920, height: 1080 }, ['core/youtube']],
    ]);
    const profiles = engine.plugins.registries.platforms.list();
    expect(formats.map((f) => presetForPlatforms(profiles, f.platformIds))).toEqual([
      'core/vertical',
      'core/youtube',
    ]);
    expect(engine.planner.state.slots[0]!.projectId).toBe(out.projectId);
    expect(engine.registry.byId(out.projectId)?.dir).toBe(out.dir);

    // A second slot with the same title gets the next free folder and the same formats.
    await engine.planner.dispatch('planner/slot.add', {
      id: 'cal_2',
      date: '2026-12-02',
      title: 'Release trailer',
      campaignId: 'cmp_launch',
      platformTargets: ['core/tiktok', 'core/youtube', 'acme/unknown'],
    });
    const second = await engine.createFromCalendarSlot('cal_2');
    expect(second.dir).toBe(join(home, 'projects', 'Launch', 'Release trailer 2.tforge'));
    expect(second.warnings).toEqual([
      'Platform acme/unknown is not installed: no version was made for it.',
    ]);
    expect(engine.projects.get(second.dir)!.state.formatTargets).toEqual(formats);
  });

  it('refuses a linked slot, an unknown slot and a folder in use', async () => {
    await expect(engine.createFromCalendarSlot('cal_x')).rejects.toMatchObject({
      code: 'not-found',
    });
    const used = join(home, 'used');
    await mkdir(used);
    await writeFile(join(used, 'notes.txt'), 'mine');
    await expect(engine.createFromCalendarSlot('cal_1', { dir: used })).rejects.toThrow(
      /not empty/,
    );
    await engine.createFromCalendarSlot('cal_1');
    await expect(engine.createFromCalendarSlot('cal_1')).rejects.toThrow(/already has a project/);
  });

  it('leaves nothing behind when a step fails', async () => {
    const dir = join(home, 'chosen.tforge');
    const spy = vi.spyOn(engine.planner, 'dispatch').mockRejectedValueOnce(new Error('disk full'));
    const err = await createFromCalendarSlotOp(engine, 'cal_1', { dir }).catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(OpError);
    expect(err.message).toMatch(/disk full/);
    expect(await exists(dir)).toBe(false);
    expect(engine.projects.size).toBe(0);
    expect(engine.registry.list()).toEqual([]);
    expect(engine.planner.state.slots[0]!.projectId).toBeNull();
    // An empty folder the user chose is kept, and emptied again.
    await mkdir(dir);
    vi.spyOn(engine.planner, 'dispatch').mockRejectedValueOnce(new Error('again'));
    await createFromCalendarSlotOp(engine, 'cal_1', { dir }).catch(() => {});
    expect(await exists(dir)).toBe(true);
    expect(await exists(join(dir, 'project.json'))).toBe(false);
  });
});

describe('plannerViewOp', () => {
  it('shows each slot with its project live fields, and is stable', async () => {
    const before = await plannerViewOp(engine);
    expect(before.slots[0]!.project).toBeNull();
    expect(before.platforms.find((p) => p.id === 'core/steam')).toEqual({
      id: 'core/steam',
      name: 'Steam store page',
      aspect: '16:9',
      presetId: 'core/steam',
    });
    const out = await engine.createFromCalendarSlot('cal_1');
    const store = engine.projects.get(out.dir)!;
    store.dispatch('core/project.set-schedule', { scheduledDate: '2026-12-15' });
    store.dispatch('core/project.set-status', { status: 'capturing' });
    await store.save();
    const view = await plannerViewOp(engine);
    expect(view.slots[0]!.date).toBe('2026-12-01');
    expect(view.slots[0]!.project).toMatchObject({
      id: out.projectId,
      state: 'ok',
      status: 'capturing',
      scheduledDate: '2026-12-15',
      suggestion: null,
    });
    expect(view.campaigns[0]!.sharedFootage).toEqual([]);
    expect(await plannerViewOp(engine)).toEqual(view);

    // Closed projects are read from their file.
    await engine.closeProject(out.dir);
    expect((await plannerViewOp(engine)).slots[0]!.project).toEqual(view.slots[0]!.project);
  });
});
