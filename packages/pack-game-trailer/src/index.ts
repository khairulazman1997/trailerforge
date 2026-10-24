import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { PACK_ID } from './brief-ext.js';
import { storyboardTemplates } from './templates.js';
import { unityExtractor } from './unity.js';
import { videoTypes } from './video-types.js';

export * from './brief-ext.js';
export * from './capture.js';
export * from './templates.js';
export * from './unity.js';
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
    for (const t of storyboardTemplates) ctx.templates.register(t);
    ctx.knowledgeExtractors.register(unityExtractor);
  },
});
