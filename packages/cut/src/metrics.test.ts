import { FLICKS_PER_SECOND, Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { resolveMusicGrid } from './grid.js';
import { cutMetrics } from './metrics.js';
import { buildRoughCut, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;

/**
 * The evaluation corpus: the sample storyboard on five tempos, with every shot recorded, half the
 * shots recorded, and nothing recorded. A change to the cut logic that moves these numbers shows
 * up here; update the snapshot only when the change is intended (and say why in the commit).
 */
function corpus() {
  const out: Record<string, ReturnType<typeof cutMetrics>> = {};
  for (const bpm of [90, 110, 120, 128, 150]) {
    for (const recorded of ['all', 'half', 'none'] as const) {
      const p = Project.parse(sampleProject());
      const shots = p
        .storyboard!.sections.flatMap((s) => s.slots)
        .filter((s): s is ShotSlot => s.kind === 'shot');
      const sources = new Map<string, TakeSource>();
      shots.forEach((s, i) => {
        if (recorded === 'none' || (recorded === 'half' && i % 2 === 1)) return;
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
      });
      const grid = resolveMusicGrid(steady(bpm, 200, 0.2));
      const { timeline } = buildRoughCut({
        storyboard: p.storyboard!,
        grid,
        sources,
        timeline: {
          id: 'tl',
          frameRate: { num: 30, den: 1 },
          resolution: { width: 1920, height: 1080 },
        },
        now: new Date('2026-10-24T12:00:00Z'),
      });
      out[`${bpm} bpm, ${recorded} recorded`] = cutMetrics(timeline, grid);
    }
  }
  return out;
}

describe('cut metrics (evaluation baseline)', () => {
  it('every cut lands on the beat, no flash frames, placeholders only where footage is missing', () => {
    const m = corpus();
    for (const [name, x] of Object.entries(m)) {
      expect(x.onBeat, name).toBe(1);
      expect(x.flashItems, name).toBe(0);
      if (name.endsWith('all recorded')) expect(x.placeholders, name).toBe(0);
      if (name.endsWith('none recorded')) expect(x.placeholders, name).toBe(2);
    }
  });

  it('matches the recorded baseline', () => {
    expect(corpus()).toMatchSnapshot();
  });
});
