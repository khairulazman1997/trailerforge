import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Resvg, renderAsync, type ResvgRenderOptions } from '@resvg/resvg-js';
import { fallbackFontPath, mediaFileNames, writeFileAtomic } from '@trailerforge/core';
import { renderSvg as sceneSvg, type Scene, type TimelineScene } from '@trailerforge/graphics';
import {
  FALLBACK_FONTS,
  flicksPerFrame,
  resolveBrandFonts,
  type Brand,
  type BrandFontResolution,
  type Rate,
} from '@trailerforge/schema';
import { fontFamilyName } from './font-name.js';

/**
 * Graphics frames: a scene's SVG rasterized with resvg (pinned, local, no system fonts so every
 * machine draws the same pixels) into RGBA PNG frames. Frames are cached by content hash under
 * the project's `cache/frames/`, so a still stretch of a card renders once. M6 composites the
 * PNG sequences (straight alpha) over the picture.
 */

/** Bumped when the same SVG would rasterize differently (renderer settings, resvg version). */
export const RENDERER_VERSION = 'resvg-2.6.2/1';

export interface FrameRendererOptions {
  /** Project folder: brand files come from its `media/`, the cache goes to `cache/frames/`. */
  projectDir?: string;
  brand?: Brand | null;
  /** Cache folder override; `false` disables the cache. */
  cacheDir?: string | false;
}

export interface RenderedFrame {
  png: Buffer;
  hash: string;
  cached: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** A complete PNG: right signature and an IEND chunk at the very end (not cut off). */
export const isCompletePng = (b: Buffer) =>
  b.length > 20 && b.subarray(0, 8).equals(PNG_SIGNATURE) && b.subarray(-8).equals(PNG_IEND);

/** `<file>.tmp-<pid>-<hex>`, as `writeFileAtomic` names its temp files. */
const TEMP_FILE = /\.tmp-(\d+)-[0-9a-f]+$/;

const alive = (pid: number) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Remove temp files a crashed render left in the frame cache. Files of a process still running
 * (another window rendering into the same project) are left alone. Finished frames are only
 * ever renamed into place, so a crash leaves at worst a stray temp file, never a torn PNG.
 */
export async function sweepTempFiles(cacheDir: string): Promise<number> {
  let removed = 0;
  let dirs: string[];
  try {
    dirs = await readdir(cacheDir);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    let names: string[];
    try {
      names = await readdir(join(cacheDir, d));
    } catch {
      continue; // not a folder
    }
    for (const name of names) {
      const m = TEMP_FILE.exec(name);
      if (!m || alive(Number(m[1]))) continue;
      await rm(join(cacheDir, d, name), { force: true });
      removed++;
    }
  }
  return removed;
}

/** Frame times sampled across a scene: first, last and evenly between, on whole flicks. */
export function sampleTimes(duration: number, samples: number): number[] {
  const n = Math.max(1, Math.floor(samples));
  if (n === 1) return [0];
  const last = Math.max(0, duration - 1);
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round((last * i) / (n - 1))))];
}

const escapeAttr = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

export class FrameRenderer {
  private constructor(
    private readonly fontFiles: string[],
    /** Declared family (as the SVG names it) → the family inside the loaded file. */
    private readonly aliases: Map<string, string>,
    private readonly fingerprint: string,
    private readonly projectDir: string | undefined,
    private readonly cacheDir: string | undefined,
    readonly fonts: BrandFontResolution,
    readonly warnings: string[],
  ) {}

