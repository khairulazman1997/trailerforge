import {
  readFootageAnalysis,
  readLatestTranscript,
  readMusicAnalysis,
} from '@trailerforge/analysis';
import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import {
  buildShortCut,
  mergeRoughCut,
  resolveMusicGrid,
  type AlignWord,
  type TakeSource,
} from '@trailerforge/cut';
import { LlmConsentError } from '@trailerforge/llm';
import {
  fillShortWording,
  rebuildShortStoryboard,
  tiktokFormat,
  WORDING_TASK,
} from '@trailerforge/pack-game-trailer';
import {
  DecisionRecord,
  FLICKS_PER_SECOND,
  shortTimelineId,
  type Short,
} from '@trailerforge/schema';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { STILL_SECONDS } from './still.js';

/**
 * TikTok templates. A short is made from a concept (`core/shorts.add`, which any caller can
 * dispatch) and then built: the format fixes the structure and the concept seeds the words, so
 * the build works with no AI at all; an optional AI pass improves the wording of the slots that
 * were just written. Building again (or only some sections) refreshes what the user has not
 * touched and keeps locked sections, slots with files or hand edits, and recorded voiceover.
 */

export interface BuildShortOptions {
  /** Only these sections; default all. */
  sectionIds?: readonly string[] | undefined;
  /** Improve the wording with the AI (default true). Failing or declining never fails the build. */
  wording?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface BuildShortOutcome {
  shortId: string;
  /** Slots written from the template and the concept. */
  rebuilt: number;
  /** Slots left as they were (files, hand edits, locked sections). */
  kept: number;
  wording:
    | { status: 'off' }
    | { status: 'nothing-to-write' }
    | { status: 'skipped'; reason: string }
    | { status: 'done'; changed: number; ignored: number };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function findShort(store: ProjectStore, shortId: string): Short {
  const s = store.state.shorts.find((x) => x.id === shortId);
  if (!s) throw new OpError('not-found', `no TikTok "${shortId}"`);
  return s;
}

export async function buildShortOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: BuildShortOptions = {},
): Promise<BuildShortOutcome> {
  const short = findShort(store, shortId);
  if (!tiktokFormat(short.concept.formatId))
    throw new OpError('usage', `unknown TikTok format "${short.concept.formatId}"`);
  for (const id of opts.sectionIds ?? [])
    if (!short.storyboard?.sections.some((s) => s.id === id))
      throw new OpError('not-found', `no section "${id}" in "${short.name}"`);

  const { callToAction, tone } = store.state.brief;
  const built = rebuildShortStoryboard({
    short,
    ...(callToAction ? { callToAction } : {}),
    ...(tone ? { tone } : {}),
    ...(opts.sectionIds ? { sectionIds: opts.sectionIds } : {}),
  });
  let storyboard = built.storyboard;
  let wording: BuildShortOutcome['wording'] = { status: 'off' };
  let via: Record<string, string | boolean> = {};
  if (opts.wording !== false) {
    if (built.rebuilt.length === 0) wording = { status: 'nothing-to-write' };
    else {
      try {
        const w = await fillShortWording(
          { llm: engine.llmFor(store) },
          store.state,
          { ...short, storyboard },
          { slotIds: built.rebuilt, ...(opts.signal ? { signal: opts.signal } : {}) },
        );
        storyboard = w.storyboard;
        wording = { status: 'done', changed: w.changed.length, ignored: w.ignored.length };
        via = { task: WORDING_TASK, provider: w.provider, fellBack: w.fellBack };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        wording = {
          status: 'skipped',
          reason:
            err instanceof LlmConsentError
              ? 'you chose not to send the wording request'
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }
  }
  opts.signal?.throwIfAborted();

  store.dispatch('core/shorts.set-storyboard', { shortId, storyboard });
  const at = new Date().toISOString();
  await appendDecisions(store.paths.decisions, [
    DecisionRecord.parse({
      id: `dec_${sha256(`tiktok-template|${at}|${shortId}`).slice(0, 24)}`,
      at,
      step: 'game-trailer/tiktok-template',
      subject: { kind: 'short', id: shortId },
      choice: { formatId: short.concept.formatId, targetSeconds: short.concept.targetSeconds },
      reasons: {
        rebuilt: built.rebuilt.length,
        kept: built.kept.length,
        wording: wording.status,
        ...via,
      },
      summary: `Built the ${tiktokFormat(short.concept.formatId)!.name} template for "${short.name}": ${built.rebuilt.length} slots written, ${built.kept.length} kept.`,
    }),
  ]);
  return { shortId, rebuilt: built.rebuilt.length, kept: built.kept.length, wording };
}

// ---- the cut ---------------------------------------------------------------------------------

/** Every library file a short uses: its takes, its voiceover takes and its music. */
function assetsOf(short: Short): string[] {
  const sb = short.storyboard;
  if (!sb) return [];
  const ids = new Set<string>();
  for (const sec of sb.sections)
    for (const slot of sec.slots)
      if (slot.kind === 'shot') for (const t of slot.takes) ids.add(t.assetId);
  for (const v of sb.voLines) for (const t of v.takes) ids.add(t.assetId);
  if (sb.music.trackAssetId) ids.add(sb.music.trackAssetId);
  return [...ids].sort();
}

/** What the cut needs to know about each file: length, footage analysis, whether it is an image. */
export async function shortSources(
  engine: Engine,
  store: ProjectStore,
  short: Short,
): Promise<Map<string, TakeSource>> {
  const out = new Map<string, TakeSource>();
  for (const id of assetsOf(short)) {
    const a = engine.library.get(id);
    if (!a?.media || (await engine.library.status(id)) !== 'ok') continue;
    const still = a.kind === 'image' && a.media.video.length > 0;
    const analysis =
      !still && a.media.video.length > 0
        ? await readFootageAnalysis(store.paths.analysisCache, a.quickHash)
        : null;
    out.set(id, {
      duration: Math.round((still ? STILL_SECONDS : a.media.duration) * FLICKS_PER_SECOND),
      ...(analysis ? { footage: analysis } : {}),
      ...(still ? { still: true } : {}),
    });
  }
  return out;
}

export interface ShortCutOutcome {
  timelineId: string;
  /** What set the timing: the voice, the beat, or the storyboard's own lengths. */
  mode: 'voice' | 'beat' | 'plain';
  items: number;
  placeholders: number;
  /** Subtitle cues placed. */
  cues: number;
  keptEdits: string[];
  warnings: string[];
}

/**
 * Build (or rebuild) a TikTok's cut from its template, recordings, images, voiceover and music,
 * as one undo step. Hand edits and locked tracks are kept on a rebuild. Subtitles come from the
 * voiceover's transcript when there is one (the model never runs here: transcribing is its own
 * step, `placeVoiceOp`), else from the script.
 */
export async function generateShortCutOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ShortCutOutcome> {
  const short = findShort(store, shortId);
  const sb = short.storyboard;
  if (!sb) throw new OpError('usage', `"${short.name}" has no template yet: build it first`);
  await engine.library.reload();
  const sources = await shortSources(engine, store, short);
  opts.signal?.throwIfAborted();

  const track = sb.music.trackAssetId ? engine.library.get(sb.music.trackAssetId) : undefined;
  const music = track ? await readMusicAnalysis(store.paths.analysisCache, track.quickHash) : null;
  const grid = music ? resolveMusicGrid(music, sb.music.grid ?? {}) : null;

  const words = new Map<string, readonly AlignWord[]>();
  const model = engine.voice.manifest;
  if (model && short.subtitles.enabled) {
    for (const v of sb.voLines) {
      const take =
        v.takes.find((t) => t.id === v.chosenTakeId) ?? v.takes.filter((t) => !t.rejected).at(-1);
      const a = take ? engine.library.get(take.assetId) : undefined;
      if (!take || !a || words.has(take.assetId)) continue;
      const t = await readLatestTranscript(model.id, { quickHash: a.quickHash, analysisDir: store.paths.analysisCache }); // prettier-ignore
      if (t) words.set(take.assetId, t.words);
    }
  }

  const target =
    store.state.formatTargets.find((f) => f.id === short.formatTargetId) ??
    store.state.formatTargets.find((f) => f.aspect === '9:16');
  const id = shortTimelineId(shortId);
  const built = buildShortCut({
    storyboard: sb,
    sources,
    grid,
    timeline: {
      id,
      name: short.name,
      frameRate: target?.frameRate ?? { num: 30, den: 1 },
      resolution: target?.resolution ?? { width: 1080, height: 1920 },
    },
    now: new Date(),
    ...(short.subtitles.enabled
      ? { subtitles: { style: short.subtitles.style, edits: short.subtitles.edits, words } }
      : {}),
  });
  const previous = store.state.timelines.find((t) => t.id === id);
  const merged = mergeRoughCut(previous, built.timeline, sources);
  store.dispatch('core/timeline.set', { timeline: merged.timeline });
  await appendDecisions(store.paths.decisions, built.decisions);

  const items = merged.timeline.tracks.flatMap((t) => t.items);
  return {
    timelineId: id,
    mode: built.mode,
    items: items.length,
    placeholders: items.filter((i) => i.kind === 'placeholder').length,
    cues: built.cues.length,
    keptEdits: merged.kept,
    warnings: [...new Set([...built.warnings, ...merged.warnings])],
  };
}
