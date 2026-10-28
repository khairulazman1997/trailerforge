import {
  brandTokens,
  builtinRegistry,
  buildScene,
  checkScene,
  renderSvg,
  safeBox,
} from '@trailerforge/graphics';
import {
  FLICKS_PER_SECOND,
  resolveBrandFonts,
  snapToFrame,
  type Brand,
  type Rate,
  type Resolution,
} from '@trailerforge/schema';

/** A parameter of a template or effect as an editor shows it, from its JSON Schema. */
export interface Field {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'choice';
  choices?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  /** The schema's default, when it has one. */
  default?: string | number | boolean;
  required: boolean;
}

type JsonSchema = {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

/** `subtitle` → "Subtitle", `barOpacity` → "Bar opacity". */
export function labelFor(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The editable fields of a strict-object JSON Schema; anything more complex is left out. */
export function fieldsOf(schema: unknown): Field[] {
  const s = schema as JsonSchema;
  const required = new Set(s?.required ?? []);
  const out: Field[] = [];
  for (const [name, p] of Object.entries(s?.properties ?? {})) {
    const base = { name, label: labelFor(name), required: required.has(name) };
    const def = p.default;
    const dflt =
      typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean'
        ? { default: def }
        : {};
    if (Array.isArray(p.enum) && p.enum.every((c) => typeof c === 'string'))
      out.push({ ...base, ...dflt, kind: 'choice', choices: p.enum as string[] });
    else if (p.type === 'string')
      out.push({
        ...base,
        ...dflt,
        kind: 'text',
        ...(typeof p.maxLength === 'number' ? { maxLength: p.maxLength } : {}),
      });
    else if (p.type === 'number' || p.type === 'integer')
      out.push({
        ...base,
        ...dflt,
        kind: 'number',
        ...(typeof p.minimum === 'number' ? { min: p.minimum } : {}),
        ...(typeof p.maximum === 'number' ? { max: p.maximum } : {}),
      });
    else if (p.type === 'boolean') out.push({ ...base, ...dflt, kind: 'boolean' });
  }
  return out;
}

/** The defaults an effect or transition gets when picked: every field that has one. */
export function defaultsOf(schema: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(
    fieldsOf(schema).flatMap((f) => (f.default === undefined ? [] : [[f.name, f.default]])),
  );
}

/** FNV-1a, 32 bits, as hex: a short fingerprint of a frame's SVG, for telling two draws apart. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface Preview {
  svg: string;
  warnings: string[];
  seconds: number;
}

const registry = builtinRegistry();

/**
 * One frame of a built-in template, drawn with the same package the renderer uses, so the
 * preview and the final frames share their layout, animation and text fitting. Templates from
 * plugins are not in the browser; `error` says so.
 */
export function previewFrame(o: {
  templateId: string;
  params: Record<string, unknown>;
  brand: Brand | null;
  size: Resolution;
  seconds: number;
  at: number;
  /** `<hash>.<ext>` names of the brand's logo and fonts that the browser has loaded. */
  present?: ReadonlySet<string>;
}): Preview | { error: string } {
  const t = registry.get(o.templateId);
  if (!t)
    return {
      error: `The preview does not know the template ${o.templateId}; it is drawn in the final render.`,
    };
  const duration = Math.max(1, Math.round(o.seconds * FLICKS_PER_SECOND));
  const safe = safeBox(o.size);
  const present = o.present ?? new Set<string>();
  try {
    const scene = buildScene(t, {
      params: o.params,
      brand: brandTokens(
        o.brand,
        resolveBrandFonts(o.brand, present),
        o.size,
        !o.brand?.logo || present.has(`${o.brand.logo.hash}.${o.brand.logo.ext}`),
      ),
      size: o.size,
      duration,
      safe,
    });
    const at = Math.min(duration, Math.max(0, Math.round(o.at * FLICKS_PER_SECOND)));
    return {
      svg: renderSvg(scene, at),
      warnings: [...new Set(checkScene(scene, safe, o.seconds))],
      seconds: o.seconds,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Swaps the project's own images (`media/<hash>.<ext>`, the logo) for data URIs the page holds,
 * for display only: the frame's hash is taken from the SVG as the engine writes it.
 */
export function inlineImages(svg: string, images: Readonly<Record<string, string>>): string {
  return svg.replace(/href="(media\/[^"]+)"/g, (whole, href: string) =>
    images[href] ? `href="${images[href]}"` : whole,
  );
}

/** Seconds as flicks on the frame grid, at least one frame. */
export function secondsToFrameFlicks(seconds: number, rate: Rate): number {
  const fpf = (FLICKS_PER_SECOND * rate.den) / rate.num;
  return Math.max(fpf, snapToFrame(Math.round(seconds * FLICKS_PER_SECOND), rate));
}
