import { z } from 'zod';
import { resolveTools } from '@trailerforge/media';
import { callSidecar } from './sidecar.js';
import type { AnalyzeOptions } from './analyze.js';

/**
 * Facts measured on a reference clip (plan M10 decision 10), in seconds: they go to a model as
 * text, so they stay readable (not flicks). Measured locally by the sidecar; the clip never leaves.
 */
export const ReferenceFacts = z.object({
  seconds: z.number(),
  frameCount: z.int(),
  rate: z.object({ num: z.int(), den: z.int() }),
  colors: z.array(z.object({ hex: z.string(), share: z.number() })),
  brightness: z.object({ min: z.number(), max: z.number(), mean: z.number() }),
  events: z.array(
    z.union([
      z.object({ kind: z.enum(['flash', 'cut', 'appear']), at: z.number() }),
      z.object({ kind: z.enum(['fade-in', 'fade-out']), from: z.number(), to: z.number() }),
    ]),
  ),
  motion: z.object({ direction: z.string(), speed: z.number(), share: z.number() }),
});
export type ReferenceFacts = z.infer<typeof ReferenceFacts>;

export async function analyzeReference(
  path: string,
  opts: AnalyzeOptions & { duration?: number } = {},
): Promise<ReferenceFacts> {
  return ReferenceFacts.parse(
    await callSidecar(
      'analyze.reference',
      {
        path,
        ffmpeg: opts.ffmpeg ?? resolveTools().ffmpeg,
        ...(opts.duration ? { duration: opts.duration } : {}),
      },
      opts,
    ),
  );
}
