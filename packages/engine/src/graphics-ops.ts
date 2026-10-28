import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  brandStatus,
  importBrandFile,
  writeFileAtomic,
  type BrandFileKind,
  type ProjectStore,
} from '@trailerforge/core';
import {
  VariantCache,
  defaultVariants,
  timelineHash,
  type DerivedVariant,
  type SoundSetup,
} from '@trailerforge/cut';
import { SFX_KINDS, generatedCatalog, type SfxOption } from '@trailerforge/effects';
import {
  brandTokens,
  buildScene,
  checkScene,
  renderSvg,
  safeBox,
  timelineScenes,
} from '@trailerforge/graphics';
import { buildSfxCatalog, scanSfxFolder } from '@trailerforge/media';
import { FrameRenderer, fontFamilyName } from '@trailerforge/render';
import {
  FLICKS_PER_SECOND,
  checkBrandContrast,
  type Brand,
  type BrandFile,
  type FormatTarget,
  type Resolution,
} from '@trailerforge/schema';
import { z } from 'zod';
import type { Engine } from './engine.js';
import { cutGridOp, takeSources } from './footage-ops.js';
import { OpError } from './ops.js';

/**
 * Versions, the brand kit, graphics templates, effects and sound effects, shared by the CLI, the
 * MCP server and the local service. Reads compute from `project.json`, the library and the
 * analysis cache; edits go through typed commands, so each is undoable. Nothing derived is stored.
 */

// ---- variants --------------------------------------------------------------------------------

export interface VariantEntry {
  id: string;
  name: string;
  formatTargetId: string;
  format: Pick<FormatTarget, 'name' | 'aspect' | 'resolution' | 'frameRate'> | null;
  /** Seconds, or null for the master's length. */
  targetDuration: number | null;
  reframe: 'crop' | 'fill';
  overrides: Record<string, unknown>;
  /** Derived on demand from the master cut; null with `error` when it cannot be. */
  derived: Pick<DerivedVariant, 'duration' | 'target' | 'shortfall' | 'slots' | 'warnings'> | null;
  error?: string;
}

export interface VariantsView {
  /** There is a rough cut to derive from. */
  hasMaster: boolean;
  variants: VariantEntry[];
  /** Format targets without a version yet. */
  missing: { formatTargetId: string; name: string }[];
}

const caches = new WeakMap<Engine, VariantCache>();

