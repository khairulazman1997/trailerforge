import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinRegistry, buildScene, brandTokens, safeBox } from '@trailerforge/graphics';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EC_TEMPLATES,
  EffectCraftCli,
  EffectCraftRenderer,
  buildTemplateFiles,
  ecGraphicTemplates,
  ecTemplateById,
  loadTemplateFiles,
  templateAuthoringCommands,
  templateMisfit,
} from './index.js';

const STUB = fileURLToPath(new URL('./__fixtures__/stub-cli.mjs', import.meta.url));
const loc = { bin: process.execPath, prefixArgs: [STUB, 'ok'] };
const sec = (s: number) => Math.round(s * FLICKS_PER_SECOND);

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tf-ect-'));
  dir = join(root, 'templates');
  await mkdir(join(root, 'cwd-b'), { recursive: true });
  await buildTemplateFiles(new EffectCraftCli(loc), dir, join(root, 'cwd-b'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('shipped templates', () => {
  it('lists three templates, each with a built-in fallback that exists', () => {
    expect(EC_TEMPLATES.map((t) => t.id)).toEqual([
      'effectcraft/title-reveal',
      'effectcraft/logo-sting',
      'effectcraft/kinetic-text',
    ]);
    const builtin = builtinRegistry();
    for (const t of EC_TEMPLATES) expect(builtin.get(t.fallback)).toBeDefined();
  });

  it('authors each source composition with named layers, one control per text layer, and an export', () => {
    const cmds = templateAuthoringCommands(
      ecTemplateById('effectcraft/title-reveal')!,
      '/x/t.ectemplate',
    );
    expect(cmds[0]).toMatchObject({
      command: 'comp.new',
      params: { name: 'tf-title-reveal', width: 1920, height: 1080, duration: 10 },
    });
    expect(cmds.filter((c) => c.command === 'layer.newText').map((c) => c.params.name)).toEqual([
      'Title',
      'Subtitle',
    ]);
    expect(cmds.filter((c) => c.command === 'essential.addProperty')).toHaveLength(2);
    expect(cmds.at(-1)).toEqual({
      command: 'essential.exportTemplate',
      params: { comp: 'tf-title-reveal', path: '/x/t.ectemplate' },
    });
  });

  it('builds the files and a manifest; changed, missing or other-version files are not offered', async () => {
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(Object.keys(m.templates)).toHaveLength(3);
    expect(loadTemplateFiles(dir, '0.9.2')).toMatchObject({ problems: [] });
    expect(Object.keys(loadTemplateFiles(dir, '0.9.2').files)).toHaveLength(3);
    expect(loadTemplateFiles(dir, '0.9.3').problems[0]).toMatch(/not 0\.9\.3/);
    await writeFile(join(dir, 'logo-sting.ectemplate'), 'tampered');
    const r = loadTemplateFiles(dir, '0.9.2');
    expect(Object.keys(r.files)).toEqual(['effectcraft/title-reveal', 'effectcraft/kinetic-text']);
    expect(r.problems).toEqual([
      'template effectcraft/logo-sting does not match its recorded hash',
    ]);
    expect(loadTemplateFiles(join(root, 'none'), '0.9.2').problems[0]).toMatch(
      /no EffectCraft templates/,
    );
  });

  it('registers stand-ins only for available templates, drawing the fallback scene', () => {
    expect(ecGraphicTemplates(new Set())).toEqual([]);
    const [t] = ecGraphicTemplates(new Set(['effectcraft/title-reveal']));
    expect(t).toMatchObject({ id: 'effectcraft/title-reveal', kind: 'card', serves: [] });
    const brand = brandTokens(null, undefined, { width: 1920, height: 1080 });
    const ctx = {
      size: { width: 1920, height: 1080 },
      brand,
      safe: safeBox({ width: 1920, height: 1080 }),
      duration: sec(3),
    };
    const reg = builtinRegistry();
    const a = buildScene(t!, { ...ctx, params: { text: 'EMBER KNIGHT' } } as never);
    const b = buildScene(reg.get('core/title-card')!, {
      ...ctx,
      params: { text: 'EMBER KNIGHT' },
    } as never);
    expect(a).toEqual(b);
  });

  it('checks size (same shape, smaller is fine) and length', () => {
    const d = ecTemplateById('effectcraft/title-reveal')!;
    expect(templateMisfit(d, { width: 1920, height: 1080 }, 3)).toBeNull();
    expect(templateMisfit(d, { width: 1280, height: 720 }, 3)).toBeNull();
    expect(templateMisfit(d, { width: 1080, height: 1920 }, 3)).toMatch(/made for 1920×1080/);
    expect(templateMisfit(d, { width: 3840, height: 2160 }, 3)).toMatch(/made for/);
    expect(templateMisfit(d, { width: 1920, height: 1080 }, 11)).toMatch(/at most 10 s/);
  });

  it('renders with the slot text on the template controls, and at draft size', async () => {
    const { files } = loadTemplateFiles(dir, '0.9.2');
    const r = new EffectCraftRenderer({ cli: loc, workRoot: join(root, 'work'), templates: files });
    expect(r.supports('effectcraft/kinetic-text')).toBe(true);
    const job = {
      templateId: 'effectcraft/title-reveal',
      params: { text: 'NIGHTFALL', subtitle: 'Season one', extra: 'dropped' },
      duration: sec(1),
      resolution: { width: 1920, height: 1080 },
      frameRate: { num: 30, den: 1 },
      outDir: join(root, 'full'),
    };
    expect((await r.render(job, new AbortController().signal)).frames).toBe(30);
    const a = await r.fingerprint(job);
    expect(await r.fingerprint({ ...job, params: { ...job.params, extra: 'other' } })).toBe(a);
    expect(await r.fingerprint({ ...job, params: { ...job.params, text: 'DAYBREAK' } })).not.toBe(
      a,
    );
    const draft = await r.render(
      { ...job, resolution: { width: 1280, height: 720 }, outDir: join(root, 'draft') },
      new AbortController().signal,
    );
    expect(draft.frames).toBe(30);
  });
});
