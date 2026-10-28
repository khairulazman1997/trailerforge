import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brandWarnings,
  resolveBrandFonts,
  type Brand,
  type BrandFile,
  type FallbackFont,
} from '@trailerforge/schema';
import { writeFileAtomic } from './store/fs-atomic.js';
import { projectPaths } from './store/layout.js';

/**
 * Brand files (logo, fonts) are copied into the project's `media/` under their content hash.
 * The same file is stored once; nothing is ever deleted here, so undo can always find a file.
 */

export type BrandFileKind = 'logo' | 'font';

export class BrandFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandFileError';
  }
}

const MAX_BYTES = { logo: 5 * 1024 * 1024, font: 10 * 1024 * 1024 } as const;

const startsWith = (b: Uint8Array, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);

/** What the content says the file is, or null. Extensions are not trusted. */
export function sniffBrandFile(bytes: Uint8Array): BrandFile['ext'] | null {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (startsWith(bytes, 0x00, 0x01, 0x00, 0x00) || startsWith(bytes, 0x74, 0x72, 0x75, 0x65))
    return 'ttf';
  if (startsWith(bytes, 0x4f, 0x54, 0x54, 0x4f)) return 'otf';
  if (startsWith(bytes, 0x77, 0x4f, 0x46, 0x32)) return 'woff2';
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^\uFEFF/, '');
  if (/<svg[\s>]/i.test(head) && /^\s*(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(head)) return 'svg';
  return null;
}

/** Reasons an SVG cannot be a logo: it could run code or fetch from the network. */
export function svgProblems(text: string): string[] {
  const out: string[] = [];
  if (/<script[\s>]/i.test(text)) out.push('contains a script');
  if (/\son[a-z]+\s*=/i.test(text)) out.push('contains an event handler');
  if (/<foreignObject[\s>]/i.test(text)) out.push('contains foreign content');
  if (
    /(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//i.test(text) ||
    /url\(\s*["']?\s*(?:https?:)?\/\//i.test(text)
  )
    out.push('refers to a file on the internet');
  return out;
}

/** Copy a logo or font into `media/` by hash; returns what the brand kit stores. */
export async function importBrandFile(
  projectDir: string,
  sourcePath: string,
  kind: BrandFileKind,
): Promise<BrandFile> {
  const name = basename(sourcePath);
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    throw new BrandFileError(`cannot read ${name}`);
  }
  if (!info.isFile()) throw new BrandFileError(`${name} is not a file`);
  if (info.size > MAX_BYTES[kind])
    throw new BrandFileError(`${name} is larger than ${MAX_BYTES[kind] / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await readFile(sourcePath));
  const ext = sniffBrandFile(bytes);
  const allowed = kind === 'logo' ? ['svg', 'png'] : ['ttf', 'otf', 'woff2'];
  if (!ext || !allowed.includes(ext))
    throw new BrandFileError(
      `${name} is not ${kind === 'logo' ? 'an SVG or PNG logo' : 'a TTF, OTF or WOFF2 font'}`,
    );
  if (ext === 'svg') {
    const problems = svgProblems(new TextDecoder().decode(bytes));
    if (problems.length)
      throw new BrandFileError(`${name} ${problems.join(' and ')}, so it cannot be used`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const paths = projectPaths(projectDir);
  await mkdir(paths.media, { recursive: true });
  await writeFileAtomic(join(paths.media, `${hash}.${ext}`), bytes);
  return { hash, ext, name: name.slice(0, 200) || `file${extname(sourcePath)}` };
}

/** `<hash>.<ext>` names in the project's `media/`. */
export async function mediaFileNames(projectDir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(projectPaths(projectDir).media));
  } catch {
    return new Set();
  }
}

/** The brand kit's problems and font choices, checked against what is in `media/` now. */
export async function brandStatus(projectDir: string, brand: Brand | null) {
  const present = await mediaFileNames(projectDir);
  return { warnings: brandWarnings(brand, present), fonts: resolveBrandFonts(brand, present) };
}

/** Where the shipped fallback fonts live (`assets/fonts/` at the app's root). */
export const FALLBACK_FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
export const fallbackFontPath = (f: Pick<FallbackFont, 'file'>) => join(FALLBACK_FONT_DIR, f.file);
