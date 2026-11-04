import type { ProjectStore } from '@trailerforge/core';
import {
  SERIES_EPISODES_MAX,
  SERIES_EPISODES_MIN,
  shortVersionIds,
  shortTimelineId,
  type Series,
} from '@trailerforge/schema';
import { conceptsOp, type ConceptsOutcome } from './concepts-ops.js';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { exportVersionOp, type ExportResult, type Progress } from './render-ops.js';

export function findSeries(store: ProjectStore, seriesId: string): Series {
  const s = store.state.series.find((x) => x.id === seriesId);
  if (!s) throw new OpError('not-found', `no series "${seriesId}"`);
  return s;
}

/**
 * Ask the app's AI for episodes of a series (5 to 10 at once, none repeating an existing episode
 * or a waiting concept). They land in the waiting list linked to the series; pick each with
 * "Make this TikTok" to get an episode with the series' look.
 */
export async function seriesConceptsOp(
  engine: Engine,
  store: ProjectStore,
  seriesId: string,
  opts: { count?: number | undefined; ideas?: readonly string[] | undefined; signal?: AbortSignal | undefined } = {}, // prettier-ignore
): Promise<ConceptsOutcome> {
  const series = findSeries(store, seriesId);
  const count = Math.max(SERIES_EPISODES_MIN, Math.min(SERIES_EPISODES_MAX, opts.count ?? 6));
  return conceptsOp(engine, store, {
    series,
    count,
    ...(opts.ideas ? { ideas: opts.ideas } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export interface SeriesExportEntry {
  shortId: string;
  /** The version exported: the episode itself, or one of its hook versions. */
  versionId: string;
  episode: number | null;
  status: 'exported' | 'blocked' | 'failed' | 'skipped';
  file?: string;
  /** Why it was not exported. */
  reason?: string;
}

export interface SeriesExportResult {
  seriesId: string;
  entries: SeriesExportEntry[];
}

/**
 * Export every episode of a series (and the hook versions of each), one after another in episode
 * order. An episode the Quality Gate blocks, or that has no cut yet, is reported and the rest go
 * on; cancelling stops the queue.
 */
export async function exportSeriesOp(
  engine: Engine,
  store: ProjectStore,
  seriesId: string,
  o: { signal?: AbortSignal | undefined; onProgress?: ((p: Progress) => void) | undefined } = {},
): Promise<SeriesExportResult> {
  const series = findSeries(store, seriesId);
  const episodes = store.state.shorts
    .filter((x) => x.seriesId === series.id)
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || (a.id < b.id ? -1 : 1));
  if (episodes.length === 0) throw new OpError('usage', `"${series.name}" has no episodes yet`);
  const queue = episodes.flatMap((sh) => shortVersionIds(sh).map((v) => ({ sh, v })));
  const entries: SeriesExportEntry[] = [];
  for (const [i, { sh, v }] of queue.entries()) {
    o.signal?.throwIfAborted();
    const base = { shortId: sh.id, versionId: v, episode: sh.episode ?? null };
    if (!store.state.timelines.some((t) => t.id === shortTimelineId(sh.id))) {
      entries.push({ ...base, status: 'skipped', reason: 'its cut is not built yet' });
      continue;
    }
    try {
      const r: ExportResult = await exportVersionOp(engine, store, v, {
        ...(o.signal ? { signal: o.signal } : {}),
        onProgress: (p) =>
          o.onProgress?.({
            ...p,
            fraction: (i + p.fraction) / queue.length,
            message: `Episode ${sh.episode ?? '?'}: ${sh.name}`,
          }),
      });
      entries.push({ ...base, status: 'exported', file: r.file });
    } catch (err) {
      o.signal?.throwIfAborted();
      const blocked = err instanceof OpError && err.code === 'gate-blocked';
      entries.push({ ...base, status: blocked ? 'blocked' : 'failed', reason: err instanceof Error ? err.message : String(err) }); // prettier-ignore
    }
  }
  o.onProgress?.({ phase: 'done', fraction: 1 });
  return { seriesId, entries };
}
