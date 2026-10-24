import {
  FLICKS_PER_SECOND,
  Project,
  flicksPerFrame,
  type ShotSlot,
  type Timeline,
} from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { resolveMusicGrid } from './grid.js';
import {
  buildRoughCut,
  timelineHash,
  type FootageFacts,
  type RoughCutInput,
  type TakeSource,
} from './rough-cut.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;
const RATE = { num: 30, den: 1 };
const FPF = flicksPerFrame(RATE);
const NOW = new Date('2026-10-24T12:00:00Z');
const T = '2026-10-24T10:00:00.000Z';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Footage at 30 fps with the given black/frozen ranges, shot changes and motion level. */
function footage(
  seconds: number,
  o: {
    black?: [number, number][];
    frozen?: [number, number][];
    scenes?: number[];
    flashes?: number[];
    busy?: [number, number];
  } = {},
): FootageFacts {
  const n = Math.round(seconds * 30);
  const at = (s: number) => Math.round(s * 30) * FPF;
  return {
    rate: RATE,
    frameCount: n,
    duration: n * FPF,
    scenes: (o.scenes ?? []).map(at),
    black: (o.black ?? []).map(([a, b]) => ({ start: at(a), end: at(b) })),
    frozen: (o.frozen ?? []).map(([a, b]) => ({ start: at(a), end: at(b) })),
    flashes: (o.flashes ?? []).map(at),
    motion: Array.from({ length: n }, (_, i) =>
      o.busy && i >= o.busy[0] * 30 && i < o.busy[1] * 30 ? 120 : 20,
    ),
  };
}
const source = (f: FootageFacts): TakeSource => ({ duration: f.duration, footage: f });

function fixture() {
  const p = Project.parse(sampleProject());
  const sb = p.storyboard!;
  const parry = sb.sections.flatMap((s) => s.slots).find((s) => s.id === 'shot_parry') as ShotSlot;
  parry.takes = [
    {
      id: 'take_a',
      assetId: 'asset_a',
      matchedBy: 'code',
      rejected: false,
      note: '',
      attachedAt: T,
    },
    {
      id: 'take_b',
      assetId: 'asset_b',
      matchedBy: 'code',
      rejected: false,
      note: '',
      attachedAt: T,
    },
  ];
  const sources = new Map<string, TakeSource>([
    // take A: black at the start, a shot change in the middle
    ['asset_a', source(footage(8, { black: [[0, 2]], scenes: [4] }))],
    // take B: clean, busy between 3 and 5 s
    ['asset_b', source(footage(8, { busy: [3, 5] }))],
  ]);
  const input: RoughCutInput = {
    storyboard: sb,
    grid: resolveMusicGrid(steady(120, 64)),
    sources,
    timeline: { id: 'tl_rough', frameRate: RATE, resolution: { width: 1920, height: 1080 } },
    now: NOW,
  };
  return { input, parry };
}

const item = (t: Timeline, slotId: string) =>
  t.tracks.flatMap((k) => k.items).find((i) => i.slotId === slotId && !i.id.endsWith('_rest'));

