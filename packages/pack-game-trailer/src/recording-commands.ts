import { defineCommand, type CommandDef } from '@trailerforge/core';
import { z } from 'zod';
import { readPackKey, writePackKey } from './pack-ext.js';
import { RECORDING_FIELDS, RecordingOverrides, RecordingPatch } from './recording.js';

function store(extensions: Record<string, unknown>, next: RecordingOverrides): void {
  writePackKey(extensions, 'recording', Object.keys(next).length > 0 ? next : undefined);
}

function currentOverrides(extensions: Record<string, unknown>): RecordingOverrides {
  const parsed = RecordingOverrides.safeParse(readPackKey(extensions, 'recording') ?? {});
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
