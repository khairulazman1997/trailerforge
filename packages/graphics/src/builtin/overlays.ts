import { z } from 'zod';
import type { GraphicTemplate, Layer, TemplateContext } from '../template.js';
import { SEC, fade, rise, scene, stack, wipe } from './common.js';

/**
 * Overlays drawn over the picture, on a transparent background: the name label (lower third)
 * and the caption box. Text stays inside the safe area; the box behind a caption is the brand
 * background at 75%, so it reads over any footage.
 */

const Text = z.string().max(200);

/** The brand background behind text, as a semi-opaque layer fading with the text. */
function plate(
  ctx: TemplateContext<unknown>,
  id: string,
  box: { x: number; y: number; w: number; h: number },
  peak = 0.75,
): Layer {
  return {
    id,
    kind: 'rect',
    box,
    fill: ctx.brand.colors.background,
    radius: ctx.size.height * 0.008,
    animation: { opacity: fade(ctx.duration, peak) },
  };
}

export const lowerThird: GraphicTemplate<{ text: string; role?: string | undefined }> = {
  id: 'core/lower-third',
  name: 'Name label',
  kind: 'overlay',
  serves: ['name'],
  params: z.strictObject({ text: Text.default('Name'), role: Text.optional() }),
  duration: { default: 3 * SEC, min: Math.round(1.5 * SEC) },
  build: (ctx) => {
    const c = ctx.brand.colors;
    const s = ctx.brand.sizes;
    const width = ctx.safe.w * (ctx.size.width > ctx.size.height * 1.2 ? 0.5 : 0.9);
    const bandH = (ctx.params.role ? s.heading + s.body : s.heading) * 1.9;
    const x = ctx.safe.x;
    const y = ctx.safe.y + ctx.safe.h - bandH;
    const pad = s.body * 0.6;
    const inner = {
      x: x + pad * 1.6,
      y: y + pad * 0.4,
      w: width - pad * 2.4,
      h: bandH - pad * 0.8,
    };
    const text = stack(
      ctx as TemplateContext<unknown>,
      inner,
      [
        {
          id: 'text',
          text: ctx.params.text,
          size: s.heading * 0.85,
          weight: 'heading',
          color: c.text,
          maxLines: 1,
        },
        {
          id: 'role',
          text: ctx.params.role ?? '',
          size: s.body * 0.9,
          weight: 'body',
          color: c.accent,
          maxLines: 1,
          delay: 0.1,
        },
      ],
      'start',
      0.008,
    );
    const slide = (l: Layer): Layer => ({
      ...l,
      animation: { ...l.animation, translate: rise(ctx.duration, 0) },
    });
    return scene(
      ctx as TemplateContext<unknown>,
      [
        plate(ctx as TemplateContext<unknown>, 'plate', { x, y, w: width, h: bandH }),
        {
          id: 'accent',
          kind: 'rect',
          box: { x, y, w: Math.max(5, ctx.size.height * 0.007), h: bandH },
          fill: c.primary,
          animation: { reveal: wipe(ctx.duration), opacity: fade(ctx.duration) },
        },
        ...text.map(slide),
      ],
      true,
    );
  },
};

export const caption: GraphicTemplate<{ text: string }> = {
  id: 'core/caption',
  name: 'Caption box',
  kind: 'overlay',
  serves: ['caption'],
  params: z.strictObject({ text: Text.default('Caption') }),
  duration: { default: 2.5 * SEC, min: SEC },
  build: (ctx) => {
    const s = ctx.brand.sizes;
    const c = ctx.brand.colors;
    const bandH = s.caption * 3.2;
    const w = ctx.safe.w * (ctx.size.width > ctx.size.height * 1.2 ? 0.7 : 0.95);
    const x = ctx.safe.x + (ctx.safe.w - w) / 2;
    const y = ctx.safe.y + ctx.safe.h - bandH;
    const text = stack(
      ctx as TemplateContext<unknown>,
      {
        x: x + s.caption,
        y: y + s.caption * 0.3,
        w: w - s.caption * 2,
        h: bandH - s.caption * 0.6,
      },
      [
        {
          id: 'text',
          text: ctx.params.text,
          size: s.caption,
          weight: 'body',
          color: c.text,
          maxLines: 2,
        },
      ],
    );
    // Fit the plate to the text rather than the whole band.
    const t = text[0];
    const plateBox = t
      ? {
          x: Math.max(ctx.safe.x, t.layout.bounds.x - s.caption),
          y: t.layout.bounds.y - s.caption * 0.4,
          w: Math.min(ctx.safe.w, t.layout.bounds.w + s.caption * 2),
          h: t.layout.bounds.h + s.caption * 0.8,
        }
      : { x, y, w, h: bandH };
    return scene(
      ctx as TemplateContext<unknown>,
      [plate(ctx as TemplateContext<unknown>, 'plate', plateBox), ...text],
      true,
    );
  },
};

export const overlayTemplates = [
  lowerThird,
  caption,
] as unknown as readonly GraphicTemplate<unknown>[];
