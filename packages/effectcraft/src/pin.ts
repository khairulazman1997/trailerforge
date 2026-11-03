/**
 * The one EffectCraft build TrailerForge drives (plan M8 decision 1). Updating it is a
 * TrailerForge release: the version goes into render plan hashes (8.3), so frames rendered by
 * another build are never mixed with these.
 */
export const EFFECTCRAFT_VERSION = '0.9.2';
/** The `.ecproj` schema the pinned build reads and writes (`"schema": 2` in the file). */
export const EFFECTCRAFT_SCHEMA = 2;

/** `effectcraft-cli --version` prints `effectcraft-cli 0.9.2`; returns the version or null. */
export function parseCliVersion(stdout: string): string | null {
  const m = /^effectcraft-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m.exec(stdout);
  return m ? m[1]! : null;
}

/** Null when `version` is the pinned one, else why it is refused. Exact match: no ranges. */
export function pinProblem(version: string | null): string | null {
  if (version === null) return 'effectcraft-cli did not report a version';
  if (version !== EFFECTCRAFT_VERSION)
    return `effectcraft-cli ${version} is not the pinned ${EFFECTCRAFT_VERSION}`;
  return null;
}
