// `pnpm --filter @trailerforge/effectcraft build:templates`: makes the three shipped `.ectemplate`
// files with the pinned EffectCraft CLI (`TFORGE_EFFECTCRAFT=<path to effectcraft-cli>`) and
// records their hashes in `templates/manifest.json`. Run after `pnpm build`; the files are
// committed, so a release does not need to rebuild them.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EffectCraftCli, buildTemplateFiles, locateCli } from '../dist/index.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const location = locateCli();
if (!location) {
  console.error('Set TFORGE_EFFECTCRAFT to the pinned effectcraft-cli.');
  process.exit(1);
}
const cwd = await mkdtemp(join(tmpdir(), 'tforge-ectemplates-'));
try {
  const manifest = await buildTemplateFiles(new EffectCraftCli(location), out, cwd);
  for (const [id, t] of Object.entries(manifest.templates))
    console.log(`${id}: ${t.file} ${t.sha256.slice(0, 12)}`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
