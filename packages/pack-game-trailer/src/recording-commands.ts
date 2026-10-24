import { defineCommand, type CommandDef } from '@trailerforge/core';
import { z } from 'zod';
import { PACK_ID } from './brief-ext.js';
import { RECORDING_FIELDS, RecordingOverrides, RecordingPatch } from './recording.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Writes the overrides back under `extensions['game-trailer'].recording`, leaving any other
 * pack data alone and removing the key (and an emptied pack object) when nothing is overridden.
 */
function store(extensions: Record<string, unknown>, next: RecordingOverrides): void {
  const current = extensions[PACK_ID];
  const pack: Json = isObject(current) ? { ...current } : {};
  if (Object.keys(next).length > 0) pack['recording'] = next;
  else delete pack['recording'];
  if (Object.keys(pack).length > 0) extensions[PACK_ID] = pack;
  else delete extensions[PACK_ID];
}

function currentOverrides(extensions: Record<string, unknown>): RecordingOverrides {
  const pack = extensions[PACK_ID];
  const parsed = RecordingOverrides.safeParse(isObject(pack) ? (pack['recording'] ?? {}) : {});
  return parsed.success ? parsed.data : {};
}

/** Set or clear recording-setting overrides (`null` clears one field). */
export const setRecordingOverrides = defineCommand({
  type: 'game-trailer/recording.set-overrides',
  payload: RecordingPatch,
  label: () => 'Change recording settings',
  apply: (d, patch) => {
    const next: Record<string, unknown> = { ...currentOverrides(d.extensions) };
    for (const f of RECORDING_FIELDS) {
      const v = patch[f];
      if (v === undefined) continue;
      if (v === null) delete next[f];
      else next[f] = v;
    }
    store(d.extensions, RecordingOverrides.parse(next));
  },
});

/** Drop every override and go back to the derived settings. */
export const resetRecordingOverrides = defineCommand({
  type: 'game-trailer/recording.reset-overrides',
  payload: z.strictObject({}),
  label: () => 'Reset recording settings',
  apply: (d) => store(d.extensions, {}),
});

export const recordingCommands = [
  setRecordingOverrides,
  resetRecordingOverrides,
] as unknown as readonly CommandDef<unknown>[];
