import { z } from 'zod';
import type { GraphicTemplate, Layer, TemplateContext, TextLayer } from '../template.js';
import { approxMeasure, layoutText, type Box, type TextLayout } from '../text.js';
import { SEC } from './common.js';

/**
 * Subtitles for spoken words. They cut on and off with the voice (no fades: they follow the
 * words to the frame), sit at the bottom of the safe area (a short's safe area keeps them clear
 * of the app's interface) and read over any picture on a brand-coloured plate.
 *
 * - `core/subtitle-line`: the sentence, up to two lines.
 * - `core/word-caption`: a few big words, the one being said highlighted and popping in.
 */

function plateFor(ctx: TemplateContext<unknown>, text: Box, pad: number, peak: number): Layer {
  return {
    id: 'plate',
    kind: 'rect',
    box: {
      x: Math.max(ctx.safe.x, text.x - pad),
      y: text.y - pad * 0.45,
      w: Math.min(ctx.safe.w, text.w + pad * 2),
      h: text.h + pad * 0.9,
    },
    fill: ctx.brand.colors.background,
    radius: ctx.size.height * 0.008,
    animation: { opacity: peak },
  };
}

export const subtitleLine: GraphicTemplate<{ text: string }> = {
  id: 'core/subtitle-line',
  name: 'Subtitle line',
  kind: 'overlay',
  serves: ['subtitle'],
  params: z.strictObject({ text: z.string().max(200).default('') }),
  duration: { default: 2 * SEC, min: Math.round(0.2 * SEC) },
  build: (ctx) => {
    const size = ctx.brand.sizes.caption * 1.15;
    const pad = size * 0.6;
    const h = size * 1.2 * 2 + pad;
    const box = { x: ctx.safe.x + pad, y: ctx.safe.y + ctx.safe.h - h, w: ctx.safe.w - pad * 2, h };
    const font = ctx.brand.fonts.heading;
    const layout = layoutText({
      text: ctx.params.text,
      box,
      font,
      size,
      lineHeight: 1.2,
      maxLines: 2,
      align: 'middle',
      valign: 'bottom',
      ...(ctx.measure ? { measure: ctx.measure } : {}),
    });
    const text: TextLayer = {
      id: 'text',
      kind: 'text',
      box,
      layout,
      font,
      fill: ctx.brand.colors.text,
      text: ctx.params.text,
    };
    const layers: Layer[] = ctx.params.text.trim()
      ? [plateFor(ctx as TemplateContext<unknown>, layout.bounds, pad, 0.7), text]
      : [];
    return { size: ctx.size, duration: ctx.duration, layers, warnings: [...layout.warnings] };
  },
};

const Word = z.strictObject({
  text: z.string().min(1).max(40),
  /** Flicks from the start of the item. */
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});

export const wordCaption: GraphicTemplate<{ words: z.infer<typeof Word>[] }> = {
  id: 'core/word-caption',
  name: 'Word-by-word caption',
  kind: 'overlay',
  serves: ['subtitle'],
  params: z.strictObject({ words: z.array(Word).max(12).default([]) }),
  duration: { default: SEC, min: Math.round(0.2 * SEC) },
  build: (ctx) => {
    const words = ctx.params.words;
    const size = ctx.brand.sizes.heading * 1.25;
    const pad = size * 0.4;
    const font = ctx.brand.fonts.heading;
    const measure = ctx.measure ?? approxMeasure;
    const h = size * 1.15 * 2 + pad;
    // A little below the middle of the frame, inside the safe area.
    const y = Math.min(ctx.safe.y + ctx.safe.h - h, ctx.size.height * 0.6 - h / 2);
    const box = { x: ctx.safe.x + pad, y: Math.max(ctx.safe.y, y), w: ctx.safe.w - pad * 2, h };
    const all = words.map((w) => w.text).join(' ');
    const layout = layoutText({
      text: all,
      box,
      font,
      size,
      maxLines: 2,
      align: 'middle',
      ...(ctx.measure ? { measure: ctx.measure } : {}),
    });
    const base: TextLayer = { id: 'text', kind: 'text', box, layout, font, fill: ctx.brand.colors.text, text: all }; // prettier-ignore
    const layers: Layer[] = all ? [plateFor(ctx as TemplateContext<unknown>, layout.bounds, pad, 0.55), base] : []; // prettier-ignore
    // The spoken word on top, in the accent colour, where the layout put it.
    let k = 0;
    for (const line of layout.lines) {
      const left = layout.align === 'middle' ? line.x - line.width / 2 : line.x;
      let prefix = '';
      for (const piece of line.text.split(' ')) {
        const w = words[k];
        if (!w || (piece !== w.text && !piece.endsWith('…'))) break;
        k++;
        const x = left + (prefix ? measure(`${prefix} `, layout.size, font) : 0);
        const width = measure(piece, layout.size, font);
        prefix = prefix ? `${prefix} ${piece}` : piece;
        const end = Math.min(ctx.duration, Math.max(w.end, w.start + 1));
        if (w.start >= ctx.duration) continue;
        const one: TextLayout = {
          lines: [{ text: piece, x, y: line.y, width }],
          size: layout.size,
          lineHeight: layout.lineHeight,
          bounds: {
            x,
            y: line.y - layout.size * 0.8,
            w: width,
            h: layout.size * layout.lineHeight,
          },
          align: 'start',
          shrunk: false,
          truncated: false,
          warnings: [],
        };
        const pop = Math.min(Math.round(0.12 * SEC), Math.max(1, end - w.start));
        layers.push({
          id: `word-${k}`,
          kind: 'text',
          box: one.bounds,
          layout: one,
          font,
          fill: ctx.brand.colors.accent,
          text: piece,
          animation: {
            opacity: {
              keyframes: [
                ...(w.start > 0 ? [{ at: 0, value: 0, easing: 'hold' as const }] : []),
                { at: w.start, value: 1, easing: 'hold' as const },
                ...(end < ctx.duration ? [{ at: end, value: 0, easing: 'hold' as const }] : []),
              ],
            },
            scale: {
              keyframes: [
                ...(w.start > 0 ? [{ at: 0, value: 1.15, easing: 'hold' as const }] : []),
                { at: w.start, value: 1.15, easing: 'ease-out' as const },
                { at: w.start + pop, value: 1, easing: 'linear' as const },
              ],
            },
          },
        });
      }
    }
    return { size: ctx.size, duration: ctx.duration, layers, warnings: [...layout.warnings] };
  },
};

export const subtitleTemplates = [
  subtitleLine,
  wordCaption,
] as unknown as readonly GraphicTemplate<unknown>[];