export async function variantsViewOp(engine: Engine, store: ProjectStore): Promise<VariantsView> {
  const project = store.state;
  const sb = project.storyboard;
  const hasMaster = project.timelines.some((t) => t.id === 'tl_rough' || !t.variantId);
  const cache = caches.get(engine) ?? caches.set(engine, new VariantCache(32)).get(engine)!;
  const sources = hasMaster ? await takeSources(engine, store) : undefined;
  const beats = hasMaster ? (await cutGridOp(engine, store))?.beats : undefined;
  const variants: VariantEntry[] = [];
  for (const v of sb?.variants ?? []) {
    const f = project.formatTargets.find((x) => x.id === v.formatTargetId);
    const entry: VariantEntry = {
      id: v.id,
      name: v.name,
      formatTargetId: v.formatTargetId,
      format: f
        ? { name: f.name, aspect: f.aspect, resolution: f.resolution, frameRate: f.frameRate }
        : null,
      targetDuration: v.targetDuration ?? null,
      reframe: v.reframe.mode,
      overrides: v.overrides,
      derived: null,
    };
    if (hasMaster) {
      try {
        const d = cache.get({
          project,
          variantId: v.id,
          ...(sources ? { sources } : {}),
          ...(beats ? { beats } : {}),
        });
        entry.derived = {
          duration: d.duration,
          target: d.target,
          slots: d.slots,
          warnings: d.warnings,
          ...(d.shortfall ? { shortfall: d.shortfall } : {}),
        };
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }
    variants.push(entry);
  }
  return { hasMaster, variants, missing: defaultVariants(project) };
}

/** One version per format target that has none, at the master's length (one undo step each). */
export function createDefaultVariantsOp(store: ProjectStore): { added: string[] } {
  if (!store.state.storyboard)
    throw new OpError('not-found', 'this project has no storyboard yet; generate one first');
  const added: string[] = [];
  for (const d of defaultVariants(store.state)) {
    store.dispatch('core/variants.add', d);
    added.push(store.state.storyboard!.variants.at(-1)!.id);
  }
  return { added };
}

/** The derived timeline of one version (for the preview and, later, the renderer). */
export async function deriveVariantOp(engine: Engine, store: ProjectStore, variantId: string) {
  const sources = await takeSources(engine, store);
  const beats = (await cutGridOp(engine, store))?.beats;
  const cache = caches.get(engine) ?? caches.set(engine, new VariantCache(32)).get(engine)!;
  try {
    return cache.get({ project: store.state, variantId, sources, ...(beats ? { beats } : {}) });
  } catch (err) {
    throw new OpError('not-found', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Render the cards and captions of a version (its derived timeline) with the brand kit: `samples`
 * frames per item into the frame cache, with the hash of every frame, so a check (or M6's
 * export) can see that two renders agree. Nothing is stored in the project.
 */
export async function renderVariantGraphicsOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string,
  o: { samples?: number; cacheDir?: string; signal?: AbortSignal } = {},
) {
  const derived = await deriveVariantOp(engine, store, variantId);
  const status = await brandStatus(store.paths.dir, store.state.brand);
  const { scenes, warnings } = timelineScenes({
    timeline: derived.timeline,
    templates: engine.plugins.registries.graphicTemplates,
    brand: store.state.brand,
    fonts: status.fonts,
    logoPresent: !status.warnings.some((w) => w.startsWith('The logo')),
  });
  const r = await FrameRenderer.create({
    projectDir: store.paths.dir,
    brand: store.state.brand,
    ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}),
  });
  const items = await r.renderScenes(scenes, {
    ...(o.samples ? { samples: o.samples } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  return {
    variantId,
    timelineHash: timelineHash(derived.timeline),
    items: items.map((it, i) => ({ ...it, kind: scenes[i]!.kind, start: scenes[i]!.start })),
    warnings: [...new Set([...status.warnings, ...warnings, ...r.warnings])],
  };
}

// ---- brand kit -------------------------------------------------------------------------------

export interface BrandView {
  brand: Brand | null;
  /** Everything worth telling the user: contrast, missing files. */
  warnings: string[];
  contrast: ReturnType<typeof checkBrandContrast>;
  /** Which font each role uses now. */
  fonts: { heading: string; body: string };
}

export async function brandViewOp(store: ProjectStore): Promise<BrandView> {
  const brand = store.state.brand;
  const status = await brandStatus(store.paths.dir, brand);
  const name = (c: typeof status.fonts.heading) =>
    c.source === 'brand'
      ? `${c.family}${c.bold ? ' Bold' : ''}`
      : `${c.fallback.family}${c.fallback.bold ? ' Bold' : ''} (shipped)`;
  return {
    brand,
    warnings: status.warnings,
    contrast: checkBrandContrast(
      brand?.colors ?? {
        background: '#0b0d12',
        text: '#f5f6f8',
        primary: '#ffb020',
        accent: '#4cc9f0',
      },
    ),
    fonts: { heading: name(status.fonts.heading), body: name(status.fonts.body) },
  };
}

export interface BrandImport {
  kind: BrandFileKind;
  path: string;
  /** Fonts: which role it is for (default: heading for a bold file name, else body). */
  role?: 'heading' | 'body' | undefined;
  /** Fonts: the family to use (default: read from the file). */
  family?: string | undefined;
  bold?: boolean | undefined;
}

/**
 * Copy a logo or font into the project's `media/` (hashed) and set it in the brand kit. Not
 * offered to the MCP server: which files go into a project is the user's choice.
 */
export async function brandImportOp(
  store: ProjectStore,
  o: BrandImport,
): Promise<{ file: BrandFile; family?: string }> {
  let file: BrandFile;
  try {
    file = await importBrandFile(store.paths.dir, o.path, o.kind);
  } catch (err) {
    throw new OpError('usage', err instanceof Error ? err.message : String(err));
  }
  if (o.kind === 'logo') {
    store.dispatch('core/brand.set-logo', { file });
    return { file };
  }
  const bytes = new Uint8Array(await readFile(join(store.paths.media, `${file.hash}.${file.ext}`)));
  const family = o.family ?? fontFamilyName(bytes) ?? file.name.replace(/\.[^.]+$/, '');
  const bold = o.bold ?? /bold|black|heavy/i.test(file.name);
  const role = o.role ?? (bold ? 'heading' : 'body');
  store.dispatch('core/brand.set-font', { role, font: { family, bold, file } });
  return { file, family };
}

// ---- graphics templates ----------------------------------------------------------------------

export interface TemplateEntry {
  id: string;
  name: string;
  kind: 'card' | 'overlay';
  serves: string[];
  /** Seconds. */
  duration: { default: number; min: number };
  /** JSON Schema of its parameters (what an editor shows). */
  params: unknown;
}

export function templatesViewOp(engine: Engine): TemplateEntry[] {
  return engine.plugins.registries.graphicTemplates
    .list()
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      serves: [...t.serves],
      duration: {
        default: t.duration.default / FLICKS_PER_SECOND,
        min: t.duration.min / FLICKS_PER_SECOND,
      },
      params: z.toJSONSchema(t.params as z.ZodType, { io: 'input', target: 'draft-7' }),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface TemplatePreview {
  templateId: string;
  /** Standalone SVG of the frame (images are `media/<hash>` paths; fonts are named, not embedded). */
  svg: string;
  /** Base64 PNG as the final render draws it, when asked for. */
  png?: string;
  /** Text outside the safe area, text shrunk to fit, too short to read, missing brand files. */
  warnings: string[];
  seconds: number;
  at: number;
}

/** One frame of a template with the project's brand kit (for pickers; the render does the same). */
export async function templatePreviewOp(
  engine: Engine,
  store: ProjectStore,
  o: {
    templateId: string;
    params?: Record<string, unknown> | undefined;
    at?: number | undefined;
    seconds?: number | undefined;
    size?: Resolution | undefined;
    png?: boolean | undefined;
  },
): Promise<TemplatePreview> {
  const t = engine.plugins.registries.graphicTemplates.get(o.templateId);
  if (!t)
    throw new OpError(
      'not-found',
      `no graphics template "${o.templateId}"; the installed ones are ${engine.plugins.registries.graphicTemplates
        .list()
        .map((x) => x.id)
        .join(', ')}`,
    );
  const size = o.size ?? store.state.formatTargets[0]?.resolution ?? { width: 1920, height: 1080 };
  const seconds = o.seconds ?? t.duration.default / FLICKS_PER_SECOND;
  const duration = Math.max(1, Math.round(seconds * FLICKS_PER_SECOND));
  const status = await brandStatus(store.paths.dir, store.state.brand);
  const safe = safeBox(size);
  let scene;
  try {
    scene = buildScene(t as never, {
      params: o.params ?? {},
      brand: brandTokens(
        store.state.brand,
        status.fonts,
        size,
        !status.warnings.some((w) => w.startsWith('The logo')),
      ),
      size,
      duration,
      safe,
    });
  } catch (err) {
    throw new OpError('usage', err instanceof Error ? err.message : String(err));
  }
  const at = Math.min(duration, Math.max(0, Math.round((o.at ?? seconds / 2) * FLICKS_PER_SECOND)));
  const svg = renderSvg(scene, at);
  const warnings = [...status.warnings, ...checkScene(scene, safe, seconds)];
  let png: string | undefined;
  if (o.png) {
    const r = await FrameRenderer.create({
      projectDir: store.paths.dir,
      brand: store.state.brand,
      cacheDir: false,
    });
    png = (await r.render(svg)).png.toString('base64');
    warnings.push(...r.warnings);
  }
  return {
    templateId: t.id,
    svg,
    ...(png ? { png } : {}),
    warnings: [...new Set(warnings)],
    seconds,
    at: at / FLICKS_PER_SECOND,
  };
}

// ---- effects, transitions and sounds ---------------------------------------------------------

export interface FilterEntry {
  id: string;
  name: string;
  kind: 'transition' | 'effect';
  /** Seconds, for transitions. */
  defaultSeconds?: number;
  params: unknown;
  /** It flashes, so the flash guard checks it. */
  flashes: boolean;
}

export interface EffectsView {
  transitions: FilterEntry[];
  effects: FilterEntry[];
  sounds: SfxView;
}

export async function effectsViewOp(engine: Engine): Promise<EffectsView> {
  const filters = engine.filters();
  const entry = (id: string): FilterEntry => {
    const d = filters.get(id)! as unknown as {
      id: string;
      name: string;
      kind: 'transition' | 'effect';
      defaultDuration?: number;
      params: z.ZodType;
      flashes?: unknown;
    };
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      ...(d.kind === 'transition' ? { defaultSeconds: d.defaultDuration ?? 0.5 } : {}),
      params: z.toJSONSchema(d.params, { io: 'input', target: 'draft-7' }),
      flashes: !!d.flashes,
    };
  };
  return {
    transitions: filters.ids('transition').map(entry),
    effects: filters.ids('effect').map(entry),
    sounds: await sfxViewOp(engine),
  };
}

// ---- sound effects ---------------------------------------------------------------------------

const SfxSettings = z.strictObject({ version: z.literal(1), folder: z.string().min(1).nullable() });
const sfxSettingsFile = (engine: Engine) => join(engine.home, 'sfx-folder.json');
const generatedDir = (engine: Engine) => join(engine.home, 'sfx', 'generated');

async function sfxFolder(engine: Engine): Promise<string | null> {
  try {
    return SfxSettings.parse(JSON.parse(await readFile(sfxSettingsFile(engine), 'utf8'))).folder;
  } catch {
    return null;
  }
}

export interface SfxView {
  /** The user's folder of licensed or CC0 sounds, if set. */
  folder: string | null;
  /** The generated kinds. */
  generated: string[];
  /** Files found in the folder and what each was taken to be. */
  files: { name: string; kind: string }[];
  warnings: string[];
}

export async function sfxViewOp(engine: Engine): Promise<SfxView> {
  const folder = await sfxFolder(engine);
  const files = folder ? await scanSfxFolder(folder) : [];
  const warnings: string[] = [];
  if (
    folder &&
    !(await stat(folder).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    warnings.push(`the folder ${folder} cannot be read; only the generated sounds are used`);
  for (const f of files)
    if (f.kind === 'custom')
      warnings.push(
        `${f.name}: cannot tell what kind of sound it is; put whoosh, riser, impact or sub-drop in its name`,
      );
  return {
    folder,
    generated: [...SFX_KINDS],
    files: files.map((f) => ({ name: f.name, kind: f.kind })),
    warnings,
  };
}

/** Set (or clear, with null) the folder of the user's own sounds. Nothing is copied or uploaded. */
export async function setSfxFolderOp(engine: Engine, folder: string | null): Promise<SfxView> {
  if (
    folder !== null &&
    !(await stat(folder).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    throw new OpError('usage', `${folder} is not a folder`);
  await writeFileAtomic(sfxSettingsFile(engine), JSON.stringify({ version: 1, folder }, null, 2));
  return sfxViewOp(engine);
}

export interface SoundCatalog {
  catalog: SfxOption[];
  /** Option id → file on disk. */
  files: Map<string, string>;
  warnings: string[];
}

/** The generated sounds (written to the app's folder) and the user's files, measured. */
export async function soundCatalog(engine: Engine): Promise<SoundCatalog> {
  const userDir = await sfxFolder(engine);
  try {
    return await buildSfxCatalog({
      generatedDir: generatedDir(engine),
      ...(userDir ? { userDir } : {}),
    });
  } catch (err) {
    return {
      catalog: generatedCatalog(),
      files: new Map(),
      warnings: [
        `sound effects could not be prepared: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/**
 * Put the sound files a cut uses into the library and the project (role `sfx`), returning the
 * asset id of each option. Files already there are reused.
 */
export async function attachSounds(
  engine: Engine,
  store: ProjectStore,
  files: ReadonlyMap<string, string>,
  optionIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of optionIds) {
    const path = files.get(id);
    if (!path) continue;
    const { asset } = await engine.library.importFile(path, { kind: 'audio' });
    out.set(id, asset.id);
    if (!store.state.assets.some((a) => a.assetId === asset.id))
      store.dispatch('core/assets.add', { assetId: asset.id, role: 'sfx' });
  }
  return out;
}

export type { SoundSetup };
