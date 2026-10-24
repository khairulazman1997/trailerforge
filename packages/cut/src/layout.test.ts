import { FLICKS_PER_SECOND, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { resolveMusicGrid } from './grid.js';
import { steady } from './test-support.js';
import { layoutOnGrid } from './layout.js';

const F = FLICKS_PER_SECOND;
const sb = () => Project.parse(sampleProject()).storyboard!;

describe('layoutOnGrid', () => {
  it('puts section boundaries on bars and slot boundaries on beats, end to end with no gaps', () => {
    const grid = resolveMusicGrid(steady(120, 64)); // bars every 2 s
    const l = layoutOnGrid(sb(), grid);
    // hook 2 s, escalation 2.5 s, end slate 3 s: boundaries at 2, 4.5 -> 4, 7.5 -> 8
    expect(l.sections.map((s) => [s.start / F, s.end / F])).toEqual([
      [0, 2],
      [2, 4],
      [4, 8],
    ]);
    for (const s of l.sections.slice(1)) expect(grid.bars).toContain(s.start);
    for (let i = 1; i < l.slots.length; i++) expect(l.slots[i]!.start).toBe(l.slots[i - 1]!.end);
    for (const x of l.slots) expect(grid.beats.includes(x.start) || x.start === 0).toBe(true);
    expect(l.end).toBe(8 * F);
    expect(l.warnings).toEqual([]);
  });

  it('resolves hit points to the beat a slot boundary lands on', () => {
    const grid = resolveMusicGrid(steady(120, 64));
    const l = layoutOnGrid(sb(), grid);
    expect(l.hits).toEqual([
      { id: 'hit_boss', kind: 'drop', slotId: 'shot_boss', at: 2 * F, beatIndex: 4, onBar: true },
    ]);
  });

  it('starts a drop section on the energy rise in the music when it is near', () => {
    const s = sb();
    s.music.structure = [{ id: 'mus_drop', label: 'drop', sectionIds: ['sec_escalation'] }];
    const src = steady(120, 64);
    const grid = resolveMusicGrid({
      ...src,
      sections: [
        { start: 0, end: 4 * F, energy: 20 },
        { start: 4 * F, end: src.duration, energy: 90 },
      ],
    });
    const l = layoutOnGrid(s, grid);
    const esc = l.sections.find((x) => x.sectionId === 'sec_escalation')!;
    // it would start at 2 s; the music rises at 4 s, one bar away -> but the next section starts at 4 s,
    // so it cannot move there and keeps its place
    expect(esc.start).toBe(2 * F);
    const end = l.sections.find((x) => x.sectionId === 'sec_end')!;
    expect(end.start).toBe(4 * F);

    s.music.structure = [{ id: 'mus_drop', label: 'drop', sectionIds: ['sec_end'] }];
    const grid2 = resolveMusicGrid({
      ...src,
      sections: [
        { start: 0, end: 6 * F, energy: 20 },
        { start: 6 * F, end: src.duration, energy: 90 },
      ],
    });
    const l2 = layoutOnGrid(s, grid2);
    const end2 = l2.sections.find((x) => x.sectionId === 'sec_end')!;
    expect(end2.start).toBe(6 * F);
    expect(end2.note).toMatch(/drop in the music at 0:06/);
  });

  it('warns and cuts off when the storyboard is longer than the music', () => {
    const grid = resolveMusicGrid(steady(120, 10)); // 5 s of music
    const l = layoutOnGrid(sb(), grid);
    expect(l.end).toBeLessThanOrEqual(grid.duration);
    expect(l.warnings.join(' ')).toMatch(/longer than the music/);
  });

  it('leaves out omitted slots and works without any beats', () => {
    const grid = resolveMusicGrid(steady(120, 64));
    const l = layoutOnGrid(sb(), grid, { omitSlotIds: new Set(['shot_boss']) });
    expect(l.slots.map((x) => x.slotId)).not.toContain('shot_boss');
    expect(l.warnings.join(' ')).toMatch(/hit point "hit_boss"/);
    const bare = layoutOnGrid(
      sb(),
      resolveMusicGrid({
        duration: 60 * F,
        beats: [],
        downbeats: [],
        beatsPerBar: 4,
        sections: [],
      }),
    );
    expect(bare.end).toBe(7.5 * F);
  });

  it('is deterministic', () => {
    const grid = resolveMusicGrid(steady(123, 80, 0.37));
    expect(layoutOnGrid(sb(), grid)).toEqual(layoutOnGrid(sb(), grid));
  });
});
