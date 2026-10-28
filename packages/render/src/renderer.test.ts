/// <reference lib="dom" />
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackFontPath } from '@trailerforge/core';
import {
  brandTokens,
  buildScene,
  builtinRegistry,
  renderSvg,
  safeBox,
  type Scene,
} from '@trailerforge/graphics';
import {
  FALLBACK_FONTS,
  FLICKS_PER_SECOND,
  defaultBrand,
  resolveBrandFonts,
  type Brand,
} from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { fontFamilyName } from './font-name.js';
import { FrameRenderer, isCompletePng } from './renderer.js';

const F = FLICKS_PER_SECOND;
const HD = { width: 1920, height: 1080 };
const reg = builtinRegistry();

function scene(
  id: string,
  params: unknown,
  brand: Brand | null = null,
  logoPresent = false,
  present: ReadonlySet<string> = new Set(),
): Scene {
  const t = reg.get(id)!;
  return buildScene(t, {
    params,
    brand: brandTokens(brand, resolveBrandFonts(brand, present), HD, logoPresent),
    size: HD,
    duration: t.duration.default,
    safe: safeBox(HD),
  });
}
const title = () =>
  scene('core/title-card', { text: 'Ember Knight', subtitle: 'A dark fantasy action RPG' });

/** Count pixels brighter than `min` in a channel, over a region. */
function bright(
  px: { width: number; rgba: Buffer },
  box: { x: number; y: number; w: number; h: number },
  min = 200,
) {
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) if (px.rgba[(y * px.width + x) * 4]! > min) n++;
  return n;
}

describe('font names', () => {
  it('reads the family from the shipped fonts, and nothing from other files', async () => {
    for (const f of FALLBACK_FONTS)
      expect(fontFamilyName(await readFile(fallbackFontPath(f)))).toBe('Inter');
    expect(fontFamilyName(Buffer.from('not a font at all'))).toBeNull();
    expect(fontFamilyName(new Uint8Array(4))).toBeNull();
  });
});

