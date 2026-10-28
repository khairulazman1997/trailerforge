import { z } from 'zod';
import type { GraphicTemplate, Layer, TemplateContext } from '../template.js';
import { SEC, fade, grow, rule, scene, stack } from './common.js';

/**
 * Full-frame cards. Every card takes the storyboard slot's text as `text` (the consumer passes
 * `{ text: slot.text, ...slot.params }`), draws on the brand background in the brand colours and
 * fonts, and animates in and out. Ids follow the storyboard's `core/<cardKind>-card` convention.
 */

const Text = z.string().max(200);
const Optional = Text.optional();

type Params = Record<string, unknown>;

function card<P extends Params>(def: {
  id: string;
  name: string;
  serves: string[];
  params: z.ZodType<P>;
  seconds?: [number, number];
  build: (ctx: TemplateContext<P>) => Layer[];
}): GraphicTemplate<P> {
  const [dflt, min] = def.seconds ?? [3, 1.5];
  return {
    id: def.id,
    name: def.name,
    kind: 'card',
    serves: def.serves,
    params: def.params,
    duration: { default: Math.round(dflt * SEC), min: Math.round(min * SEC) },
    build: (ctx) => scene(ctx as TemplateContext<unknown>, def.build(ctx)),
  };
}

const sz = (ctx: TemplateContext<unknown>) => ctx.brand.sizes;
const col = (ctx: TemplateContext<unknown>) => ctx.brand.colors;

/** The text stack plus a rule between the main text and what follows, placed under the main text. */
/** Space between stacked lines, as a share of the frame height. */
const GAP = 0.06;

function titled(
  ctx: TemplateContext<unknown>,
  main: { text: string; size: number; uppercase?: boolean },
  rest: { id: string; text: string; size: number; color: string; weight?: 'heading' | 'body' }[],
  withRule = true,
): Layer[] {
  const c = col(ctx);
  const layers: Layer[] = stack(
    ctx,
    ctx.safe,
    [
      {
        id: 'text',
        text: main.text,
        size: main.size,
        weight: 'heading',
        color: c.text,
        maxLines: 3,
        ...(main.uppercase ? { uppercase: true, letterSpacing: main.size * 0.04 } : {}),
      },
      ...rest.map((r, i) => ({
        id: r.id,
        text: r.text,
        size: r.size,
        weight: r.weight ?? ('body' as const),
        color: r.color,
        maxLines: 2,
        delay: 0.25 + 0.15 * i,
      })),
    ],
    'middle',
    GAP,
  );
  const first = layers.find((l) => l.id === 'text');
  if (withRule && first?.kind === 'text') {
    const w = Math.min(ctx.safe.w * 0.4, first.layout.bounds.w || ctx.safe.w * 0.4);
    layers.push(
      rule(
        ctx,
        'rule',
        ctx.safe.x + (ctx.safe.w - w) / 2,
        first.layout.bounds.y + first.layout.bounds.h + (GAP * ctx.size.height) / 2,
        w,
        c.primary,
      ),
    );
  }
  return layers;
}

export const titleCard = card({
  id: 'core/title-card',
  name: 'Title card',
  serves: ['title'],
  params: z.strictObject({
    text: Text.default('Game title'),
    subtitle: Optional,
    uppercase: z.boolean().default(false),
  }),
  seconds: [3, 1.5],
  build: (ctx) => {
    const p = ctx.params;
    const layers = titled(ctx, { text: p.text, size: sz(ctx).title, uppercase: p.uppercase }, [
      { id: 'subtitle', text: p.subtitle ?? '', size: sz(ctx).body, color: col(ctx).accent },
    ]);
    return layers.map((l) =>
      l.id === 'text'
        ? { ...l, animation: { ...l.animation, scale: grow(ctx.duration, 0.94) } }
        : l,
    );
  },
});

export const taglineCard = card({
  id: 'core/tagline-card',
  name: 'Tagline',
  serves: ['tagline'],
  params: z.strictObject({
    text: Text.default('Your tagline here'),
    uppercase: z.boolean().default(false),
  }),
  build: (ctx) =>
    titled(
      ctx,
      { text: ctx.params.text, size: sz(ctx).heading, uppercase: ctx.params.uppercase },
      [],
      true,
    ),
});

