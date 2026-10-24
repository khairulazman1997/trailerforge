import { JobError, defineJob, type JobQueue } from '@trailerforge/jobs';
import { probe } from '@trailerforge/media';
import { ContentHash, Rate } from '@trailerforge/schema';
import { z } from 'zod';
import {
  analyzeFootage,
  analyzeMusic,
  cached,
  footageCacheFile,
  musicCacheFile,
  readFootageAnalysis,
  readMusicAnalysis,
  type AnalyzeOptions,
} from './analyze.js';
import { PERMANENT_SIDECAR_CODES, SidecarError, type SidecarCommand } from './sidecar.js';

export const MUSIC_JOB = 'analysis/music';
export const FOOTAGE_JOB = 'analysis/footage';

const Input = z.strictObject({
  path: z.string().min(1),
  /** The library asset's quick hash: the cache key. */
  quickHash: ContentHash,
  /** The project's `cache/analysis` folder (`projectPaths(dir).analysisCache`). */
  analysisDir: z.string().min(1),
});
const FootageInput = Input.extend({
  /** Analysis rate and duration; probed from the file when missing. */
  rate: Rate.optional(),
  duration: z.number().positive().optional(),
});
type In = z.infer<typeof Input>;
type FootageIn = z.infer<typeof FootageInput>;

export interface AnalysisJobOptions {
  command?: SidecarCommand;
  ffmpeg?: string;
}

const toJobError = (err: unknown) =>
  err instanceof SidecarError
    ? new JobError(err.message, !PERMANENT_SIDECAR_CODES.has(err.code), err.code)
    : err;

/** Background analysis jobs; results are cached by asset hash and analyzer version. */
export function createAnalysisJobs(opts: AnalysisJobOptions = {}) {
  const base = (signal: AbortSignal, onProgress: (f: number) => void): AnalyzeOptions => ({
    signal,
    onProgress,
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
  });

  const music = defineJob<In, never, { cacheFile: string; cached: boolean }>({
    type: MUSIC_JOB,
    input: Input,
    maxAttempts: 2,
    concurrency: 1,
    run: async (ctx) => {
      const { path, quickHash, analysisDir } = ctx.input;
      const file = musicCacheFile(analysisDir, quickHash);
      try {
        const r = await cached(
          file,
          () => readMusicAnalysis(analysisDir, quickHash),
          () =>
            analyzeMusic(
              path,
              base(ctx.signal, (f) => ctx.progress(f)),
            ),
        );
        return { cacheFile: file, cached: r.cached };
      } catch (err) {
        throw toJobError(err);
      }
    },
  });

  const footage = defineJob<FootageIn, never, { cacheFile: string; cached: boolean }>({
    type: FOOTAGE_JOB,
    input: FootageInput,
    maxAttempts: 2,
    concurrency: 1,
    run: async (ctx) => {
      const { path, quickHash, analysisDir } = ctx.input;
      const file = footageCacheFile(analysisDir, quickHash);
      try {
        const r = await cached(
          file,
          () => readFootageAnalysis(analysisDir, quickHash),
          async () => {
            let { rate, duration } = ctx.input;
            if (!rate || !duration) {
              const info = await probe(path, { signal: ctx.signal });
              const v = info.video[0];
              if (!v) throw new JobError(`no video stream in ${path}`, false, 'no-video');
              rate ??= v.frameRate;
              duration ??= info.duration;
            }
            return analyzeFootage(
              path,
              { rate, duration },
              base(ctx.signal, (f) => ctx.progress(f)),
            );
          },
        );
        return { cacheFile: file, cached: r.cached };
      } catch (err) {
        throw toJobError(err);
      }
    },
  });

  return { music, footage };
}

export function registerAnalysisJobs(queue: JobQueue, opts: AnalysisJobOptions = {}): void {
  const jobs = createAnalysisJobs(opts);
  queue.register(jobs.music).register(jobs.footage);
}
