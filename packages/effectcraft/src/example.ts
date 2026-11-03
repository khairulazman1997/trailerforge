import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { EffectCraftError } from './cli.js';
import { EFFECT_COMP } from './effect-spec.js';
import type { EffectCraftRenderer } from './renderer.js';

/**
 * An example animation to start a custom effect from (plan M8 decision 10 (i)): what the model is
 * told about it (as text) and the EffectCraft project that holds it, nested in TrailerForge's own
 * `tf-effect` composition and fitted to the picture.
 */
export interface ExampleBase {
  /** The `.ecproj` the authored commands edit (a copy of it). */
  project: string;
  /** Compositions the commands may target: ours and the example's. */
  comps: string[];
  /** The example as text: its name, size, length and layers (names, kinds, words). */
  summary: Record<string, unknown>;
}

const LOTTIE_KINDS: Record<number, string> = { 0: 'precomp', 1: 'solid', 2: 'image', 3: 'null', 4: 'shape', 5: 'text' }; // prettier-ignore

/** What a Lottie file says about itself, or why it is not one. */
export function lottieSummary(json: unknown): {
  name: string;
  width: number;
  height: number;
  seconds: number;
  frameRate: number;
  layers: { name: string; kind: string; text?: string }[];
} {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : NaN);
  const [w, h, fr, ip, op] = ['w', 'h', 'fr', 'ip', 'op'].map(num) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (![w, h, fr, ip, op].every(Number.isFinite) || !Array.isArray(o.layers) || fr <= 0)
    throw new EffectCraftError(
      'bad-project',
      'not a Lottie animation (needs w, h, fr, ip, op and layers)',
    );
  const layers = (o.layers as Record<string, unknown>[]).slice(0, 60).map((l) => {
    const kind = LOTTIE_KINDS[Number(l.ty)] ?? 'other';
    const text = kind === 'text' ? (l as { t?: { d?: { k?: { s?: { t?: unknown } }[] } } }).t?.d?.k?.[0]?.s?.t : undefined; // prettier-ignore
    return { name: String(l.nm ?? ''), kind, ...(typeof text === 'string' ? { text } : {}) };
  });
  return {
    name: String(o.nm ?? 'Lottie'),
    width: w,
    height: h,
    seconds: (op - ip) / fr,
    frameRate: fr,
    layers,
  };
}

/**
 * Import an example into a fresh EffectCraft project at `dest`: a Lottie `.json` is imported by
 * EffectCraft (`file.importLottie`, run by TrailerForge, never by the model) and nested in a new
 * `tf-effect` composition of the picture's size and the effect's length, scaled to fit. An
 * `.ecproj` must already hold a `tf-effect` composition (an effect made here and polished in
 * EffectCraft). `.lottie` archives are not read: export the animation as `.json`.
 */
export async function importExample(
  renderer: EffectCraftRenderer,
  file: string,
  o: { dest: string; size: { width: number; height: number }; frameRate: number; seconds: number; signal: AbortSignal }, // prettier-ignore
): Promise<ExampleBase> {
  const ext = extname(file).toLowerCase();
  if (ext === '.ecproj') {
    const text = await readFile(file, 'utf8');
    if (!text.includes(`"${EFFECT_COMP}"`))
      throw new EffectCraftError('bad-project', `the project has no "${EFFECT_COMP}" composition; start from a Lottie .json or an effect made in TrailerForge`); // prettier-ignore
    const p = await renderer.authorProject([{ command: 'layer.newNull', params: { name: 'tf-example-check' } }], o.dest, o.signal, { base: file }); // prettier-ignore
    return { project: p.path, comps: [EFFECT_COMP], summary: { kind: 'effectcraft-project', note: 'an effect made earlier; its layers are in the "tf-effect" composition' } }; // prettier-ignore
  }
  if (ext !== '.json')
    throw new EffectCraftError(
      'bad-project',
      'use a Lottie animation saved as .json, or an .ecproj',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new EffectCraftError('bad-project', 'the Lottie file is not valid JSON');
  }
  const s = lottieSummary(parsed);
  const comp = s.name.slice(0, 60) || 'Lottie';
  if (comp === EFFECT_COMP) throw new EffectCraftError('bad-project', 'rename the animation');
  const k = Math.round(Math.min(o.size.width / s.width, o.size.height / s.height) * 1e5) / 1e3;
  const p = await renderer.importAndNest(file, o.dest, o.signal, {
    comp: { name: EFFECT_COMP, width: o.size.width, height: o.size.height, frameRate: Math.round(o.frameRate * 1e6) / 1e6, duration: Math.round(o.seconds * 1e6) / 1e6 }, // prettier-ignore
    layerName: comp,
    scale: k,
  });
  return {
    project: p.path,
    comps: [EFFECT_COMP, comp],
    summary: { kind: 'lottie', composition: comp, size: { width: s.width, height: s.height }, seconds: Math.round(s.seconds * 1000) / 1000, layers: s.layers, nestedAs: { layer: comp, inComposition: EFFECT_COMP, scalePercent: k } }, // prettier-ignore
  };
}
