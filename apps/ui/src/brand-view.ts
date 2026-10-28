import { CONTRAST_AA, contrastRatio, type BrandColors } from '@trailerforge/schema';

export const COLOR_FIELDS = [
  { key: 'background', label: 'Background' },
  { key: 'text', label: 'Text' },
  { key: 'primary', label: 'Main accent' },
  { key: 'accent', label: 'Second accent' },
] as const satisfies readonly { key: keyof BrandColors; label: string }[];

export const SCALE_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'heading', label: 'Heading' },
  { key: 'body', label: 'Body' },
  { key: 'caption', label: 'Caption' },
] as const;

/** `#abc`, `abc` or `#AABBCC` as `#aabbcc`; null when it is not a colour. */
export function normalizeHex(text: string): string | null {
  const t = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) return `#${[...t].map((c) => c + c).join('')}`;
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null;
}

export interface ContrastRow {
  label: string;
  ratio: number;
  required: number;
  pass: boolean;
}

/** Each colour against the background with the WCAG AA threshold it needs (ratio rounded down). */
export function contrastRows(colors: BrandColors): ContrastRow[] {
  const rows: [string, keyof BrandColors, number][] = [
    ['Text on background', 'text', CONTRAST_AA.text],
    ['Main accent on background', 'primary', CONTRAST_AA.large],
    ['Second accent on background', 'accent', CONTRAST_AA.large],
  ];
  return rows.map(([label, key, required]) => {
    const raw = contrastRatio(colors[key], colors.background);
    return { label, ratio: Math.floor(raw * 10) / 10, required, pass: raw >= required };
  });
}

/** A share of the frame's shorter side as a percentage with at most one decimal. */
export const toPercent = (share: number): string => String(Math.round(share * 1000) / 10);

/** A percentage typed by the user as a share (2–50 %), or null. */
export function fromPercent(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 2 && n <= 50 ? Math.round(n * 10) / 1000 : null;
}