export const dateCard = card({
  id: 'core/date-card',
  name: 'Release date',
  serves: ['date'],
  params: z.strictObject({
    text: Text.default('Coming 2027'),
    label: Optional,
    platforms: Optional,
  }),
  build: (ctx) => {
    const p = ctx.params;
    const layers: Layer[] = stack(ctx, ctx.safe, [
      {
        id: 'label',
        text: p.label ?? '',
        size: sz(ctx).body,
        weight: 'body',
        color: col(ctx).accent,
        uppercase: true,
        letterSpacing: sz(ctx).body * 0.12,
      },
      {
        id: 'text',
        text: p.text,
        size: sz(ctx).title * 0.8,
        weight: 'heading',
        color: col(ctx).text,
        maxLines: 2,
        delay: 0.1,
      },
      {
        id: 'platforms',
        text: p.platforms ?? '',
        size: sz(ctx).body,
        weight: 'body',
        color: col(ctx).text,
        delay: 0.35,
      },
    ]);
    return layers;
  },
});

export const laurelsCard = card({
  id: 'core/laurels-card',
  name: 'Awards and scores',
  serves: ['laurels'],
  params: z.strictObject({
    text: Text.default('Best Indie Game'),
    source: Optional,
    score: Optional,
  }),
  build: (ctx) => {
    const p = ctx.params;
    const c = col(ctx);
    const text = stack(ctx, ctx.safe, [
      {
        id: 'score',
        text: p.score ?? '',
        size: sz(ctx).title,
        weight: 'heading',
        color: c.primary,
      },
      {
        id: 'text',
        text: p.text,
        size: sz(ctx).heading,
        weight: 'heading',
        color: c.text,
        maxLines: 3,
        delay: 0.1,
      },
      {
        id: 'source',
        text: p.source ?? '',
        size: sz(ctx).body,
        weight: 'body',
        color: c.accent,
        delay: 0.3,
      },
    ]);
    const layers: Layer[] = [];
    const top = text[0];
    const bottom = text[text.length - 1];
    if (top && bottom) {
      const barW = Math.min(ctx.safe.w * 0.5, ctx.size.width * 0.4);
      const x = ctx.safe.x + (ctx.safe.w - barW) / 2;
      layers.push(
        rule(
          ctx,
          'rule-top',
          x,
          Math.max(ctx.safe.y, top.layout.bounds.y - sz(ctx).body * 0.9),
          barW,
          c.primary,
          0,
        ),
      );
      layers.push(
        rule(
          ctx,
          'rule-bottom',
          x,
          Math.min(
            ctx.safe.y + ctx.safe.h,
            bottom.layout.bounds.y + bottom.layout.bounds.h + sz(ctx).body * 0.6,
          ),
          barW,
          c.primary,
          0.1,
        ),
      );
    }
    return [...layers, ...text];
  },
});

export const quoteCard = card({
  id: 'core/quote-card',
  name: 'Press quote',
  serves: ['quote'],
  params: z.strictObject({ text: Text.default('A masterpiece.'), source: Optional }),
  seconds: [4, 2],
  build: (ctx) => {
    const p = ctx.params;
    const c = col(ctx);
    const text = stack(
      ctx,
      { ...ctx.safe, x: ctx.safe.x + ctx.safe.w * 0.06, w: ctx.safe.w * 0.94 },
      [
        {
          id: 'text',
          text: p.text,
          size: sz(ctx).heading,
          weight: 'heading',
          color: c.text,
          maxLines: 5,
        },
        {
          id: 'source',
          text: p.source ? `— ${p.source}` : '',
          size: sz(ctx).body,
          weight: 'body',
          color: c.accent,
          delay: 0.3,
        },
      ],
      'start',
    );
    const first = text[0];
    const last = text[text.length - 1];
    const bar: Layer[] =
      first && last
        ? [
            {
              id: 'bar',
              kind: 'rect',
              box: {
                x: ctx.safe.x,
                y: first.layout.bounds.y,
                w: Math.max(4, ctx.size.height * 0.008),
                h: last.layout.bounds.y + last.layout.bounds.h - first.layout.bounds.y,
              },
              fill: c.primary,
              animation: { opacity: fade(ctx.duration), reveal: 1 },
            },
          ]
        : [];
    return [...bar, ...text];
  },
});

