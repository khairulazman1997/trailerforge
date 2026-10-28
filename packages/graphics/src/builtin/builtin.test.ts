import { CardSlot, defaultBrand, resolveBrandFonts, type Resolution } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  brandTokens,
  buildScene,
  checkScene,
  renderSvg,
  safeBox,
  type BrandTokens,
} from '../template.js';
import { SEC } from './common.js';
import { builtinRegistry, builtinTemplates } from './index.js';

const HD: Resolution = { width: 1920, height: 1080 };
const VERTICAL: Resolution = { width: 1080, height: 1920 };
const SQUARE: Resolution = { width: 1080, height: 1080 };
const reg = builtinRegistry();

const tokens = (size: Resolution, logo = false): BrandTokens =>
  brandTokens(
    logo
      ? { ...defaultBrand(), logo: { hash: 'd'.repeat(64), ext: 'svg', name: 'logo.svg' } }
      : defaultBrand(),
    resolveBrandFonts(null, new Set()),
    size,
  );

const build = (
  id: string,
  size: Resolution,
  params: unknown = {},
  opts: { logo?: boolean; duration?: number } = {},
) => {
  const t = reg.get(id)!;
  const duration = opts.duration ?? t.duration.default;
  const safe = safeBox(size);
  return {
    t,
    duration,
    safe,
    scene: buildScene(t, { params, brand: tokens(size, opts.logo), size, duration, safe }),
  };
};

/** Showy parameters, so the goldens show every part of a template. */
const SAMPLE: Record<string, unknown> = {
  'core/title-card': { text: 'Ember Knight', subtitle: 'A dark fantasy action RPG' },
  'core/tagline-card': { text: 'Rise from the ashes' },
  'core/date-card': { text: '14 March 2027', label: 'Coming', platforms: 'PC and consoles' },
  'core/laurels-card': { text: 'Best Indie Game', score: '9/10', source: 'Pixel Weekly' },
  'core/quote-card': {
    text: 'The tightest combat I have played all year.',
    source: 'Game Informer',
  },
  'core/logo-card': { text: 'Ember Knight' },
  'core/cta-card': { text: 'Wishlist now', detail: 'on Steam' },
  'core/end-slate': {
    text: 'Ember Knight',
    cta: 'Wishlist on Steam',
    detail: 'Coming 14 March 2027 for PC',
  },
  'core/custom-card': { text: 'Three years in the making', subtitle: 'by a team of four' },
  'core/lower-third': { text: 'The Ash Warden', role: 'Final boss' },
  'core/caption': { text: 'Parry to counter' },
};

