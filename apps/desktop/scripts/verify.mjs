// `pnpm --filter @trailerforge/desktop package:check`: is the unpacked Windows build complete?
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage } from '../dist/package-check.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'release');
const unpacked = join(root, 'win-unpacked');
if (!existsSync(unpacked)) {
  console.error(
    'No release/win-unpacked: run `pnpm --filter @trailerforge/desktop package` first.',
  );
  process.exit(1);
}
const problems = checkPackage(unpacked);
const installers = existsSync(root)
  ? readdirSync(root).filter((f) => /Setup.*\.exe$/i.test(f))
  : [];
if (process.argv.includes('--installer') && !installers.length)
  problems.push(
    'no installer (TrailerForge-Setup-*.exe) in release/ (NSIS needs Windows, or wine, to build the installer)',
  );
if (problems.length) {
  console.error(`Package check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `Package complete: release/win-unpacked${installers.length ? `, ${installers.join(', ')}` : ' (no installer: build that on Windows)'}.`,
);
