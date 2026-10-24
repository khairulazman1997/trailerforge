import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  FOOTAGE_JOB,
  MUSIC_JOB,
  VISION_JOB,
  readFootageAnalysis,
  readRecordingEmbedding,
  readMusicAnalysis,
  summarizeFootage,
  type FootageAnalysis,
} from '@trailerforge/analysis';
import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import {
  buildRoughCut,
  mergeRoughCut,
  placeCaptions,
  resolveMusicGrid,
  type TakeSource,
} from '@trailerforge/cut';
import { assetCachePaths, mediaWarnings, type MediaWarning } from '@trailerforge/ingest';
import {
  acceptMatchesPayload,
  rankTakes,
  suggestMatches,
  type MatchRecording,
  type RecordingMatch,
  type TakeFacts,
} from '@trailerforge/pack-game-trailer';
import {
  FLICKS_PER_SECOND,
  type LibraryAsset,
  type Project,
  type ShotSlot,
} from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { readyVisionModel, visionScoresFor } from './vision-ops.js';

/**
 * Footage operations shared by the CLI, MCP server and local service: import, status, analysis,
 * matching, take ranking and the rough cut. Reads compute from the library, the analysis cache
 * and `project.json`; edits go through typed commands, so each is undoable.
 */

export const ROUGH_CUT_TIMELINE_ID = 'tl_rough';

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

function requireStoryboard(store: ProjectStore) {
  const sb = store.state.storyboard;
  if (!sb) throw new OpError('not-found', 'this project has no storyboard yet; generate one first');
  return sb;
}

/** Slot ids with a recording attached, by asset id. */
function attachedAssets(project: Project): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of project.storyboard?.sections ?? [])
    for (const slot of s.slots)
      if (slot.kind === 'shot')
        for (const t of slot.takes) out.set(t.assetId, [...(out.get(t.assetId) ?? []), slot.id]);
  return out;
}

// ---- import ----------------------------------------------------------------------------------

