import {
  FLICKS_PER_SECOND,
  Project,
  flicksPerFrame,
  itemEnd,
  type Rate,
  type Slot,
  type Timeline,
  type TimelineItem,
} from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { resolveMusicGrid } from './grid.js';
import { buildRoughCut, timelineHash, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';
import {
  VariantCache,
  defaultVariants,
  deriveVariant,
  share,
  type VariantInput,
} from './variants.js';

const F = FLICKS_PER_SECOND;
const MASTER_RATE: Rate = { num: 60, den: 1 };

/** mulberry32: a small seeded generator so every "random" case is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

const ROLES = ['escalation', 'setup', 'climax', 'systems'];

/** A random storyboard, its master cut at 60 fps, recording lengths and one variant. */
function randomCase(seed: number): VariantInput & { project: Project } {
  const r = rng(seed);
  const base = sampleProject();
  const fpf60 = flicksPerFrame(MASTER_RATE);
  const sections: { id: string; name: string; role: string; slots: unknown[] }[] = [];
  const nSec = r.int(2, 5);
  for (let si = 0; si < nSec; si++) {
    const role = si === 0 ? 'hook' : si === nSec - 1 ? 'end-slate' : r.pick(ROLES);
    const slots: unknown[] = [];
    const nSlots = si === nSec - 1 ? 1 : r.int(1, 5);
    for (let k = 0; k < nSlots; k++) {
      const id = `s${si}_${k}`;
      const min = r.int(5, 20) / 10;
      const ideal = min + r.int(0, 20) / 10;
      const max = ideal + r.int(0, 30) / 10;
      const common = {
        id,
        title: id,
        duration: { min, ideal, max },
        priority: r.chance(0.4) ? 'nice' : 'must',
      };
      if (si === nSec - 1 || r.chance(0.1)) {
        slots.push({
          ...common,
          kind: 'card',
          cardKind: si === nSec - 1 ? 'cta' : r.pick(['title', 'tagline', 'logo', 'quote']),
          templateId: 'core/card',
        });
      } else {
        slots.push({
          ...common,
          kind: 'shot',
          takes: [0, 1].slice(0, r.int(1, 2)).map((n) => ({
            id: `take_${id}_${n}`,
            assetId: `asset_${id}_${n}`,
            matchedBy: 'code',
            attachedAt: '2026-10-28T10:00:00.000Z',
          })),
          overlays: r.chance(0.3)
            ? [{ id: `ov_${id}`, templateId: 'core/caption', text: 'Hi' }]
            : [],
        });
      }
    }
    sections.push({ id: `sec_${si}`, name: `Section ${si}`, role, slots });
  }
  const p = Project.parse({
    ...base,
    formatTargets: [
      ...(base.formatTargets ?? []),
      {
        id: 'fmt_sq',
        name: 'Square',
        aspect: '1:1',
        resolution: { width: 1080, height: 1080 },
        frameRate: { num: 24000, den: 1001 },
        targetDuration: 15,
      },
    ],
    storyboard: { ...base.storyboard, sections, music: {}, variants: [] },
    timelines: [],
  });
  const slotsInOrder = p.storyboard!.sections.flatMap((s) => s.slots);

  // Master: slots back to back on the frame grid, some shots padded with a placeholder.
  const picture: TimelineItem[] = [];
  const cards: TimelineItem[] = [];
  const captions: TimelineItem[] = [];
  const sources = new Map<string, TakeSource>();
  let t = 0;
  for (const slot of slotsInOrder) {
    if (r.chance(0.08)) continue; // not in the master cut
    const frames = Math.round((slot.duration.ideal + (r.next() - 0.5)) * 60);
    const len = Math.max(30, frames) * fpf60;
    if (slot.kind === 'card') {
      cards.push(item(slot.id, 'graphic', t, len, slot.id));
    } else {
      const assetId = slot.takes[0]!.assetId;
      for (const take of slot.takes)
        if (r.chance(0.8)) sources.set(take.assetId, { duration: r.int(1, 12) * F });
      const rest = r.chance(0.2) ? Math.floor(len / 2 / fpf60) * fpf60 : 0;
      picture.push({
        ...item(`rc_${slot.id}`, 'clip', t, len - rest, slot.id),
        assetId,
        sourceIn: r.int(0, 2) * (F / 2),
      } as TimelineItem);
      if (rest)
        picture.push(item(`rc_${slot.id}_rest`, 'placeholder', t + len - rest, rest, slot.id));
      if (slot.overlays.length)
        captions.push({
          ...item(`cap_${slot.id}`, 'caption', t, len, slot.id),
          text: 'Hi',
        } as TimelineItem);
    }
    t += len;
  }
  const end = t;
  const fade = Math.min(end, 2 * F);
  const master: Timeline = {
    id: 'tl_rough',
    name: 'Rough cut',
    frameRate: MASTER_RATE,
    resolution: { width: 1920, height: 1080 },
    sampleRate: 48_000,
    tracks: [
      track('trk_picture', 'video', picture),
      track('trk_cards', 'graphics', cards),
      track('trk_captions', 'caption', captions),
      track('trk_music', 'audio', [
        {
          ...item('rc_music', 'clip', 0, end),
          assetId: 'asset_music',
          sourceIn: 0,
          gainDb: {
            keyframes: [
              { at: end - fade, value: 0, easing: 'linear' },
              { at: end, value: -60, easing: 'linear' },
            ],
          },
        } as TimelineItem,
      ]),
    ],
    markers: Array.from({ length: Math.floor(end / (2 * F)) }, (_, n) => ({
      id: `mk_bar_${n}`,
      at: n * 2 * F,
      kind: 'downbeat' as const,
      label: '',
    })),
    extensions: {},
  };
  p.timelines = [master];

  const overrides: Record<string, object> = {};
  for (const slot of slotsInOrder) {
    const roll = r.next();
    if (roll < 0.1) overrides[slot.id] = { excluded: true };
    else if (roll < 0.2) overrides[slot.id] = { excluded: false };
    else if (roll < 0.27) {
      const min = r.int(5, 15) / 10;
      overrides[slot.id] = { duration: { min, ideal: min + 0.5, max: min + 1 } };
    } else if (slot.kind === 'shot' && slot.takes.length > 1 && r.chance(0.3))
      overrides[slot.id] = { takeId: slot.takes[1]!.id };
  }
  const masterSecs = end / F;
  const targets = [undefined, 15, 30, 60, Math.round(masterSecs * 0.6 * 10) / 10, masterSecs * 1.2];
  p.storyboard!.variants = [
    {
      id: 'var_x',
      name: '',
      formatTargetId: r.pick(['fmt_yt', 'fmt_tt', 'fmt_sq']),
      ...(r.pick(targets) !== undefined ? { targetDuration: r.pick(targets.slice(1)) } : {}),
      reframe: { mode: 'crop' },
      overrides,
    },
  ];
  return { project: p, variantId: 'var_x', ...(r.chance(0.8) ? { sources } : {}) };

  function item(id: string, kind: string, start: number, duration: number, slotId?: string) {
    return {
      id,
      kind,
      start,
      duration,
      ...(slotId ? { slotId } : {}),
      extensions: {},
      ...(kind === 'clip' ? { speed: 1, effects: [], gainDb: 0, muted: false } : {}),
      ...(kind === 'graphic' ? { templateId: 'core/card', params: {}, effects: [] } : {}),
      ...(kind === 'placeholder' ? { reason: 'missing-footage', note: '' } : {}),
    } as unknown as TimelineItem;
  }
  function track(id: string, kind: Timeline['tracks'][number]['kind'], items: TimelineItem[]) {
    return { id, kind, name: id, muted: false, locked: false, items, transitions: [] };
  }
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const allSlots = (p: Project): Slot[] => p.storyboard!.sections.flatMap((s) => s.slots);

describe('deriveVariant properties', { timeout: 30_000 }, () => {
  it('covers drops, shortening, lengthening and shortfalls across the seeds', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const d = deriveVariant(randomCase(seed));
      for (const x of d.slots) seen.add(/to fit/.test(x.reason) ? `auto-${x.fate}` : x.fate);
      if (d.shortfall) seen.add('shortfall');
    }
    for (const k of ['auto-dropped', 'auto-shortened', 'auto-lengthened', 'kept', 'shortfall'])
      expect(seen).toContain(k);
  });

  it('is deterministic, frame-exact and meets the target or says why', () => {
    for (const seed of SEEDS) {
      const input = randomCase(seed);
      const a = deriveVariant(input);
      const b = deriveVariant(structuredClone(input));
      expect(timelineHash(b.timeline), `seed ${seed}`).toBe(timelineHash(a.timeline));
      expect(b.inputHash).toBe(a.inputHash);

      const fmt = input.project.formatTargets.find(
        (f) => f.id === input.project.storyboard!.variants[0]!.formatTargetId,
      )!;
      const fpf = flicksPerFrame(fmt.frameRate);
      expect(a.timeline.frameRate).toEqual(fmt.frameRate);
      for (const tr of a.timeline.tracks)
        for (const it of tr.items) {
          for (const v of [it.start, it.duration]) {
            expect(Number.isInteger(v), `seed ${seed}`).toBe(true);
            expect(Math.abs(v / fpf - Math.round(v / fpf)), `seed ${seed}`).toBeLessThan(1e-6);
          }
          expect(itemEnd(it)).toBeLessThanOrEqual(a.duration);
        }
      for (const m of a.timeline.markers) expect(Number.isInteger(m.at)).toBe(true);

      if (!a.shortfall)
        expect(Math.abs(a.duration - a.target), `seed ${seed}`).toBeLessThanOrEqual(fpf + 1);
      else expect(a.shortfall).toMatch(/runs .* (over|under)/);
    }
  });

  it('never drops the hook, the title, the call to action or a slot kept by hand', () => {
    for (const seed of SEEDS) {
      const input = randomCase(seed);
      const d = deriveVariant(input);
      const v = input.project.storyboard!.variants[0]!;
      const roles = new Map(
        input.project.storyboard!.sections.flatMap((s) => s.slots.map((x) => [x.id, s.role])),
      );
      for (const slot of allSlots(input.project)) {
        const rep = d.slots.find((x) => x.slotId === slot.id)!;
        if (rep.fate !== 'dropped' || rep.reason === 'not in the master cut') continue;
        if (v.overrides[slot.id]?.excluded === true) {
          expect(rep.reason).toMatch(/by hand/);
          continue;
        }
        expect(roles.get(slot.id), `seed ${seed} ${slot.id}`).not.toBe('hook');
        if (slot.kind === 'card') expect(['title', 'cta']).not.toContain(slot.cardKind);
        expect(v.overrides[slot.id]?.excluded).not.toBe(false);
      }
    }
  });

  it("moves cuts after a change back onto the beat, within each slot's range", () => {
    let snapped = 0;
    for (const seed of SEEDS) {
      const input = randomCase(seed);
      const v = input.project.storyboard!.variants[0]!;
      const fmt = input.project.formatTargets.find((f) => f.id === v.formatTargetId)!;
      const fpf = flicksPerFrame(fmt.frameRate);
      const step = 8 + (seed % 9); // frames per beat
      const beats = Array.from({ length: 400 }, (_, i) => Math.round((3 + i * step) * fpf));
      const d = deriveVariant({ ...input, beats });
      const again = deriveVariant({ ...structuredClone(input), beats });
      expect(timelineHash(again.timeline)).toBe(timelineHash(d.timeline));
      if (!d.shortfall)
        expect(Math.abs(d.duration - d.target), `seed ${seed}`).toBeLessThanOrEqual(fpf + 1);
      const ends = new Map<string, number>();
      for (const tr of d.timeline.tracks)
        if (tr.kind === 'video' || tr.kind === 'graphics')
          for (const it of tr.items)
            if (it.slotId) ends.set(it.slotId, Math.max(ends.get(it.slotId) ?? 0, itemEnd(it)));
      const kept = d.slots.filter((x) => x.fate !== 'dropped' && ends.has(x.slotId));
      const order = [...kept].sort((a, b) => ends.get(a.slotId)! - ends.get(b.slotId)!);
      const first = order.findIndex((x) => x.fate !== 'kept');
      if (first < 0 || !d.slots.some((x) => x.fate !== 'kept')) continue;
      const offBeat = d.warnings.filter((w) => w.includes('off the beat')).length;
      let onBeat = 0;
      const checked = order.slice(first, -1);
      for (const x of checked) {
        const f = Math.round(ends.get(x.slotId)! / fpf) + 1; // one frame ahead of the beat
        if ((f - 3) % step === 0) onBeat++;
      }
      expect(onBeat, `seed ${seed}`).toBeGreaterThanOrEqual(checked.length - offBeat);
      snapped += onBeat;
    }
    expect(snapped).toBeGreaterThan(50);
  });

  it('drops "nice to have" slots before "must" slots, and keeps kept slots within their range', () => {
    for (const seed of SEEDS) {
      const input = randomCase(seed);
      const d = deriveVariant(input);
      const v = input.project.storyboard!.variants[0]!;
      const fmt = input.project.formatTargets.find((f) => f.id === v.formatTargetId)!;
      const fps = fmt.frameRate.num / fmt.frameRate.den;
      const bySlot = new Map(allSlots(input.project).map((s) => [s.id, s]));
      const autoDropped = d.slots.filter((x) => /to fit/.test(x.reason) && x.fate === 'dropped');
      if (autoDropped.some((x) => bySlot.get(x.slotId)!.priority === 'must')) {
        const nice = d.slots.filter(
          (x) =>
            x.fate !== 'dropped' &&
            bySlot.get(x.slotId)!.priority === 'nice' &&
            v.overrides[x.slotId]?.excluded !== false &&
            input.project.storyboard!.sections.find((s) => s.slots.some((y) => y.id === x.slotId))!
              .role !== 'hook' &&
            !(
              bySlot.get(x.slotId)!.kind === 'card' &&
              ['title', 'cta'].includes((bySlot.get(x.slotId) as { cardKind: string }).cardKind)
            ),
        );
        expect(nice, `seed ${seed}`).toEqual([]);
      }
      for (const x of d.slots) {
        if (x.fate !== 'shortened') continue;
        const range = v.overrides[x.slotId]?.duration ?? bySlot.get(x.slotId)!.duration;
        const minF = Math.max(1, Math.round(range.min * fps));
        expect(x.duration, `seed ${seed} ${x.slotId}`).toBeGreaterThanOrEqual(
          Math.min(minF * flicksPerFrame(fmt.frameRate), x.masterDuration) -
            flicksPerFrame(fmt.frameRate),
        );
      }
    }
  });

  it('is the master itself when the variant changes nothing', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const input = randomCase(seed);
      const v = input.project.storyboard!.variants[0]!;
      v.formatTargetId = 'fmt_yt'; // 60 fps, like the master
      delete v.targetDuration;
      v.overrides = {};
      const d = deriveVariant(input);
      const master = input.project.timelines[0]!;
      const strip = (t: Timeline) =>
        t.tracks.map((k) => k.items.map((i) => [i.id, i.start, i.duration]));
      expect(strip(d.timeline), `seed ${seed}`).toEqual(strip(master));
      expect(d.slots.every((x) => x.fate === 'kept' || x.reason === 'not in the master cut')).toBe(
        true,
      );
    }
  });

  it('applies overrides whatever the master looks like (they survive a rebuild)', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const before = randomCase(seed);
      const after = randomCase(seed + 10_000);
      // The same storyboard and variant, a different master cut.
      after.project.storyboard = before.project.storyboard;
      const rebuilt = randomCase(seed);
      after.project.timelines = rebuilt.project.timelines.map((tl) => ({
        ...tl,
        tracks: tl.tracks.map((k) => ({
          ...k,
          items: k.items.map((i) => ({ ...i, label: 'rebuilt' })),
        })),
      }));
      const v = before.project.storyboard!.variants[0]!;
      const d = deriveVariant({ ...after, project: after.project });
      for (const [slotId, o] of Object.entries(v.overrides)) {
        const rep = d.slots.find((x) => x.slotId === slotId)!;
        if (o.excluded === true) expect(rep.fate).toBe('dropped');
        if (o.excluded === false && rep.masterDuration > 0)
          expect(rep.fate, `seed ${seed}`).not.toBe('dropped');
      }
    }
  });

  it('swaps in the chosen take', () => {
    const input = randomCase(7);
    const shot = allSlots(input.project).find(
      (s): s is Extract<Slot, { kind: 'shot' }> =>
        s.kind === 'shot' &&
        s.takes.length > 1 &&
        input.project.timelines[0]!.tracks[0]!.items.some((i) => i.slotId === s.id),
    );
    if (!shot) return;
    const v = input.project.storyboard!.variants[0]!;
    v.overrides = { [shot.id]: { takeId: shot.takes[1]!.id } };
    const d = deriveVariant({ ...input, sources: new Map() });
    const clip = d.timeline.tracks[0]!.items.find((i) => i.slotId === shot.id);
    expect(clip).toMatchObject({ kind: 'clip', assetId: shot.takes[1]!.assetId });
    expect(d.slots.find((x) => x.slotId === shot.id)!.reason).toMatch(/uses take/);
  });
});