describe('FrameRenderer', () => {
  it('renders byte-identical frames for the same input, through the cache or not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-frames-'));
    const s = title();
    const a = await (await FrameRenderer.create({ cacheDir: false })).renderFrame(s, 1.5 * F);
    const b = await (await FrameRenderer.create({ cacheDir: false })).renderFrame(title(), 1.5 * F);
    expect(isCompletePng(a.png)).toBe(true);
    expect(b.png.equals(a.png)).toBe(true);
    expect(b.hash).toBe(a.hash);
    const cached = await FrameRenderer.create({ cacheDir: dir });
    const first = await cached.renderFrame(s, 1.5 * F);
    const again = await cached.renderFrame(s, 1.5 * F);
    expect([first.cached, again.cached]).toEqual([false, true]);
    expect(again.png.equals(a.png)).toBe(true);
    // A different frame is a different picture.
    expect((await cached.renderFrame(s, 0.2 * F)).hash).not.toBe(a.hash);
  });

  it('renders a damaged cache entry again instead of using it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-frames-'));
    const r = await FrameRenderer.create({ cacheDir: dir });
    const f = await r.renderFrame(title(), F);
    const file = join(dir, f.hash.slice(0, 2), `${f.hash}.png`);
    await writeFile(file, f.png.subarray(0, f.png.length / 2)); // a torn write
    const again = await r.renderFrame(title(), F);
    expect(again.cached).toBe(false);
    expect(again.png.equals(f.png)).toBe(true);
    expect((await readFile(file)).equals(f.png)).toBe(true);
  });

  it('writes a numbered PNG sequence, rendering still frames once', async () => {
    const work = await mkdtemp(join(tmpdir(), 'tforge-seq-'));
    const r = await FrameRenderer.create({ cacheDir: join(work, 'cache') });
    const s = title();
    const out = await r.renderSequence(s, { num: 30, den: 1 }, join(work, 'seq'));
    expect(out.frames).toBe(90);
    expect(out.unique).toBeLessThan(out.frames);
    const files = (await readdir(out.dir)).sort();
    expect(files).toHaveLength(90);
    expect(files[0]).toBe('frame_000000.png');
    expect(files.at(-1)).toBe('frame_000089.png');
    const mid = await readFile(join(out.dir, 'frame_000045.png'));
    expect(mid.equals((await r.renderFrame(s, 45 * (F / 30))).png)).toBe(true);
    const rerun = await r.renderSequence(s, { num: 30, den: 1 }, join(work, 'seq2'));
    expect(rerun.rendered).toBe(0); // everything came from the cache
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      r.renderSequence(s, { num: 30, den: 1 }, join(work, 'seq3'), { signal: ctrl.signal }),
    ).rejects.toThrow();
  }, 30_000);

  it('keeps the alpha of overlays', async () => {
    const r = await FrameRenderer.create({ cacheDir: false });
    const s = scene('core/caption', { text: 'Parry to counter' });
    const { rgba, width } = await r.pixels(renderSvg(s, 1.25 * F), 'rgba(0,0,0,0)');
    expect(rgba[3]).toBe(0); // the corner is transparent
    const box = s.layers.find((l) => l.kind === 'rect')!.box;
    const i = (Math.round(box.y + 4) * width + Math.round(box.x + 4)) * 4;
    expect(rgba[i + 3]).toBeGreaterThan(150); // the plate is mostly opaque
    expect(rgba[i + 3]).toBeLessThan(255);
  });

  it('uses a brand font file under its own family name, and warns about WOFF2', async () => {
    const project = await mkdtemp(join(tmpdir(), 'tforge-brandfont-'));
    await mkdir(join(project, 'media'));
    const bold = fallbackFontPath(FALLBACK_FONTS[1]!);
    const hash = 'e'.repeat(64);
    await copyFile(bold, join(project, 'media', `${hash}.otf`));
    const brand: Brand = {
      ...defaultBrand(),
      fonts: [
        {
          role: 'heading',
          family: 'My Brand Font',
          bold: true,
          file: { hash, ext: 'otf', name: 'brand.otf' },
        },
      ],
    };
    const r = await FrameRenderer.create({ projectDir: project, brand, cacheDir: false });
    expect(r.warnings).toEqual([]);
    expect(r.fonts.heading.source).toBe('brand');
    const s = scene(
      'core/title-card',
      { text: 'Ember Knight' },
      brand,
      false,
      new Set([`${hash}.otf`]),
    );
    expect(renderSvg(s, F)).toContain('font-family="My Brand Font"');
    expect(await r.prepare(renderSvg(s, F))).toContain('font-family="Inter"');
    const px = await r.pixels(renderSvg(s, 1.5 * F), '#000000');
    expect(bright(px, { x: 0, y: 0, w: 1920, h: 1080 })).toBeGreaterThan(5000); // the text was drawn

    const woff = 'f'.repeat(64);
    await writeFile(join(project, 'media', `${woff}.woff2`), 'wOF2....');
    const w = await FrameRenderer.create({
      projectDir: project,
      brand: {
        ...brand,
        fonts: [{ ...brand.fonts[0]!, file: { hash: woff, ext: 'woff2', name: 'b.woff2' } }],
      },
      cacheDir: false,
    });
    expect(w.warnings).toEqual([
      expect.stringMatching(/WOFF2 file, which the renderer cannot read yet/),
    ]);
  });

  it('draws the brand logo from the project media, and nothing when it is missing', async () => {
    const project = await mkdtemp(join(tmpdir(), 'tforge-logo-'));
    await mkdir(join(project, 'media'));
    const hash = 'a'.repeat(64);
    const logo =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ffffff"/></svg>';
    await writeFile(join(project, 'media', `${hash}.svg`), logo);
    const brand: Brand = { ...defaultBrand(), logo: { hash, ext: 'svg', name: 'logo.svg' } };
    const s = scene('core/logo-card', {}, brand, true);
    const svg = renderSvg(s, 1.25 * F);
    const r = await FrameRenderer.create({ projectDir: project, brand, cacheDir: false });
    expect(await r.prepare(svg)).toContain('href="data:image/svg+xml;base64,');
    const box = s.layers[0]!.box;
    const region = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.w),
      h: Math.round(box.h),
    };
    expect(bright(await r.pixels(svg, '#000000'), region)).toBeGreaterThan(10_000);
    const elsewhere = await FrameRenderer.create({ cacheDir: false });
    expect(bright(await elsewhere.pixels(svg, '#000000'), region)).toBe(0);
  });

  it('renders a 1080p frame within its time budget', async () => {
    const r = await FrameRenderer.create({ cacheDir: false });
    const scenes = [
      title(),
      scene('core/end-slate', {
        text: 'Ember Knight',
        cta: 'Wishlist on Steam',
        detail: 'Coming 2027',
      }),
      scene('core/lower-third', { text: 'The Ash Warden', role: 'Final boss' }),
    ];
    const t0 = performance.now();
    let n = 0;
    for (const s of scenes)
      for (let k = 0; k < 8; k++) {
        r.rasterize(await r.prepare(renderSvg(s, Math.round((k + 1) * 0.3 * F))));
        n++;
      }
    const perFrame = (performance.now() - t0) / n;
    expect(perFrame).toBeLessThan(150); // about 15 ms here; a slow CI machine has room
  });
});