describe('built-in templates', () => {
  it('cover every card kind and overlay style the storyboard uses', () => {
    for (const kind of CardSlot.shape.cardKind.options) {
      expect(reg.get(`core/${kind}-card`), kind).toBeDefined();
      expect(reg.forUse('card', kind), kind).toBeDefined();
    }
    expect(reg.forUse('card', 'end-slate')?.id).toBe('core/end-slate');
    expect(reg.forUse('overlay', 'name')?.id).toBe('core/lower-third');
    expect(reg.forUse('overlay', 'caption')?.id).toBe('core/caption');
    // Ids the Game Trailer pack's storyboard templates and the generator use today.
    for (const id of [
      'core/title-card',
      'core/date-card',
      'core/laurels-card',
      'core/cta-card',
      'core/end-slate',
      'core/lower-third',
      'core/caption',
    ])
      expect(reg.get(id), id).toBeDefined();
    expect(reg.ids().sort()).toEqual(builtinTemplates.map((t) => t.id).sort());
    expect(reg.ids('overlay')).toEqual(['core/caption', 'core/lower-third']);
  });

  for (const t of builtinTemplates) {
    describe(t.id, () => {
      const slug = t.id.replace('core/', '');
      const frames: [string, (d: number) => number][] = [
        ['in', () => Math.round(0.2 * SEC)],
        ['rest', (d) => Math.round(d / 2)],
        ['out', (d) => d - Math.round(0.15 * SEC)],
      ];

      for (const [name, at] of frames)
        it(`golden frame: ${name}`, async () => {
          const { scene, duration } = build(t.id, HD, SAMPLE[t.id], { logo: false });
          await expect(renderSvg(scene, at(duration)) + '\n').toMatchFileSnapshot(
            `../__golden__/${slug}.${name}.svg`,
          );
        });

      it('is visible at rest, hidden at the very start and end, and deterministic', () => {
        const { scene, duration } = build(t.id, HD, SAMPLE[t.id]);
        const rest = renderSvg(scene, Math.round(duration / 2));
        expect(rest).toContain('data-layer=');
        expect(rest).not.toMatch(/NaN|undefined|Infinity/);
        expect(renderSvg(scene, 0)).not.toContain('<text');
        expect(renderSvg(scene, duration)).not.toContain('<text');
        expect(renderSvg(build(t.id, HD, SAMPLE[t.id]).scene, Math.round(duration / 2))).toBe(rest);
        if (t.kind === 'card')
          expect(rest).toContain('<rect width="1920" height="1080" fill="#0b0d12"/>');
        else expect(rest).not.toContain('width="1920" height="1080" fill=');
      });

      it('keeps default and sample text in the safe area at 16:9, 9:16 and 1:1 with nothing to warn about', () => {
        for (const size of [HD, VERTICAL, SQUARE])
          for (const params of [{}, SAMPLE[t.id]]) {
            const { scene, duration, safe } = build(t.id, size, params);
            expect(checkScene(scene, safe, duration / SEC), `${size.width}x${size.height}`).toEqual(
              [],
            );
          }
      });

      it('uses the brand colours and fonts', () => {
        const brand = {
          ...defaultBrand(),
          colors: { background: '#102030', text: '#fefefe', primary: '#ff0066', accent: '#00ffcc' },
        };
        const safe = safeBox(HD);
        const scene = buildScene(reg.get(t.id)!, {
          params: SAMPLE[t.id],
          brand: brandTokens(brand, resolveBrandFonts(null, new Set()), HD),
          size: HD,
          duration: t.duration.default,
          safe,
        });
        const svg = renderSvg(scene, Math.round(t.duration.default / 2));
        expect(svg).toContain('#fefefe');
        expect(svg).toContain('font-family="Inter"');
        if (t.kind === 'card') expect(svg).toContain('fill="#102030"');
        expect(svg).not.toContain('#0b0d12');
      });
    });
  }

  it('never lets long or strange text out of the safe area', () => {
    const long =
      'Wishlist Ember Knight on Steam today and tell all of your friends about the best game of the year Supercalifragilisticexpialidocious';
    let seed = 11;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const t of builtinTemplates)
      for (const size of [HD, VERTICAL, SQUARE]) {
        const text = long.slice(0, Math.floor(next() * long.length) + 1).trim() || 'x';
        const params = {
          text,
          ...(t.id === 'core/lower-third' ? { role: text } : {}),
          ...(t.id === 'core/end-slate' ? { cta: text, detail: text } : {}),
        };
        const { scene, safe } = build(t.id, size, params);
        const problems = checkScene(scene, safe).filter(
          (p) => p.includes('safe area') && p.includes('reaches'),
        );
        expect(problems, `${t.id} ${size.width}x${size.height}`).toEqual([]);
      }
  });

  it('draws the brand logo when there is one, and falls back to the name when there is not', () => {
    const withLogo = build('core/logo-card', HD, { text: 'Ember Knight' }, { logo: true });
    expect(renderSvg(withLogo.scene, SEC)).toContain(`<image href="media/${'d'.repeat(64)}.svg"`);
    expect(renderSvg(withLogo.scene, SEC)).not.toContain('<text');
    const without = build('core/logo-card', HD, { text: 'Ember Knight' });
    expect(renderSvg(without.scene, SEC)).toContain('>Ember Knight</tspan>');
    expect(
      renderSvg(
        build('core/end-slate', HD, SAMPLE['core/end-slate'], { logo: true }).scene,
        2 * SEC,
      ),
    ).toContain('<image');
  });

  it('refuses unknown parameters', () => {
    expect(() => build('core/title-card', HD, { text: 'x', colour: 'red' })).toThrow(/title-card/);
    expect(() => build('core/caption', HD, { text: 'x'.repeat(201) })).toThrow();
  });

  it('survives items shorter than their animations', () => {
    for (const t of builtinTemplates) {
      const { scene } = build(t.id, HD, SAMPLE[t.id], { duration: Math.round(0.2 * SEC) });
      for (const at of [0, 1000, Math.round(0.1 * SEC), Math.round(0.2 * SEC)])
        expect(renderSvg(scene, at), t.id).not.toMatch(/NaN|Infinity/);
    }
  });
});
