import { defaultBrand, resolveBrandFonts, type Resolution } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SAFE, platformIssues, platformSafeBox } from '../platform.js';
import { brandTokens, buildScene, renderSvg } from '../template.js';
import { SEC } from './common.js';
import { builtinRegistry } from './index.js';

const V: Resolution = { width: 1080, height: 1920 };
const reg = builtinRegistry();
const scene = (text: string, platform: keyof typeof PLATFORM_SAFE = 'tiktok') =>
  buildScene(reg.get('core/cover-title')!, {
    params: { text },
    brand: brandTokens(defaultBrand(), resolveBrandFonts(null, new Set()), V),
    size: V,
    duration: SEC,
    safe: platformSafeBox(V, platform),
  });

describe('core/cover-title', () => {
  it('is served for the cover, shows the words from the first frame, and is deterministic', () => {
    expect(reg.forUse('overlay', 'cover')?.id).toBe('core/cover-title');
    const s = scene('Parry or die');
    expect(renderSvg(s, 0)).toMatch(/>Parry or</);
    expect(renderSvg(s, 0)).toBe(renderSvg(scene('Parry or die'), 0));
  });

  it('keeps long titles inside the platform’s safe area, shrinking before overflowing', () => {
    for (const p of Object.keys(PLATFORM_SAFE) as (keyof typeof PLATFORM_SAFE)[]) {
      const s = scene('Every boss falls to one single perfect parry. Try it today.', p);
      expect(platformIssues(s, p)).toEqual([]);
    }
  });

  it('draws nothing for no words', () => {
    expect(scene('').layers).toEqual([]);
  });
});
