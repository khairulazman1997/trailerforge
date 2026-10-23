import { PackId, ProjectStatus } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandRegistry, defineCommand } from './commands.js';

export const renameProject = defineCommand({
  type: 'core/project.rename',
  payload: z.strictObject({ name: z.string().min(1) }),
  label: ({ name }) => `Rename project to "${name}"`,
  apply: (d, { name }) => {
    d.name = name;
  },
  merge: { key: () => 'name', windowMs: 1000 },
});

export const setProjectStatus = defineCommand({
  type: 'core/project.set-status',
  payload: z.strictObject({ status: ProjectStatus }),
  label: ({ status }) => `Set status to ${status}`,
  apply: (d, { status }) => {
    d.status = status;
  },
});

/** Replace one plugin's extension slice. Plugins validate their own data before calling this. */
export const setProjectExtension = defineCommand({
  type: 'core/project.set-extension',
  payload: z.strictObject({ pluginId: PackId, value: z.json() }),
  label: ({ pluginId }) => `Update ${pluginId} data`,
  apply: (d, { pluginId, value }) => {
    d.extensions[pluginId] = value;
  },
});

export function coreCommands(registry = new CommandRegistry()): CommandRegistry {
  return registry.register(renameProject).register(setProjectStatus).register(setProjectExtension);
}
