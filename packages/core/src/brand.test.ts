import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FALLBACK_FONTS } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandFileError,
  brandStatus,
  fallbackFontPath,
  importBrandFile,
  sniffBrandFile,
  svgProblems,
} from './brand-files.js';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
let dir: string;
let work: string;
let clock = 0;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'tforge-brand-'));
  dir = join(work, 'B.tforge');
  store = await ProjectStore.create(dir, sampleProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
    now: () => new Date(Date.parse('2026-10-28T10:00:00Z') + clock),
  });
});
afterEach(() => store.close());

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const write = async (name: string, data: string | Uint8Array) => {
  const p = join(work, name);
  await writeFile(p, data);
  return p;
};
const font = () => readFile(fallbackFontPath(FALLBACK_FONTS[0]!));

describe('brand files', () => {
  it('ships the fallback fonts', async () => {
    for (const f of FALLBACK_FONTS)
      expect(sniffBrandFile(await readFile(fallbackFontPath(f)))).toBe('otf');
    expect(
      await readFile(join(fallbackFontPath(FALLBACK_FONTS[0]!), '..', 'LICENSE.txt'), 'utf8'),
    ).toMatch(/OFL/);
  });

  it('copies a logo into media/ by hash, once', async () => {
    const src = await write('logo.svg', SVG);
    const a = await importBrandFile(dir, src, 'logo');
    expect(a).toEqual({
      hash: createHash('sha256').update(SVG).digest('hex'),
      ext: 'svg',
      name: 'logo.svg',
    });
    expect(await importBrandFile(dir, await write('same.svg', SVG), 'logo')).toMatchObject({
      hash: a.hash,
      name: 'same.svg',
    });
    expect(await readdir(join(dir, 'media'))).toEqual([`${a.hash}.svg`]);
    expect(await readFile(join(dir, 'media', `${a.hash}.svg`), 'utf8')).toBe(SVG);
  });

  it('trusts content, not the extension, and refuses unsafe or wrong files', async () => {
    await expect(importBrandFile(dir, await write('x.png', SVG), 'logo')).resolves.toMatchObject({
      ext: 'svg',
    });
    await expect(importBrandFile(dir, await write('f.ttf', 'hello'), 'font')).rejects.toThrow(
      /not a TTF/,
    );
    await expect(importBrandFile(dir, await write('logo.svg', SVG), 'font')).rejects.toThrow(
      BrandFileError,
    );
    await expect(
      importBrandFile(dir, await write('font.otf', await font()), 'logo'),
    ).rejects.toThrow(/not an SVG or PNG/);
    await expect(
      importBrandFile(
        dir,
        await write('evil.svg', SVG.replace('<rect', '<script>x</script><rect')),
        'logo',
      ),
    ).rejects.toThrow(/script/);
    await expect(importBrandFile(dir, join(work, 'nope.svg'), 'logo')).rejects.toThrow(
      /cannot read/,
    );
    expect(svgProblems('<svg onload="x()"/>')).toEqual(['contains an event handler']);
    expect(svgProblems('<svg><image href="https://x.test/a.png"/></svg>')).toEqual([
      'refers to a file on the internet',
    ]);
    expect(svgProblems('<svg><script/></svg>')).toEqual(['contains a script']); // self-closing too
    expect(svgProblems('<svg><script href="x.js"/></svg>')).toEqual(['contains a script']);
    expect(svgProblems(SVG)).toEqual([]);
  });

  it('keeps the kit in project.json and warns about a missing font file', async () => {
    const logo = await importBrandFile(dir, await write('logo.svg', SVG), 'logo');
    const otf = await importBrandFile(dir, await write('Brand.otf', await font()), 'font');
    store.dispatch('core/brand.set-logo', { file: logo });
    store.dispatch('core/brand.set-font', {
      role: 'heading',
      font: { family: 'Brand', bold: true, file: otf },
    });
    store.dispatch('core/brand.set-colors', { patch: { primary: '#ffcc00' } });
    expect(store.state.brand).toMatchObject({
      logo,
      colors: { primary: '#ffcc00' },
      fonts: [{ role: 'heading', family: 'Brand' }],
    });
    expect((await brandStatus(dir, store.state.brand)).warnings).toEqual([]);

    await store.save();
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as {
      brand: unknown;
    };
    expect(saved.brand).toEqual(JSON.parse(JSON.stringify(store.state.brand)));

    // The font file goes missing (project copied without media/): fall back, with a warning.
    const copy = join(work, 'copy');
    await mkdir(join(copy, 'media'), { recursive: true });
    await writeFile(join(copy, 'media', `${logo.hash}.svg`), SVG);
    const status = await brandStatus(copy, store.state.brand);
    expect(status.fonts.heading.source).toBe('fallback');
    expect(status.warnings).toEqual([
      expect.stringMatching(/heading font "Brand" \(Brand.otf\) is missing/),
    ]);
  });

  it('flags low contrast through the status', async () => {
    store.dispatch('core/brand.set-colors', { patch: { text: '#888888', background: '#999999' } });
    const { warnings } = await brandStatus(dir, store.state.brand);
    expect(warnings[0]).toMatch(/text on background contrast is 1.2:1/);
  });
});

describe('core/brand commands', () => {
  it('create the kit on first use, undo, merge quick colour edits, and reset', () => {
    expect(store.state.brand).toBeNull();
    store.dispatch('core/brand.set-colors', { patch: { primary: '#aabbcc' } });
    clock += 200;
    store.dispatch('core/brand.set-colors', { patch: { accent: '#ddeeff' } });
    expect(store.state.brand!.colors).toMatchObject({ primary: '#aabbcc', accent: '#ddeeff' }); // the second edit kept the first
    store.undo();
    expect(store.state.brand).toBeNull(); // both edits were one step
    store.redo();
    store.dispatch('core/brand.set-scale', { patch: { title: 0.2 } });
    expect(store.state.brand!.typeScale.title).toBe(0.2);
    expect(() => store.dispatch('core/brand.set-scale', { patch: { title: 5 } })).toThrow();
    expect(() => store.dispatch('core/brand.set-colors', { patch: { text: 'blue' } })).toThrow();
    store.dispatch('core/brand.reset', {});
    expect(store.state.brand).toBeNull();
  });

  it('keeps one font per role and checks file types', () => {
    const f = (ext: 'otf' | 'png') => ({ hash: 'b'.repeat(64), ext, name: 'f' });
    store.dispatch('core/brand.set-font', { role: 'body', font: { family: 'A', file: f('otf') } });
    store.dispatch('core/brand.set-font', { role: 'body', font: { family: 'B', file: f('otf') } });
    store.dispatch('core/brand.set-font', {
      role: 'heading',
      font: { family: 'C', file: f('otf') },
    });
    expect(store.state.brand!.fonts.map((x) => [x.role, x.family])).toEqual([
      ['body', 'B'],
      ['heading', 'C'],
    ]);
    store.dispatch('core/brand.set-font', { role: 'body', font: null });
    expect(store.state.brand!.fonts).toHaveLength(1);
    expect(() =>
      store.dispatch('core/brand.set-font', {
        role: 'body',
        font: { family: 'D', file: f('png') },
      }),
    ).toThrow(/TTF/);
    expect(() => store.dispatch('core/brand.set-logo', { file: f('otf') })).toThrow(/SVG or PNG/);
  });
});
