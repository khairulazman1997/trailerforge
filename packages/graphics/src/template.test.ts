import { FLICKS_PER_SECOND, defaultBrand, resolveBrandFonts } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TITLE_SAFE,
  TemplateParamsError,
  TemplateRegistry,
  brandTokens,
  buildScene,
  checkScene,
  fadeInOut,
  renderSvg,
  safeBox,
  type GraphicTemplate,
} from './template.js';
import { layoutText } from './text.js';

const F = FLICKS_PER_SECOND;
const HD = { width: 1920, height: 1080 };

/** A minimal title card, to exercise the contract (the built-in set comes in 5.5). */
const title: GraphicTemplate<{ text: string; color?: string | undefined }> = {
  id: 'test/title',
  name: 'Title',
  kind: 'card',
  serves: ['title'],
  params: z.strictObject({ text: z.string().min(1), color: z.string().optional() }),
  duration: { default: 3 * F, min: F },
  build: ({ params, brand, size, duration, safe, measure }) => {
    const layout = layoutText({
      text: params.text,
      box: safe,
      font: brand.fonts.heading,
      size: brand.sizes.title,
      ...(measure ? { measure } : {}),
    });
    return {
      size,
      duration,
      background: brand.colors.background,
      layers: [
        {
          id: 'bar',
          kind: 'rect',
          box: { x: safe.x, y: layout.bounds.y + layout.bounds.h + 10, w: safe.w, h: 6 },
          fill: brand.colors.primary,
          animation: {
            reveal: {
              keyframes: [
                { at: 0, value: 0, easing: 'ease-out' },
                { at: F / 2, value: 1, easing: 'linear' },
              ],
            },
          },
        },
        {
          id: 'title',
          kind: 'text',
          box: layout.bounds,
          layout,
          font: brand.fonts.heading,
          fill: params.color ?? brand.colors.text,
          text: params.text,
          animation: {
            opacity: fadeInOut(duration, F / 3, F / 3),
            scale: {
              keyframes: [
                { at: 0, value: 0.9, easing: 'ease-out' },
                { at: F, value: 1, easing: 'linear' },
              ],
            },
          },
        },
      ],
      warnings: [],
    };
  },
};

const tokens = () => brandTokens(defaultBrand(), resolveBrandFonts(null, new Set()), HD);

describe('brand tokens', () => {
  it('turn the brand kit into colours, fonts and pixel sizes for the frame', () => {
    const t = tokens();
    expect(t.fonts).toEqual({
      heading: { family: 'Inter', weight: 700 },
      body: { family: 'Inter', weight: 400 },
    });
    expect(t.sizes.title).toBe(129.6);
    expect(t.colors.background).toBe('#0b0d12');
    expect(t.logo).toBeUndefined();
    const withLogo = brandTokens(
      { ...defaultBrand(), logo: { hash: 'c'.repeat(64), ext: 'svg', name: 'l.svg' } },
      undefined,
      { width: 1080, height: 1920 },
    );
    expect(withLogo.logo).toEqual({ href: `media/${'c'.repeat(64)}.svg`, ext: 'svg' });
    expect(withLogo.sizes.title).toBe(230.4);
  });
});

describe('templates', () => {
  const ctx = (text: string) => ({
    params: { text },
    brand: tokens(),
    size: HD,
    duration: 3 * F,
    safe: safeBox(HD, TITLE_SAFE),
  });

  it('build a scene that renders deterministically and animates over time', () => {
    const scene = buildScene(title as GraphicTemplate<unknown>, ctx('Ember Knight'));
    const a = renderSvg(scene, F / 4);
    expect(
      renderSvg(buildScene(title as GraphicTemplate<unknown>, ctx('Ember Knight')), F / 4),
    ).toBe(a);
    expect(renderSvg(scene, 0)).not.toContain('data-layer="title"'); // faded out at the start
    expect(a).toMatch(/<g data-layer="title" opacity="0\.\d+"/);
    expect(a).toContain('clip-path="url(#clip-bar)"');
    const rest = renderSvg(scene, 1.5 * F);
    expect(rest).toContain('<g data-layer="title"><text font-family="Inter" font-weight="700"');
    expect(rest).toContain('>Ember Knight</tspan>');
    expect(rest).not.toContain('clip-path');
    expect(checkScene(scene, safeBox(HD), 3)).toEqual([]);
  });

  it('escape text and flag text outside the safe area or too short to read', () => {
    const scene = buildScene(title as GraphicTemplate<unknown>, ctx('Fire & <Ash>'));
    expect(renderSvg(scene, 1.5 * F)).toContain('Fire &amp; &lt;Ash&gt;');
    const wide = {
      ...scene,
      layers: scene.layers.map((l) => (l.kind === 'text' ? { ...l, box: { ...l.box, x: 0 } } : l)),
    };
    expect(checkScene(wide, safeBox(HD))).toEqual([
      'text "Fire & <Ash>" reaches outside the safe area',
    ]);
    const long = buildScene(
      title as GraphicTemplate<unknown>,
      ctx('Wishlist Ember Knight on Steam today and tell your friends'),
    );
    expect(checkScene(long, safeBox(HD), 1)).toEqual([
      expect.stringMatching(/reading it takes about/),
    ]);
  });

  it('refuse bad params', () => {
    expect(() =>
      buildScene(title as GraphicTemplate<unknown>, { ...ctx(''), params: { text: '' } }),
    ).toThrow(TemplateParamsError);
    expect(() =>
      buildScene(title as GraphicTemplate<unknown>, { ...ctx(''), params: { text: 'x', size: 3 } }),
    ).toThrow(/test\/title/);
  });

  it('register by id and are found by what they serve', () => {
    const reg = new TemplateRegistry().register(title);
    expect(reg.ids()).toEqual(['test/title']);
    expect(reg.ids('overlay')).toEqual([]);
    expect(reg.forUse('card', 'title')?.id).toBe('test/title');
    expect(reg.forUse('card', 'cta')).toBeUndefined();
    expect(() => reg.register(title)).toThrow(/already/);
    expect(() => new TemplateRegistry().register({ ...title, id: 'Bad' })).toThrow(
      /bad template id/,
    );
    expect(() =>
      new TemplateRegistry().register({ ...title, duration: { default: 1, min: 2 } }),
    ).toThrow(/duration/);
  });

  it('fadeInOut stays a valid animation for short items', () => {
    expect(fadeInOut(10, 100, 100)).toBe(1);
    const f = fadeInOut(3 * F, F / 3, F / 3);
    expect(typeof f === 'object' && !Array.isArray(f) && f.keyframes.map((k) => k.at)).toEqual([
      0,
      F / 3,
      3 * F - F / 3,
      3 * F,
    ]);
  });
});
