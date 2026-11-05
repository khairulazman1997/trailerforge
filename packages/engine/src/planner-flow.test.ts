import dns from 'node:dns';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemoOp, type DemoOutcome } from './demo-ops.js';
import { Engine } from './engine.js';
import { plannerViewOp } from './planner-ops.js';
import { exportVersionOp } from './render-ops.js';
import { assetUsageOp } from './reuse-ops.js';

/**
 * The planner, start to end: a campaign with planned videos, projects made or linked, exports
 * that note the footage they used, and the campaign listing what its videos share. Built on
 * the demo project's generated footage, with no network.
 */

const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let engine: Engine;
let a: DemoOutcome;
let b: DemoOutcome;
const store = (o: DemoOutcome) => [...engine.projects.values()].find((s) => s.state.id === o.projectId)!; // prettier-ignore

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-planflow-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  a = await createDemoOp(engine);
  b = await createDemoOp(engine); // same generated footage: the library keeps one copy
}, 240_000);
afterAll(async () => engine.close());

describe('planner flow', { timeout: 600_000 }, () => {
  it('plans a campaign, links and creates projects, and follows them to a shared-footage list', async () => {
    const { planner } = engine;
    await planner.dispatch('planner/campaign.add', { id: 'cmp_flow', name: 'Launch' });
    for (const [id, title, date] of [
      ['cal_a', 'Launch trailer', '2026-12-01'],
      ['cal_b', 'Teaser', '2026-12-08'],
    ] as const)
      await planner.dispatch('planner/slot.add', {
        id,
        title,
        date,
        campaignId: 'cmp_flow',
        platformTargets: ['core/youtube'],
      });
    await planner.dispatch('planner/slot.link', { slotId: 'cal_a', projectId: a.projectId });
    await planner.dispatch('planner/slot.link', { slotId: 'cal_b', projectId: b.projectId });
    for (const o of [a, b])
      store(o).dispatch('core/project.set-campaign', { campaignId: 'cmp_flow' });
    store(a).dispatch('core/project.set-schedule', { scheduledDate: '2026-12-01' });

    // A third video starts from its calendar entry and joins the campaign by itself.
    await planner.dispatch('planner/slot.add', {
      id: 'cal_c',
      title: 'Vertical cutdown',
      date: '2026-12-15',
      campaignId: 'cmp_flow',
      platformTargets: ['core/tiktok'],
    });
    const made = await engine.createFromCalendarSlot('cal_c');
    expect(engine.projects.get(made.dir)!.state).toMatchObject({
      campaignId: 'cmp_flow',
      scheduledDate: '2026-12-15',
    });

    // Before any export: nothing shared, and the demo's cut points past "Idea".
    const before = await plannerViewOp(engine);
    expect(before.campaigns[0]!.sharedFootage).toEqual([]);
    const row = (view: typeof before, id: string) => view.slots.find((s) => s.id === id)!.project!;
    expect(row(before, 'cal_a')).toMatchObject({ status: 'idea', scheduledDate: '2026-12-01' });
    expect(row(before, 'cal_a').suggestion?.status).toBe('editing');
    expect(row(before, 'cal_c').suggestion).toBeNull();

    // Export the 16:9 version of each demo: the footage they play is noted.
    const first = (o: DemoOutcome) => o.versions[0]!;
    const exportedA = await exportVersionOp(engine, store(a), first(a));
    expect(exportedA.file).toMatch(/exports[\\/]render/);
    const afterA = await plannerViewOp(engine);
    const sharedA = afterA.campaigns[0]!.sharedFootage;
    expect(sharedA.length).toBeGreaterThanOrEqual(5); // five shots and the music
    expect(sharedA.every((f) => f.projectIds.join() === a.projectId)).toBe(true);
    // A has an export and a date now: "Scheduled" is suggested, not applied.
    expect(row(afterA, 'cal_a')).toMatchObject({ status: 'idea' });
    expect(row(afterA, 'cal_a').suggestion?.status).toBe('scheduled');

    await exportVersionOp(engine, store(b), first(b));
    const afterB = await plannerViewOp(engine);
    const shared = afterB.campaigns[0]!.sharedFootage;
    expect(shared.length).toBe(sharedA.length);
    for (const f of shared) expect([...f.projectIds].sort()).toEqual([a.projectId, b.projectId].sort()); // prettier-ignore

    // Each recording says where it was used, once per export.
    const usage = assetUsageOp(engine, shared[0]!.assetId)[0]!.uses;
    expect(usage.map((u) => [u.projectName, u.exports]).sort()).toEqual([
      ['Demo: Ember Knight', 1],
      ['Demo: Ember Knight', 1],
    ]);

    // Applying the suggestion is the user's step, and the calendar follows it.
    store(a).dispatch('core/project.set-status', { status: 'scheduled' });
    const done = await plannerViewOp(engine);
    expect(row(done, 'cal_a')).toMatchObject({ status: 'scheduled', suggestion: null });
    expect(done.projects.map((p) => p.campaignId)).toEqual(['cmp_flow', 'cmp_flow', 'cmp_flow']);
    expect(done.projects).toHaveLength(3);
  });

  it('used no network', () => {
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
