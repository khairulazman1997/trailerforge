import { describe, expect, it } from 'vitest';
import { contrastRows, fromPercent, normalizeHex, toPercent } from './brand-view.js';

describe('brand view', () => {
  it('normalises colours the way people type them', () => {
    expect(normalizeHex('#FFB020')).toBe('#ffb020');
    expect(normalizeHex('ffb020')).toBe('#ffb020');
    expect(normalizeHex('#fa0')).toBe('#ffaa00');
    for (const bad of ['', '#12', '#12345', 'red', '#gggggg'])
      expect(normalizeHex(bad), bad).toBeNull();
  });

  it('rows pass or fail against the AA threshold of each pair', () => {
    const ok = contrastRows({
      background: '#0b0d12',
      text: '#f5f6f8',
      primary: '#ffb020',
      accent: '#4cc9f0',
    });
    expect(ok.every((r) => r.pass)).toBe(true);
    const bad = contrastRows({
      background: '#ffffff',
      text: '#777777',
      primary: '#eeeeee',
      accent: '#000000',
    });
    expect(bad.map((r) => [r.pass, r.ratio, r.required])).toEqual([
      [false, 4.4, 4.5],
      [false, 1.1, 3],
      [true, 21, 3],
    ]);
  });

  it('converts text sizes to and from percentages', () => {
    expect(toPercent(0.12)).toBe('12');
    expect(toPercent(0.035)).toBe('3.5');
    expect(fromPercent('12')).toBe(0.12);
    expect(fromPercent('3,5')).toBe(0.035);
    for (const bad of ['1', '51', 'x', '']) expect(fromPercent(bad), bad).toBeNull();
  });
});
