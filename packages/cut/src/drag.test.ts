import { moveItem, trimItem } from '@trailerforge/core';
import { Timeline, flicksPerFrame, rate, type Project } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { nearestTarget, planDrag, snapTargets, type DragCommand, type DragPlan } from './drag.js';

const R = rate(30);
const FPF = flicksPerFrame(R);
const fr = (n: number) => n * FPF;

/** mulberry32: a small seeded generator so every "random" case is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTimeline(seed: number): Timeline {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  let n = 0;
  const track = (id: string, kind: 'video' | 'graphics', locked: boolean) => {
    let at = int(0, 10);
    const items = Array.from({ length: int(2, 6) }, () => {
      const start = at;
      const duration = int(3, 40);
      at = start + duration + (r() < 0.4 ? 0 : int(1, 12));
      const id = `i${n++}`;
      return kind === 'video'
        ? { id, kind: 'clip', start: fr(start), duration: fr(duration), assetId: 'a', sourceIn: fr(int(0, 60)), speed: r() < 0.2 ? 2 : 1 }
        : { id, kind: 'graphic', start: fr(start), duration: fr(duration), templateId: 'core/title-card' };
    }); // prettier-ignore
    return { id, kind, locked, items };
  };
  return Timeline.parse({
    id: 'tl',
    name: 'T',
    frameRate: R,
    resolution: { width: 1920, height: 1080 },
    tracks: [track('v1', 'video', false), track('v2', 'video', r() < 0.3), track('g1', 'graphics', false)],
    markers: Array.from({ length: 12 }, (_, k) => ({ id: `m${k}`, at: fr(15 * k) + 1000, kind: k % 4 ? 'beat' : 'downbeat' })),
  }); // prettier-ignore
}

/** Apply a planned command with the real core command; throws like the store would. */
function apply(tl: Timeline, cmd: DragCommand): Timeline {
  const d = { timelines: [structuredClone(tl)] } as unknown as Project;
  if (cmd.type === 'core/timeline.move') moveItem.apply(d as never, cmd.payload as never);
  else trimItem.apply(d as never, cmd.payload as never);
  return Timeline.parse(d.timelines[0]);
}

/** The command a refused plan stood for (to show the commands refuse it too). */
function attempted(tl: Timeline, plan: DragPlan, itemId: string, ripple: boolean): DragCommand {
  const track = tl.tracks.find((t) => t.items.some((i) => i.id === itemId))!;
  const it = track.items.find((i) => i.id === itemId)!;
  const ref = { timelineId: tl.id, itemId, ...(ripple ? { ripple: true } : {}) };
  if (plan.start !== it.start || plan.end !== it.start + it.duration || plan.trackId !== track.id) {
    const isMove = plan.end - plan.start === it.duration && (plan.trackId !== track.id || plan.start !== it.start); // prettier-ignore
    if (isMove)
      return { type: 'core/timeline.move', payload: { ...ref, start: plan.start, ...(plan.trackId !== track.id ? { trackId: plan.trackId } : {}) } }; // prettier-ignore
  }
  const inEdge = plan.end === it.start + it.duration && !ripple ? true : plan.start !== it.start;
  const delta = inEdge ? plan.start - it.start : plan.end - (it.start + it.duration);
  return { type: 'core/timeline.trim', payload: { ...ref, edge: inEdge ? 'in' : 'out', delta } };
}

const where = (tl: Timeline, id: string) => {
  const track = tl.tracks.find((t) => t.items.some((i) => i.id === id))!;
  const it = track.items.find((i) => i.id === id)!;
  return { trackId: track.id, start: it.start, end: it.start + it.duration };
};

