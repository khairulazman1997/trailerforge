import { describe, expect, it } from 'vitest';
import { baseName, confidentCount, lengthText, parsePaths } from './footage-view.js';

describe('footage view helpers', () => {
  it('reads pasted paths: lines or semicolons, quotes, blanks and repeats', () => {
    expect(parsePaths('  "C:\\Videos\\OBS"\n\n/home/me/rec ; /home/me/rec\n')).toEqual([
      'C:\\Videos\\OBS',
      '/home/me/rec',
    ]);
    expect(parsePaths('   \n')).toEqual([]);
  });

  it('counts only suggestions that attach on their own', () => {
    const m = (kind: string, confidence: string, n = 1) =>
      ({ kind, confidence, candidates: Array(n).fill({}) }) as never;
    expect(
      confidentCount([
        m('code', 'certain'),
        m('suggested', 'high'),
        m('suggested', 'medium'),
        m('ambiguous-code', 'high'),
        m('none', 'high', 0),
      ]),
    ).toBe(2);
  });

  it('formats lengths and names', () => {
    expect(lengthText(null)).toBe('length unknown');
    expect(lengthText(6.04)).toBe('6 s');
    expect(lengthText(125)).toBe('2 min 5 s');
    expect(baseName('C:\\rec\\a.mp4')).toBe('a.mp4');
    expect(baseName('/rec/b.mkv')).toBe('b.mkv');
  });
});
