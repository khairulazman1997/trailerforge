// `pnpm --filter @trailerforge/desktop package [--dir] [--skip-build]`: an unsigned Windows x64
// build. Stages a flat production copy of the app, adds resvg's Windows binary, the pinned uv and
// the pinned EffectCraft CLI, then runs electron-builder. Nothing here launches the app.
// `--effectcraft-zip=<file>` (or TFORGE_EFFECTCRAFT_ZIP) uses a downloaded release zip instead of
// fetching it; either way its sha256 must match the pin.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UV_VERSION = '0.11.32';
const UV_SHA256 = 'acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;

// EffectCraft (plan M8 decision 1): the release's portable zip; only `effectcraft-cli.exe` is kept
// (the desktop app is the user's own install, for "Open in EffectCraft"). Its licence files ship
// from `third-party/effectcraft`, copied from the v0.9.2 tag.
const EC_VERSION = '0.9.2';
const EC_ZIP = `effectcraft-${EC_VERSION}-windows-x64-portable.zip`;
const EC_URL = `https://github.com/storytold/effectcraft/releases/download/v${EC_VERSION}/${EC_ZIP}`;
// Not recorded yet: the release asset could not be downloaded where this script was written.
// Record it once from a trusted download (the release page's digest, or a build of the tag).
const EC_SHA256 = '';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(here, '..', '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const ecZipArg =
  argv.find((a) => a.startsWith('--effectcraft-zip='))?.slice('--effectcraft-zip='.length) ??
  process.env.TFORGE_EFFECTCRAFT_ZIP;
// On Windows the shell joins the arguments into one command line, so a path with a space
// (`D:\Craft Tools\...`) must be quoted or it arrives as two arguments.
const win = process.platform === 'win32';
const quote = (s) => (/[\s&|<>^()%!]/.test(s) ? `"${s}"` : s);
const run = (cmd, a, cwd = repo) =>
  execFileSync(cmd, win ? a.map(quote) : a, { cwd, stdio: 'inherit', shell: win });

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

// EffectCraft CLI: pinned, hash-checked; a stamp says which pin the vendored copy came from.
const ecDir = join(here, 'vendor', 'effectcraft');
const ecStamp = join(ecDir, 'PINNED');
const ecPin = `${EC_VERSION} ${EC_SHA256}\n`;
if (
  !existsSync(join(ecDir, 'effectcraft-cli.exe')) ||
  !existsSync(ecStamp) ||
  readFileSync(ecStamp, 'utf8') !== ecPin
) {
  let buf;
  if (ecZipArg) buf = readFileSync(ecZipArg);
  else {
    const res = await fetch(EC_URL);
    if (!res.ok)
      throw new Error(
        `EffectCraft download failed: ${res.status} (${EC_URL}); download it yourself and pass --effectcraft-zip=<file>`,
      );
    buf = Buffer.from(await res.arrayBuffer());
  }
  const sum = createHash('sha256').update(buf).digest('hex');
  if (!EC_SHA256)
    throw new Error(
      `EffectCraft's pinned sha256 is not recorded yet. ${EC_ZIP} hashes to ${sum}: check it against the v${EC_VERSION} release page, then set EC_SHA256 in apps/desktop/scripts/package.mjs.`,
    );
  if (sum !== EC_SHA256) throw new Error(`EffectCraft checksum mismatch: ${sum}`);
  const zip = join(tmp, 'effectcraft.zip');
  const out = join(tmp, 'effectcraft');
  writeFileSync(zip, buf);
  mkdirSync(out, { recursive: true });
  if (process.platform === 'win32') run('tar', ['-xf', zip, '-C', out], tmp);
  else run('unzip', ['-o', '-q', zip, '-d', out], tmp);
  const cli = readdirSync(out, { recursive: true }).find(
    (f) => basename(String(f)).toLowerCase() === 'effectcraft-cli.exe',
  );
  if (!cli) throw new Error(`${EC_ZIP} has no effectcraft-cli.exe`);
  rmSync(ecDir, { recursive: true, force: true });
  mkdirSync(ecDir, { recursive: true });
  copyFileSync(join(out, String(cli)), join(ecDir, 'effectcraft-cli.exe'));
  writeFileSync(ecStamp, ecPin);
}
rmSync(tmp, { recursive: true, force: true });

run(
  'pnpm',
  ['exec', 'electron-builder', '--win', '--x64', ...(args.has('--dir') ? ['--dir'] : [])],
  here,
);
