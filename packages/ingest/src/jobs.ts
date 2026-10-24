import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fullHashFile, type LibraryStore } from '@trailerforge/core';
import { JobError, defineJob, type JobQueue } from '@trailerforge/jobs';
import {
  MediaError,
  ensureFreeSpace,
  extractThumbnail,
  makeFilmstrip,
  makeProxy,
  probe,
  type FfmpegTools,
} from '@trailerforge/media';
import { AssetKind, type MediaInfo } from '@trailerforge/schema';
import { z } from 'zod';
import { assetCachePaths } from './cache-paths.js';
import { mediaWarnings, type MediaWarning } from './warnings.js';

export const IMPORT_JOB = 'ingest/import-file';
export const PREVIEWS_JOB = 'ingest/previews';
export const FULL_HASH_JOB = 'ingest/full-hash';

export interface IngestDeps {
  library: LibraryStore;
  queue: JobQueue;
  /** The app home (previews are written under `<home>/library/cache`). */
  home: string;
  tools?: FfmpegTools;
  /** How long to watch a file for growth before importing it (default 400 ms). */
  growthCheckMs?: number;
  /** Wait before retrying a file that was still growing (default 3 s; six attempts in all). */
  retryDelayMs?: number;
  /**
   * Diagnostic hook called as an import moves through its stages (`start`, `registered`,
   * `probed`). Tests use it to hold a job at a known point; production leaves it unset.
   */
  onStage?: (stage: string, info: { path: string; assetId?: string }) => void | Promise<void>;
}

export interface ImportOutput {
  assetId: string;
  kind: AssetKind;
  /** A new library entry was written (false: the same recording was already imported). */
  created: boolean;
  /** A known recording whose file had moved now points here. */
  relinked: boolean;
  warnings: MediaWarning[];
}

const toJobError = (err: unknown) =>
  err instanceof MediaError ? new JobError(err.message, err.retryable, err.code) : err;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), {
      once: true,
    });
  });

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Move a finished file into place; copes with temp and cache being on different drives. */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const part = `${to}.copy-${process.pid}`;
    await copyFile(from, part);
    await rename(part, to);
    await rm(from, { force: true });
  }
}

/**
 * The three background jobs of footage ingest. Every step is safe to run twice, so a crash
 * anywhere just re-runs the job: the library dedupes by content, previews are written to a temp
 * folder and moved into place only when finished, and a job that is cancelled leaves nothing
 * behind but what had already been completed.
 */
