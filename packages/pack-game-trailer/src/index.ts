import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { PACK_ID } from './brief-ext.js';
import { videoTypes } from './video-types.js';

export * from './brief-ext.js';
export * from './video-types.js';

/** Game Trailer domain pack: everything game-specific lives here, not in the core. */
export const gameTrailerPack = definePlugin({
  id: PACK_ID,
  name: 'Game Trailer pack',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION,
  dependsOn: ['core'],
  register(ctx) {
    for (const vt of videoTypes) ctx.videoTypes.register(vt);
  },
});
