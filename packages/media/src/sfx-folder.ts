import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import {
  type SfxKind,
  type SfxOption,
  SFX_KINDS,
  SFX_SPECS,
  encodeWav,
  generatedCatalog,
  generatedSfxFileName,
  synthSfx,
} from '@trailerforge/effects';
import { resolveTools, type FfmpegTools } from './detect.js';
import { measureLoudness } from './loudness.js';
import { probe } from './probe.js';

/**
 * Sound effects on disk: the generated ones (written once, byte-identical every time) and the
 * user's own licensed or CC0 packs from a folder they choose. Nothing is downloaded.
 */

export const SFX_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.aif', '.aiff', '.m4a']);

/** What a file name says the sound is, by common words in pack file names; `custom` when unsure. */
export function guessSfxKind(name: string): SfxKind | 'custom' {
  const w = name.toLowerCase();
  if (/(whoosh|swoosh|swish|woosh|swipe|pass[\s_-]?by)/.test(w)) return 'whoosh';
  if (/(riser|rise|build[\s_-]?up|swell|sweep|uplifter)/.test(w)) return 'riser';
  if (/(sub[\s_-]?drop|sub[\s_-]?boom|downlifter|drop)/.test(w)) return 'sub-drop';
  if (/(impact|hit|boom|slam|punch|thud|stinger|explosion)/.test(w)) return 'impact';
  return 'custom';
}

export interface SfxFile {
  /** File name, also the sound's id (`user:<name>`). */
  name: string;
  path: string;
  kind: SfxKind | 'custom';
}

/** Audio files in the folder (not its subfolders), sorted by name. A missing folder is empty. */
export async function scanSfxFolder(dir: string): Promise<SfxFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SfxFile[] = [];
  for (const name of names.sort()) {
    if (!SFX_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    out.push({ name, path, kind: guessSfxKind(name) });
  }
  return out;
}

/** Write the generated sounds into `dir` (skipping files that are already right); returns their paths. */
export async function ensureGeneratedSfx(
  dir: string,
  sampleRate = 48_000,
): Promise<Map<SfxKind, string>> {
  await mkdir(dir, { recursive: true });
  const out = new Map<SfxKind, string>();
  for (const kind of SFX_KINDS) {
    const path = join(dir, generatedSfxFileName(kind));
    const wav = encodeWav(synthSfx(kind, { sampleRate }), sampleRate);
    let current = -1;
    try {
      current = (await stat(path)).size;
    } catch {
      // not written yet
    }
    if (current !== wav.length) {
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, wav);
      await rename(tmp, path);
    }
    out.set(kind, path);
  }
  return out;
}

export interface SfxCatalog {
  catalog: SfxOption[];
  /** Option id → file on disk. */
  files: Map<string, string>;
  warnings: string[];
}

/**
 * Everything available: the generated sounds (written to `generatedDir`) and the user's files,
 * with length and peak level measured (`custom` files, whose kind is unknown, are listed in
 * `warnings` but not offered: a cue needs to know what a sound is for).
 */
export async function buildSfxCatalog(opts: {
  generatedDir: string;
  userDir?: string;
  tools?: FfmpegTools;
}): Promise<SfxCatalog> {
  const tools = opts.tools ?? resolveTools();
  const catalog = generatedCatalog();
  const files = new Map<string, string>();
  for (const [kind, path] of await ensureGeneratedSfx(opts.generatedDir))
    files.set(`generated:${kind}`, path);
  const warnings: string[] = [];
  for (const f of opts.userDir ? await scanSfxFolder(opts.userDir) : []) {
    if (f.kind === 'custom') {
      warnings.push(
        `${f.name}: cannot tell what kind of sound it is; put whoosh, riser, impact or sub-drop in its name`,
      );
      continue;
    }
    try {
      const info = await probe(f.path, { tools });
      let peakDb = -6;
      try {
        const m = await measureLoudness(f.path, { tools });
        if (Number.isFinite(m.truePeakDb)) peakDb = m.truePeakDb;
      } catch {
        warnings.push(`${f.name}: could not measure its level; assuming -6 dB`);
      }
      catalog.push({
        id: `user:${f.name}`,
        source: 'user',
        kind: f.kind,
        duration: Math.round(info.duration * FLICKS_PER_SECOND),
        peakOffset: SFX_SPECS[f.kind].peakOffset,
        peakDb,
      });
      files.set(`user:${f.name}`, f.path);
    } catch (err) {
      warnings.push(
        `${f.name}: cannot be read as audio (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { catalog, files, warnings };
}
