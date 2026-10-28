import { z } from 'zod';
import { ContentHash } from './common.js';

/**
 * The game's look for trailer graphics: colours, a logo, up to two fonts and a type scale.
 * Files are kept in the project's `media/` folder under their content hash, so the project
 * stays portable and the same file is never stored twice. Everything here is data; the
 * checks (contrast, missing files) are pure functions below.
 */

export const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'colours are #rrggbb')
  .transform((c) => c.toLowerCase());

/** A file kept in `media/<hash>.<ext>`. */
export const BrandFile = z.strictObject({
  hash: ContentHash,
  ext: z.enum(['svg', 'png', 'ttf', 'otf', 'woff2']),
  /** The name it had when imported, for display. */
  name: z.string().min(1).max(200),
});
export type BrandFile = z.infer<typeof BrandFile>;

export const brandFilePath = (f: Pick<BrandFile, 'hash' | 'ext'>) => `media/${f.hash}.${f.ext}`;

export const BrandFont = z.strictObject({
  role: z.enum(['heading', 'body']),
  /** Family name used in the graphics' SVG. */
  family: z.string().min(1).max(100),
  bold: z.boolean().default(false),
  file: BrandFile,
});
export type BrandFont = z.infer<typeof BrandFont>;

/** Text sizes as a share of the frame's shorter side, so they hold at any resolution and aspect ratio. */
export const TypeScale = z.strictObject({
  title: z.number().min(0.02).max(0.5).default(0.12),
  heading: z.number().min(0.02).max(0.5).default(0.07),
  body: z.number().min(0.02).max(0.5).default(0.04),
  caption: z.number().min(0.02).max(0.5).default(0.035),
});
export type TypeScale = z.infer<typeof TypeScale>;

const scaleValue = z.number().min(0.02).max(0.5);
export const TypeScalePatch = z.strictObject({
  title: scaleValue.optional(),
  heading: scaleValue.optional(),
  body: scaleValue.optional(),
  caption: scaleValue.optional(),
});
export type TypeScalePatch = z.infer<typeof TypeScalePatch>;

export const BrandColors = z.strictObject({
  background: HexColor.default('#0b0d12'),
  text: HexColor.default('#f5f6f8'),
  primary: HexColor.default('#ffb020'),
  accent: HexColor.default('#4cc9f0'),
});
export type BrandColors = z.infer<typeof BrandColors>;

/** A change to some colours. (`.partial()` would fill in the defaults of the others.) */
export const BrandColorsPatch = z.strictObject({
  background: HexColor.optional(),
  text: HexColor.optional(),
  primary: HexColor.optional(),
  accent: HexColor.optional(),
});
export type BrandColorsPatch = z.infer<typeof BrandColorsPatch>;

export const Brand = z.strictObject({
  colors: BrandColors.default(BrandColors.parse({})),
  logo: BrandFile.optional(),
  /** At most one font per role (two files in all). */
  fonts: z.array(BrandFont).max(2).default([]),
  typeScale: TypeScale.default(TypeScale.parse({})),
});
export type Brand = z.infer<typeof Brand>;

/** The brand a project has before anyone sets one. */
export const defaultBrand = (): Brand => Brand.parse({});

// -- fallback fonts ----------------------------------------------------------------------------

export interface FallbackFont {
  id: string;
  family: string;
  bold: boolean;
  /** Path under the app's `assets/fonts/`. */
  file: string;
  licence: string;
}

/** Open-licence fonts shipped with the app; used whenever the brand has no usable font. */
export const FALLBACK_FONTS: readonly FallbackFont[] = [
  {
    id: 'inter-regular',
    family: 'Inter',
    bold: false,
    file: 'inter/Inter-Regular.otf',
    licence: 'SIL OFL 1.1',
  },
  {
    id: 'inter-bold',
    family: 'Inter',
    bold: true,
    file: 'inter/Inter-Bold.otf',
    licence: 'SIL OFL 1.1',
  },
];

export type FontChoice =
  | { source: 'brand'; role: BrandFont['role']; family: string; bold: boolean; file: BrandFile }
  | { source: 'fallback'; role: BrandFont['role']; fallback: FallbackFont };

export interface BrandFontResolution {
  heading: FontChoice;
  body: FontChoice;
  warnings: string[];
}

/**
 * Which font each role uses. A brand font whose file is not in the project falls back to the
 * shipped one, with a warning. `present` is the set of `<hash>.<ext>` names in `media/`.
 */
export function resolveBrandFonts(
  brand: Brand | null | undefined,
  present: ReadonlySet<string>,
): BrandFontResolution {
  const warnings: string[] = [];
  const pick = (role: BrandFont['role']): FontChoice => {
    const font = brand?.fonts.find((f) => f.role === role);
    if (font) {
      if (present.has(`${font.file.hash}.${font.file.ext}`))
        return { source: 'brand', role, family: font.family, bold: font.bold, file: font.file };
      warnings.push(
        `The ${role} font "${font.family}" (${font.file.name}) is missing from the project's media; using ${role === 'heading' ? 'Inter Bold' : 'Inter'} instead.`,
      );
    }
    const wantBold = role === 'heading';
    return {
      source: 'fallback',
      role,
      fallback: FALLBACK_FONTS.find((f) => f.bold === wantBold)!,
    };
  };
  return { heading: pick('heading'), body: pick('body'), warnings };
}

// -- contrast ----------------------------------------------------------------------------------

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA: 4.5 for body text, 3 for large text (titles, and the primary and accent colours). */
export const CONTRAST_AA = { text: 4.5, large: 3 } as const;

export interface ContrastIssue {
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  message: string;
}

/** Colour pairs below WCAG AA. Ratios are shown rounded down to one decimal. */
export function checkBrandContrast(colors: BrandColors): ContrastIssue[] {
  const pairs: [string, keyof BrandColors, number][] = [
    ['text on background', 'text', CONTRAST_AA.text],
    ['primary on background', 'primary', CONTRAST_AA.large],
    ['accent on background', 'accent', CONTRAST_AA.large],
  ];
  const out: ContrastIssue[] = [];
  for (const [pair, fg, required] of pairs) {
    const raw = contrastRatio(colors[fg], colors.background);
    // Shown rounded down: 4.48 must not read as the 4.5 it falls short of.
    const ratio = Math.floor(raw * 10) / 10;
    if (raw < required)
      out.push({
        pair,
        foreground: colors[fg],
        background: colors.background,
        ratio,
        required,
        message: `The ${pair} contrast is ${ratio}:1; WCAG AA needs ${required}:1, so it may be hard to read.`,
      });
  }
  return out;
}

/** Everything worth telling the user about a brand kit. */
export function brandWarnings(
  brand: Brand | null | undefined,
  present: ReadonlySet<string>,
): string[] {
  if (!brand) return [];
  const w = checkBrandContrast(brand.colors).map((i) => i.message);
  w.push(...resolveBrandFonts(brand, present).warnings);
  if (brand.logo && !present.has(`${brand.logo.hash}.${brand.logo.ext}`))
    w.push(`The logo (${brand.logo.name}) is missing from the project's media.`);
  return w;
}
