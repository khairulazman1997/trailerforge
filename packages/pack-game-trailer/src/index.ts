import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { PACK_ID } from './brief-ext.js';
import { captureTipsCommands } from './capture-tips-commands.js';
import { captureCommands } from './capture-commands.js';
import { recordingCommands } from './recording-commands.js';
import { storyboardTemplates } from './templates.js';
import { unityExtractor } from './unity.js';
import { videoTypes } from './video-types.js';

export * from './brief-ext.js';
export * from './capture.js';
export * from './capture-hints.js';
export * from './capture-pack.js';
export * from './capture-pack-render.js';
export * from './capture-pack-write.js';
export * from './capture-tips.js';
export * from './capture-tips-commands.js';
export * from './pack-ext.js';
export * from './capture-commands.js';
export * from './recording.js';
export * from './shot-codes.js';
export * from './matching.js';
export * from './recording-commands.js';
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
    for (const c of [...captureCommands, ...captureTipsCommands, ...recordingCommands])
      ctx.commands.register(c);
  },
});
