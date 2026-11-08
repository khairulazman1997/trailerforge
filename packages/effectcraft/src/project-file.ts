import { readFile } from 'node:fs/promises';
import { EffectCraftError, type EffectCraftCli } from './cli.js';
import { compareVersions } from './compat.js';

export interface ProjectHeader {
  /** The EffectCraft version that last saved the file. */
  savedBy: string;
  schema: number;
}

/** The `savedBy` and `schema` fields every `.ecproj` starts with. */
export function readProjectHeader(text: string): ProjectHeader {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new EffectCraftError('bad-project', 'not an EffectCraft project: the file is not JSON');
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (typeof o.schema !== 'number')
    throw new EffectCraftError('bad-project', 'not an EffectCraft project: no `schema` field');
  return { savedBy: typeof o.savedBy === 'string' ? o.savedBy : '', schema: o.schema };
}

/**
 * A `.ecproj` is accepted only when it is an EffectCraft project (a numeric `schema`) and the
 * installed EffectCraft opens it cleanly (plan decision 3): files written by hand or by another
 * tool get no other trust. A file saved by a newer EffectCraft than the one running passes with a
 * warning (it may use features this copy does not draw the same way).
 */
export async function checkProjectFile(
  cli: EffectCraftCli,
  path: string,
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; runningVersion?: string },
): Promise<{ header: ProjectHeader; warnings: string[] }> {
  const header = readProjectHeader(await readFile(path, 'utf8'));
  const { runningVersion, ...run } = opts;
  try {
    await cli.run(['info', path, '--json'], run);
  } catch (e) {
    if (e instanceof EffectCraftError && e.code === 'failed')
      throw new EffectCraftError('bad-project', `EffectCraft cannot open it: ${e.message}`);
    throw e;
  }
  const newer =
    runningVersion !== undefined &&
    /^\d+\.\d+\.\d+/.test(header.savedBy) &&
    compareVersions(header.savedBy, runningVersion) > 0;
  const warnings = newer
    ? [`saved by EffectCraft ${header.savedBy}, newer than the installed ${runningVersion}`]
    : [];
  return { header, warnings };
}
