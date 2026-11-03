import { readFile } from 'node:fs/promises';
import { EffectCraftError, type EffectCraftCli } from './cli.js';
import { EFFECTCRAFT_SCHEMA, EFFECTCRAFT_VERSION } from './pin.js';

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
 * A `.ecproj` is accepted only when it has the pinned schema and the pinned EffectCraft opens it
 * cleanly (plan decision 3): files written by hand or by another tool get no other trust. A file
 * saved by another EffectCraft version with the same schema passes with a warning.
 */
export async function checkProjectFile(
  cli: EffectCraftCli,
  path: string,
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ header: ProjectHeader; warnings: string[] }> {
  const header = readProjectHeader(await readFile(path, 'utf8'));
  if (header.schema !== EFFECTCRAFT_SCHEMA)
    throw new EffectCraftError(
      'bad-project',
      `project schema ${header.schema} is not the pinned schema ${EFFECTCRAFT_SCHEMA}`,
    );
  try {
    await cli.run(['info', path, '--json'], opts);
  } catch (e) {
    if (e instanceof EffectCraftError && e.code === 'failed')
      throw new EffectCraftError('bad-project', `EffectCraft cannot open it: ${e.message}`);
    throw e;
  }
  const warnings =
    header.savedBy === EFFECTCRAFT_VERSION
      ? []
      : [
          `saved by EffectCraft ${header.savedBy || 'unknown'}, rendered with ${EFFECTCRAFT_VERSION}`,
        ];
  return { header, warnings };
}