export interface ImportOutcome {
  jobs: { path: string; jobId: string }[];
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

/** Queue an import for each file found in `paths` (files, or folders searched for video and audio). */
export async function importFootageOp(
  engine: Engine,
  store: ProjectStore,
  opts: { paths: string[]; signal?: AbortSignal | undefined },
): Promise<ImportOutcome> {
  if (opts.paths.length === 0) throw new OpError('usage', 'give at least one file or folder');
  return engine.ingestor.importPaths(opts.paths, {
    projectId: store.state.id,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

// ---- status ----------------------------------------------------------------------------------

export interface FootageEntry {
  assetId: string;
  name: string;
  kind: LibraryAsset['kind'];
  /** `missing` or `changed` when the file is not where it was; relink to fix. */
  file: 'ok' | 'missing' | 'changed';
  durationSec: number | null;
  warnings: MediaWarning[];
  analyzed: boolean;
  previews: { thumbnail: boolean; proxy: boolean };
  /** Shots this recording is a take of. */
  slotIds: string[];
  inProject: boolean;
}

/** Every video in the library with what is known about it, and import progress for this project. */
export async function footageStatusOp(
  engine: Engine,
  store: ProjectStore,
): Promise<{
  footage: FootageEntry[];
  /** Music and other sound files in the library, for choosing the track. */
  music: {
    assetId: string;
    name: string;
    durationSec: number | null;
    analyzed: boolean;
    chosen: boolean;
  }[];
  jobs: { queued: number; running: number; failed: { id: string; type: string; error: string }[] };
}> {
  await engine.library.reload();
  const attached = attachedAssets(store.state);
  const inProject = new Set(store.state.assets.map((a) => a.assetId));
  const footage: FootageEntry[] = [];
  for (const a of engine.library.list()) {
    if (a.kind !== 'video') continue;
    const cache = assetCachePaths(engine.home, a.quickHash);
    footage.push({
      assetId: a.id,
      name: a.originalName,
      kind: a.kind,
      file: await engine.library.status(a.id),
      durationSec: a.media?.duration ?? null,
      warnings: a.media ? mediaWarnings(a.media) : [],
      analyzed: (await readFootageAnalysis(store.paths.analysisCache, a.quickHash)) !== null,
      previews: { thumbnail: await exists(cache.thumbnail), proxy: await exists(cache.proxy) },
      slotIds: attached.get(a.id) ?? [],
      inProject: inProject.has(a.id),
    });
  }
  const chosen = store.state.storyboard?.music.trackAssetId;
  const music: Awaited<ReturnType<typeof footageStatusOp>>['music'] = [];
  for (const a of engine.library.list()) {
    if (a.kind !== 'audio') continue;
    music.push({
      assetId: a.id,
      name: a.originalName,
      durationSec: a.media?.duration ?? null,
      analyzed: (await readMusicAnalysis(store.paths.analysisCache, a.quickHash)) !== null,
      chosen: a.id === chosen,
    });
  }
  const jobs = engine.jobs.list({ projectId: store.state.id });
  return {
    footage,
    music,
    jobs: {
      queued: jobs.filter((j) => j.status === 'queued').length,
      running: jobs.filter((j) => j.status === 'running').length,
      failed: jobs
        .filter((j) => j.status === 'failed')
        .map((j) => ({ id: j.id, type: j.type, error: j.error?.message ?? 'failed' })),
    },
  };
}

// ---- analysis --------------------------------------------------------------------------------

/**
 * Queue footage analysis for recordings (all unanalysed ones by default) and the music track.
 * When the vision model is downloaded, also embed sampled frames of recordings not yet embedded.
 */
export async function analyzeOp(
  engine: Engine,
  store: ProjectStore,
  opts: { assetIds?: string[] | undefined; music?: boolean | undefined } = {},
): Promise<{ jobs: { assetId: string; type: string; jobId: string }[]; skipped: string[] }> {
  await engine.library.reload();
  const analysisDir = store.paths.analysisCache;
  const vision = await readyVisionModel(engine);
  const jobs: { assetId: string; type: string; jobId: string }[] = [];
  const skipped: string[] = [];
  const wanted = opts.assetIds ? new Set(opts.assetIds) : null;
  for (const a of engine.library.list()) {
    if (a.kind !== 'video' || (wanted && !wanted.has(a.id))) continue;
    if (!a.media?.video[0]) {
      skipped.push(`${a.originalName}: not probed yet`);
      continue;
    }
    if (
      vision &&
      a.media.duration > 0 &&
      (wanted || !(await readRecordingEmbedding(vision.modelId, a.quickHash, analysisDir)))
    ) {
      jobs.push({
        assetId: a.id,
        type: VISION_JOB,
        jobId: engine.jobs.enqueue(
          VISION_JOB,
          {
            path: a.uri,
            quickHash: a.quickHash,
            analysisDir,
            durationSec: a.media.duration,
            ...vision,
          },
          {
            projectId: store.state.id,
            dedupeKey: `${VISION_JOB}:${vision.modelId}:${a.quickHash}`,
          },
        ),
      });
    }
    if (!wanted && (await readFootageAnalysis(analysisDir, a.quickHash))) continue;
    const v = a.media.video[0];
    jobs.push({
      assetId: a.id,
      type: FOOTAGE_JOB,
      jobId: engine.jobs.enqueue(
        FOOTAGE_JOB,
        {
          path: a.uri,
          quickHash: a.quickHash,
          analysisDir,
          rate: v.frameRate,
          duration: a.media.duration,
        },
        { projectId: store.state.id, dedupeKey: `${FOOTAGE_JOB}:${a.quickHash}` },
      ),
    });
  }
  const trackId = store.state.storyboard?.music.trackAssetId;
  if (opts.music !== false && trackId) {
    const track = engine.library.get(trackId);
    if (!track) skipped.push(`the music track ${trackId} is not in the library`);
    else if (!(await readMusicAnalysis(analysisDir, track.quickHash)) || wanted?.has(trackId)) {
      jobs.push({
        assetId: trackId,
        type: MUSIC_JOB,
        jobId: engine.jobs.enqueue(
          MUSIC_JOB,
          { path: track.uri, quickHash: track.quickHash, analysisDir },
          { projectId: store.state.id, dedupeKey: `${MUSIC_JOB}:${track.quickHash}` },
        ),
      });
    }
  }
  return { jobs, skipped };
}

// ---- matching --------------------------------------------------------------------------------

function recordings(engine: Engine, project: Project, assetIds?: string[]): MatchRecording[] {
  const wanted = assetIds ? new Set(assetIds) : null;
  const music = project.storyboard?.music.trackAssetId;
  return engine.library
    .list()
    .filter((a) => a.kind === 'video' && a.id !== music && (!wanted || wanted.has(a.id)))
    .map((a) => ({
      assetId: a.id,
      name: a.originalName,
      ...(a.fileModifiedAt ? { recordedAt: a.fileModifiedAt } : {}),
      ...(a.media ? { durationSec: a.media.duration } : {}),
    }));
}

/**
 * Ranked suggestions for which shot each imported recording belongs to. With the vision model
 * downloaded, frame vectors the analysis already cached add an "AI vision" signal; recordings
 * not embedded yet are matched without it (nothing is decoded here).
 */
export async function matchSuggestOp(
  engine: Engine,
  store: ProjectStore,
  opts: { assetIds?: string[] | undefined; signal?: AbortSignal | undefined } = {},
): Promise<{ matches: RecordingMatch[]; recordings: MatchRecording[]; usedVision: boolean }> {
  requireStoryboard(store);
  await engine.library.reload();
  const recs = recordings(engine, store.state, opts.assetIds);
  const vision = await visionScoresFor(engine, store, recs, opts.signal);
  return {
    matches: suggestMatches({
      project: store.state,
      recordings: recs,
      ...(vision ? { vision } : {}),
    }).matches,
    recordings: recs,
    usedVision: vision !== undefined,
  };
}

/** Attach every code match and every suggestion at or above `minConfidence`, as one undo step. */
export async function matchAcceptOp(
  engine: Engine,
  store: ProjectStore,
  opts: {
    minConfidence?: 'certain' | 'high' | 'medium' | undefined;
    assetIds?: string[] | undefined;
  } = {},
): Promise<{ attached: { slotId: string; assetId: string; matchedBy: string }[] }> {
  const { matches } = await matchSuggestOp(
    engine,
    store,
    opts.assetIds ? { assetIds: opts.assetIds } : {},
  );
  const payload = acceptMatchesPayload(matches, {
    minConfidence: opts.minConfidence ?? 'high',
    attachedAt: new Date().toISOString(),
  });
  if (payload.items.length > 0) store.dispatch('core/takes.attach-many', payload);
  return { attached: payload.items };
}

// ---- rough cut -------------------------------------------------------------------------------

async function takeSources(engine: Engine, store: ProjectStore): Promise<Map<string, TakeSource>> {
  const out = new Map<string, TakeSource>();
  for (const [assetId] of attachedAssets(store.state)) {
    const a = engine.library.get(assetId);
    if (!a?.media || (await engine.library.status(assetId)) !== 'ok') continue;
    const analysis: FootageAnalysis | null = await readFootageAnalysis(
      store.paths.analysisCache,
      a.quickHash,
    );
    out.set(assetId, {
      duration: Math.round(a.media.duration * FLICKS_PER_SECOND),
      ...(analysis ? { footage: analysis } : {}),
    });
  }
  return out;
}

export interface CutOutcome {
  timelineId: string;
  items: number;
  placeholders: number;
  keptEdits: string[];
  warnings: string[];
  /** Footage with no analysis yet (the cut used the middle of those takes). */
  unanalysed: number;
}

/**
 * Build (or rebuild) the rough cut on the music and apply it as one undo step. Rebuilding keeps
 * locked tracks and clips edited by hand. Needs the music analysed; footage analysis improves it.
 */
export async function generateCutOp(
  engine: Engine,
  store: ProjectStore,
  opts: { leadFrames?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<CutOutcome> {
  const sb = requireStoryboard(store);
  await engine.library.reload();
  const trackId = sb.music.trackAssetId;
  if (!trackId) throw new OpError('usage', 'choose a music track first (core/music.set-track)');
  const track = engine.library.get(trackId);
  if (!track) throw new OpError('not-found', `the music track ${trackId} is not in the library`);
  const music = await readMusicAnalysis(store.paths.analysisCache, track.quickHash);
  if (!music)
    throw new OpError('not-found', 'the music has not been analysed yet; run the analysis first');
  opts.signal?.throwIfAborted();

  const grid = resolveMusicGrid(music, sb.music.grid ?? {});
  const sources = await takeSources(engine, store);
  const target = store.state.formatTargets[0];
  const built = buildRoughCut({
    storyboard: sb,
    grid,
    sources,
    timeline: {
      id: ROUGH_CUT_TIMELINE_ID,
      frameRate: target?.frameRate ?? { num: 30, den: 1 },
      resolution: target?.resolution ?? { width: 1920, height: 1080 },
    },
    now: new Date(),
    ...(opts.leadFrames ? { options: { leadFrames: opts.leadFrames } } : {}),
  });
  const previous = store.state.timelines.find((t) => t.id === ROUGH_CUT_TIMELINE_ID);
  const merged = mergeRoughCut(previous, built.timeline, sources);
  // Captions follow their shot to wherever the merge put it.
  const captioned = placeCaptions(merged.timeline, sb);
  store.dispatch('core/timeline.set', { timeline: captioned.timeline });
  await appendDecisions(store.paths.decisions, built.decisions);

  const items = captioned.timeline.tracks.flatMap((t) => t.items);
  const attached = [...attachedAssets(store.state).keys()];
  return {
    timelineId: ROUGH_CUT_TIMELINE_ID,
    items: items.length,
    placeholders: items.filter((i) => i.kind === 'placeholder').length,
    keptEdits: merged.kept,
    // Caption notes are already in the built cut's warnings; the re-placement repeats them.
    warnings: [...new Set([...built.warnings, ...merged.warnings, ...captioned.warnings])],
    unanalysed: attached.filter((id) => sources.has(id) && !sources.get(id)!.footage).length,
  };
}

// ---- the cut screen: music grid and playable media ------------------------------------------

export interface CutGrid {
  assetId: string;
  tempo: number;
  beatsPerBar: number;
  /** Flicks from the start of the music. */
  beats: number[];
  bars: number[];
  duration: number;
}

/** The beat grid the cut lands on (analysis plus the user's nudges), or null before the music is analysed. */
export async function cutGridOp(engine: Engine, store: ProjectStore): Promise<CutGrid | null> {
  const sb = store.state.storyboard;
  const trackId = sb?.music.trackAssetId;
  if (!sb || !trackId) return null;
  await engine.library.reload();
  const track = engine.library.get(trackId);
  const music = track ? await readMusicAnalysis(store.paths.analysisCache, track.quickHash) : null;
  if (!music) return null;
  const g = resolveMusicGrid(music, sb.music.grid ?? {});
  return {
    assetId: trackId,
    tempo: g.tempo,
    beatsPerBar: g.beatsPerBar,
    beats: g.beats,
    bars: g.bars,
    duration: g.duration,
  };
}

export interface MediaFile {
  path: string;
  type: string;
  size: number;
}

const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
};

export type LibraryMediaKind = 'proxy' | 'audio' | 'thumbnail' | 'filmstrip';

/**
 * A file the UI may fetch: a recording's small editing copy, thumbnail or filmstrip (10 frames of
 * 160 px in one row) from the library cache, or a music track. Only library assets, only those
 * things; never an arbitrary path.
 */
export async function libraryMediaOp(
  engine: Engine,
  assetId: string,
  what: LibraryMediaKind,
): Promise<MediaFile> {
  await engine.library.reload();
  const a = engine.library.get(assetId);
  if (!a) throw new OpError('not-found', `no library asset "${assetId}"`);
  let path: string;
  let type: string;
  if (what !== 'audio') {
    if (a.kind !== 'video') throw new OpError('usage', `only recordings have a ${what}`);
    path = assetCachePaths(engine.home, a.quickHash)[what];
    type = what === 'proxy' ? 'video/mp4' : 'image/jpeg';
  } else {
    const t = AUDIO_TYPES[extname(a.uri).toLowerCase()];
    if (a.kind !== 'audio' || !t)
      throw new OpError('usage', 'that asset is not a music file the player can use');
    path = a.uri;
    type = t;
  }
  try {
    return { path, type, size: (await stat(path)).size };
  } catch {
    throw new OpError(
      'not-found',
      what === 'audio'
        ? 'the music file is missing'
        : what === 'proxy'
          ? 'the editing copy is not built yet'
          : `the ${what} is not built yet`,
    );
  }
}

// ---- optional AI take ranking ----------------------------------------------------------------

/** Ask the model which take to use for shots with several (text only; the user's consent first). */
export async function rankTakesOp(
  engine: Engine,
  store: ProjectStore,
  opts: { overwriteChosen?: boolean | undefined; signal?: AbortSignal | undefined } = {},
): Promise<{
  chosen: { slotId: string; takeId: string; reason: string }[];
  skipped: { slotId: string; reason: string }[];
}> {
  requireStoryboard(store);
  await engine.library.reload();
  const facts = new Map<string, TakeFacts>();
  for (const s of store.state.storyboard!.sections)
    for (const slot of s.slots as ShotSlot[])
      for (const t of slot.kind === 'shot' ? slot.takes : []) {
        const a = engine.library.get(t.assetId);
        const analysis = a
          ? await readFootageAnalysis(store.paths.analysisCache, a.quickHash)
          : null;
        if (analysis) facts.set(t.assetId, summarizeFootage(analysis));
      }
  const result = await rankTakes({ llm: engine.llm }, store.state, {
    facts,
    ...(opts.overwriteChosen ? { overwriteChosen: true } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  if (result.apply.choices.length > 0) {
    store.dispatch('core/takes.choose-many', result.apply);
    await appendDecisions(store.paths.decisions, result.decisions);
  }
  return {
    chosen: result.choices.map(({ slotId, takeId, reason }) => ({ slotId, takeId, reason })),
    skipped: result.skipped,
  };
}
