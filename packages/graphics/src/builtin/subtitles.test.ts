import { defaultBrand, resolveBrandFonts, type Resolution } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SAFE, platformIssues, platformSafeBox } from '../platform.js';
import { brandTokens, buildScene, checkScene, renderSvg, safeBox } from '../template.js';
import { SEC } from './common.js';
import { builtinRegistry } from './index.js';

const V: Resolution = { width: 1080, height: 1920 };
const reg = builtinRegistry();
const brand = { ...defaultBrand(), colors: { ...defaultBrand().colors, accent: '#ffcc00' } };
const build = (
  id: string,
  params: unknown,
  duration = 2 * SEC,
  safe = platformSafeBox(V, 'tiktok'),
) => ({
  scene: buildScene(reg.get(id)!, { params, brand: brandTokens(brand, resolveBrandFonts(null, new Set()), V), size: V, duration, safe }), // prettier-ignore
  safe,
});

describe('core/subtitle-line', () => {
  it('cuts on and off with the voice: visible from the first frame to the last, no fade', () => {
    const { scene } = build('core/subtitle-line', { text: 'This boss has one tell.' });
    for (const at of [0, SEC, 2 * SEC - 1]) expect(renderSvg(scene, at)).toContain('>This boss has one tell.</tspan>'); // prettier-ignore
    expect(renderSvg(scene, 0)).not.toMatch(/data-layer="text" opacity/);
  });

  it('stays clear of TikTok’s interface, wraps to two lines and shrinks rather than overflow', () => {
    const long =
      'Miss it and you are done, every single time, no matter how many times you try again';
    const { scene, safe } = build('core/subtitle-line', { text: long });
    const text = scene.layers.find((l) => l.kind === 'text')!;
    expect(text.kind === 'text' && text.layout.lines.length).toBeLessThanOrEqual(2);
    expect(platformIssues(scene, 'tiktok')).toEqual([]);
    expect(checkScene(scene, safe).filter((m) => m.includes('reaches outside'))).toEqual([]);
    // The text sits at the bottom of the safe area, above the caption area.
    expect(text.kind === 'text' && text.layout.bounds.y + text.layout.bounds.h).toBeGreaterThan(
      V.height * 0.6,
    );
  });

  it('draws nothing for empty text', () => {
    expect(build('core/subtitle-line', {}).scene.layers).toEqual([]);
  });
});

describe('core/word-caption', () => {
  const words = [
    { text: 'One', start: 0, end: Math.round(0.3 * SEC) },
    { text: 'tell.', start: Math.round(0.3 * SEC), end: Math.round(0.8 * SEC) },
  ];
  it('highlights the word being said, in the accent colour, and pops it in', () => {
    const { scene } = build('core/word-caption', { words }, SEC);
    const at = (t: number) => renderSvg(scene, Math.round(t * SEC));
    expect(at(0.1)).toMatch(/fill="#ffcc00"[^>]*>(<tspan[^>]*>One<\/tspan>)/);
    expect(at(0.1)).not.toMatch(/fill="#ffcc00"[^>]*><tspan[^>]*>tell\./);
    expect(at(0.5)).toMatch(/fill="#ffcc00"[^>]*><tspan[^>]*>tell\./);
    expect(at(0.9)).not.toContain('#ffcc00'); // after the last word ends
    expect(at(0.3)).toContain('scale(1.15)');
    expect(at(0.1)).toContain('>One tell.</tspan>'); // the whole phrase under it
  });

  it('places each highlight over its word in the phrase', () => {
    const { scene } = build('core/word-caption', { words }, SEC);
    const [base, one, two] = scene.layers.filter((l) => l.kind === 'text');
    if (base?.kind !== 'text' || one?.kind !== 'text' || two?.kind !== 'text')
      throw new Error('layers');
    const line = base.layout.lines[0]!;
    expect(one.layout.lines[0]!.x).toBeCloseTo(line.x - line.width / 2, 6);
    expect(two.layout.lines[0]!.x).toBeGreaterThan(
      one.layout.lines[0]!.x + one.layout.lines[0]!.width,
    );
    expect(platformIssues(scene, 'tiktok')).toEqual([]);
  });

  it('refuses a word too long or too many words', () => {
    expect(() => build('core/word-caption', { words: [{ text: 'x'.repeat(41), start: 0, end: 1 }] })).toThrow(); // prettier-ignore
    expect(() => build('core/word-caption', { words: Array(13).fill(words[0]) })).toThrow();
  });
});

describe('platform safe zones', () => {
  it('names the part of the interface that covers text', () => {
    const { scene } = build('core/subtitle-line', { text: 'Wishlist now' }, SEC, safeBox(V));
    expect(platformIssues(scene, 'tiktok')).toEqual([
      `text "Wishlist now" sits where TikTok's interface covers it (the caption area at the bottom)`,
    ]);
    expect(PLATFORM_SAFE.reels.bottom).toBeLessThan(PLATFORM_SAFE.tiktok.bottom);
  });
});
