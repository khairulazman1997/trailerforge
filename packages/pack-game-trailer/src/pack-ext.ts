import { PACK_ID } from './brief-ext.js';

type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One key of this pack's data under `extensions['game-trailer']`, or undefined. */
export function readPackKey(extensions: Record<string, unknown>, key: string): unknown {
  const pack = extensions[PACK_ID];
  return isObject(pack) ? pack[key] : undefined;
}

/**
 * Sets (or, with `undefined`, removes) one key of the pack's data, leaving its other keys alone
 * and removing the pack object itself once it is empty.
 */
export function writePackKey(
  extensions: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const current = extensions[PACK_ID];
  const pack: Json = isObject(current) ? { ...current } : {};
  if (value === undefined) delete pack[key];
  else pack[key] = value;
  if (Object.keys(pack).length > 0) extensions[PACK_ID] = pack;
  else delete extensions[PACK_ID];
}
