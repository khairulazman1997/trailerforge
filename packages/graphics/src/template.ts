import {
  FALLBACK_FONTS,
  defaultBrand,
  type Animatable,
  type Brand,
  type BrandFontResolution,
  type Resolution,
} from '@trailerforge/schema';
import type { z } from 'zod';
import { evaluateNumber, evaluateVector } from './evaluate.js';
import { readTimeWarning, type Box, type FontSpec, type Measure, type TextLayout } from './text.js';

/**
 * The graphics template contract. A template turns its parameters, the brand kit and the frame
 * size into a scene: layers (text, shapes, images) with animation tracks. `renderSvg` draws a
 * scene at any frame as SVG; the renderer rasterizes that SVG (M5.6) and the browser preview
 * shows it, so both draw the same thing. Templates are plugins registered by id; the LLM may
 * only pick ids from the installed set.
 */

/** Fractions of the frame kept clear at each edge (title-safe is 0.1 all round). */
export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const TITLE_SAFE: SafeInsets = { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 };

export function safeBox(size: Resolution, safe: SafeInsets = TITLE_SAFE): Box {
  return {
    x: size.width * safe.left,
    y: size.height * safe.top,
    w: size.width * (1 - safe.left - safe.right),
    h: size.height * (1 - safe.top - safe.bottom),
  };
}

/** What a template may use from the brand kit. */
export interface BrandTokens {
  colors: Brand['colors'];
  fonts: { heading: FontSpec; body: FontSpec };
  /** Text sizes in px for this frame (a share of its shorter side). */
  sizes: { title: number; heading: number; body: number; caption: number };
  /** `media/<hash>.<ext>` of the logo, if it is in the project. */
  logo?: { href: string; ext: 'svg' | 'png' };
}

/** Brand tokens for a frame size; fonts as `resolveBrandFonts` chose them. */
export function brandTokens(
  brand: Brand | null | undefined,
  fonts: BrandFontResolution | undefined,
  size: Resolution,
  logoPresent = true,
): BrandTokens {
  const b = brand ?? defaultBrand();
  const spec = (choice: BrandFontResolution['heading'] | undefined, bold: boolean): FontSpec =>
    choice?.source === 'brand'
      ? { family: choice.family, weight: choice.bold ? 700 : 400 }
      : {
          family: (choice?.source === 'fallback' ? choice.fallback : FALLBACK_FONTS[0]!).family,
          weight: bold ? 700 : 400,
        };
  // The shorter side, so the same brand gives the same type size at 1080p on every aspect ratio.
  const h = Math.min(size.width, size.height);
  return {
    colors: b.colors,
    fonts: { heading: spec(fonts?.heading, true), body: spec(fonts?.body, false) },
    sizes: {
      title: round(b.typeScale.title * h),
      heading: round(b.typeScale.heading * h),
      body: round(b.typeScale.body * h),
      caption: round(b.typeScale.caption * h),
    },
    ...(b.logo && logoPresent
      ? { logo: { href: `media/${b.logo.hash}.${b.logo.ext}`, ext: b.logo.ext as 'svg' | 'png' } }
      : {}),
  };
}

/** Animated properties every layer has. Offsets in flicks from the item's start. */
export interface LayerAnimation {
  /** 0..1. */
  opacity?: Animatable;
  /** [dx, dy] in px. */
  translate?: Animatable;
  /** Around the layer's centre. */
  scale?: Animatable;
  /** Share of the layer shown, revealed from the left (0..1). */
  reveal?: Animatable;
}

interface LayerBase {
  id: string;
  /** Where the layer sits at rest (no animation), px; used for safe-area checks. */
  box: Box;
  animation?: LayerAnimation;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  layout: TextLayout;
  font: FontSpec;
  fill: string;
  /** Words to check against the on-screen time; usually the layout's source text. */
  text: string;
  letterSpacing?: number;
}

export interface RectLayer extends LayerBase {
  kind: 'rect';
  fill: string;
  radius?: number;
}

export interface ImageLayer extends LayerBase {
  kind: 'image';
  /** A project-relative path such as `media/<hash>.svg`; the renderer resolves it. */
  href: string;
}

export type Layer = TextLayer | RectLayer | ImageLayer;