describe('planDrag', { timeout: 30_000 }, () => {
  it('every planned drop applies through the real command and lands where the plan said', () => {
    let applied = 0;
    let refused = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const tl = randomTimeline(seed);
      const r = rng(seed * 7919);
      const items = tl.tracks.flatMap((t) => t.items);
      const item = items[Math.floor(r() * items.length)]!;
      const mode = (['move', 'trim-in', 'trim-out'] as const)[Math.floor(r() * 3)]!;
      const ripple = r() < 0.4;
      const track = tl.tracks.find((t) => t.items.includes(item))!;
      const other = tl.tracks.find((t) => t !== track && t.kind === track.kind);
      const toTrackId = mode === 'move' && other && r() < 0.4 ? other.id : undefined;
      const snap = r() < 0.5 ? { targets: snapTargets(tl, null, { exclude: item.id }), threshold: fr(3) } : null; // prettier-ignore
      const delta = Math.round((r() * 120 - 60) * FPF + (r() < 0.3 ? FPF / 3 : 0));
      const plan = planDrag({ timeline: tl, itemId: item.id, mode, delta, ripple, snap, ...(toTrackId ? { toTrackId } : {}) }); // prettier-ignore
      const ctx = `seed ${seed} ${mode} ${item.id} ripple=${ripple} to=${toTrackId}`;
      // Whatever happens, the plan stays on the frame grid.
      expect(plan.start % FPF, ctx).toBe(0);
      expect(plan.end % FPF, ctx).toBe(0);
      if (track.locked || (toTrackId && tl.tracks.find((t) => t.id === toTrackId)!.locked)) {
        expect(plan.ok, ctx).toBe(false);
        continue;
      }
      if (!plan.ok) {
        refused++;
        expect(plan.reason, ctx).toMatch(/overlap/);
        expect(() => apply(tl, attempted(tl, plan, item.id, ripple)), ctx).toThrow();
        continue;
      }
      if (!plan.command) continue;
      applied++;
      const next = apply(tl, plan.command);
      expect(where(next, item.id), ctx).toEqual({ trackId: plan.trackId, start: plan.start, end: plan.end }); // prettier-ignore
      const moved = new Map(plan.shifted.map((s) => [s.itemId, s]));
      for (const t of tl.tracks)
        for (const it of t.items) {
          if (it.id === item.id) continue;
          const now = where(next, it.id);
          const want = moved.get(it.id);
          expect(now.start, `${ctx} ${it.id}`).toBe(want ? want.start : it.start);
          expect(now.end - now.start, `${ctx} ${it.id}`).toBe(it.duration);
          if (t.locked) expect(now, `${ctx} locked`).toEqual(where(tl, it.id));
        }
      // Ripple keeps the gaps between the items after the change.
      if (ripple && !toTrackId && plan.shifted.length > 1) {
        const gaps = (x: Timeline) => {
          const ids = plan.shifted.map((s) => s.itemId);
          const sp = ids.map((id) => where(x, id)).sort((a, b) => a.start - b.start);
          return sp.slice(1).map((s, i) => s.start - sp[i]!.end);
        };
        expect(gaps(next), ctx).toEqual(gaps(tl));
      }
    }
    expect(applied).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(20);
  });

  it('snaps a move to the nearest target of either edge, inside the threshold', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const tl = randomTimeline(seed);
      const r = rng(seed * 31);
      const items = tl.tracks.filter((t) => !t.locked).flatMap((t) => t.items);
      const item = items[Math.floor(r() * items.length)]!;
      const targets = snapTargets(tl, null, { exclude: item.id, playhead: fr(37) });
      const threshold = fr(4);
      const delta = Math.round((r() * 80 - 40) * FPF);
      const plan = planDrag({ timeline: tl, itemId: item.id, mode: 'move', delta, snap: { targets, threshold } }); // prettier-ignore
      const start = item.start + Math.round(delta / FPF) * FPF;
      const a = nearestTarget(targets, start, threshold);
      const b = nearestTarget(targets, start + item.duration, threshold);
      if (plan.clamped) continue;
      if (!a && !b) {
        expect(plan.snapped).toBeUndefined();
        expect(plan.start).toBe(start);
        continue;
      }
      const best = Math.min(a ? Math.abs(a.at - start) : Infinity, b ? Math.abs(b.at - start - item.duration) : Infinity); // prettier-ignore
      expect(plan.snapped).toBeDefined();
      expect(Math.min(Math.abs(plan.start - start), Math.abs(plan.end - start - item.duration))).toBe(best); // prettier-ignore
      expect([plan.start, plan.end]).toContain(plan.snapped!.at);
    }
  });

  const fixed = () =>
    Timeline.parse({
      id: 'tl',
      name: 'T',
      frameRate: R,
      resolution: { width: 1920, height: 1080 },
      tracks: [
        { id: 'v1', kind: 'video', name: 'Picture', items: [
          { id: 'a', kind: 'clip', label: 'Parry', start: 0, duration: fr(10), assetId: 'x', sourceIn: fr(5) },
          { id: 'b', kind: 'clip', label: 'Boss', start: fr(10), duration: fr(10), assetId: 'x', sourceIn: 0 },
          { id: 'c', kind: 'clip', label: 'Fall', start: fr(25), duration: fr(10), assetId: 'x', sourceIn: 0 },
        ] },
        { id: 'v2', kind: 'video', name: 'Over', items: [] },
        { id: 'g1', kind: 'graphics', name: 'Cards', locked: true, items: [
          { id: 'g', kind: 'graphic', start: 0, duration: fr(5), templateId: 'core/title-card' },
        ] },
      ],
      markers: [{ id: 'm1', at: fr(30), kind: 'downbeat' }],
    }); // prettier-ignore
  const plan = (o: Partial<Parameters<typeof planDrag>[0]>) =>
    planDrag({ timeline: fixed(), itemId: 'b', mode: 'move', delta: 0, ...o });

  it('overwrite refuses an overlap and names what is in the way; ripple moves the rest along', () => {
    expect(plan({ delta: fr(8) })).toMatchObject({ ok: false, reason: 'it would overlap "Fall"' });
    const r = plan({ delta: fr(8), ripple: true });
    expect(r).toMatchObject({ ok: true, start: fr(18), shifted: [{ itemId: 'c', trackId: 'v1', start: fr(33) }] }); // prettier-ignore
    expect(r.ok && r.command).toEqual({ type: 'core/timeline.move', payload: { timelineId: 'tl', itemId: 'b', start: fr(18), ripple: true } }); // prettier-ignore
  });

  it('moves onto another track; with ripple the gap closes behind it', () => {
    const r = plan({ toTrackId: 'v2', delta: fr(2), ripple: true });
    expect(r).toMatchObject({ ok: true, trackId: 'v2', start: fr(12), shifted: [{ itemId: 'c', trackId: 'v1', start: fr(15) }] }); // prettier-ignore
    expect(plan({ toTrackId: 'g1' })).toMatchObject({
      ok: false,
      reason: 'track "Cards" is locked',
    });
    expect(planDrag({ timeline: fixed(), itemId: 'g', mode: 'move', delta: fr(1) })).toMatchObject({ ok: false, reason: 'track "Cards" is locked' }); // prettier-ignore
  });

  it('trims are held at the recording start and one frame; a ripple trim keeps the start', () => {
    const back = planDrag({ timeline: fixed(), itemId: 'a', mode: 'trim-in', delta: -fr(20) });
    expect(back).toMatchObject({ ok: true, start: 0, clamped: true, command: null }); // start of the timeline
    const shortest = planDrag({ timeline: fixed(), itemId: 'c', mode: 'trim-out', delta: -fr(50) });
    expect(shortest).toMatchObject({ ok: true, start: fr(25), end: fr(26), clamped: true });
    const ripple = planDrag({ timeline: fixed(), itemId: 'a', mode: 'trim-in', delta: fr(4), ripple: true }); // prettier-ignore
    expect(ripple).toMatchObject({ ok: true, start: 0, end: fr(6) });
    expect(ripple.shifted.map((s) => [s.itemId, s.start])).toEqual([
      ['b', fr(6)],
      ['c', fr(21)],
    ]);
  });

  it('snaps to a bar one frame ahead of the beat, the way the rough cut cuts', () => {
    const targets = snapTargets(fixed(), { beats: [fr(15)], bars: [fr(30)] }, { exclude: 'c' });
    expect(targets).toContainEqual({ at: fr(29), kind: 'bar' });
    expect(targets).toContainEqual({ at: fr(14), kind: 'beat' });
    const r = planDrag({ timeline: fixed(), itemId: 'c', mode: 'trim-out', delta: -fr(5) - 2000, snap: { targets, threshold: fr(2) } }); // prettier-ignore
    expect(r).toMatchObject({ ok: true, end: fr(29), snapped: { kind: 'bar' } });
  });
});
