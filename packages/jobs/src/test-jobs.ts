/** Job definitions shared by tests and the crash child process. */
import { z } from 'zod';
import { defineJob } from './types.js';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

/** Counts `steps` steps, checkpointing after each; reports which steps ran in this attempt. */
export const stepJob = defineJob<
  { steps: number; stepMs: number },
  { done: number },
  { ranFrom: number; attempt: number }
>({
  type: 'test/steps',
  input: z.strictObject({ steps: z.int().positive(), stepMs: z.int().nonnegative() }),
  run: async (ctx) => {
    const from = ctx.checkpoint?.done ?? 0;
    for (let i = from; i < ctx.input.steps; i++) {
      await sleep(ctx.input.stepMs, ctx.signal);
      ctx.saveCheckpoint({ done: i + 1 });
      ctx.progress((i + 1) / ctx.input.steps, `step ${i + 1}`);
      process.stdout.write?.(`step ${i + 1}\n`);
    }
    return { ranFrom: from, attempt: ctx.attempt };
  },
});
