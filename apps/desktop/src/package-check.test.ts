import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPackage } from './package-check.js';

const FILES = [
  'TrailerForge.exe',
  'resources/app/dist/main.js',
  'resources/app/preload.cjs',
  'resources/ui/index.html',
  'resources/uv/uv.exe',
  'resources/analysis/pyproject.toml',
  'resources/analysis/uv.lock',
  'resources/analysis/.python-version',
  'resources/analysis/src/tforge_analysis/__main__.py',
  'resources/assets/fonts/inter/Inter-Regular.ttf',
  'resources/assets/fonts/inter/Inter-Bold.ttf',
  'resources/app/node_modules/@resvg/resvg-js-win32-x64-msvc/resvg.win32-x64-msvc.node',
  'resources/app/node_modules/@trailerforge/engine/dist/index.js',
  ...['llm', 'brief', 'storyboard', 'knowledge', 'pack-game-trailer'].map(
    (p) => `resources/app/node_modules/@trailerforge/${p}/prompts/a.md`,
  ),
];

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'tforge-pkg-'));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), '');
  }
  return root;
}

describe('checkPackage', () => {
  it('accepts a complete tree', () => {
    expect(checkPackage(tree(FILES))).toEqual([]);
  });
  it('names what is missing and what should not be there', () => {
    const files = FILES.filter((f) => !f.endsWith('uv.exe') && !f.includes('win32-x64'));
    files.push('resources/app/node_modules/@resvg/resvg-js-linux-x64-gnu/a.node');
    files.push('resources/analysis/.venv/x');
    const problems = checkPackage(tree(files)).join('\n');
    expect(problems).toMatch(/uv\.exe/);
    expect(problems).toMatch(/Windows binary/);
    expect(problems).toMatch(/linux-x64-gnu/);
    expect(problems).toMatch(/\.venv/);
  });
});
