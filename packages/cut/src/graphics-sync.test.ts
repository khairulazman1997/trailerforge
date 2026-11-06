import { Project, type CardSlot, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { placeCaptions } from './captions.js';
import { refreshGraphics } from './graphics-sync.js';
import { resolveMusicGrid } from './grid.js';
import { buildRoughCut, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';

function build() {
  const p = Project.parse(sampleProject());
  const sb = p.storyboard!;
  const slots = sb.sections.flatMap((s) => s.slots);
  const shot = slots.find((s): s is ShotSlot => s.kind === 'shot')!;
  shot.overlays = [
    { id: 'ov1', templateId: 'core/caption', text: 'Old words', params: {}, offset: 0 },
  ];
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
  const timeline = placeCaptions(r.timeline, sb).timeline;
  const card = slots.find((s): s is CardSlot => s.kind === 'card')!;
  return { timeline, sb, card, shot };
}

const items = (tl: ReturnType<typeof build>['timeline']) => tl.tracks.flatMap((t) => t.items);

describe('refreshGraphics', () => {
  it('returns the same timeline when nothing changed', () => {
    const { timeline, sb } = build();
    expect(refreshGraphics(timeline, sb)).toBe(timeline);
  });

  it('takes card and caption looks from the storyboard, keeping the timing', () => {
    const { timeline, sb, card, shot } = build();
    card.text = 'New title';
    card.templateId = 'core/custom-card';
    card.params = { subtitle: 'Soon' };
    shot.overlays[0]!.text = 'New words';
    shot.overlays[0]!.templateId = 'core/lower-third';
    const next = refreshGraphics(timeline, sb);
    const g = items(next).find((i) => i.kind === 'graphic' && i.slotId === card.id);
    expect(g).toMatchObject({
      templateId: 'core/custom-card',
      params: { subtitle: 'Soon', text: 'New title' },
    });
    const before = items(timeline).find((i) => i.id === g!.id)!;
    expect([g!.start, g!.duration]).toEqual([before.start, before.duration]);
    const c = items(next).find((i) => i.kind === 'caption');
    expect(c).toMatchObject({ text: 'New words', styleId: 'core/lower-third' });
  });
});
