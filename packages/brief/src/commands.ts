import { defineCommand, type CommandDef } from '@trailerforge/core';
import { Assumption, FormatTarget, Id, PluginRef } from '@trailerforge/schema';
import { z } from 'zod';
import { setAt } from './path.js';

/** Paths under `brief.` that answers may write; assumptions have their own commands. */
const BriefPath = z
  .string()
  .regex(/^brief\.[^\s]+$/, 'path must start with "brief."')
  .refine((p) => !p.startsWith('brief.assumptions'), 'use the assumption commands');

export const setBriefField = defineCommand({
  type: 'core/brief.set-field',
  payload: z.strictObject({ path: BriefPath, value: z.json().optional() }),
  label: ({ path }) => `Set ${path.replace(/^brief\./, '')}`,
  apply: (d, { path, value }) => {
    setAt(d as unknown as Record<string, unknown>, path, value);
    // A real answer supersedes any assumption made for this field.
    d.brief.assumptions = d.brief.assumptions.filter((a) => a.field !== path);
  },
  merge: { key: ({ path }) => path, windowMs: 1500 },
});

export const setVideoType = defineCommand({
  type: 'core/brief.set-video-type',
  payload: z.strictObject({ videoTypeId: PluginRef }),
  label: () => 'Change video type',
  apply: (d, { videoTypeId }) => {
    d.brief.videoTypeId = videoTypeId;
  },
});

export const addFormatTarget = defineCommand({
  type: 'core/project.add-format-target',
  payload: FormatTarget,
  label: (f) => `Add format ${f.name}`,
  apply: (d, f) => {
    d.formatTargets.push(f);
    d.brief.assumptions = d.brief.assumptions.filter((a) => a.field !== 'formatTargets');
  },
});

export const removeFormatTarget = defineCommand({
  type: 'core/project.remove-format-target',
  payload: z.strictObject({ id: Id }),
  label: () => 'Remove format',
  apply: (d, { id }) => {
    d.formatTargets = d.formatTargets.filter((f) => f.id !== id);
  },
});

/** Logged, visible assumption used when the user chooses "proceed with assumptions". */
export const addAssumption = defineCommand({
  type: 'core/brief.add-assumption',
  payload: Assumption,
  label: (a) => `Assume ${a.field.replace(/^brief\./, '')}`,
  apply: (d, a) => {
    d.brief.assumptions = [...d.brief.assumptions.filter((x) => x.field !== a.field), a];
  },
});

export const removeAssumption = defineCommand({
  type: 'core/brief.remove-assumption',
  payload: z.strictObject({ field: z.string().min(1) }),
  label: ({ field }) => `Drop assumption for ${field.replace(/^brief\./, '')}`,
  apply: (d, { field }) => {
    d.brief.assumptions = d.brief.assumptions.filter((a) => a.field !== field);
  },
});

/** Registered by the core plugin. Payloads are validated at dispatch, so the list is type-erased. */
export const briefCommands = [
  setBriefField,
  setVideoType,
  addFormatTarget,
  removeFormatTarget,
  addAssumption,
  removeAssumption,
] as unknown as readonly CommandDef<unknown>[];
