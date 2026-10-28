import { describe, expect, it } from 'vitest';
import {
  Brand,
  FALLBACK_FONTS,
  Project,
  brandWarnings,
  checkBrandContrast,
  contrastRatio,
  defaultBrand,
  resolveBrandFonts,
} from './index.js';
import { sampleProject } from './fixtures.js';

const hash = 'a'.repeat(64);
const file = (ext: 'otf' | 'svg', name = 'f') => ({ hash, ext, name });

describe('brand kit', () => {
  it('round-trips through the project and defaults to none', () => {
    expect(Project.parse(sampleProject()).brand).toBeNull();
    const brand = Brand.parse({
      colors: { primary: '#FF0000' },
      logo: file('svg', 'logo.svg'),
      fonts: [{ role: 'heading', family: 'Bebas', bold: true, file: file('otf', 'bebas.otf') }],
      typeScale: { title: 0.15 },
    });
    expect(brand.colors.primary).toBe('#ff0000'); // lower-cased
    expect(brand.typeScale).toEqual({ title: 0.15, heading: 0.07, body: 0.04, caption: 0.035 });
    const p = Project.parse({ ...sampleProject(), brand });
    expect(Project.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(Brand.safeParse({ colors: { text: 'red' } }).success).toBe(false);
    expect(
      Brand.safeParse({
        fonts: [1, 2, 3].map(() => ({ role: 'body', family: 'x', file: file('otf') })),
      }).success,
    ).toBe(false);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('flags colour pairs below AA and passes the defaults', () => {
    expect(checkBrandContrast(defaultBrand().colors)).toEqual([]);
    const bad = checkBrandContrast({
      ...defaultBrand().colors,
      text: '#777777',
      background: '#ffffff',
      primary: '#eeeeee',
      accent: '#000000',
    });
    expect(bad.map((i) => i.pair)).toEqual(['text on background', 'primary on background']);
    expect(bad[0]).toMatchObject({ ratio: 4.4, required: 4.5 });
    expect(bad[0]!.message).toMatch(/WCAG AA needs 4.5:1/);
  });

  it('falls back to the shipped fonts, with a warning when a brand font file is missing', () => {
    expect(FALLBACK_FONTS.map((f) => f.id)).toEqual(['inter-regular', 'inter-bold']);
    const none = resolveBrandFonts(null, new Set());
    expect(none.warnings).toEqual([]);
    expect(none.heading).toMatchObject({ source: 'fallback', fallback: { id: 'inter-bold' } });
    expect(none.body).toMatchObject({ source: 'fallback', fallback: { id: 'inter-regular' } });

    const brand = Brand.parse({
      fonts: [{ role: 'heading', family: 'Bebas', bold: true, file: file('otf', 'bebas.otf') }],
    });
    const missing = resolveBrandFonts(brand, new Set());
    expect(missing.heading.source).toBe('fallback');
    expect(missing.warnings).toEqual([
      'The heading font "Bebas" (bebas.otf) is missing from the project\'s media; using Inter Bold instead.',
    ]);
    const ok = resolveBrandFonts(brand, new Set([`${hash}.otf`]));
    expect(ok.heading).toMatchObject({ source: 'brand', family: 'Bebas', bold: true });
    expect(ok.warnings).toEqual([]);
  });

  it('reports a missing logo too', () => {
    const brand = Brand.parse({ logo: file('svg', 'logo.svg') });
    expect(brandWarnings(brand, new Set())).toEqual([
      "The logo (logo.svg) is missing from the project's media.",
    ]);
    expect(brandWarnings(brand, new Set([`${hash}.svg`]))).toEqual([]);
    expect(brandWarnings(null, new Set())).toEqual([]);
  });
});
