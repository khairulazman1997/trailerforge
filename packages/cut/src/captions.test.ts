import { FLICKS_PER_SECOND, Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { CAPTION_TRACK_ID, placeCaptions } from './captions.js';
import { resolveMusicGrid } from './grid.js';
import { buildRoughCut, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;

function build(overlays: Record<string, ShotSlot['overlays']>) {
  const p = Project.parse(sampleProject());
  const sb = p.storyboard!;
  const shots = sb.sections.flatMap((s) => s.slots).filter((s): s is ShotSlot => s.kind === 'shot');
  for (const s of shots) s.overlays = overlays[s.id] ?? [];
  const r = buildRoughCut({
    storyboard: sb,
    grid: resolveMusicGrid(steady(120, 64)),
    sources: new Map<string, TakeSource>(),
    timeline: {
      id: 'tl_rough',
      frameRate: { num: 30, den: 1 },
      resolution: { width: 1920, height: 1080 },
    },
    now: new Date('2026-10-25T12:00:00Z'),
  });
  return { ...r, sb, shots };
}
const overlay = (id: string, text: string, offset = 0, duration?: number) => ({
  id,
  templateId: 'core/caption',
  text,
  params: {},
  offset,
  ...(duration !== undefined ? { duration } : {}),
});
const span = (r: ReturnType<typeof build>, slotId: string) => {
  const items = r.timeline.tracks
    .filter((t) => t.kind === 'video' || t.kind === 'graphics')
    .flatMap((t) => t.items)
    .filter((i) => i.slotId === slotId);
  return {
    start: Math.min(...items.map((i) => i.start)),
    end: Math.max(...items.map((i) => i.start + i.duration)),
  };
};

describe('captions on the rough cut', () => {
  it('puts each shot caption over its shot, by offset and duration, even over a placeholder', () => {
    const r = build({
      shot_parry: [overlay('ov_a', 'Master the parry'), overlay('ov_b', 'Then strike', 1, 0.5)],
    });
    const track = r.timeline.tracks.find((t) => t.id === CAPTION_TRACK_ID)!;
    expect(track.kind).toBe('caption');
    const s = span(r, 'shot_parry');
    const [a, b] = track.items;
    expect(a).toMatchObject({ kind: 'caption', text: 'Master the parry', slotId: 'shot_parry' });
    expect(a!.start).toBe(s.start);
    expect(a!.start + a!.duration).toBe(b!.start); // trimmed so the next caption can show
    expect(b).toMatchObject({ text: 'Then strike', start: s.start + 1 * F, duration: 0.5 * F });
    expect(r.warnings.some((w) => w.includes('shortened'))).toBe(true);
  });

  it('adds no caption track without caption text, and leaves out text that falls past the shot', () => {
    expect(build({}).timeline.tracks.some((t) => t.id === CAPTION_TRACK_ID)).toBe(false);
    const r = build({ shot_parry: [overlay('ov_c', '  '), overlay('ov_d', 'Too late', 999)] });
    expect(r.timeline.tracks.some((t) => t.id === CAPTION_TRACK_ID)).toBe(false);
    expect(r.warnings.some((w) => w.includes('Too late'))).toBe(true);
  });

  it('follows the shot when it moves, and keeps a locked caption track as it is', () => {
    const r = build({ shot_parry: [overlay('ov_a', 'Master the parry')] });
    // The whole picture starts a second later (as after a hand edit early on).
    const moved = {
      ...r.timeline,
      tracks: r.timeline.tracks.map((t) =>
        t.kind === 'video' || t.kind === 'graphics'
          ? { ...t, items: t.items.map((i) => ({ ...i, start: i.start + F })) }
          : t,
      ),
    };
    const again = placeCaptions(moved, r.sb);
    const cap = again.timeline.tracks.find((t) => t.id === CAPTION_TRACK_ID)!.items[0]!;
    expect(cap.start).toBe(span(r, 'shot_parry').start + F);

    const locked = {
      ...r.timeline,
      tracks: r.timeline.tracks.map((t) =>
        t.id === CAPTION_TRACK_ID ? { ...t, locked: true } : t,
      ),
    };
    expect(placeCaptions(locked, { sections: [] }).timeline).toBe(locked);
  });
});