  static async create(opts: FrameRendererOptions = {}): Promise<FrameRenderer> {
    const present = opts.projectDir ? await mediaFileNames(opts.projectDir) : new Set<string>();
    const fonts = resolveBrandFonts(opts.brand, present);
    const warnings = [...fonts.warnings];
    const files: string[] = FALLBACK_FONTS.map((f) => fallbackFontPath(f));
    const aliases = new Map<string, string>();
    for (const choice of [fonts.heading, fonts.body]) {
      if (choice.source !== 'brand' || !opts.projectDir) continue;
      const path = join(opts.projectDir, 'media', `${choice.file.hash}.${choice.file.ext}`);
      const family = choice.file.ext === 'woff2' ? null : fontFamilyName(await readFile(path));
      if (!family) {
        warnings.push(
          choice.file.ext === 'woff2'
            ? `The ${choice.role} font "${choice.family}" is a WOFF2 file, which the renderer cannot read yet; using Inter. Import the TTF or OTF version.`
            : `The ${choice.role} font "${choice.family}" (${choice.file.name}) could not be read; using Inter.`,
        );
        aliases.set(choice.family, 'Inter');
        continue;
      }
      if (!files.includes(path)) files.push(path);
      if (family !== choice.family) aliases.set(choice.family, family);
    }
    // Everything that changes pixels for the same SVG text.
    const h = createHash('sha256').update(RENDERER_VERSION);
    for (const f of files)
      h.update(
        createHash('sha256')
          .update(await readFile(f))
          .digest('hex'),
      );
    h.update(JSON.stringify([...aliases].sort()));
    const cacheDir =
      opts.cacheDir === false
        ? undefined
        : (opts.cacheDir ??
          (opts.projectDir ? join(opts.projectDir, 'cache', 'frames') : undefined));
    if (cacheDir) await sweepTempFiles(cacheDir);
    return new FrameRenderer(
      files,
      aliases,
      h.digest('hex'),
      opts.projectDir,
      cacheDir,
      fonts,
      warnings,
    );
  }

  /** The SVG exactly as rasterized: font families mapped, project images inlined. */
  async prepare(svg: string): Promise<string> {
    let out = svg;
    for (const [from, to] of this.aliases)
      out = out.split(`font-family="${escapeAttr(from)}"`).join(`font-family="${escapeAttr(to)}"`);
    const hrefs = [
      ...new Set([...out.matchAll(/href="(media\/[a-f0-9]{64}\.(svg|png))"/g)].map((m) => m[1]!)),
    ];
    for (const href of hrefs) {
      let data: string | null = null;
      if (this.projectDir) {
        try {
          const bytes = await readFile(join(this.projectDir, href));
          data = `data:${href.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${bytes.toString('base64')}`;
        } catch {
          data = null;
        }
      }
      // A missing file draws nothing rather than failing the render.
      out = out.split(`href="${href}"`).join(`href="${data ?? ''}"`);
    }
    return out;
  }

  /** Rasterize one SVG document (as `renderSvg` makes them) to a PNG, through the cache. */
  async render(svg: string): Promise<RenderedFrame> {
    const prepared = await this.prepare(svg);
    const hash = createHash('sha256')
      .update(this.fingerprint)
      .update('\0')
      .update(prepared)
      .digest('hex');
    const file = this.cacheDir ? join(this.cacheDir, hash.slice(0, 2), `${hash}.png`) : undefined;
    if (file) {
      try {
        const hit = await readFile(file);
        if (isCompletePng(hit)) return { png: hit, hash, cached: true };
        await rm(file, { force: true }); // damaged: render again
      } catch {
        // not cached yet
      }
    }
    // Off the main thread (libuv's pool): the same pixels as `rasterize`, several at once.
    const png = (await renderAsync(prepared, this.options('rgba(0,0,0,0)'))).asPng();
    if (file) {
      await mkdir(join(this.cacheDir!, hash.slice(0, 2)), { recursive: true });
      await writeFileAtomic(file, png);
    }
    return { png, hash, cached: false };
  }

  /** resvg, with no system fonts: only the shipped and brand files. */
  rasterize(prepared: string, background = 'rgba(0,0,0,0)'): Buffer {
    return this.resvg(prepared, background).render().asPng();
  }