export interface Scene {
  size: Resolution;
  duration: number;
  /** Full-frame background colour; omitted for overlays (transparent). */
  background?: string;
  layers: Layer[];
  warnings: string[];
}

export interface TemplateContext<P> {
  params: P;
  brand: BrandTokens;
  size: Resolution;
  /** Length of the item, flicks. */
  duration: number;
  /** Where text and logos must stay, px (the platform's safe area). */
  safe: Box;
  measure?: Measure;
}

export interface GraphicTemplate<P = Record<string, unknown>> {
  /** Plugin-qualified id, e.g. `core/title`. */
  id: string;
  name: string;
  /** Full-frame card, or an overlay drawn over the picture. */
  kind: 'card' | 'overlay';
  /** Card kinds or overlay styles from the storyboard it can draw. */
  serves: readonly string[];
  /** Parameters, with defaults; checked before `build`. */
  params: z.ZodType<P>;
  /** Default and shortest sensible length, flicks. */
  duration: { default: number; min: number };
  build(ctx: TemplateContext<P>): Scene;
}

// -- checks ---------------------------------------------------------------------------------------

const inside = (a: Box, b: Box) =>
  a.x >= b.x - 0.5 &&
  a.y >= b.y - 0.5 &&
  a.x + a.w <= b.x + b.w + 0.5 &&
  a.y + a.h <= b.y + b.h + 0.5;

/**
 * Problems a viewer would notice: text outside the safe area at rest, or on screen for less
 * than its read time. Text layout warnings (shrunk, shortened) are included.
 */
export function checkScene(scene: Scene, safe: Box, onScreenSeconds?: number): string[] {
  const out = [...scene.warnings];
  for (const l of scene.layers) {
    if (l.kind !== 'text') continue;
    out.push(...l.layout.warnings);
    if (!inside(l.layout.bounds, safe) || !inside(l.box, safe))
      out.push(`text "${l.text}" reaches outside the safe area`);
    if (onScreenSeconds !== undefined) {
      const w = readTimeWarning(l.text, onScreenSeconds);
      if (w) out.push(w);
    }
  }
  return [...new Set(out)];
}

// -- SVG ------------------------------------------------------------------------------------------

const round = (v: number) => Math.round(v * 1000) / 1000;
const num = (v: number) => String(round(v) === 0 ? 0 : round(v));

const escapeXml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** The frame `at` flicks into the item, as a standalone SVG document. Deterministic. */
export function renderSvg(scene: Scene, at: number): string {
  const { width, height } = scene.size;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  const defs: string[] = [];
  if (scene.background)
    parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(scene.background)}"/>`);
  for (const l of scene.layers) {
    const a = l.animation ?? {};
    const opacity = a.opacity === undefined ? 1 : clamp01(evaluateNumber(a.opacity, at));
    if (opacity <= 0) continue;
    const [dx, dy] = a.translate === undefined ? [0, 0] : evaluateVector(a.translate, at, 2);
    const s = a.scale === undefined ? 1 : evaluateNumber(a.scale, at);
    const reveal = a.reveal === undefined ? 1 : clamp01(evaluateNumber(a.reveal, at));
    if (reveal <= 0 || s <= 0) continue;
    const cx = l.box.x + l.box.w / 2;
    const cy = l.box.y + l.box.h / 2;
    const transforms: string[] = [];
    if (dx || dy) transforms.push(`translate(${num(dx!)} ${num(dy!)})`);
    if (s !== 1)
      transforms.push(
        `translate(${num(cx)} ${num(cy)}) scale(${num(s)}) translate(${num(-cx)} ${num(-cy)})`,
      );
    const attrs = [
      `data-layer="${escapeXml(l.id)}"`,
      ...(opacity < 1 ? [`opacity="${num(opacity)}"`] : []),
      ...(transforms.length ? [`transform="${transforms.join(' ')}"`] : []),
    ];
    if (reveal < 1) {
      const clipId = `clip-${l.id}`;
      defs.push(
        `<clipPath id="${escapeXml(clipId)}"><rect x="${num(l.box.x)}" y="${num(l.box.y - l.box.h)}" width="${num(l.box.w * reveal)}" height="${num(l.box.h * 3)}"/></clipPath>`,
      );
      attrs.push(`clip-path="url(#${escapeXml(clipId)})"`);
    }
    parts.push(`<g ${attrs.join(' ')}>${drawLayer(l)}</g>`);
  }
  if (defs.length) parts.splice(1, 0, `<defs>${defs.join('')}</defs>`);
  parts.push('</svg>');
  return parts.join('');
}

