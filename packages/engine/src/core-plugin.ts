import { briefCommands } from '@trailerforge/brief';
import { BUILTIN_PLATFORMS } from './platforms.js';
import { builtinEffects, builtinTransitions } from '@trailerforge/effects';
import { builtinTemplates } from '@trailerforge/graphics';
import { genericExtractor, knowledgeCommands } from '@trailerforge/knowledge';
import { storyboardCommands } from '@trailerforge/storyboard';
import { critiqueCommands } from './critique-commands.js';
import { JobError, defineJob } from '@trailerforge/jobs';
import { MediaError, makeProxy, probe } from '@trailerforge/media';
import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import type { MediaInfo } from '@trailerforge/schema';
import { z } from 'zod';

const toJobError = (err: unknown) =>
  err instanceof MediaError ? new JobError(err.message, err.retryable, err.code) : err;

export const probeJob = defineJob<{ path: string }, never, MediaInfo>({
  type: 'core/media.probe',
  input: z.strictObject({ path: z.string().min(1) }),
  maxAttempts: 2,
  run: async (ctx) => {
    try {
      return await probe(ctx.input.path, { signal: ctx.signal });
    } catch (err) {
      throw toJobError(err);
    }
  },
});

export const proxyJob = defineJob<
  { path: string; out: string; height?: number | undefined },
  never,
  { out: string }
>({
  type: 'core/media.proxy',
  input: z.strictObject({
    path: z.string().min(1),
    out: z.string().min(1),
    height: z.int().positive().optional(),
  }),
  concurrency: 2,
  run: async (ctx) => {
    try {
      const info = await probe(ctx.input.path, { signal: ctx.signal });
      await makeProxy(ctx.input.path, info, ctx.input.out, {
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(p),
        ...(ctx.input.height ? { height: ctx.input.height } : {}),
      });
      return { out: ctx.input.out };
    } catch (err) {
      throw toJobError(err);
    }
  },
});

/** Built-in features, loaded through the same plugin path as third-party plugins. */
export const corePlugin = definePlugin({
  id: 'core',
  name: 'TrailerForge core',
  version: '0.0.0',
  apiVersion: PLUGIN_API_VERSION,
  register(ctx) {
    for (const platform of BUILTIN_PLATFORMS) ctx.platforms.register(platform);
    ctx.exportPresets.register({
      id: 'core/youtube-1080p',
      name: 'YouTube 1080p H.264',
      container: 'mp4',
      video: {
        codec: 'h264',
        resolution: { width: 1920, height: 1080 },
        bitrateKbps: 12_000,
        pixelFormat: 'yuv420p',
      },
      audio: { codec: 'aac', bitrateKbps: 320 },
      platformId: 'core/youtube',
      captions: ['srt'],
    });
    for (const command of briefCommands) ctx.commands.register(command);
    for (const command of storyboardCommands) ctx.commands.register(command);
    for (const command of knowledgeCommands) ctx.commands.register(command);
    for (const command of critiqueCommands) ctx.commands.register(command);
    for (const template of builtinTemplates) ctx.graphicTemplates.register(template);
    for (const t of builtinTransitions) ctx.transitions.register(t);
    for (const e of builtinEffects) ctx.effects.register(e);
    ctx.knowledgeExtractors.register(genericExtractor);
    ctx.jobs.register(probeJob);
    ctx.jobs.register(proxyJob);
  },
});
