import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { fallbackFontPath, mediaFileNames, writeFileAtomic } from '@trailerforge/core';
import { renderSvg as sceneSvg, type Scene } from '@trailerforge/graphics';
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
    const png = this.rasterize(prepared);
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
    return new Resvg(prepared, {
      font: { fontFiles: this.fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' },
      background,
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    });
  }

  /** The frame `at` flicks into a scene. */
  renderFrame(scene: Scene, at: number): Promise<RenderedFrame> {
    return this.render(sceneSvg(scene, at));
  }

  /**
   * Every frame of a scene at `rate` as `frame_000000.png`, `frame_000001.png`… in `outDir`
   * (created; existing frames are overwritten). Frame k is at k frames from the item's start.
   */
  async renderSequence(
    scene: Scene,
    rate: Rate,
    outDir: string,
    opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ dir: string; pattern: string; frames: number; unique: number; rendered: number }> {
    const fpf = flicksPerFrame(rate);
    const frames = Math.max(1, Math.round(scene.duration / fpf));
    await mkdir(outDir, { recursive: true });
    const seen = new Map<string, string>();
    let rendered = 0;
    for (let k = 0; k < frames; k++) {
      opts.signal?.throwIfAborted();
      const svg = sceneSvg(scene, Math.round(k * fpf));
      const name = `frame_${String(k).padStart(6, '0')}.png`;
      const dest = join(outDir, name);
      const prev = seen.get(svg);
      if (prev) await copyFile(prev, dest);
      else {
        const f = await this.render(svg);
        if (!f.cached) rendered++;
        await writeFileAtomic(dest, f.png);
        seen.set(svg, dest);
      }
      opts.onProgress?.(k + 1, frames);
    }
    return { dir: outDir, pattern: 'frame_%06d.png', frames, unique: seen.size, rendered };
  }
}