function drawLayer(l: Layer): string {
  if (l.kind === 'rect')
    return `<rect x="${num(l.box.x)}" y="${num(l.box.y)}" width="${num(l.box.w)}" height="${num(l.box.h)}"${l.radius ? ` rx="${num(l.radius)}"` : ''} fill="${escapeXml(l.fill)}"/>`;
  if (l.kind === 'image')
    return `<image href="${escapeXml(l.href)}" x="${num(l.box.x)}" y="${num(l.box.y)}" width="${num(l.box.w)}" height="${num(l.box.h)}" preserveAspectRatio="xMidYMid meet"/>`;
  const anchor = l.layout.align;
  const spacing = l.letterSpacing ? ` letter-spacing="${num(l.letterSpacing)}"` : '';
  const lines = l.layout.lines
    .map((line) => `<tspan x="${num(line.x)}" y="${num(line.y)}">${escapeXml(line.text)}</tspan>`)
    .join('');
  return `<text font-family="${escapeXml(l.font.family)}" font-weight="${l.font.weight}" font-size="${num(l.layout.size)}" fill="${escapeXml(l.fill)}" text-anchor="${anchor}"${spacing}>${lines}</text>`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// -- animation helpers for templates -------------------------------------------------------------

/** Keyframes fading in over `inF` and out over `outF` flicks of an item `duration` long. */
export function fadeInOut(duration: number, inF: number, outF: number, peak = 1): Animatable {
  const i = Math.max(1, Math.min(inF, Math.floor(duration / 2)));
  const o = Math.max(1, Math.min(outF, Math.floor(duration / 2)));
  if (i + o >= duration) return peak;
  return {
    keyframes: [
      { at: 0, value: 0, easing: 'ease-out' },
      { at: i, value: peak, easing: 'linear' },
      { at: duration - o, value: peak, easing: 'ease-in' },
      { at: duration, value: 0, easing: 'linear' },
    ],
  };
}

// -- registry -------------------------------------------------------------------------------------

/** Installed templates by id; the storyboard and the LLM may only use ids listed here. */
export class TemplateRegistry {
  private readonly byId = new Map<string, GraphicTemplate<never>>();

  register<P>(t: GraphicTemplate<P>): this {
    if (!/^[a-z0-9-]+(\/[a-z0-9._-]+)+$/.test(t.id)) throw new Error(`bad template id "${t.id}"`);
    if (this.byId.has(t.id)) throw new Error(`template already registered: ${t.id}`);
    if (t.duration.min <= 0 || t.duration.default < t.duration.min)
      throw new Error(`template ${t.id}: duration must satisfy 0 < min <= default`);
    this.byId.set(t.id, t as unknown as GraphicTemplate<never>);
    return this;
  }

  get(id: string): GraphicTemplate<unknown> | undefined {
    return this.byId.get(id) as GraphicTemplate<unknown> | undefined;
  }

  /** Sorted ids, for building the LLM's enum. */
  ids(kind?: GraphicTemplate['kind']): string[] {
    return [...this.byId.values()]
      .filter((t) => !kind || t.kind === kind)
      .map((t) => t.id)
      .sort();
  }

  /** The template that serves a storyboard card kind or overlay style, if any. */
  forUse(kind: GraphicTemplate['kind'], use: string): GraphicTemplate<unknown> | undefined {
    const ids = this.ids(kind);
    const id = ids.find((x) => this.byId.get(x)!.serves.includes(use));
    return id ? this.get(id) : undefined;
  }
}

export class TemplateParamsError extends Error {
  constructor(
    readonly templateId: string,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateParamsError';
  }
}

/** Check params against the template's schema, then build the scene. */
export function buildScene(
  template: GraphicTemplate<unknown>,
  ctx: Omit<TemplateContext<unknown>, 'params'> & { params: unknown },
): Scene {
  const parsed = template.params.safeParse(ctx.params ?? {});
  if (!parsed.success)
    throw new TemplateParamsError(
      template.id,
      `${template.id}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
    );
  return template.build({ ...ctx, params: parsed.data });
}