export function createIngestJobs(deps: IngestDeps) {
  const { library, queue, home } = deps;
  const toolOpts = deps.tools ? { tools: deps.tools } : {};

  const importFile = defineJob<
    { path: string; kind?: AssetKind | undefined; projectId?: string | undefined },
    never,
    ImportOutput
  >({
    type: IMPORT_JOB,
    input: z.strictObject({
      path: z.string().min(1),
      kind: AssetKind.optional(),
      projectId: z.string().optional(),
    }),
    // A recording that is still growing is retried with the queue's backoff, not waited on.
    maxAttempts: 6,
    backoffMs: () => deps.retryDelayMs ?? 3000,
    run: async (ctx) => {
      const { path } = ctx.input;
      await deps.onStage?.('start', { path });
      ctx.signal.throwIfAborted();
      const first = await stat(path).catch(() => null);
      if (!first?.isFile()) throw new JobError(`file not found: ${path}`, false, 'file-not-found');
      await sleep(deps.growthCheckMs ?? 400, ctx.signal);
      const second = await stat(path).catch(() => null);
      if (!second || second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
        throw new JobError(`still being written: ${path}`, true, 'file-still-growing');
      }

      await library.reload();
      const result = await library.importFile(path, ctx.input.kind ? { kind: ctx.input.kind } : {});
      let asset = result.asset;
      await deps.onStage?.('registered', { path, assetId: asset.id });
      ctx.signal.throwIfAborted();

      let info: MediaInfo | undefined = asset.media;
      if ((asset.kind === 'video' || asset.kind === 'audio') && !info) {
        try {
          info = await probe(path, { signal: ctx.signal, ...toolOpts });
        } catch (err) {
          // A file that cannot be read as media does not belong in the library.
          if (result.created && err instanceof MediaError && !err.retryable) {
            await library.remove(asset.id);
          }
          throw toJobError(err);
        }
        const probed = info;
        asset = await library.update(asset.id, (a) => ({ ...a, media: probed }));
      }
      await deps.onStage?.('probed', { path, assetId: asset.id });

      const opts = ctx.input.projectId ? { projectId: ctx.input.projectId } : {};
      if (asset.kind === 'video' && info && info.video.length > 0) {
        queue.enqueue(
          PREVIEWS_JOB,
          { assetId: asset.id },
          { ...opts, dedupeKey: `${PREVIEWS_JOB}:${asset.id}` },
        );
      }
      if (!asset.contentHash && asset.kind !== 'other') {
        queue.enqueue(
          FULL_HASH_JOB,
          { assetId: asset.id },
          { ...opts, priority: -1, dedupeKey: `${FULL_HASH_JOB}:${asset.id}` },
        );
      }
      return {
        assetId: asset.id,
        kind: asset.kind,
        created: result.created,
        relinked: result.relinked,
        warnings: info ? mediaWarnings(info) : [],
      };
    },
  });

  const previews = defineJob<
    { assetId: string },
    never,
    { thumbnail: boolean; filmstrip: boolean; proxy: boolean }
  >({
    type: PREVIEWS_JOB,
    input: z.strictObject({ assetId: z.string().min(1) }),
    concurrency: 2,
    run: async (ctx) => {
      await library.reload();
      const asset = library.get(ctx.input.assetId);
      if (!asset)
        throw new JobError(`unknown library asset "${ctx.input.assetId}"`, false, 'unknown-asset');
      if ((await library.status(asset.id)) !== 'ok') {
        throw new JobError(`the file is missing or changed: ${asset.uri}`, false, 'file-missing');
      }
      const out = assetCachePaths(home, asset.quickHash);
      const done = { thumbnail: false, filmstrip: false, proxy: false };
      try {
        const info = asset.media ?? (await probe(asset.uri, { signal: ctx.signal, ...toolOpts }));
        if (info.video.length === 0) return done;
        await mkdir(out.dir, { recursive: true });
        // Roughly 1.5 MB per second of proxy, plus room for the stills.
        await ensureFreeSpace(out.dir, Math.ceil(info.duration * 1.5e6) + 5e6);

        const steps: {
          key: keyof typeof done;
          final: string;
          weight: number;
          make: (tmp: string, onP: (f: number) => void) => Promise<void>;
        }[] = [
          {
            key: 'thumbnail',
            final: out.thumbnail,
            weight: 0.05,
            make: (tmp) =>
              extractThumbnail(asset.uri, info.duration * 0.1, tmp, 320, {
                signal: ctx.signal,
                ...toolOpts,
              }),
          },
          {
            key: 'filmstrip',
            final: out.filmstrip,
            weight: 0.1,
            make: (tmp) =>
              makeFilmstrip(asset.uri, info, tmp, 10, 160, { signal: ctx.signal, ...toolOpts }),
          },
          {
            key: 'proxy',
            final: out.proxy,
            weight: 0.85,
            make: (tmp, onProgress) =>
              makeProxy(asset.uri, info, tmp, { signal: ctx.signal, onProgress, ...toolOpts }),
          },
        ];
        let base = 0;
        for (const step of steps) {
          ctx.signal.throwIfAborted();
          if (!(await exists(step.final))) {
            const tmp = join(ctx.tempDir, step.final.split(/[\\/]/).pop()!);
            await mkdir(ctx.tempDir, { recursive: true });
            await step.make(tmp, (f) => ctx.progress(base + step.weight * f));
            await moveFile(tmp, step.final);
            done[step.key] = true;
          }
          base += step.weight;
          ctx.progress(base);
        }
        return done;
      } catch (err) {
        throw toJobError(err);
      }
    },
  });

  const fullHash = defineJob<{ assetId: string }, never, { contentHash: string | null }>({
    type: FULL_HASH_JOB,
    input: z.strictObject({ assetId: z.string().min(1) }),
    concurrency: 1,
    run: async (ctx) => {
      await library.reload();
      const asset = library.get(ctx.input.assetId);
      if (!asset)
        throw new JobError(`unknown library asset "${ctx.input.assetId}"`, false, 'unknown-asset');
      if (asset.contentHash) return { contentHash: asset.contentHash };
      if ((await library.status(asset.id)) !== 'ok') return { contentHash: null }; // moved or changed: nothing to verify
      const contentHash = await fullHashFile(asset.uri, {
        signal: ctx.signal,
        onProgress: (done, total) => ctx.progress(total > 0 ? done / total : 1),
      });
      await library.update(asset.id, (a) => ({ ...a, contentHash }));
      return { contentHash };
    },
  });

  return { importFile, previews, fullHash };
}

/** Register the ingest job types on a queue (call before or after `queue.start()`). */
export function registerIngestJobs(deps: IngestDeps): void {
  const jobs = createIngestJobs(deps);
  deps.queue.register(jobs.importFile).register(jobs.previews).register(jobs.fullHash);
}
