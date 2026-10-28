/**
 * Text layout for graphics: fit a string into a box (the frame's safe area or part of it) by
 * wrapping at spaces, then shrinking down to a minimum size, then breaking long words, and only
 * as a last resort shortening it with an ellipsis. The result never leaves the box; when the
 * text had to be shrunk past its preferred size or shortened, a warning says why.
 *
 * Widths come from a `Measure` so the renderer can use real font metrics; `approxMeasure` is a
 * deterministic stand-in good enough for layout decisions and tests.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FontSpec {
  family: string;
  weight: number;
}

/** Width in pixels of `text` at `size` px. */
export type Measure = (text: string, size: number, font: FontSpec) => number;

/** Average advance widths (em) for a typical sans: narrow, wide and everything else. */
const NARROW = new Set("iIl.,:;'!|`".split(''));
const SEMI = new Set('fjrt()[]-"/ '.split(''));
const WIDE = new Set('mwMW@%'.split(''));
export const approxMeasure: Measure = (text, size, font) => {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.28;
    else if (SEMI.has(ch)) em += 0.36;
    else if (WIDE.has(ch)) em += 0.86;
    else if (ch >= 'A' && ch <= 'Z') em += 0.66;
    else em += 0.56;
  }
  return em * size * (font.weight >= 600 ? 1.05 : 1);
};

export interface TextLayoutInput {
  text: string;
  box: Box;
  font: FontSpec;
  /** Preferred size, px. */
  size: number;
  /** Smallest acceptable size, px (default 60% of `size`). */
  minSize?: number;
  /** Line height as a multiple of the size (default 1.15). */
  lineHeight?: number;
  maxLines?: number;
  align?: 'start' | 'middle' | 'end';
  /** Where the block sits vertically in the box (default middle). */
  valign?: 'top' | 'middle' | 'bottom';
  uppercase?: boolean;
  measure?: Measure;
}

export interface TextLine {
  text: string;
  /** Anchor x (depends on `align`) and baseline y, px. */
  x: number;
  y: number;
  width: number;
}

export interface TextLayout {
  lines: TextLine[];
  size: number;
  lineHeight: number;
  /** The block's bounds, px; always inside the box. */
  bounds: Box;
  align: 'start' | 'middle' | 'end';
  shrunk: boolean;
  truncated: boolean;
  warnings: string[];
}

/** Baseline sits this far (of the size) below the line's top; descenders fit in the rest. */
const ASCENT = 0.8;

function wrap(words: string[], width: number, size: number, font: FontSpec, m: Measure): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || m(next, size, font) <= width) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Break words wider than `width` into pieces that fit. */
function breakLong(words: string[], width: number, size: number, font: FontSpec, m: Measure) {
  const out: string[] = [];
  for (const w of words) {
    if (m(w, size, font) <= width) {
      out.push(w);
      continue;
    }
    let piece = '';
    for (const ch of w) {
      if (piece && m(piece + ch, size, font) > width) {
        out.push(piece);
        piece = ch;
      } else piece += ch;
    }
    if (piece) out.push(piece);
  }
  return out;
}

export function layoutText(input: TextLayoutInput): TextLayout {
  const m = input.measure ?? approxMeasure;
  const { box, font } = input;
  const lh = input.lineHeight ?? 1.15;
  const align = input.align ?? 'middle';
  const raw = (input.uppercase ? input.text.toUpperCase() : input.text).trim().replace(/\s+/g, ' ');
  const words = raw ? raw.split(' ') : [];
  const minSize = Math.max(1, Math.min(input.size, input.minSize ?? input.size * 0.6));
  const maxLines = Math.max(1, input.maxLines ?? Infinity);
  const warnings: string[] = [];

  const linesFit = (lines: string[], size: number) =>
    lines.length <= maxLines &&
    lines.length * size * lh <= box.h + 1e-9 &&
    lines.every((l) => m(l, size, font) <= box.w + 1e-9);

  // Largest size from preferred down to minimum (5% steps) where the wrapped text fits.
  let size = input.size;
  let lines = wrap(words, box.w, size, font, m);
  while (!linesFit(lines, size) && size > minSize) {
    size = Math.max(minSize, Math.round(size * 0.95 * 100) / 100);
    lines = wrap(words, box.w, size, font, m);
  }
  let truncated = false;
  if (!linesFit(lines, size)) {
    lines = wrap(breakLong(words, box.w, size, font, m), box.w, size, font, m);
    // A single letter wider than the box: nothing fits.
    const tooNarrow = lines.some((l) => m(l, size, font) > box.w + 1e-9);
    const room = tooNarrow
      ? 0
      : Math.max(0, Math.min(maxLines, Math.floor((box.h + 1e-9) / (size * lh))));
    if (lines.length > room) {
      truncated = true;
      lines = lines.slice(0, room);
      if (lines.length) {
        let lastLine = lines[lines.length - 1]!;
        while (lastLine && m(`${lastLine}…`, size, font) > box.w)
          lastLine = lastLine.slice(0, -1).trimEnd();
        lines[lines.length - 1] = `${lastLine}…`;
      }
    }
  }
  const shrunk = size < input.size;
  if (shrunk && !truncated)
    warnings.push(
      `"${short(raw)}" was set smaller (${round(size)} px instead of ${round(input.size)} px) to fit the safe area`,
    );
  if (truncated)
    warnings.push(
      lines.length
        ? `"${short(raw)}" does not fit the safe area even at ${round(size)} px, so it was shortened; use fewer words`
        : `"${short(raw)}" does not fit: the space for it is smaller than one line or one letter`,
    );

  const blockH = lines.length * size * lh;
  const top =
    input.valign === 'top'
      ? box.y
      : input.valign === 'bottom'
        ? box.y + box.h - blockH
        : box.y + (box.h - blockH) / 2;
  const ax = align === 'start' ? box.x : align === 'end' ? box.x + box.w : box.x + box.w / 2;
  const out = lines.map((text, i) => ({
    text,
    x: round(ax),
    y: round(top + i * size * lh + size * ASCENT + ((lh - 1) * size) / 2),
    width: round(m(text, size, font)),
  }));
  const widest = Math.max(0, ...out.map((l) => l.width));
  const bx =
    align === 'start'
      ? box.x
      : align === 'end'
        ? box.x + box.w - widest
        : box.x + (box.w - widest) / 2;
  return {
    lines: out,
    size: round(size),
    lineHeight: lh,
    bounds: { x: round(bx), y: round(top), w: widest, h: round(blockH) },
    align,
    shrunk,
    truncated,
    warnings,
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}…` : s);

// -- read time -----------------------------------------------------------------------------------

/** Seconds a viewer needs to read `text` on screen: 0.6 s to notice it, plus 0.33 s a word (180 wpm), at least 1 s. */
export function minReadSeconds(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (!words) return 0;
  return Math.max(1, Math.round((0.6 + words / 3) * 100) / 100);
}

/** A warning when `text` is on screen for less than its read time, else null. */
export function readTimeWarning(text: string, onScreenSeconds: number): string | null {
  const need = minReadSeconds(text);
  if (onScreenSeconds + 1e-9 >= need) return null;
  return `"${short(text.trim())}" is on screen for ${round(onScreenSeconds)} s; reading it takes about ${need} s`;
}
