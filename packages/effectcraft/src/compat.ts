import { BASIC_EFFECT_COMMANDS } from './effect-spec.js';

/**
 * Which EffectCraft TrailerForge works with (plan M10 decision 1, revised 2026-11-09): not one
 * pinned build but any installed one that passes a compatibility check: it reports a version no
 * older than `EFFECTCRAFT_MIN_VERSION` and has every command TrailerForge sends. The version still
 * goes into render content hashes (10.3), so frames of another build are never mixed with these,
 * and approvals made with another build show as out of date.
 */
export const EFFECTCRAFT_TESTED_VERSION = '0.22.0';
/** The oldest version the adapter was built and tested against (the 10.1 spike). */
export const EFFECTCRAFT_MIN_VERSION = '0.9.2';

/**
 * Every command id TrailerForge sends: the scene writer, the shipped-template author, the
 * example import, and the basic commands a model may use in a custom effect. A build missing any
 * of them is refused as a whole (with the missing ids named), not half used. The richer effect
 * commands (`RICH_EFFECT_COMMANDS`) are optional: a build without some of them is still used, and
 * the model is offered only what it lists.
 */
export const REQUIRED_COMMANDS: readonly string[] = [
  ...new Set([
    'comp.new',
    'layer.newText',
    'layer.newSolid',
    'layer.newNull',
    'prop.set',
    'prop.addKey',
    'keys.select',
    'keys.easyEase',
    'keys.toggleHold',
    'essential.addProperty',
    'essential.exportTemplate',
    'file.importLottie',
    'layer.addItem',
    ...BASIC_EFFECT_COMMANDS,
  ]),
];

/** `effectcraft-cli --version` prints `effectcraft-cli 0.22.0`; returns the version or null. */
export function parseCliVersion(stdout: string): string | null {
  const m = /^effectcraft-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m.exec(stdout);
  return m ? m[1]! : null;
}

/** Compares `major.minor.patch` numerically (anything after the patch number is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The ids in `effectcraft-cli commands --json` output (an array of `{ id, … }`), or null. */
export function parseCommandIds(stdout: string): Set<string> | null {
  try {
    const v: unknown = JSON.parse(stdout);
    if (!Array.isArray(v)) return null;
    const ids = v
      .map((c) => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids);
  } catch {
    return null;
  }
}

/**
 * What `commands --json` says about the given ids beyond `id`, `label` and `enabled` (their
 * parameters, as the build reports them), one compact line each, cut to `maxPerCommand`
 * characters. Ids it does not describe are left out; unreadable output gives an empty list.
 */
export function describeCommands(
  stdout: string,
  ids: readonly string[],
  maxPerCommand = 700,
): string[] {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of v)
    if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
      byId.set((c as { id: string }).id, c as Record<string, unknown>);
  const out: string[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const { id: _id, label: _label, enabled: _enabled, ...rest } = c;
    if (!Object.keys(rest).length) continue;
    const line = `${id}: ${JSON.stringify(rest)}`;
    out.push(line.length > maxPerCommand ? `${line.slice(0, maxPerCommand - 1)}…` : line);
  }
  return out;
}

/** Null when this build can be used, else why not, in words. */
export function compatProblem(version: string | null, commands: Set<string> | null): string | null {
  if (version === null) return 'effectcraft-cli did not report a version';
  if (compareVersions(version, EFFECTCRAFT_MIN_VERSION) < 0)
    return `EffectCraft ${version} is older than ${EFFECTCRAFT_MIN_VERSION}, the oldest version this app works with`;
  if (commands === null) return `EffectCraft ${version} did not list its commands`;
  const missing = REQUIRED_COMMANDS.filter((c) => !commands.has(c));
  if (missing.length)
    return `EffectCraft ${version} lacks commands this app uses: ${missing.join(', ')}`;
  return null;
}

/** A note for a build that passed the check but is not the one the app was tested with. */
export function untestedNote(version: string): string | null {
  return version === EFFECTCRAFT_TESTED_VERSION
    ? null
    : `EffectCraft ${version} passed the compatibility check; this app was tested with ${EFFECTCRAFT_TESTED_VERSION}`;
}
