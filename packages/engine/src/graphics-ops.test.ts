import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackFontPath } from '@trailerforge/core';
import { FALLBACK_FONTS } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile } from 'node:fs/promises';
import { Engine } from './engine.js';
import {
  attachSounds,
  brandImportOp,
  brandViewOp,
  createDefaultVariantsOp,
  deriveVariantOp,
  effectsViewOp,
  setSfxFolderOp,
  sfxViewOp,
  soundCatalog,
  templatePreviewOp,
  templatesViewOp,
  variantsViewOp,
} from './graphics-ops.js';

let root: string;
let engine: Engine;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-gfx-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
});
afterAll(async () => {
  await engine.close();
});
const sample = () =>
  engine.createProject(join(root, `P${++n}.tforge`), {
    ...sampleProject(),
    id: `proj_${n}`,
  } as never);

describe('versions', () => {
  it('lists them with what was dropped, suggests the missing formats and adds them in one step each', async () => {
    const store = await sample();
    const v = await variantsViewOp(engine, store);
    expect(v.hasMaster).toBe(true);
    expect(v.variants.map((x) => x.id)).toEqual(['var_tt']);
    const tt = v.variants[0]!;
    expect(tt.format).toMatchObject({
      name: 'TikTok 9:16',
      resolution: { width: 1080, height: 1920 },
    });
    expect(tt.derived!.slots.map((s) => s.slotId)).toContain('shot_parry');
    expect(tt.derived!.slots.every((s) => s.reason.length > 0)).toBe(true);
    expect(v.missing).toEqual([{ formatTargetId: 'fmt_yt', name: 'YouTube 16:9' }]);

    expect(createDefaultVariantsOp(store).added).toHaveLength(1);
    expect((await variantsViewOp(engine, store)).missing).toEqual([]);
    store.undo();
    expect((await variantsViewOp(engine, store)).missing).toHaveLength(1);

    const derived = await deriveVariantOp(engine, store, 'var_tt');
    expect(derived.timeline.variantId).toBe('var_tt');
    expect(derived.timeline.resolution).toEqual({ width: 1080, height: 1920 });
    await expect(deriveVariantOp(engine, store, 'var_nope')).rejects.toMatchObject({
      code: 'not-found',
    });
    // Derived data is never stored.
    expect(store.state.timelines.some((t) => t.variantId)).toBe(false);
  });

  it('says there is nothing to derive from without a storyboard or a cut', async () => {
    const store = await engine.createProject(join(root, `P${++n}.tforge`), { name: 'Empty' });
    expect(await variantsViewOp(engine, store)).toMatchObject({ hasMaster: false, variants: [] });
    expect(() => createDefaultVariantsOp(store)).toThrow(/no storyboard/);
  });
});

describe('brand kit', () => {
  it('imports a logo and fonts by hash, picks the role from the file, and warns about low contrast', async () => {
    const store = await sample();
    const before = await brandViewOp(store);
    expect(before).toMatchObject({ brand: null, warnings: [], contrast: [] });
    expect(before.fonts.heading).toBe('Inter Bold (shipped)');

    const logo = join(root, 'logo.svg');
    await writeFile(
      logo,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
    );
    const l = await brandImportOp(store, { kind: 'logo', path: logo });
    expect(l.file).toMatchObject({ ext: 'svg', name: 'logo.svg' });
    expect(store.state.brand!.logo).toEqual(l.file);

    const bold = join(root, 'Inter-Bold.otf');
    await copyFile(fallbackFontPath(FALLBACK_FONTS[1]!), bold);
    const f = await brandImportOp(store, { kind: 'font', path: bold });
    expect(f.family).toBe('Inter'); // read from the file
    expect(store.state.brand!.fonts).toEqual([
      expect.objectContaining({ role: 'heading', bold: true, family: 'Inter' }),
    ]);

    store.dispatch('core/brand.set-colors', { patch: { text: '#777777', background: '#888888' } });
    const v = await brandViewOp(store);
    expect(v.fonts.heading).toBe('Inter Bold');
    expect(v.contrast.map((c) => c.pair)).toContain('text on background');
    expect(v.warnings.some((w) => /contrast/.test(w))).toBe(true);
    store.undo(); // the colours; the logo and font stay
    expect(store.state.brand!.logo).toBeDefined();
    expect((await brandViewOp(store)).contrast).toEqual([]);
  });

  it('refuses files that are not what they claim, and unsafe logos', async () => {
    const store = await sample();
    const evil = join(root, 'evil.svg');
    await writeFile(
      evil,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(brandImportOp(store, { kind: 'logo', path: evil })).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringMatching(/script/),
    });
    const junk = join(root, 'font.ttf');
    await writeFile(junk, 'not a font');
    await expect(brandImportOp(store, { kind: 'font', path: junk })).rejects.toMatchObject({
      code: 'usage',
    });
    expect(store.state.brand).toBeNull();
  });
});