export const logoCard = card({
  id: 'core/logo-card',
  name: 'Logo reveal',
  serves: ['logo'],
  params: z.strictObject({ text: Optional }),
  seconds: [2.5, 1.5],
  build: (ctx) => {
    if (!ctx.brand.logo) {
      // No logo in the brand kit: show the name in the heading font.
      return stack(ctx, ctx.safe, [
        {
          id: 'text',
          text: ctx.params.text || 'Logo',
          size: sz(ctx).title,
          weight: 'heading',
          color: col(ctx).text,
          maxLines: 3,
        },
      ]).map((l) => ({ ...l, animation: { ...l.animation, scale: grow(ctx.duration, 0.9) } }));
    }
    const w = ctx.safe.w * 0.7;
    const h = ctx.safe.h * 0.5;
    return [
      {
        id: 'logo',
        kind: 'image',
        href: ctx.brand.logo.href,
        box: { x: ctx.safe.x + (ctx.safe.w - w) / 2, y: ctx.safe.y + (ctx.safe.h - h) / 2, w, h },
        animation: { opacity: fade(ctx.duration), scale: grow(ctx.duration, 0.9) },
      },
    ];
  },
});

export const ctaCard = card({
  id: 'core/cta-card',
  name: 'Call to action',
  serves: ['cta'],
  params: z.strictObject({ text: Text.default('Wishlist now'), detail: Optional }),
  seconds: [3, 1.5],
  build: (ctx) =>
    titled(ctx, { text: ctx.params.text, size: sz(ctx).title * 0.85 }, [
      {
        id: 'detail',
        text: ctx.params.detail ?? '',
        size: sz(ctx).heading * 0.8,
        color: col(ctx).accent,
        weight: 'heading',
      },
    ]),
});

export const endSlate = card({
  id: 'core/end-slate',
  name: 'End slate',
  serves: ['end-slate', 'cta'],
  params: z.strictObject({ text: Text.default('Game title'), cta: Optional, detail: Optional }),
  seconds: [4, 2],
  build: (ctx) => {
    const p = ctx.params;
    const c = col(ctx);
    const layers: Layer[] = [];
    const logoH = ctx.brand.logo ? ctx.safe.h * 0.28 : 0;
    const area = {
      ...ctx.safe,
      y: ctx.safe.y + (logoH ? logoH + ctx.safe.h * 0.04 : 0),
      h: ctx.safe.h - (logoH ? logoH + ctx.safe.h * 0.04 : 0),
    };
    if (ctx.brand.logo) {
      const w = ctx.safe.w * 0.5;
      layers.push({
        id: 'logo',
        kind: 'image',
        href: ctx.brand.logo.href,
        box: { x: ctx.safe.x + (ctx.safe.w - w) / 2, y: ctx.safe.y, w, h: logoH },
        animation: { opacity: fade(ctx.duration), scale: grow(ctx.duration, 0.92) },
      });
    }
    layers.push(
      ...stack(ctx, area, [
        {
          id: 'text',
          text: p.text,
          size: sz(ctx).heading,
          weight: 'heading',
          color: c.text,
          maxLines: 2,
        },
        {
          id: 'cta',
          text: p.cta ?? '',
          size: sz(ctx).heading * 0.8,
          weight: 'heading',
          color: c.primary,
          delay: 0.2,
        },
        {
          id: 'detail',
          text: p.detail ?? '',
          size: sz(ctx).body,
          weight: 'body',
          color: c.accent,
          maxLines: 3,
          delay: 0.4,
        },
      ]),
    );
    return layers;
  },
});

export const customCard = card({
  id: 'core/custom-card',
  name: 'Custom card',
  serves: ['custom'],
  params: z.strictObject({ text: Text.default('Your text'), subtitle: Optional }),
  build: (ctx) =>
    titled(ctx, { text: ctx.params.text, size: sz(ctx).heading }, [
      {
        id: 'subtitle',
        text: ctx.params.subtitle ?? '',
        size: sz(ctx).body,
        color: col(ctx).accent,
      },
    ]),
});

export const cardTemplates = [
  titleCard,
  taglineCard,
  dateCard,
  laurelsCard,
  quoteCard,
  logoCard,
  ctaCard,
  endSlate,
  customCard,
] as unknown as readonly GraphicTemplate<unknown>[];
