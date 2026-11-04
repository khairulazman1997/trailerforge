import { z } from 'zod';
import type { GraphicTemplate, Layer, TextLayer } from '../template.js';
import { layoutText } from '../text.js';
import { SEC } from './common.js';

/**
 * The title on a TikTok's cover frame: a few big words on a brand-coloured plate, centred in the
 * safe area (a short's safe area keeps it clear of the app's buttons) and high enough to survive
 * the 3:4 crop of a profile grid. Used once, as a still, over the frame the user picked.
 */
export const coverTitle: GraphicTemplate<{ text: string }> = {
  id: 'core/cover-title',
  name: 'Cover title',
  kind: 'overlay',
  serves: ['cover'],
  params: z.strictObject({ text: z.string().max(60).default('') }),
  duration: { default: SEC, min: Math.round(0.2 * SEC) },
  build: (ctx) => {
    const size = ctx.brand.sizes.title;
    const pad = size * 0.5;
    const h = size * 1.15 * 3 + pad;
    const box = {
      x: ctx.safe.x + pad,
      y: ctx.safe.y + ctx.safe.h * 0.34 - h / 2,
      w: ctx.safe.w - pad * 2,
      h,
    };
    const font = ctx.brand.fonts.heading;
    const layout = layoutText({
      text: ctx.params.text,
      box,
      font,
      size,
      lineHeight: 1.15,
      maxLines: 3,
      align: 'middle',
      valign: 'middle',
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
    const b = layout.bounds;
    const layers: Layer[] = ctx.params.text.trim()
      ? [
          {
            id: 'plate',
            kind: 'rect',
            box: {
              x: Math.max(ctx.safe.x, b.x - pad),
              y: b.y - pad * 0.6,
              w: Math.min(ctx.safe.w, b.w + pad * 2),
              h: b.h + pad * 1.2,
            },
            fill: ctx.brand.colors.background,
            radius: ctx.size.height * 0.012,
            animation: { opacity: 0.78 },
          },
          text,
        ]
      : [];
    return { size: ctx.size, duration: ctx.duration, layers, warnings: [...layout.warnings] };
  },
};

export const coverTemplates = [coverTitle] as unknown as readonly GraphicTemplate<unknown>[];
