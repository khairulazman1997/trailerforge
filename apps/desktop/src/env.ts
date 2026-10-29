// Imported first by `main.ts`, so the settings are in place before the engine loads.
import { join } from 'node:path';
import { app } from 'electron';
import { packagedEnv } from './packaged-env.js';

if (app.isPackaged) {
  const env = packagedEnv({
    resourcesPath: process.resourcesPath,
    userData: join(app.getPath('userData'), 'engine'),
    platform: process.platform,
  });
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
}