  /** Raw RGBA pixels over an opaque `background` (for checks and parity tests). */
  async pixels(
    svg: string,
    background: string,
  ): Promise<{ width: number; height: number; rgba: Buffer }> {
    const img = this.resvg(await this.prepare(svg), background).render();
    return { width: img.width, height: img.height, rgba: img.pixels };
  }

  private resvg(prepared: string, background: string): Resvg {
    return new Resvg(prepared, this.options(background));
  }

  private options(background: string): ResvgRenderOptions {
    return {
      font: { fontFiles: this.fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' },
      background,
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    };
  }

  /** The frame `at` flicks into a scene. */
  renderFrame(scene: Scene, at: number): Promise<RenderedFrame> {
    return this.render(sceneSvg(scene, at));
  }

  /**
   * The graphics of a timeline (from `timelineScenes`), `samples` frames each: per frame its cache
   * key and the hash of its PNG, so two renders of a version can be compared.
   */
  async renderScenes(
    scenes: readonly TimelineScene[],
    opts: { samples?: number; signal?: AbortSignal } = {},
  ): Promise<
    { itemId: string; templateId: string; frames: { at: number; hash: string; png: string }[] }[]
  > {
    const out = [];
    for (const s of scenes) {
      const frames = [];
      for (const at of sampleTimes(s.duration, opts.samples ?? 5)) {
        opts.signal?.throwIfAborted();
        const f = await this.renderFrame(s.scene, at);
        frames.push({ at, hash: f.hash, png: createHash('sha256').update(f.png).digest('hex') });
      }
      out.push({ itemId: s.itemId, templateId: s.templateId, frames });
    }
    return out;
  }

  /**
   * Every frame of a scene at `rate` as `frame_000000.png`, `frame_000001.png`… in `outDir`
   * (created; existing frames are overwritten). Frame k is at k frames from the item's start.
   * Distinct frames are drawn `parallel` at a time (default: the CPU cores); `SEQUENCE_DONE` is
   * written last, so a sequence without it was interrupted and is not to be trusted.
   */
  async renderSequence(
    scene: Scene,
    rate: Rate,
    outDir: string,
    opts: {
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
      parallel?: number;
    } = {},
  ): Promise<{ dir: string; pattern: string; frames: number; unique: number; rendered: number }> {
    const fpf = flicksPerFrame(rate);
    const frames = Math.max(1, Math.round(scene.duration / fpf));
    await mkdir(outDir, { recursive: true });
    await rm(join(outDir, SEQUENCE_DONE), { force: true });
    const name = (k: number) => join(outDir, `frame_${String(k).padStart(6, '0')}.png`);
    // Frames that draw the same SVG are drawn once and copied.
    const firstOf = new Map<string, number>();
    const copies: [from: number, to: number][] = [];
    for (let k = 0; k < frames; k++) {
      const svg = sceneSvg(scene, Math.round(k * fpf));
      const first = firstOf.get(svg);
      if (first === undefined) firstOf.set(svg, k);
      else copies.push([first, k]);
    }
    const unique = [...firstOf];
    let rendered = 0;
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const [svg, k] = unique[next++]!;
        opts.signal?.throwIfAborted();
        const f = await this.render(svg);
        if (!f.cached) rendered++;
        await writeFileAtomic(name(k), f.png);
        opts.onProgress?.(++done, frames);
      }
    };
    const workers = Math.max(1, Math.min(opts.parallel ?? availableParallelism(), unique.length));
    await Promise.all(Array.from({ length: workers }, worker));
    for (const [from, to] of copies) {
      opts.signal?.throwIfAborted();
      await copyFile(name(from), name(to));
      opts.onProgress?.(++done, frames);
    }
    await writeFileAtomic(join(outDir, SEQUENCE_DONE), `${frames}\n`);
    return { dir: outDir, pattern: 'frame_%06d.png', frames, unique: unique.length, rendered };
  }
}

/** Written into a sequence's folder once every frame is there. */
export const SEQUENCE_DONE = 'SEQUENCE_DONE';
