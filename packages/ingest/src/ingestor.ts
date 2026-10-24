import { resolve } from 'node:path';
import type { AssetKind } from '@trailerforge/schema';
import { collectMediaFiles, type CollectOptions, type SkippedPath } from './files.js';
import { IMPORT_JOB, type IngestDeps } from './jobs.js';
import { FolderWatcher, type FolderWatcherOptions } from './watcher.js';

export interface ImportRequestOptions extends CollectOptions {
  projectId?: string;
  kind?: AssetKind;
}

export interface ImportRequest {
  /** One import job per file found, in the order they were found. */
  jobs: { path: string; jobId: string }[];
  skipped: SkippedPath[];
  truncated: boolean;
}

/**
 * Front door of footage ingest, shared by the CLI, the service and the watched folder: expand
 * what the user chose into files and queue one import job for each. Dropping the same file twice
 * while its import is still queued or running gives the same job.
 */
export class Ingestor {
  constructor(private readonly deps: Pick<IngestDeps, 'queue'>) {}

  async importPaths(paths: string[], opts: ImportRequestOptions = {}): Promise<ImportRequest> {
    const { projectId, kind, ...collect } = opts;
    const found = await collectMediaFiles(paths, collect);
    const jobs = found.files.map((path) => ({
      path,
      jobId: this.deps.queue.enqueue(
        IMPORT_JOB,
        { path, ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}) },
        { ...(projectId ? { projectId } : {}), dedupeKey: `${IMPORT_JOB}:${resolve(path)}` },
      ),
    }));
    return { jobs, skipped: found.skipped, truncated: found.truncated };
  }

  /** A watcher that queues an import for every recording that finishes in `folders`. */
  watch(options: Omit<FolderWatcherOptions, 'onReady'> & { projectId?: string }): FolderWatcher {
    const { projectId, ...rest } = options;
    return new FolderWatcher({
      ...rest,
      onReady: async (file) => {
        await this.importPaths([file.path], projectId ? { projectId } : {});
      },
    });
  }
}
