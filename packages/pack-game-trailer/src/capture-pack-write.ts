import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@trailerforge/core';
import { capturePackJson, type CapturePack } from './capture-pack.js';
import { renderCapturePackHtml, renderCapturePackMarkdown } from './capture-pack-render.js';

export type CapturePackFormat = 'md' | 'html' | 'json';
export const CAPTURE_PACK_DIR = ['exports', 'capture'] as const;
const FILES: Record<CapturePackFormat, string> = {
  md: 'capture-pack.md',
  html: 'capture-pack.html',
  json: 'capture-pack.json',
};

export function renderCapturePack(pack: CapturePack, format: CapturePackFormat): string {
  return format === 'md'
    ? renderCapturePackMarkdown(pack)
    : format === 'html'
      ? renderCapturePackHtml(pack)
      : capturePackJson(pack);
}

/**
 * Writes the pack under `<projectDir>/exports/capture/` with fixed file names, replacing earlier
 * ones atomically. Returns the project-relative paths (forward slashes), never absolute ones.
 */
export async function writeCapturePack(
  projectDir: string,
  pack: CapturePack,
  formats: readonly CapturePackFormat[] = ['md', 'html', 'json'],
): Promise<string[]> {
  const dir = join(projectDir, ...CAPTURE_PACK_DIR);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const format of [...new Set(formats)].sort()) {
    await writeFileAtomic(join(dir, FILES[format]), renderCapturePack(pack, format));
    written.push([...CAPTURE_PACK_DIR, FILES[format]].join('/'));
  }
  return written;
}
