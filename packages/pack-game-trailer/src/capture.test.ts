import {
  KnowledgeEntity,
  Project,
  Storyboard,
  type Section,
  type Slot,
  type SlotStatus,
} from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  buildCapturePlan,
  capturePadding,
  type CapturePlan,
  MIN_RECORD_SECONDS,
  PACK_ID,
  readCaptureExt,
} from './index.js';

/** mulberry32: small seeded PRNG so property runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES: SlotStatus[] = ['empty', 'recorded', 'approved', 'rejected'];
const LOCATIONS = ['Forest', 'forest ', 'Castle', 'Hub', '', '  Castle'];
const SETUPS = ['', 'Boss phase 2', 'boss  phase 2', 'Night', 'Max loadout'];
const ENTITIES = ['ent_a', 'ent_b', 'ent_c', 'ent_missing'];

function knowledge(): KnowledgeEntity[] {
  return [
    KnowledgeEntity.parse({ id: 'ent_a', kind: 'boss', name: 'Warden' }),
    KnowledgeEntity.parse({ id: 'ent_b', kind: 'level', name: 'Ashwood', excludedFromLlm: true }),
    KnowledgeEntity.parse({ id: 'ent_c', kind: 'character', name: 'warden' }),
  ];
}

function randomStoryboard(seed: number, maxSlots: number): Storyboard {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const slotCount = Math.floor(r() * (maxSlots + 1));
  const sections: unknown[] = [];
  let n = 0;
  while (n < slotCount || sections.length === 0) {
    const slots: unknown[] = [];
    const size = Math.min(slotCount - n, 1 + Math.floor(r() * 6));
    for (let i = 0; i < size; i++, n++) {
      const ideal = Math.round(r() * 80) / 10;
      const duration = { min: ideal / 2, ideal, max: ideal + Math.round(r() * 40) / 10 };
      if (r() < 0.15) {
        slots.push({ id: `s${n}`, kind: 'card', cardKind: 'cta', templateId: 'core/x', duration });
        continue;
      }
      const capture: Record<string, unknown> = {};
      if (r() < 0.1) capture['skipped'] = true;
      if (r() < 0.3) capture['order'] = Math.floor(r() * 5) - 2;
      if (r() < 0.05) capture['takes'] = 'garbage';
      slots.push({
        id: `s${n}`,
        kind: 'shot',
        duration,
        location: pick(LOCATIONS),
        setup: pick(SETUPS),
        status: pick(STATUSES),
        entityIds: r() < 0.3 ? [] : [pick(ENTITIES), pick(ENTITIES)],
        ...(r() < 0.2 ? { transitionOut: { transitionId: 'core/flash', duration: 0.25 } } : {}),
        extensions: Object.keys(capture).length ? { [PACK_ID]: { capture } } : {},
      });
    }
    sections.push({ id: `sec${sections.length}`, name: 'S', locked: r() < 0.3, slots });
  }
  return Storyboard.parse({
    id: 'sb',
    meta: { videoTypeId: 'game-trailer/release-trailer', targetDuration: 60 },
    sections,
  });
}

const shots = (sb: Storyboard) =>
  sb.sections.flatMap((s: Section) => s.slots).filter((s: Slot) => s.kind === 'shot');
const itemIds = (p: CapturePlan) => p.groups.flatMap((g) => g.items.map((i) => i.slotId));

describe('buildCapturePlan properties', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  it('lists every unrecorded, unskipped shot exactly once and nothing else', () => {
    for (const seed of seeds) {
      const sb = randomStoryboard(seed, 40);
      const all = buildCapturePlan(sb, knowledge());
      const todo = buildCapturePlan(sb, knowledge(), { include: 'todo' });
      const live = shots(sb).filter((s) => !readCaptureExt(s).skipped);
      const unrecorded = live.filter((s) => s.status === 'empty' || s.status === 'rejected');

      const ids = itemIds(all);
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
      expect([...ids].sort()).toEqual(live.map((s) => s.id).sort());
      expect([...itemIds(todo)].sort()).toEqual(unrecorded.map((s) => s.id).sort());
      expect(all.skippedSlotIds).toEqual(
        shots(sb)
          .filter((s) => readCaptureExt(s).skipped)
          .map((s) => s.id),
      );
      expect(all.total).toBe(live.length);
      expect(all.total - all.done).toBe(unrecorded.length);
      expect(all.groups.reduce((s, g) => s + g.total, 0)).toBe(all.total);
    }
  });

  it('is deterministic: same input, identical output, input untouched', () => {
    for (const seed of seeds.slice(0, 50)) {
      const sb = randomStoryboard(seed, 40);
      const before = structuredClone(sb);
      const a = buildCapturePlan(sb, knowledge());
      const b = buildCapturePlan(structuredClone(sb), [...knowledge()].reverse());
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(sb).toEqual(before);
    }
  });

  it('keeps each group contiguous and groups sorted by location, setup, entity', () => {
    for (const seed of seeds) {
      const plan = buildCapturePlan(randomStoryboard(seed, 40), knowledge());
      const keys = plan.groups.map((g) => g.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const g of plan.groups) {
        for (const i of g.items) {
          const loc = i.location.trim().replace(/\s+/g, ' ').toLowerCase();
          expect(g.key.startsWith(`${loc}|`)).toBe(true);
          expect(g.entity?.id ?? null).toBe(i.entities[0]?.id ?? null);
        }
      }
      // Named locations first, unnamed last.
      const locs = plan.groups.map((g) => g.key.split('|')[0]!);
      const firstEmpty = locs.indexOf('');
      if (firstEmpty >= 0) expect(locs.slice(firstEmpty).every((l) => l === '')).toBe(true);
    }
  });

  it('orders items within a group by capture order, then storyboard order', () => {
    for (const seed of seeds) {
      const sb = randomStoryboard(seed, 40);
      const order = new Map(shots(sb).map((s) => [s.id, readCaptureExt(s).order ?? Infinity]));
      for (const g of buildCapturePlan(sb, knowledge()).groups) {
        for (let k = 1; k < g.items.length; k++) {
          const [p, q] = [g.items[k - 1]!, g.items[k]!];
          const [op, oq] = [order.get(p.slotId)!, order.get(q.slotId)!];
          expect(op < oq || (op === oq && p.shotNumber < q.shotNumber)).toBe(true);
        }
      }
    }
  });

  it('pads every shot: record ≥ max + 2 × handle, whole seconds, handle in [1, 3]', () => {
    for (const seed of seeds.slice(0, 50)) {
      for (const g of buildCapturePlan(randomStoryboard(seed, 40), knowledge()).groups) {
        for (const i of g.items) {
          expect(i.handle).toBeGreaterThanOrEqual(1);
          expect(i.handle).toBeLessThanOrEqual(3);
          expect(Number.isInteger(i.recordSeconds)).toBe(true);
          expect(i.recordSeconds).toBeGreaterThanOrEqual(i.duration.max + 2 * i.handle - 1e-9);
          expect(i.recordSeconds).toBeGreaterThanOrEqual(MIN_RECORD_SECONDS);
        }
      }
    }
  });
});

describe('capturePadding', () => {
  const pad = (ideal: number, max: number, tIn = 0, tOut = 0) =>
    capturePadding({
      duration: { min: 0, ideal, max },
      ...(tIn ? { transitionIn: { transitionId: 'core/x', duration: tIn, params: {} } } : {}),
      ...(tOut ? { transitionOut: { transitionId: 'core/x', duration: tOut, params: {} } } : {}),
    });

  it.each([
    // ideal, max, handle, record
    [0, 0, 1, 5], // floor handle, minimum length
    [1, 1.5, 1, 5],
    [4, 6, 2, 10],
    [3, 4.1, 1.5, 8], // 7.1 → 8
    [10, 12, 3, 18], // handle capped
  ])('ideal %s max %s → handle %s, record %s', (ideal, max, handle, record) => {
    expect(pad(ideal, max)).toEqual({ handle, recordSeconds: record });
  });

  it('adds transition time and ignores float noise', () => {
    expect(pad(4, 6, 0.5, 0.5).recordSeconds).toBe(11);
    expect(pad(4, 5.9 + 0.1).recordSeconds).toBe(10);
  });
});

describe('buildCapturePlan examples', () => {
  it('handles an empty storyboard', () => {
    const plan = buildCapturePlan({ id: 'sb', revision: 3, sections: [] }, []);
    expect(plan).toEqual({
      storyboardId: 'sb',
      storyboardRevision: 3,
      groups: [],
      skippedSlotIds: [],
      total: 0,
      done: 0,
      todoRecordSeconds: 0,
    });
  });

  it('builds the sample project plan with names, exclusions and locked sections kept', () => {
    const p = Project.parse(sampleProject());
    const plan = buildCapturePlan(p.storyboard!, p.knowledge);
    const items = plan.groups.flatMap((g) => g.items);
    expect(items.map((i) => i.slotId).sort()).toEqual(['shot_boss', 'shot_parry']);
    expect(plan.groups.every((g) => g.location === 'Forest')).toBe(true);
    const boss = items.find((i) => i.slotId === 'shot_boss')!;
    expect(boss.entities.map((e) => e.id)).toEqual(['ent_warden', 'ent_forest']);
    expect(boss.entities.every((e) => e.name.length > 0)).toBe(true);
    const parry = items.find((i) => i.slotId === 'shot_parry')!;
    expect(parry).toMatchObject({ hud: 'off', shotNumber: 1, sectionName: 'Hook', todo: true });
    expect(parry.instruction).toContain('parry');
  });

  it('marks unknown entities excluded and uses labels from the first shot', () => {
    const sb = Storyboard.parse({
      id: 'sb',
      meta: { videoTypeId: 'x/y', targetDuration: 30 },
      sections: [
        {
          id: 'sec',
          name: 'A',
          locked: true,
          slots: [
            { id: 'b', kind: 'shot', duration: { min: 1, ideal: 2, max: 3 }, location: 'castle ' },
            { id: 'a', kind: 'shot', duration: { min: 1, ideal: 2, max: 3 }, location: 'Castle' },
            {
              id: 'c',
              kind: 'shot',
              status: 'recorded',
              duration: { min: 1, ideal: 2, max: 3 },
              entityIds: ['ent_gone'],
              extensions: { [PACK_ID]: { capture: { notes: 'redo', takes: 2 } } },
            },
          ],
        },
      ],
    });
    const plan = buildCapturePlan(sb, []);
    expect(plan.groups.map((g) => [g.location, g.items.map((i) => i.slotId)])).toEqual([
      ['castle', ['b', 'a']],
      ['', ['c']],
    ]);
    expect(plan.groups[1]!.entity).toEqual({
      id: 'ent_gone',
      name: 'ent_gone',
      kind: null,
      excludedFromLlm: true,
    });
    expect(plan.groups[1]!.items[0]).toMatchObject({ notes: 'redo', takes: 2, todo: false });
    expect(plan).toMatchObject({ total: 3, done: 1, todoRecordSeconds: 10 });
  });

  it('scales to a huge storyboard', () => {
    const sb = randomStoryboard(42, 5000);
    const t0 = performance.now();
    const plan = buildCapturePlan(sb, knowledge());
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(plan.total).toBe(shots(sb).filter((s) => !readCaptureExt(s).skipped).length);
  });
});
