// `pnpm --filter @trailerforge/desktop package [--dir] [--skip-build]`: an unsigned Windows x64
// build. Stages a flat production copy of the app, adds resvg's Windows binary and the pinned uv,
// then runs electron-builder. Nothing here launches the app.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UV_VERSION = '0.11.32';
const UV_SHA256 = 'acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(here, '..', '..');
const args = new Set(process.argv.slice(2));
const run = (cmd, a, cwd = repo) =>
  execFileSync(cmd, a, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (!args.has('--skip-build')) run('pnpm', ['turbo', 'build']);

const stage = join(here, 'stage');
rmSync(stage, { recursive: true, force: true });
rmSync(join(here, 'release'), { recursive: true, force: true });
run('pnpm', [
  '--config.node-linker=hoisted',
  '--filter',
  '@trailerforge/desktop',
  'deploy',
  '--legacy',
  '--prod',
  stage,
]);

// resvg: keep only the Windows binding, at the version the renderer pins.
const resvg = join(stage, 'node_modules', '@resvg');
const version = JSON.parse(readFileSync(join(resvg, 'resvg-js', 'package.json'), 'utf8')).version;
for (const d of readdirSync(resvg))
  if (d !== 'resvg-js') rmSync(join(resvg, d), { recursive: true, force: true });
const tmp = mkdtempSync(join(tmpdir(), 'tforge-pack-'));
run('npm', ['pack', `@resvg/resvg-js-win32-x64-msvc@${version}`, '--pack-destination', tmp], tmp);
const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
const winDir = join(resvg, 'resvg-js-win32-x64-msvc');
mkdirSync(winDir, { recursive: true });
run('tar', ['-xzf', join(tmp, tgz), '-C', winDir, '--strip-components=1'], tmp);

// electron-builder would re-resolve dependencies from the workspace (and bring the Linux
// bindings back), so the staged node_modules ships as-is through extraResources instead.
const stagedPackage = join(stage, 'package.json');
const manifest = JSON.parse(readFileSync(stagedPackage, 'utf8'));
delete manifest.dependencies;
delete manifest.devDependencies;
delete manifest.optionalDependencies;
writeFileSync(stagedPackage, JSON.stringify(manifest, null, 2));

// uv: pinned, hash-checked.
const uvDir = join(here, 'vendor', 'uv');
if (!existsSync(join(uvDir, 'uv.exe'))) {
  const res = await fetch(UV_URL);
  if (!res.ok) throw new Error(`uv download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(buf).digest('hex');
  if (sum !== UV_SHA256) throw new Error(`uv checksum mismatch: ${sum}`);
  const zip = join(tmp, 'uv.zip');
  writeFileSync(zip, buf);
  mkdirSync(uvDir, { recursive: true });
  if (process.platform === 'win32') run('tar', ['-xf', zip, '-C', uvDir], tmp);
  else run('unzip', ['-o', '-j', zip, 'uv.exe', '-d', uvDir], tmp);
}
rmSync(tmp, { recursive: true, force: true });

run(
  'pnpm',
  ['exec', 'electron-builder', '--win', '--x64', ...(args.has('--dir') ? ['--dir'] : [])],
  here,
);
