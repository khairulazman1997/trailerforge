import { buildCaptureHints, buildCapturePlan } from '@trailerforge/pack-game-trailer/browser';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  formatSeconds,
  groupTitle,
  moveBefore,
  moveWithin,
  parsePositive,
  parseResolution,
  percent,
  splitSetup,
} from './capture-view.js';

describe('capture view helpers', () => {
  it('titles groups and formats times and progress', () => {
    expect(groupTitle({ location: 'Forest', setup: '', entity: null })).toBe('Forest');
    expect(groupTitle({ location: '', setup: '', entity: null })).toBe('Anywhere');
    expect(formatSeconds(6)).toBe('6 s');
    expect(formatSeconds(300)).toBe('5 min');
    expect(percent(1, 4)).toBe(25);
    expect(percent(0, 0)).toBe(0);
  });

  it('moves shots within a group', () => {
    expect(moveWithin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveWithin(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(moveWithin(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    expect(moveBefore(['a', 'b', 'c'], 'a', 'b')).toBeNull(); // already there
    expect(moveBefore(['a', 'b'], 'x', 'a')).toBeNull();
  });

  it('parses settings input', () => {
    expect(parseResolution('2560x1440')).toEqual({ width: 2560, height: 1440 });
    expect(parseResolution('big')).toBeNull();
    expect(parsePositive('30', { integer: true })).toBe(30);
    expect(parsePositive('29.97', { integer: true })).toBeNull();
    expect(parsePositive('12.5')).toBe(12.5);
    expect(parsePositive('')).toBeNull();
    expect(parsePositive('-1')).toBeNull();
    expect(parsePositive('abc')).toBeNull();
  });

  it('shows setup that applies everywhere once, and leaves it out of the groups', () => {
    const p = Project.parse(sampleProject());
    const base = p.knowledge[0]!;
    p.knowledge.push(
      {
        ...base,
        id: 'ent_dbg',
        kind: 'other',
        name: 'god',
        description: 'console: god',
        tags: ['debug-command', 'all-levels'],
        sourcePaths: [],
        origin: 'extracted',
      },
      {
        ...base,
        id: 'ent_save',
        kind: 'other',
        name: 'slot1.sav',
        description: 'saves',
        tags: ['save-file', 'all-levels'],
        sourcePaths: [],
        origin: 'extracted',
      },
      {
        ...base,
        id: 'ent_warp',
        kind: 'other',
        name: 'warp',
        description: 'Cinder Forest',
        tags: ['debug-command'],
        sourcePaths: [],
        origin: 'extracted',
      },
    );
    const plan = buildCapturePlan(p.storyboard!, p.knowledge);
    const hints = buildCaptureHints(plan, p.knowledge);
    expect(hints.every((h) => h.debugCommands.some((d) => d.name === 'god'))).toBe(true);
    const view = splitSetup(hints, p.knowledge);
    expect(view.everywhere.debugCommands.map((h) => h.name)).toEqual(['god']);
    expect(view.everywhere.saveFiles.map((h) => h.name)).toEqual(['slot1.sav']);
    for (const g of view.groups) {
      expect(g.debugCommands.map((h) => h.name)).toEqual(['warp']);
      expect(g.saveFiles).toEqual([]);
    }
  });
});