describe('graphics templates and effects', () => {
  it('lists the installed templates with their parameters', () => {
    const t = templatesViewOp(engine);
    expect(t.map((x) => x.id)).toContain('core/title-card');
    expect(t).toHaveLength(11);
    const title = t.find((x) => x.id === 'core/title-card')!;
    expect(title).toMatchObject({
      kind: 'card',
      serves: ['title'],
      duration: { default: 3, min: 1.5 },
    });
    expect(JSON.stringify(title.params)).toContain('"text"');
  });

  it('previews one frame with the brand kit: SVG, optional PNG, and what a viewer would notice', async () => {
    const store = await sample();
    const p = await templatePreviewOp(engine, store, {
      templateId: 'core/title-card',
      params: { text: 'Ember Knight' },
    });
    expect(p.svg).toContain('>Ember Knight</tspan>');
    expect(p.svg).toContain('fill="#0b0d12"');
    expect(p.warnings).toEqual([]);
    const png = await templatePreviewOp(engine, store, {
      templateId: 'core/title-card',
      params: { text: 'Ember Knight' },
      png: true,
    });
    expect(Buffer.from(png.png!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const rushed = await templatePreviewOp(engine, store, {
      templateId: 'core/caption',
      params: { text: 'Parry the Warden at the last possible moment' },
      seconds: 1,
      at: 0.5,
    });
    expect(rushed.warnings.some((w) => /reading it takes/.test(w))).toBe(true);
    await expect(
      templatePreviewOp(engine, store, { templateId: 'core/nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      templatePreviewOp(engine, store, {
        templateId: 'core/title-card',
        params: { colour: 'red' },
      }),
    ).rejects.toMatchObject({ code: 'usage' });
  });

  it('lists transitions, effects and sounds, marking the ones that flash', async () => {
    const v = await effectsViewOp(engine);
    expect(v.transitions.map((t) => t.id)).toContain('core/whip');
    expect(v.effects.map((e) => e.id)).toContain('core/vignette');
    expect(v.transitions.find((t) => t.id === 'core/flash')).toMatchObject({
      flashes: true,
      defaultSeconds: 0.12,
    });
    expect(v.effects.find((e) => e.id === 'core/grain')?.flashes).toBe(false);
    expect(v.sounds.generated).toEqual(['whoosh', 'riser', 'impact', 'sub-drop']);
  });
});

describe('sound effects', () => {
  it('sets and clears the user folder, classifies its files and refuses a missing folder', async () => {
    const dir = join(root, 'sfx-pack');
    await mkdir(dir);
    await writeFile(join(dir, 'Big-Impact.wav'), 'x');
    await writeFile(join(dir, 'door.wav'), 'x');
    const v = await setSfxFolderOp(engine, dir);
    expect(v.folder).toBe(dir);
    expect(v.files).toEqual([
      { name: 'Big-Impact.wav', kind: 'impact' },
      { name: 'door.wav', kind: 'custom' },
    ]);
    expect(v.warnings).toEqual([expect.stringMatching(/door\.wav: cannot tell what kind/)]);
    await expect(setSfxFolderOp(engine, join(root, 'missing'))).rejects.toMatchObject({
      code: 'usage',
    });
    expect((await setSfxFolderOp(engine, null)).folder).toBeNull();
    expect((await sfxViewOp(engine)).files).toEqual([]);
  });

  it('puts the sounds a cut uses into the library and the project, once', async () => {
    const store = await sample();
    const cat = await soundCatalog(engine);
    expect(cat.catalog.filter((o) => o.source === 'generated')).toHaveLength(4);
    const ids = await attachSounds(engine, store, cat.files, [
      'generated:impact',
      'generated:whoosh',
      'user:gone.wav',
    ]);
    expect([...ids.keys()]).toEqual(['generated:impact', 'generated:whoosh']);
    const sfxAssets = store.state.assets.filter((a) => a.role === 'sfx');
    expect(sfxAssets.map((a) => a.assetId).sort()).toEqual([...ids.values()].sort());
    expect(engine.library.get(ids.get('generated:impact')!)).toMatchObject({ kind: 'audio' });
    const again = await attachSounds(engine, store, cat.files, ['generated:impact']);
    expect(again.get('generated:impact')).toBe(ids.get('generated:impact'));
    expect(store.state.assets.filter((a) => a.role === 'sfx')).toHaveLength(2);
  });
});
