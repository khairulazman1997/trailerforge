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
import { mergeRoughCut } from './merge.js';
import { buildRoughCut, timelineHash, type RoughCutInput, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;
const RATE = { num: 30, den: 1 };
const FPF = flicksPerFrame(RATE);

function input(): RoughCutInput {
  const p = Project.parse(sampleProject());
  const sb = p.storyboard!;
  const shots = sb.sections.flatMap((s) => s.slots).filter((s): s is ShotSlot => s.kind === 'shot');
  for (const s of shots)
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
  const sources = new Map<string, TakeSource>(
    shots.map((s) => [`asset_${s.id}`, { duration: 20 * F }]),
  );
  return {
    storyboard: sb,
    grid: resolveMusicGrid(steady(120, 64)),
    sources,
    timeline: { id: 'tl_rough', frameRate: RATE, resolution: { width: 1920, height: 1080 } },
    now: new Date('2026-10-24T12:00:00Z'),
  };
}

const items = (t: Timeline) =>
  t.tracks
    .filter((k) => k.kind === 'video' || k.kind === 'graphics')
    .flatMap((k) => k.items)
    .sort((a, b) => a.start - b.start);
const edit = (
  t: Timeline,
  id: string,
  change: (i: Timeline['tracks'][number]['items'][number]) => object,
): Timeline => ({
  ...t,
  tracks: t.tracks.map((k) => ({
    ...k,
    items: k.items.map((i) =>
      i.id === id
        ? ({ ...i, ...change(i), extensions: { core: { userEdited: true } } } as typeof i)
        : i,
    ),
  })),
});

describe('mergeRoughCut', () => {
  it('without a previous cut it is the generated cut', () => {
    const g = buildRoughCut(input()).timeline;
    expect(mergeRoughCut(undefined, g).timeline).toBe(g);
  });

  it('regenerating after a hand trim keeps the trim; the next shot absorbs it and later cuts stay on the beat', () => {
    const inp = input();
    const first = buildRoughCut(inp).timeline;
    // the user shortens the first shot by 10 frames and starts it 1 s later in the take
    const trimmed = edit(first, 'rc_shot_parry', (i) => ({
      duration: i.duration - 10 * FPF,
      sourceIn: ('sourceIn' in i ? i.sourceIn : 0) + F,
    }));
    const again = buildRoughCut(inp).timeline;
    const { timeline, kept, warnings } = mergeRoughCut(trimmed, again, inp.sources);
    expect(kept).toEqual(['rc_shot_parry']);
    expect(warnings).toEqual([]);
    const [a, b, c] = items(timeline);
    const [ga, gb, gc] = items(again);
    expect(a).toMatchObject({ id: 'rc_shot_parry', duration: ga!.duration - 10 * FPF });
    expect(b!.start).toBe(a!.duration); // no gap
    expect(b!.start + b!.duration).toBe(gb!.start + gb!.duration); // the next cut stays put
    if (b!.kind === 'clip' && gb!.kind === 'clip')
      expect(b!.sourceIn).toBe(gb!.sourceIn - 10 * FPF);
    expect(c).toEqual(gc);
  });

  it("keeps a clip's sound setting (J/L offsets) on regenerate", () => {
    const inp = input();
    const first = buildRoughCut(inp).timeline;
    const clipAudio = { enabled: true, lead: F / 4, lag: F / 2 };
    const withSound: Timeline = {
      ...first,
      tracks: first.tracks.map((k) => ({
        ...k,
        items: k.items.map((i) =>
          i.id === 'rc_shot_parry'
            ? ({
                ...i,
                gainDb: -6,
                extensions: { core: { userEdited: true, clipAudio } },
              } as typeof i)
            : i,
        ),
      })),
    };
    const { timeline } = mergeRoughCut(withSound, buildRoughCut(inp).timeline, inp.sources);
    const a = items(timeline)[0]!;
    expect(a.extensions.core).toMatchObject({ clipAudio });
    expect(a.kind === 'clip' && a.gainDb).toBe(-6);
  });

  it('keeps locked tracks exactly as they were', () => {
    const inp = input();
    const first = buildRoughCut(inp).timeline;
    const lockedMusic: Timeline = {
      ...first,
      tracks: first.tracks.map((k) =>
        k.id === 'trk_music'
          ? { ...k, locked: true, items: k.items.map((i) => ({ ...i, duration: i.duration - F })) }
          : k,
      ),
    };
    const { timeline } = mergeRoughCut(lockedMusic, buildRoughCut(inp).timeline, inp.sources);
    expect(timeline.tracks.find((k) => k.id === 'trk_music')).toEqual(
      lockedMusic.tracks.find((k) => k.id === 'trk_music'),
    );
  });

  it('drops an edited clip whose shot left the storyboard, with a warning, and is deterministic', () => {
    const inp = input();
    const first = edit(buildRoughCut(inp).timeline, 'rc_shot_boss', (i) => ({
      duration: i.duration - 2 * FPF,
    }));
    const without = buildRoughCut({
      ...inp,
      options: { omitSlotIds: new Set(['shot_boss']) },
    }).timeline;
    const r = mergeRoughCut(first, without, inp.sources);
    expect(r.warnings.join(' ')).toMatch(/no longer in the cut/);
    expect(items(r.timeline).some((i) => i.slotId === 'shot_boss')).toBe(false);
    expect(timelineHash(mergeRoughCut(first, without, inp.sources).timeline)).toBe(
      timelineHash(r.timeline),
    );
  });
});
