import { describe, expect, it } from 'vitest';
import {
  addDays,
  campaignColor,
  effectiveDate,
  filterSlots,
  groupByDate,
  isIsoDate,
  longDate,
  monthGrid,
  monthLabel,
  moveKeyDelta,
  platformNames,
  shiftMonth,
  statusChip,
  todayIso,
  type SlotLike,
} from './planner-view.js';

const slot = (over: Partial<SlotLike> = {}): SlotLike => ({
  id: 's1',
  date: '2026-12-01',
  title: 'Trailer',
  campaignId: null,
  platformTargets: [],
  project: null,
  ...over,
});
const project = (over: Partial<NonNullable<SlotLike['project']>> = {}) => ({
  scheduledDate: null,
  status: 'idea',
  state: 'ok',
  suggestion: null,
  ...over,
});

describe('calendar dates', () => {
  it('checks real dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(isIsoDate('soon')).toBe(false);
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-01', 7)).toBe('2026-12-08');
  });

  it('uses the local calendar day for today', () => {
    expect(todayIso(new Date(2026, 10, 6, 23, 59))).toBe('2026-11-06');
  });

  it('shifts and names months', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-05', -17)).toBe('2024-12');
    expect(monthLabel('2026-12')).toBe('December 2026');
    expect(longDate('2026-12-01')).toBe('Tuesday 1 December 2026');
  });
});

describe('monthGrid', () => {
  it('starts on a Monday and covers the whole month in whole weeks', () => {
    const grid = monthGrid('2026-12'); // 1 December 2026 is a Tuesday
    expect(grid[0]![0]).toEqual({ date: '2026-11-30', inMonth: false });
    expect(grid[0]![1]).toEqual({ date: '2026-12-01', inMonth: true });
    expect(grid.every((w) => w.length === 7)).toBe(true);
    const inMonth = grid.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(grid.at(-1)!.some((c) => c.inMonth)).toBe(true);
  });

  it('has four weeks for a February that starts on Monday, and six when it must', () => {
    expect(monthGrid('2027-02')).toHaveLength(4); // 1 Feb 2027 is a Monday, 28 days
    expect(monthGrid('2026-08')).toHaveLength(6); // starts Saturday, 31 days
  });
});

describe('planned videos', () => {
  it('moves by arrow keys: a day sideways, a week up and down', () => {
    expect(moveKeyDelta('ArrowLeft')).toBe(-1);
    expect(moveKeyDelta('ArrowRight')).toBe(1);
    expect(moveKeyDelta('ArrowUp')).toBe(-7);
    expect(moveKeyDelta('ArrowDown')).toBe(7);
    expect(moveKeyDelta('Enter')).toBeNull();
  });

  it("shows on the project's date once there is one", () => {
    expect(effectiveDate(slot())).toBe('2026-12-01');
    expect(effectiveDate(slot({ project: project({ scheduledDate: '2026-12-15' }) }))).toBe(
      '2026-12-15',
    );
    expect(effectiveDate(slot({ project: project() }))).toBe('2026-12-01');
  });

  it('groups by shown date in title order, and filters by campaign', () => {
    const a = slot({ id: 'a', title: 'Zeta', campaignId: 'c1' });
    const b = slot({ id: 'b', title: 'Alpha' });
    const c = slot({ id: 'c', title: 'Moved', project: project({ scheduledDate: '2026-12-02' }) });
    const days = groupByDate([a, b, c]);
    expect(days.get('2026-12-01')!.map((s) => s.id)).toEqual(['b', 'a']);
    expect(days.get('2026-12-02')!.map((s) => s.id)).toEqual(['c']);
    expect(filterSlots([a, b, c], 'all')).toHaveLength(3);
    expect(filterSlots([a, b, c], 'none').map((s) => s.id)).toEqual(['b', 'c']);
    expect(filterSlots([a, b, c], 'c1').map((s) => s.id)).toEqual(['a']);
  });

  it('describes the status chip and a suggestion', () => {
    expect(statusChip(slot())).toMatchObject({ label: 'No project yet', tone: 'plain' });
    expect(statusChip(slot({ project: project({ status: 'in-review' }) })).label).toBe('In review');
    expect(statusChip(slot({ project: project({ status: 'scheduled' }) })).tone).toBe('ok');
    expect(
      statusChip(slot({ project: project({ status: null, state: 'missing' }) })),
    ).toMatchObject({ label: 'Folder missing', tone: 'warn' });
    expect(statusChip(slot({ project: project({ status: null, state: 'unknown' }) })).label).toBe(
      'Project not found',
    );
    const chip = statusChip(
      slot({
        project: project({ suggestion: { status: 'editing', reason: 'A cut has been built.' } }),
      }),
    );
    expect(chip.suggestion).toEqual({
      status: 'editing',
      label: 'Editing',
      reason: 'A cut has been built.',
    });
  });

  it('colours campaigns and names platforms', () => {
    expect(campaignColor({ color: '#112233' }, 0)).toBe('#112233');
    expect(campaignColor({}, 0)).toBe(campaignColor({}, 6));
    expect(campaignColor({}, 0)).not.toBe(campaignColor({}, 1));
    expect(
      platformNames(['core/youtube', 'acme/x'], [{ id: 'core/youtube', name: 'YouTube' }]),
    ).toBe('YouTube, acme/x');
  });
});
