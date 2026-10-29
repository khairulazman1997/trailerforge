import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What an unpacked Windows build must contain, checked against the folder `electron-builder`
 * wrote (`release/win-unpacked`). Returns the problems, empty when the build is complete. Used
 * by `pnpm package:check` after packaging, and tested against a fake tree.
 */
export function checkPackage(unpacked: string): string[] {
  const problems: string[] = [];
  const need = (rel: string, why: string) => {
    if (!existsSync(join(unpacked, rel))) problems.push(`missing ${rel} (${why})`);
  };
  const res = 'resources';
  const app = `${res}/app`;
  need('TrailerForge.exe', 'the app');
  need(`${app}/dist/main.js`, 'the main process');
  need(`${app}/preload.cjs`, 'the window preload');
  need(`${res}/ui/index.html`, 'the built interface');
  need(`${res}/uv/uv.exe`, 'the pinned uv that builds the analysis environment');
  need(`${res}/analysis/pyproject.toml`, 'the analysis sidecar source');
  need(`${res}/analysis/uv.lock`, "the sidecar's pinned packages");
  need(`${res}/analysis/.python-version`, "the sidecar's Python version");
  need(`${res}/analysis/src/tforge_analysis/__main__.py`, 'the sidecar entry point');

  const fonts = join(unpacked, res, 'assets', 'fonts');
  const ttf = existsSync(fonts) ? findFiles(fonts, /\.(ttf|otf)$/i) : [];
  if (ttf.length < 2) problems.push('missing the bundled Inter fonts under resources/assets/fonts');

  const nm = join(unpacked, app, 'node_modules');
  const win = join(nm, '@resvg', 'resvg-js-win32-x64-msvc');
  if (!existsSync(win) || findFiles(win, /\.node$/).length === 0)
    problems.push("missing resvg's Windows binary (@resvg/resvg-js-win32-x64-msvc, a .node file)");
  for (const other of ['linux-x64-gnu', 'linux-x64-musl', 'darwin-x64', 'darwin-arm64'])
    if (existsSync(join(nm, '@resvg', `resvg-js-${other}`)))
      problems.push(`a ${other} resvg binary came along; it is dead weight in a Windows build`);

  for (const [pkg, dir] of [
    ['llm', 'prompts'],
    ['brief', 'prompts'],
    ['storyboard', 'prompts'],
    ['knowledge', 'prompts'],
    ['pack-game-trailer', 'prompts'],
  ] as const)
    need(`${app}/node_modules/@trailerforge/${pkg}/${dir}`, `${pkg}'s prompt files`);
  need(`${app}/node_modules/@trailerforge/engine/dist/index.js`, 'the engine');

  for (const bad of ['.venv', 'tests', '__pycache__'])
    if (findDirs(join(unpacked, res, 'analysis'), bad).length)
      problems.push(`resources/analysis contains a ${bad} folder; only the source should ship`);
  return problems;
}

function walk(dir: string, visit: (path: string, isDir: boolean) => void): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const isDir = statSync(p).isDirectory();
    visit(p, isDir);
    if (isDir) walk(p, visit);
  }
}
function findFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  walk(dir, (p, d) => !d && re.test(p) && out.push(p));
  return out;
}
function findDirs(dir: string, name: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  walk(dir, (p, d) => d && p.endsWith(`/${name}`) && out.push(p));
  return out;
}
