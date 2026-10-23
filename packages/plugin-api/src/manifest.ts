import { PackId } from '@trailerforge/schema';
import { z } from 'zod';
import type { PluginContext } from './host.js';

/** Major version of the plugin API. Plugins declaring another major are refused. */
export const PLUGIN_API_VERSION = 1;

export const PluginManifest = z.strictObject({
  id: PackId,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'expected semver'),
  apiVersion: z.int().positive(),
  /** Plugins that must load first; failure of a dependency disables this plugin. */
  dependsOn: z.array(PackId).default([]),
});
export type PluginManifest = z.input<typeof PluginManifest>;

export interface Plugin extends PluginManifest {
  register(ctx: PluginContext): void | Promise<void>;
}

/** Identity helper that gives plugin authors type checking. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