describe('deriveVariant on a real rough cut', () => {
  function project() {
    const p = Project.parse(sampleProject());
    const sb = p.storyboard!;
    const shots = sb.sections.flatMap((s) => s.slots).filter((s) => s.kind === 'shot');
    const sources = new Map<string, TakeSource>();
    for (const s of shots) {
      s.takes = [
        {
          id: `take_${s.id}`,
          assetId: `asset_${s.id}`,
          matchedBy: 'code',
          rejected: false,
          note: '',
          attachedAt: '2026-10-24T10:00:00.000Z',
        },
      ];
      sources.set(`asset_${s.id}`, { duration: 20 * F });
    }
    const cut = buildRoughCut({
      storyboard: sb,
      grid: resolveMusicGrid(steady(120, 64)),
      sources,
      timeline: {
        id: 'tl_rough',
        frameRate: { num: 60, den: 1 },
        resolution: { width: 1920, height: 1080 },
      },
      now: new Date('2026-10-24T12:00:00Z'),
    });
    p.timelines = [cut.timeline];
    sb.variants = [
      {
        id: 'var_tt',
        name: 'TikTok',
        formatTargetId: 'fmt_tt',
        targetDuration: 5,
        reframe: { mode: 'crop' },
        overrides: {},
      },
    ];
    return { p, sources };
  }

  it('cuts the sample down to 5 s at 30 fps, keeping the hook and the call to action', () => {
    const { p, sources } = project();
    const d = deriveVariant({ project: p, variantId: 'var_tt', sources });
    expect(d.timeline).toMatchObject({
      id: 'tl_var_tt',
      variantId: 'var_tt',
      formatTargetId: 'fmt_tt',
    });
    expect(d.timeline.resolution).toEqual({ width: 1080, height: 1920 });
    expect(d.duration).toBe(5 * F);
    const fates = Object.fromEntries(d.slots.map((x) => [x.slotId, x.fate]));
    expect(fates.shot_parry).not.toBe('dropped');
    expect(fates.card_end).not.toBe('dropped');
    const music = d.timeline.tracks.find((t) => t.kind === 'audio')!.items[0]!;
    expect(itemEnd(music)).toBe(d.duration);
    const gain = (music as { gainDb: { keyframes: { at: number }[] } }).gainDb.keyframes;
    expect(gain.at(-1)!.at).toBe(music.duration);
  });

  it('caches by input hash and recomputes when the inputs change', () => {
    const { p, sources } = project();
    const cache = new VariantCache(2);
    const a = cache.get({ project: p, variantId: 'var_tt', sources });
    expect(cache.get({ project: structuredClone(p), variantId: 'var_tt', sources })).toBe(a);
    p.storyboard!.variants[0]!.targetDuration = 4;
    const b = cache.get({ project: p, variantId: 'var_tt', sources });
    expect(b).not.toBe(a);
    // The hook (1.5 s) and the call to action (3 s) cannot go: 4.5 s, and it says so.
    expect(b.duration).toBe(4.5 * F);
    expect(b.shortfall).toMatch(/runs 0.5 s over 4 s/);
  });

  it('suggests one variant per format target without one', () => {
    const { p } = project();
    expect(defaultVariants(p)).toEqual([{ formatTargetId: 'fmt_yt', name: 'YouTube 16:9' }]);
  });
});

describe('share', () => {
  it('splits whole units in proportion, within caps, summing to the amount', () => {
    const r = rng(99);
    for (let n = 0; n < 500; n++) {
      const caps = Array.from({ length: r.int(1, 8) }, () => r.int(0, 50));
      const total = caps.reduce((a, b) => a + b, 0);
      const amount = r.int(0, total + 10);
      const out = share(amount, caps);
      out.forEach((x, i) => {
        expect(Number.isInteger(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(caps[i]!);
      });
      expect(out.reduce((a, b) => a + b, 0)).toBe(Math.min(amount, total));
    }
  });
});
