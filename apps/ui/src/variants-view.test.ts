import { describe, expect, it } from 'vitest';
import {
  choiceOf,
  cropAround,
  cropStyle,
  fateTone,
  focusFromPoint,
  formatLine,
  parseLength,
  seconds,
} from './variants-view.js';

describe('variants view', () => {
  it("reads a shot's choice from its override", () => {
    expect(choiceOf(undefined)).toBe('auto');
    expect(choiceOf({ excluded: true })).toBe('drop');
    expect(choiceOf({ excluded: false })).toBe('keep');
    expect(choiceOf({ cropCenter: { x: 0.5, y: 0.5 } })).toBe('auto');
    expect(fateTone('dropped')).toBe('warn');
    expect(fateTone('kept')).toBe('ok');
  });

  it('formats lengths and formats', () => {
    expect(seconds(705_600_000 * 2.54)).toBe('2.5 s');
    expect(
      formatLine({
        aspect: '9:16',
        resolution: { width: 1080, height: 1920 },
        frameRate: { num: 30, den: 1 },
      }),
    ).toBe('9:16, 1080×1920, 30 fps');
    expect(
      formatLine({
        aspect: { w: 21, h: 9 },
        resolution: { width: 2560, height: 1080 },
        frameRate: { num: 24000, den: 1001 },
      }),
    ).toBe('21:9, 2560×1080, 23.98 fps');
  });

  it('parses a typed length', () => {
    expect(parseLength('')).toBe('');
    expect(parseLength(' 30 ')).toBe(30);
    expect(parseLength('7,5')).toBe(7.5);
    for (const bad of ['0', '-3', 'abc', '601', '1e9']) expect(parseLength(bad), bad).toBeNull();
  });

  it('turns a click on a frame into a focus point, inside the frame', () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(focusFromPoint(300, 150, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(focusFromPoint(0, 1000, box)).toEqual({ x: 0, y: 1 });
    expect(focusFromPoint(1000, 0, box)).toEqual({ x: 1, y: 0 });
  });

  it('outlines the part of the master a vertical or square version shows', () => {
    const hd = { width: 1920, height: 1080 };
    const r = cropAround(hd, { width: 1080, height: 1920 }, { x: 0.5, y: 0.5 });
    expect(r.h).toBe(1);
    expect(r.w).toBeCloseTo(0.3164, 3);
    expect(cropStyle(r)).toEqual({ left: '34.18%', top: '0%', width: '31.64%', height: '100%' });
    expect(cropAround(hd, { width: 1080, height: 1920 }, { x: 1, y: 0.5 }).x).toBeCloseTo(
      0.6836,
      3,
    ); // kept inside the frame
    expect(cropAround(hd, hd, { x: 0.2, y: 0.2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
