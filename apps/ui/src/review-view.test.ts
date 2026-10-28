import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '@trailerforge/schema';
import {
  APPROVAL_LABEL,
  commentsFor,
  formatTime,
  overridableChecks,
  parseTime,
  percentAt,
  progressLabel,
  seconds,
  toFlicks,
  verdictLine,
  type GateGroups,
} from './review-view.js';

const groups = (g: Partial<GateGroups> = {}): GateGroups => ({
  blocking: [],
  needsOverride: [],
  overridden: [],
  warnings: [],
  ...g,
});
const f = (checkId: string) => ({ checkId, severity: 'error' as const, message: checkId });

describe('review view helpers', () => {
  it('has a label and a tone for every approval state', () => {
    expect(APPROVAL_LABEL.none.text).toBe('Not approved');
    expect(APPROVAL_LABEL.approved.tone).toBe('ok');
    expect(APPROVAL_LABEL.stale.text).toMatch(/out of date/);
  });

  it('formats and parses times', () => {
    expect(formatTime(5.24)).toBe('5.2');
    expect(formatTime(83.4)).toBe('1:23.4');
    expect(formatTime(60)).toBe('1:00.0');
    expect(formatTime(-3)).toBe('0.0');
    expect(parseTime('1:23.4')).toBeCloseTo(83.4);
    expect(parseTime(' 83 ')).toBe(83);
    expect(parseTime('2:5')).toBe(125);
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:2:3')).toBeNull();
    expect(seconds(toFlicks(2.5))).toBe(2.5);
  });

  it('places markers on a ruler inside its bounds', () => {
    expect(percentAt(5, 20)).toBe(25);
    expect(percentAt(-1, 20)).toBe(0);
    expect(percentAt(99, 20)).toBe(100);
    expect(percentAt(1, 0)).toBe(0);
  });

  it("lists one version's comments in time order", () => {
    const c = (id: string, variantId: string | null, at: number) =>
      ({
        id,
        variantId,
        at,
        text: 'x',
        resolved: false,
        createdAt: '2026-10-28T00:00:00.000Z',
      }) as ReviewComment;
    expect(
      commentsFor([c('b', 'v', 20), c('a', 'v', 5), c('m', null, 1)], 'v').map((x) => x.id),
    ).toEqual(['a', 'b']);
    expect(commentsFor([c('m', null, 1)], null)).toHaveLength(1);
  });

  it('says what a report means, and which checks can be overridden once', () => {
    expect(verdictLine(groups(), true)).toEqual({ text: 'May be exported. Nothing to report.', tone: 'ok' });
    expect(verdictLine(groups({ warnings: [f('core/jump-cut')] }), true)).toMatchObject({ tone: 'warn', text: expect.stringMatching(/1 warning to look at/) });
    const blocked = verdictLine(groups({ blocking: [f('core/placeholders')], needsOverride: [f('core/loudness'), f('core/loudness')] }), false);
    expect(blocked).toEqual({ tone: 'bad', text: 'Blocked: 1 always blocks, 2 need an override with a reason.' });
    expect(overridableChecks(groups({ needsOverride: [f('core/loudness'), f('core/loudness')], overridden: [{ ...f('core/av-sync'), reason: 'x' }] }))).toEqual(['core/loudness', 'core/av-sync']);
  }); // prettier-ignore

  it('labels progress', () => {
    expect(progressLabel({ phase: 'segments', fraction: 0.456 })).toBe('Rendering the picture 46%');
    expect(progressLabel({ phase: 'x', fraction: 1, message: 'Custom' })).toBe('Custom 100%');
  });
});
