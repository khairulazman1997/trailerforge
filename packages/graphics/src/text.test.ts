import { describe, expect, it } from 'vitest';
import { approxMeasure, layoutText, minReadSeconds, readTimeWarning, type Box } from './text.js';

const FONT = { family: 'Inter', weight: 700 };
const WORDS = [
  'Ember',
  'Knight',
  'rises',
  'from',
  'the',
  'ashes',
  'of',
  'a',
  'burned',
  'kingdom',
  'Supercalifragilisticexpialidocious',
  'now',
  '2026',
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.01 &&
  inner.y >= outer.y - 0.01 &&
  inner.x + inner.w <= outer.x + outer.w + 0.01 &&
  inner.y + inner.h <= outer.y + outer.h + 0.01;

describe('layoutText', () => {
  it('never leaves the box, and says why whenever it had to shrink or shorten', () => {
    const r = rng(5);
    for (let n = 0; n < 1000; n++) {
      const text = Array.from(
        { length: 1 + Math.floor(r() * 14) },
        () => WORDS[Math.floor(r() * WORDS.length)],
      ).join(' ');
      const box = { x: r() * 100, y: r() * 100, w: 40 + r() * 1700, h: 20 + r() * 900 };
      const size = 10 + r() * 140;
      const align = (['start', 'middle', 'end'] as const)[n % 3]!;
      const l = layoutText({
        text,
        box,
        font: FONT,
        size,
        ...(r() < 0.5 ? { maxLines: 1 + Math.floor(r() * 3) } : {}),
        align,
        valign: (['top', 'middle', 'bottom'] as const)[n % 3]!,
      });
      if (l.lines.length) expect(within(l.bounds, box), `case ${n}`).toBe(true);
      for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(box.w + 0.01);
      expect(l.lines.length * l.size * l.lineHeight).toBeLessThanOrEqual(box.h + 0.01);
      if (l.shrunk || l.truncated) expect(l.warnings.length).toBeGreaterThan(0);
      else expect(l.warnings).toEqual([]);
      if (!l.truncated)
        expect(
          l.lines
            .map((x) => x.text)
            .join(' ')
            .replace(/ /g, ''),
        ).toBe(text.replace(/ /g, ''));
    }
  });

  it('keeps the preferred size when the text fits', () => {
    const l = layoutText({
      text: 'Ember Knight',
      box: { x: 0, y: 0, w: 1000, h: 300 },
      font: FONT,
      size: 100,
    });
    expect(l).toMatchObject({ size: 100, shrunk: false, truncated: false, warnings: [] });
    expect(l.lines.map((x) => x.text)).toEqual(['Ember Knight']);
    expect(l.lines[0]!.x).toBe(500);
  });

  it('wraps, then shrinks, then shortens with an ellipsis', () => {
    const box = { x: 0, y: 0, w: 400, h: 120 };
    const wrapped = layoutText({ text: 'Ember Knight rises', box, font: FONT, size: 50 });
    expect(wrapped.lines.length).toBe(2);
    expect(wrapped.shrunk).toBe(false);
    const shrunk = layoutText({
      text: 'Ember Knight rises from the ashes',
      box,
      font: FONT,
      size: 50,
    });
    expect(shrunk.shrunk).toBe(true);
    expect(shrunk.warnings[0]).toMatch(/set smaller/);
    const cut = layoutText({
      text: WORDS.join(' ').repeat(3),
      box,
      font: FONT,
      size: 50,
      maxLines: 2,
    });
    expect(cut.truncated).toBe(true);
    expect(cut.lines.length).toBe(2);
    expect(cut.lines.at(-1)!.text.endsWith('…')).toBe(true);
    expect(cut.warnings[0]).toMatch(/shortened; use fewer words/);
  });

  it('breaks a word too long for any size', () => {
    const l = layoutText({
      text: 'Supercalifragilisticexpialidocious',
      box: { x: 0, y: 0, w: 200, h: 400 },
      font: FONT,
      size: 40,
      minSize: 30,
    });
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines)
      expect(approxMeasure(line.text, l.size, FONT)).toBeLessThanOrEqual(200);
  });
});

describe('read time', () => {
  it('needs about a third of a second a word, at least a second', () => {
    expect(minReadSeconds('')).toBe(0);
    expect(minReadSeconds('Out now')).toBe(1.27);
    expect(minReadSeconds('One')).toBe(1);
    expect(readTimeWarning('Out now', 2)).toBeNull();
    expect(readTimeWarning('Wishlist Ember Knight on Steam today', 1)).toMatch(
      /on screen for 1 s; reading it takes about 2.6 s/,
    );
  });
});