/** Chromium for the parity check: TFORGE_CHROMIUM, or the sandbox's preinstalled one. */
const CHROMIUM =
  process.env.TFORGE_CHROMIUM ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

describe.skipIf(!CHROMIUM)('parity with the browser preview', () => {
  it('draws the same frames as Chromium, within a small tolerance', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: HD, deviceScaleFactor: 1 });
      const font = async (i: number) =>
        (await readFile(fallbackFontPath(FALLBACK_FONTS[i]!))).toString('base64');
      const faces = `@font-face{font-family:Inter;font-weight:400;src:url(data:font/otf;base64,${await font(0)})}@font-face{font-family:Inter;font-weight:700;src:url(data:font/otf;base64,${await font(1)})}`;
      const r = await FrameRenderer.create({ cacheDir: false });
      const cases: [string, Scene, number][] = [
        ['title', title(), 1.5 * F],
        ['title fading in', title(), 0.2 * F],
        [
          'quote',
          scene('core/quote-card', {
            text: 'The tightest combat I have played all year.',
            source: 'Game Informer',
          }),
          2 * F,
        ],
        [
          'name label',
          scene('core/lower-third', { text: 'The Ash Warden', role: 'Final boss' }),
          1.5 * F,
        ],
        ['caption', scene('core/caption', { text: 'Parry to counter' }), 1.25 * F],
      ];
      for (const [name, s, at] of cases) {
        const svg = renderSvg(s, at);
        await page.setContent(
          `<html><head><style>${faces}html,body{margin:0;background:#28503c}</style></head><body>${svg}</body></html>`,
        );
        await page.evaluate(() => document.fonts.ready);
        const shot = (await page.screenshot({ type: 'png' })).toString('base64');
        const ours = r.rasterize(await r.prepare(svg), '#28503c').toString('base64');
        const diff = await page.evaluate(
          async ([a, b]) => {
            const load = async (src: string) => {
              const img = new Image();
              img.src = `data:image/png;base64,${src}`;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext('2d')!;
              ctx.drawImage(img, 0, 0);
              return ctx.getImageData(0, 0, c.width, c.height).data;
            };
            const [x, y] = [await load(a!), await load(b!)];
            let sum = 0;
            let off = 0;
            for (let i = 0; i < x.length; i += 4) {
              const d = Math.max(
                Math.abs(x[i]! - y[i]!),
                Math.abs(x[i + 1]! - y[i + 1]!),
                Math.abs(x[i + 2]! - y[i + 2]!),
              );
              sum += d;
              if (d > 64) off++;
            }
            return { mean: sum / (x.length / 4), off: off / (x.length / 4) };
          },
          [shot, ours],
        );
        console.log(
          `parity ${name}: mean ${diff.mean.toFixed(3)}, off ${(diff.off * 100).toFixed(3)}%`,
        );
        // Text antialiasing differs between Skia and resvg at glyph edges; shapes match exactly.
        expect(diff.mean, name).toBeLessThan(1);
        expect(diff.off, name).toBeLessThan(0.005);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
