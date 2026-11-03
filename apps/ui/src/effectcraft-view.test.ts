import { EC_TEMPLATES } from '@trailerforge/effectcraft';
import { describe, expect, it } from 'vitest';
import { parseSeconds, proposalFrame, requestLines, requestProblem } from './effectcraft-view.js';
import { STAND_INS, previewFrame } from './graphics-view.js';

describe('effectcraft view helpers', () => {
  it('reads times', () => {
    expect(parseSeconds('2')).toBe(2);
    expect(parseSeconds('0:02.5')).toBe(2.5);
    expect(parseSeconds('1:30')).toBe(90);
    expect(parseSeconds('x')).toBeNull();
    expect(parseSeconds('')).toBeNull();
  });
  it('says why a request cannot go', () => {
    const ok = { words: 'a title', seconds: '2', landAt: '', hasSource: false };
    expect(requestProblem(ok)).toBeNull();
    expect(requestProblem({ ...ok, words: '' })).toMatch(/Say what/);
    expect(requestProblem({ ...ok, words: '', hasSource: true })).toBeNull();
    expect(requestProblem({ ...ok, seconds: '30' })).toMatch(/0.5 and 20/);
    expect(requestProblem({ ...ok, landAt: '3' })).toMatch(/inside the effect/);
  });
  it('picks preview frames', () => {
    expect(proposalFrame({ frames: 60, still: 30 })).toBe(30);
    expect(proposalFrame({ frames: 60 })).toBe(30);
    expect(proposalFrame({ frames: 60 }, 1)).toBe(59);
    expect(proposalFrame({ frames: 60 }, 0)).toBe(0);
  });
  it('lists what is sent', () => {
    expect(
      requestLines({
        words: 'x',
        seconds: 2,
        landAt: 1,
        size: { width: 1920, height: 1080 },
        frameRate: 30,
      }),
    ).toEqual([
      // prettier-ignore
      'Your words: “x”',
      'Length 2 s, the hit at 1 s.',
      'Picture 1920×1080 at 30 fps.',
    ]);
  });
  it('draws the shipped EffectCraft templates with their built-in stand-ins, matching the package', () => {
    expect(Object.keys(STAND_INS).sort()).toEqual(EC_TEMPLATES.map((t) => t.id).sort());
    for (const t of EC_TEMPLATES) expect(STAND_INS[t.id]).toBe(t.fallback);
    const p = previewFrame({
      templateId: 'effectcraft/title-reveal',
      params: { text: 'EMBER KNIGHT' },
      brand: null,
      size: { width: 1920, height: 1080 },
      seconds: 3,
      at: 1,
    });
    expect('error' in p).toBe(false);
    expect(p).toMatchObject({ standIn: 'core/title-card' });
  });
});
