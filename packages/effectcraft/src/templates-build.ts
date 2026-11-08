import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffectCraftCli } from './cli.js';
import { compatProblem } from './compat.js';
import { chunkCommands } from './scene-commands.js';
import { EC_TEMPLATES, templateAuthoringCommands, type TemplateManifest } from './templates.js';

/**
 * Makes the shipped `.ectemplate` files into `outDir` with the installed CLI (through its commands)
 * and writes `manifest.json` with their hashes. `cwd` is scratch space for the CLI.
 */
export async function buildTemplateFiles(
  cli: EffectCraftCli,
  outDir: string,
  cwd: string,
): Promise<TemplateManifest> {
  const version = await cli.version({ cwd });
  const problem = compatProblem(version, version ? await cli.commands({ cwd }) : null);
  if (problem) throw new Error(problem);
  await mkdir(outDir, { recursive: true });
  const manifest: TemplateManifest = { effectcraft: version!, templates: {} };
  for (const def of EC_TEMPLATES) {
    const dest = join(outDir, def.file);
    const project = join(cwd, `${def.file}.ecproj`);
    const chunks = chunkCommands(templateAuthoringCommands(def, dest));
    for (const [i, chunk] of chunks.entries())
      await cli.run(
        i === 0
          ? ['--empty', 'run', ...chunk, '--save-as', project, '--json']
          : ['--project', project, '--save', 'run', ...chunk, '--json'],
        { cwd },
      );
    manifest.templates[def.id] = {
      file: def.file,
      sha256: createHash('sha256')
        .update(await readFile(dest))
        .digest('hex'),
    };
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
