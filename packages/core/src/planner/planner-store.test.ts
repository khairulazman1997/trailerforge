import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError } from '../commands.js';
import { PlannerOpenError, PlannerStore } from './planner-store.js';

let home: string;
let clock: number;
const now = () => new Date(clock);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-planner-'));
  clock = Date.parse('2026-11-05T09:00:00Z');
});
afterEach(() => rm(home, { recursive: true, force: true }));

async function seeded() {
  const store = await PlannerStore.open(home, { now });
  await store.dispatch('planner/campaign.add', { id: 'cmp_a', name: 'Launch' });
  await store.dispatch('planner/slot.add', {
    id: 'cal_1',
    date: '2026-12-01',
    title: 'Release trailer',
    campaignId: 'cmp_a',
    platformTargets: ['core/youtube', 'core/tiktok'],
  });
  return store;
}

describe('PlannerStore', () => {
  it('starts empty and persists commands to planner.json', async () => {
    const store = await seeded();
    const again = await PlannerStore.open(home);
    expect(again.state).toEqual(store.state);
    expect(again.state.slots[0]).toMatchObject({
      campaignId: 'cmp_a',
      projectId: null,
      createdAt: '2026-11-05T09:00:00.000Z',
    });
  });

  it('gives new entities ids when none are passed', async () => {
    const store = await PlannerStore.open(home);
    await store.dispatch('planner/campaign.add', { name: 'Demo' });
    expect(store.state.campaigns[0]!.id).toMatch(/^cmp_[0-9a-f]{8}$/);
  });

  it('undoes and redoes each command as one step', async () => {
    const store = await seeded();
    await store.dispatch('planner/slot.move', { slotId: 'cal_1', date: '2026-12-08' });
    expect(store.undoLabel()).toBe('Move to 2026-12-08');
    await store.undo();
    expect(store.state.slots[0]!.date).toBe('2026-12-01');
    await store.undo();
    expect(store.state.slots).toEqual([]);
    await store.redo();
    await store.redo();
    expect(store.state.slots[0]!.date).toBe('2026-12-08');
    expect((await PlannerStore.open(home)).state).toEqual(store.state);
  });

  it('merges quick repeated moves into one undo step', async () => {
    const store = await seeded();
    for (const date of ['2026-12-02', '2026-12-03', '2026-12-04']) {
      clock += 200;
      await store.dispatch('planner/slot.move', { slotId: 'cal_1', date });
    }
    await store.undo();
    expect(store.state.slots[0]!.date).toBe('2026-12-01');
  });

  it('removing a campaign keeps its slots without one, or removes them', async () => {
    const store = await seeded();
    await store.dispatch('planner/campaign.remove', { campaignId: 'cmp_a' });
    expect(store.state.slots[0]!.campaignId).toBeNull();
    await store.undo();
    await store.dispatch('planner/campaign.remove', { campaignId: 'cmp_a', slots: 'remove' });
    expect(store.state.slots).toEqual([]);
  });

  it('clears optional fields with null and refuses invalid results', async () => {
    const store = await seeded();
    await store.dispatch('planner/campaign.set', {
      campaignId: 'cmp_a',
      color: '#ff8800',
      startDate: '2026-11-01',
    });
    clock += 5000; // past the merge window: its own undo step
    await store.dispatch('planner/campaign.set', { campaignId: 'cmp_a', color: null });
    expect(store.state.campaigns[0]!.color).toBeUndefined();
    await expect(
      store.dispatch('planner/campaign.set', { campaignId: 'cmp_a', endDate: '2026-10-01' }),
    ).rejects.toThrow(/cannot end before it starts/);
    await expect(
      store.dispatch('planner/slot.add', { date: '2026-12-01', title: 'x', campaignId: 'nope' }),
    ).rejects.toThrow(CommandError);
    await expect(store.dispatch('planner/slot.move', { slotId: 'cal_1' })).rejects.toThrow(
      /invalid payload/,
    );
    // Failed commands leave no undo step behind.
    await store.undo();
    expect(store.state.campaigns[0]!.color).toBe('#ff8800');
  });

  it('links a project to one slot only', async () => {
    const store = await seeded();
    await store.dispatch('planner/slot.add', { id: 'cal_2', date: '2026-12-09', title: 'Cutdown' });
    await store.dispatch('planner/slot.link', { slotId: 'cal_1', projectId: 'proj_x' });
    await expect(
      store.dispatch('planner/slot.link', { slotId: 'cal_2', projectId: 'proj_x' }),
    ).rejects.toThrow(/already on "Release trailer"/);
    await store.dispatch('planner/slot.unlink', { slotId: 'cal_1' });
    await store.dispatch('planner/slot.link', { slotId: 'cal_2', projectId: 'proj_x' });
    expect(store.state.slots.map((s) => s.projectId)).toEqual([null, 'proj_x']);
  });

  it('two stores on one home keep both writes; undo refuses after a change elsewhere', async () => {
    const a = await seeded();
    const b = await PlannerStore.open(home);
    await b.dispatch('planner/slot.add', { id: 'cal_b', date: '2026-12-20', title: 'From B' });
    await a.dispatch('planner/slot.add', { id: 'cal_a', date: '2026-12-21', title: 'From A' });
    expect(a.state.slots.map((s) => s.id)).toEqual(['cal_1', 'cal_b', 'cal_a']);
    await b.dispatch('planner/slot.remove', { slotId: 'cal_b' });
    await expect(a.undo()).rejects.toThrow(/changed elsewhere/);
    expect(a.canUndo()).toBe(false);
    expect(a.state.slots.map((s) => s.id)).toEqual(['cal_1', 'cal_a']);
  });

  it('reports changes', async () => {
    const seen: string[] = [];
    const store = await PlannerStore.open(home, { onChange: (_f, c) => seen.push(c.kind) });
    await store.dispatch('planner/campaign.add', { name: 'X' });
    await store.undo();
    await store.redo();
    expect(seen).toEqual(['command', 'undo', 'redo']);
  });

  it('leaves an unreadable file untouched and sweeps temp files from a crashed write', async () => {
    const dir = join(home, 'planner');
    await seeded();
    const good = await readFile(join(dir, 'planner.json'), 'utf8');
    await writeFile(join(dir, 'planner.json.tmp-99999-1'), '{"half":');
    const store = await PlannerStore.open(home);
    expect(await readdir(dir)).not.toContain('planner.json.tmp-99999-1');
    expect(store.state.slots).toHaveLength(1);
    await writeFile(join(dir, 'planner.json'), '{ broken');
    await expect(PlannerStore.open(home)).rejects.toThrow(PlannerOpenError);
    expect(await readFile(join(dir, 'planner.json'), 'utf8')).toBe('{ broken');
    expect(good).toContain('"cal_1"');
  });
});
