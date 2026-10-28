import { describe, expect, it } from 'vitest';
import { FlashRiskError, assertFlashSafe, flashViolations } from './flash.js';
import { builtinFilters, flashEvents } from './registry.js';

const ctx = (duration: number) => ({
  width: 1920,
  height: 1080,
  rate: { num: 30, den: 1 },
  duration,
});
const reg = builtinFilters();

describe('flash-rate guard', () => {
  it('allows three flashes in a second and refuses four', () => {
    const three = [0, 0.3, 0.6, 1.2, 1.5, 1.8].map((at) => ({ at, source: 'Flash' }));
    expect(flashViolations(three)).toEqual([]);
    expect(() => assertFlashSafe(three)).not.toThrow();
    const four = [0, 0.25, 0.5, 0.75].map((at) => ({ at, source: 'Flash' }));
    expect(flashViolations(four)).toEqual([{ from: 0, to: 0.75, count: 4, sources: ['Flash'] }]);
    expect(() => assertFlashSafe(four)).toThrow(FlashRiskError);
    expect(() => assertFlashSafe(four)).toThrow(
      /4 flashes within one second from 0 s \(Flash\); at most 3 are safe/,
    );
  });

  it('counts flashes from transitions and effects placed on the cut', () => {
    const flash = reg.get('core/flash')!;
    const glitch = reg.get('core/glitch')!;
    // Three flash cuts a third of a second apart: fine.
    const cuts = [1, 1.34, 1.68].flatMap((at) => flashEvents(flash, {}, ctx(0.12), at));
    expect(flashViolations(cuts)).toEqual([]);
    // A glitch flickering 6 times a second for a second: refused.
    const fast = flashEvents(glitch, { rate: 6 }, ctx(1), 5);
    expect(fast).toHaveLength(6);
    expect(() => assertFlashSafe(fast)).toThrow(/Glitch/);
    // The default glitch is slow enough, even next to a flash.
    expect(
      flashViolations([
        ...flashEvents(glitch, {}, ctx(1), 5),
        ...flashEvents(flash, {}, ctx(0.12), 5.5),
      ]),
    ).toEqual([]);
    // But a flash cut on top of a busier glitch goes over.
    expect(
      flashViolations([
        ...flashEvents(glitch, { rate: 3 }, ctx(1), 5),
        ...flashEvents(flash, {}, ctx(0.12), 5.5),
      ])[0],
    ).toMatchObject({ count: 4, sources: ['Glitch', 'Flash'] });
    expect(flashEvents(reg.get('core/dip')!, { color: 'black' }, ctx(0.6), 0)).toEqual([]);
    expect(flashEvents(reg.get('core/dip')!, { color: 'white' }, ctx(0.6), 0)).toEqual([
      { at: 0.3, source: 'Dip to colour' },
    ]);
  });

  it('merges overlapping windows into one violation', () => {
    const strobe = Array.from({ length: 20 }, (_, i) => ({ at: i * 0.1, source: 'Strobe' }));
    const v = flashViolations(strobe);
    expect(v.length).toBe(1);
    expect(v[0]).toMatchObject({ from: 0, count: 10 });
    expect(v[0]!.to).toBeCloseTo(1.9, 9);
  });
});

describe('registry', () => {
  it('lists the installed ids by kind', () => {
    expect(reg.ids('transition')).toEqual([
      'core/crossfade',
      'core/dip',
      'core/flash',
      'core/glitch',
      'core/whip',
      'core/xfade',
      'core/zoom-punch',
    ]);
    expect(reg.ids('effect')).toEqual([
      'core/glow',
      'core/grain',
      'core/impact-shake',
      'core/letterbox',
      'core/light-leak',
      'core/speed-ramp',
      'core/vignette',
    ]);
    expect(() => builtinFilters().register(reg.get('core/glow')!)).toThrow(/already/);
  });
});