describe('buildRoughCut', () => {
  it('builds the fixture cut: best take at its best moment, a placeholder for the missing shot, the card, the music', () => {
    const { input } = fixture();
    const { timeline, decisions, warnings } = buildRoughCut(input);
    const parry = item(timeline, 'shot_parry');
    expect(parry).toMatchObject({ kind: 'clip', assetId: 'asset_b', start: 0 });
    // the busy stretch of take B, not its quiet start
    if (parry?.kind === 'clip') expect(parry.sourceIn).toBeGreaterThanOrEqual(2 * F);
    expect(item(timeline, 'shot_boss')).toMatchObject({
      kind: 'placeholder',
      reason: 'missing-footage',
      note: 'not recorded yet',
    });
    expect(
      item(timeline, 'card_title')?.kind ??
        item(timeline, timeline.tracks[1]?.items[0]?.slotId ?? '')?.kind,
    ).toBe('graphic');
    const music = timeline.tracks.find((k) => k.id === 'trk_music')!.items[0]!;
    expect(music).toMatchObject({ kind: 'clip', assetId: 'asset_music', start: 0 });
    expect(decisions.length).toBe(timeline.tracks.flatMap((k) => k.items).length);
    expect(decisions.every((d) => d.step === 'core/rough-cut' && d.summary.length > 0)).toBe(true);
    expect(warnings).toEqual([]);
    expect(timeline).toMatchSnapshot();
  });

  it('cuts one frame ahead of the beat (two when asked), on the frame grid', () => {
    const { input } = fixture();
    const beats = new Set(input.grid.beats);
    for (const lead of [1, 2]) {
      const { timeline } = buildRoughCut({ ...input, options: { leadFrames: lead } });
      const pic = timeline.tracks
        .filter((k) => k.kind !== 'audio')
        .flatMap((k) => k.items)
        .sort((a, b) => a.start - b.start);
      for (const it of pic.slice(1)) {
        expect(beats.has(it.start + lead * FPF)).toBe(true);
        expect(it.start % FPF).toBe(0);
      }
    }
  });

  it('honours the chosen take and in/out hints, and never uses a rejected take', () => {
    const { input, parry } = fixture();
    parry.chosenTakeId = 'take_a';
    parry.takes[0]!.sourceIn = 5 * F;
    parry.takes[0]!.sourceOut = 8 * F;
    let c = item(buildRoughCut(input).timeline, 'shot_parry');
    expect(c).toMatchObject({ kind: 'clip', assetId: 'asset_a' });
    if (c?.kind === 'clip') expect(c.sourceIn).toBeGreaterThanOrEqual(5 * F);
    delete parry.chosenTakeId;
    parry.takes[1]!.rejected = true;
    c = item(buildRoughCut(input).timeline, 'shot_parry');
    expect(c).toMatchObject({ assetId: 'asset_a' });
  });

  it('a take shorter than the shot is used whole, the rest stays visible as a placeholder', () => {
    const { input } = fixture();
    input.sources = new Map([
      ['asset_a', source(footage(0.9))],
      ['asset_b', source(footage(0.6))],
    ]);
    const t = buildRoughCut(input).timeline;
    const pic = t.tracks[0]!.items.filter((i) => i.slotId === 'shot_parry');
    expect(pic.map((i) => i.kind)).toEqual(['clip', 'placeholder']);
    expect(pic[0]).toMatchObject({ assetId: 'asset_a' });
  });

  it('without footage analysis it takes the middle of the take; without music it still cuts', () => {
    const { input } = fixture();
    input.sources = new Map([['asset_a', { duration: 10 * F }]]);
    const t = buildRoughCut(input).timeline;
    const c = item(t, 'shot_parry');
    if (c?.kind === 'clip') expect(c.sourceIn).toBe(Math.round((10 * F - c.duration) / 2));
    const noMusic = buildRoughCut({
      ...input,
      storyboard: {
        ...input.storyboard,
        music: { ...input.storyboard.music, trackAssetId: undefined },
      } as RoughCutInput['storyboard'],
    });
    expect(noMusic.timeline.tracks.some((k) => k.kind === 'audio')).toBe(false);
    expect(noMusic.warnings.join(' ')).toMatch(/no music track/);
  });

  it('fades the music over the last bar', () => {
    const { timeline } = buildRoughCut(fixture().input);
    const music = timeline.tracks.find((k) => k.id === 'trk_music')!.items[0]!;
    if (music.kind !== 'clip' || typeof music.gainDb !== 'object' || Array.isArray(music.gainDb))
      throw new Error('expected keyframes');
    const [a, b] = music.gainDb.keyframes;
    expect(b!.at).toBe(music.duration);
    expect(b!.at - a!.at).toBe(2 * F); // a bar at 120 bpm
  });
});

describe('buildRoughCut properties', () => {
  it('integer flicks, no gaps or overlaps on the picture, every slot present, deterministic', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const { input, parry } = fixture();
      const bpm = 90 + Math.floor(r() * 60);
      input.grid = resolveMusicGrid(steady(bpm, 200, r() * 0.5), {
        downbeatShift: Math.floor(r() * 4),
      });
      const sources = new Map<string, TakeSource>();
      parry.takes = [];
      const boss = input.storyboard.sections
        .flatMap((s) => s.slots)
        .find((s) => s.id === 'shot_boss') as ShotSlot;
      for (const [slot, n] of [
        [parry, Math.floor(r() * 3)],
        [boss, Math.floor(r() * 3)],
      ] as const) {
        for (let k = 0; k < n; k++) {
          const id = `asset_${slot.id}_${k}`;
          slot.takes.push({
            id: `take_${slot.id}_${k}`,
            assetId: id,
            matchedBy: 'code',
            rejected: r() < 0.2,
            note: '',
            attachedAt: T,
          });
          const len = 1 + r() * 12;
          sources.set(
            id,
            source(
              footage(len, {
                black: r() < 0.5 ? [[0, Math.min(len, r() * 2)]] : [],
                scenes: r() < 0.5 ? [len * r()] : [],
                flashes: r() < 0.3 ? [len * r()] : [],
                busy: [len * r() * 0.5, len * (0.5 + r() * 0.5)],
              }),
            ),
          );
        }
      }
      input.sources = sources;
      const a = buildRoughCut(input);
      const reversed = buildRoughCut({ ...input, sources: new Map([...sources].reverse()) });
      expect(timelineHash(reversed.timeline)).toBe(timelineHash(a.timeline));

      const all = a.timeline.tracks.flatMap((k) => k.items);
      for (const it of all) {
        expect(Number.isInteger(it.start) && Number.isInteger(it.duration)).toBe(true);
        if (it.kind === 'clip' && it.id !== 'rc_music') {
          const src = sources.get(it.assetId)!;
          expect(it.sourceIn + it.duration).toBeLessThanOrEqual(src.duration);
        }
      }
      const pic = a.timeline.tracks
        .filter((k) => k.kind !== 'audio')
        .flatMap((k) => k.items)
        .sort((x, y) => x.start - y.start);
      expect(pic[0]!.start).toBe(0);
      for (let i = 1; i < pic.length; i++)
        expect(pic[i]!.start).toBe(pic[i - 1]!.start + pic[i - 1]!.duration);
      const slots = new Set(pic.map((i) => i.slotId));
      for (const s of input.storyboard.sections.flatMap((x) => x.slots))
        expect(slots.has(s.id)).toBe(true);
    }
  });
});
