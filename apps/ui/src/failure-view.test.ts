import { describe, expect, it } from 'vitest';
import { nextStepFor } from './failure-view.js';

describe('nextStepFor', () => {
  it('sends a missing tool to Setup, with or without a project', () => {
    expect(nextStepFor('missing-tool', null)).toEqual({ label: 'Open Setup', to: '/setup' });
    expect(nextStepFor('missing-tool', 'p1')?.to).toBe('/setup');
  });
  it('points project errors at the tab that fixes them', () => {
    expect(nextStepFor('gate-blocked', 'p1')?.to).toBe('/p/p1/review');
    expect(nextStepFor('excluded', 'p1')?.to).toBe('/p/p1/knowledge');
    expect(nextStepFor('gate-blocked', null)).toBeNull();
  });
  it('offers nothing for other codes', () => {
    expect(nextStepFor('usage', 'p1')).toBeNull();
    expect(nextStepFor(undefined, 'p1')).toBeNull();
  });
});
