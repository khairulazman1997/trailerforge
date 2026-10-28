import {
  BrandColorsPatch,
  BrandFile,
  BrandFont,
  TypeScalePatch,
  defaultBrand,
} from '@trailerforge/schema';
import type { Draft } from 'immer';
import type { Brand, Project } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * The brand kit: colours, logo, fonts and type scale. The files themselves are imported (and
 * hashed into `media/`) by `importBrandFile`; these commands only record which files the kit
 * uses. Files are never deleted, so undo always finds them again.
 */
function brand(d: Draft<Project>): Draft<Brand> {
  d.brand ??= defaultBrand();
  return d.brand;
}

export const setBrandColors = defineCommand({
  type: 'core/brand.set-colors',
  payload: z.strictObject({ patch: BrandColorsPatch }),
  label: () => 'Change brand colours',
  apply: (d, { patch }) => {
    const b = brand(d);
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (b.colors as Record<string, string>)[k] = v;
  },
  merge: { key: () => 'colors', windowMs: 1500 },
});

/** Set the logo; null removes it. */
export const setBrandLogo = defineCommand({
  type: 'core/brand.set-logo',
  payload: z.strictObject({ file: BrandFile.nullable() }),
  label: ({ file }) => (file ? 'Set the logo' : 'Remove the logo'),
  apply: (d, { file }) => {
    if (file && file.ext !== 'svg' && file.ext !== 'png')
      throw new CommandError('core/brand.set-logo', 'a logo is an SVG or PNG file');
    const b = brand(d);
    if (file) b.logo = file;
    else delete b.logo;
  },
});

/** Set the font for a role (heading or body); null removes it (the shipped font is used). */
export const setBrandFont = defineCommand({
  type: 'core/brand.set-font',
  payload: z.strictObject({
    role: BrandFont.shape.role,
    font: z
      .strictObject({
        family: BrandFont.shape.family,
        bold: z.boolean().default(false),
        file: BrandFile,
      })
      .nullable(),
  }),
  label: ({ role, font }) => (font ? `Set the ${role} font` : `Remove the ${role} font`),
  apply: (d, { role, font }) => {
    const type = 'core/brand.set-font';
    if (font && (font.file.ext === 'svg' || font.file.ext === 'png'))
      throw new CommandError(type, 'a font is a TTF, OTF or WOFF2 file');
    const b = brand(d);
    b.fonts = b.fonts.filter((f) => f.role !== role);
    if (font) b.fonts.push(BrandFont.parse({ role, ...font }));
    b.fonts.sort((x, y) => (x.role < y.role ? -1 : 1));
  },
});

export const setBrandScale = defineCommand({
  type: 'core/brand.set-scale',
  payload: z.strictObject({ patch: TypeScalePatch }),
  label: () => 'Change text sizes',
  apply: (d, { patch }) => {
    const b = brand(d);
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (b.typeScale as Record<string, number>)[k] = v;
  },
  merge: { key: () => 'scale', windowMs: 1500 },
});

/** Forget the whole brand kit. */
export const resetBrand = defineCommand({
  type: 'core/brand.reset',
  payload: z.strictObject({}),
  label: () => 'Reset the brand kit',
  apply: (d) => {
    d.brand = null;
  },
});

export const brandCommands = [
  setBrandColors,
  setBrandLogo,
  setBrandFont,
  setBrandScale,
  resetBrand,
] as unknown as readonly CommandDef<unknown>[];
