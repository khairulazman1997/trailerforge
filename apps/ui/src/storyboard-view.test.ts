import type { DecisionRecord, Section, Slot, Storyboard } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  decisionsFor,
  describeDecision,
  dropTarget,
  isHandEdited,
  stepTarget,
  storyboardTiming,
} from './storyboard-view.js';

const slot = (id: string, ideal = 2, extensions: Slot['extensions'] = {}): Slot =>
  ({
    id,
    kind: 'shot',
    title: id,
    duration: { min: 1, ideal, max: 4 },
    extensions,
  }) as unknown as Slot;
const section = (id: string, slots: Slot[]): Section =>
  ({ id, name: id, slots, locked: false }) as unknown as Section;

const sections = [
  section('A', [slot('a1'), slot('a2'), slot('a3')]),
  section('B', [slot('b1')]),
  section('C', []),
];

describe('storyboardTiming', () => {
  it('sums ideals per section and against the target', () => {
    const sb = {
      meta: { targetDuration: 5 },
      sections: [section('A', [slot('x', 2.5), slot('y', 2.5)]), section('B', [slot('z', 1.3)])],
    };
    expect(storyboardTiming(sb as unknown as Storyboard)).toEqual({
      target: 5,
      actual: 6.3,
      delta: 1.3,
      sections: [
        { id: 'A', seconds: 5 },
        { id: 'B', seconds: 1.3 },
      ],
    });
    expect(
      storyboardTiming({ meta: { targetDuration: 10 }, sections: [] } as unknown as Storyboard)
        .delta,
    ).toBe(-10);
  });
});

describe('dropTarget', () => {
  it('drops before a slot, at the end, or into an empty section', () => {
    expect(dropTarget(sections, 'a3', 'A', 'a1')).toEqual({ toSectionId: 'A', index: 0 });
    expect(dropTarget(sections, 'a1', 'A', null)).toEqual({ toSectionId: 'A', index: 2 });
    expect(dropTarget(sections, 'a1', 'B', 'b1')).toEqual({ toSectionId: 'B', index: 0 });
    expect(dropTarget(sections, 'a2', 'C', null)).toEqual({ toSectionId: 'C', index: 0 });
  });

  it('counts positions after the slot is taken out when moving down within a section', () => {
    // Move a1 to just before a3: the list without a1 is [a2, a3], so index 1.
    expect(dropTarget(sections, 'a1', 'A', 'a3')).toEqual({ toSectionId: 'A', index: 1 });
  });

  it('returns null when nothing would change or the target is missing', () => {
    expect(dropTarget(sections, 'a2', 'A', 'a3')).toBeNull(); // already right before a3
    expect(dropTarget(sections, 'a3', 'A', null)).toBeNull(); // already last
    expect(dropTarget(sections, 'a1', 'A', 'a1')).toBeNull();
    expect(dropTarget(sections, 'a1', 'Z', null)).toBeNull();
    expect(dropTarget(sections, 'nope', 'A', null)).toBeNull();
    expect(dropTarget(sections, 'a1', 'A', 'nope')).toBeNull();
  });
});

describe('stepTarget', () => {
  it('moves one place within the section, and stops at the ends', () => {
    expect(stepTarget(sections, 'a2', -1)).toEqual({ toSectionId: 'A', index: 0 });
    expect(stepTarget(sections, 'a2', 1)).toEqual({ toSectionId: 'A', index: 2 });
    expect(stepTarget(sections, 'a1', -1)).toBeNull();
    expect(stepTarget(sections, 'a3', 1)).toBeNull();
    expect(stepTarget(sections, 'b1', 1)).toBeNull();
  });
});

describe('isHandEdited', () => {
  it('reads the edit marker the engine leaves on a slot', () => {
    expect(isHandEdited(slot('x'))).toBe(false);
    expect(isHandEdited(slot('x', 2, { core: { userEdited: ['title'] } }))).toBe(true);
    expect(isHandEdited(slot('x', 2, { core: { userEdited: [] } }))).toBe(false);
  });
});

describe('decisions', () => {
  const d = (step: string, kind: string, id: string, choice: unknown = null): DecisionRecord =>
    ({
      id: `${step}${id}`,
      at: '',
      step,
      subject: { kind, id },
      choice,
      reasons: {},
      summary: 's',
      alternatives: [],
    }) as unknown as DecisionRecord;
  const all = [
    d('core/storyboard-generate', 'storyboard', 'sb'),
    d('core/storyboard-regenerate-section', 'section', 'A', { name: 'Hook v2' }),
    d('core/storyboard-regenerate-section', 'section', 'B', { name: 'Mid' }),
  ];

  it('describes known steps and falls back to the step id', () => {
    expect(describeDecision(all[0]!)).toBe('Generated the storyboard');
    expect(describeDecision(all[1]!)).toBe('Rewrote “Hook v2”');
    expect(describeDecision(d('x/other', 'asset', 'q'))).toBe('x/other');
  });

  it('shows newest first, and for a section only what concerns it', () => {
    expect(decisionsFor(all, null).map((x) => x.subject.id)).toEqual(['B', 'A', 'sb']);
    expect(decisionsFor(all, 'A').map((x) => x.subject.id)).toEqual(['A', 'sb']);
  });
});
