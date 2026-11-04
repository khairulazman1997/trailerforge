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
  tempoGrid,
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
  timelineDuration,
  type ConceptInput,
  type Short,
  type SlotInput,
  type TakeInput,
} from '@trailerforge/schema';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { STILL_SECONDS } from './still.js';
import { voiceStatusOp, type VoiceView } from './voice-ops.js';

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
  const tempo = sb.music.grid?.tempo;
  // A tapped-in tempo needs no music file: the grid comes from the tempo alone.
  const grid = music
    ? resolveMusicGrid(music, sb.music.grid ?? {})
    : tempo
      ? tempoGrid({ ...sb.music.grid, tempo }, short.concept.targetSeconds + 10)
      : null;
  // A timing-only track gives the beat and is never placed on the timeline.
  const cutBoard = (() => {
    if (!sb.music.timingOnly) return sb;
    const { trackAssetId: _unused, ...rest } = sb.music;
    return { ...sb, music: rest };
  })();

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
    storyboard: cutBoard,
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

// ---- what the TikTok tab shows ---------------------------------------------------------------

export interface ShortSlotView {
  id: string;
  sectionId: string;
  sectionName: string;
  locked: boolean;
  kind: 'shot' | 'card';
  title: string;
  /** What may fill it (picture slots); cards are written, not filled. */
  accepts: SlotInput[];
  seconds: number;
  takes: number;
  chosen: { assetId: string; name: string; input: TakeInput | null } | null;
}

export interface ShortVoiceLineView {
  id: string;
  text: string;
  linkedSlotIds: string[];
  takes: number;
  chosen: {
    assetId: string;
    name: string;
    sourceIn: number | null;
    sourceOut: number | null;
  } | null;
}

export interface ShortView {
  id: string;
  name: string;
  concept: {
    title: string;
    hook: string;
    pitch: string;
    formatId: string;
    formatName: string;
    targetSeconds: number;
    source: string;
  };
  platform: Short['platform'];
  subtitles: { enabled: boolean; style: Short['subtitles']['style']; edits: number };
  hasTemplate: boolean;
  slots: ShortSlotView[];
  voiceLines: ShortVoiceLineView[];
  musicAssetId: string | null;
  /** The music: a file (maybe for timing only) and/or a tapped-in tempo. */
  music: { assetId: string | null; timingOnly: boolean; tempo: number | null };
  /** Counts for the progress bar: picture slots with a file, voiceover lines with a recording. */
  progress: { slots: number; slotsFilled: number; lines: number; linesRecorded: number };
  cut: { built: boolean; mode: 'voice' | 'beat' | 'plain' | null; seconds: number | null };
}

export interface ShortsView {
  shorts: ShortView[];
  /** Concepts waiting to be picked. */
  concepts: ConceptInput[];
  voice: VoiceView;
}

/** Everything about the project's TikToks that a screen or an agent needs, from project state. */
export async function shortsViewOp(engine: Engine, store: ProjectStore): Promise<ShortsView> {
  await engine.library.reload();
  const name = (assetId: string) => engine.library.get(assetId)?.originalName ?? assetId;
  const project = store.state;
  const shorts: ShortView[] = project.shorts.map((s) => {
    const sb = s.storyboard;
    const slots: ShortSlotView[] = (sb?.sections ?? []).flatMap((sec) =>
      sec.slots.map((x): ShortSlotView => {
        const takes = x.kind === 'shot' ? x.takes.filter((t) => !t.rejected) : [];
        const chosen =
          x.kind === 'shot'
            ? (takes.find((t) => t.id === x.chosenTakeId) ?? takes.at(-1))
            : undefined;
        return {
          id: x.id,
          sectionId: sec.id,
          sectionName: sec.name,
          locked: sec.locked,
          kind: x.kind,
          title: x.title,
          accepts: x.kind === 'shot' ? (x.accepts ?? ['gameplay']) : [],
          seconds: x.duration.ideal,
          takes: takes.length,
          chosen: chosen
            ? { assetId: chosen.assetId, name: name(chosen.assetId), input: chosen.input ?? null }
            : null,
        };
      }),
    );
    const voiceLines: ShortVoiceLineView[] = (sb?.voLines ?? []).map((v) => {
      const takes = v.takes.filter((t) => !t.rejected);
      const chosen = takes.find((t) => t.id === v.chosenTakeId) ?? takes.at(-1);
      return {
        id: v.id,
        text: v.text,
        linkedSlotIds: v.linkedSlotIds,
        takes: takes.length,
        chosen: chosen
          ? { assetId: chosen.assetId, name: name(chosen.assetId), sourceIn: chosen.sourceIn ?? null, sourceOut: chosen.sourceOut ?? null } // prettier-ignore
          : null,
      };
    });
    const picture = slots.filter((x) => x.kind === 'shot');
    const tl = project.timelines.find((t) => t.id === shortTimelineId(s.id));
    const mode = (tl?.extensions.core as { roughCut?: { mode?: string } } | undefined)?.roughCut
      ?.mode;
    return {
      id: s.id,
      name: s.name,
      concept: {
        title: s.concept.title,
        hook: s.concept.hook,
        pitch: s.concept.pitch,
        formatId: s.concept.formatId,
        formatName: tiktokFormat(s.concept.formatId)?.name ?? s.concept.formatId,
        targetSeconds: s.concept.targetSeconds,
        source: s.concept.source,
      },
      platform: s.platform,
      subtitles: { enabled: s.subtitles.enabled, style: s.subtitles.style, edits: s.subtitles.edits.length }, // prettier-ignore
      hasTemplate: sb !== null,
      slots,
      voiceLines,
      musicAssetId: sb?.music.trackAssetId ?? null,
      music: {
        assetId: sb?.music.trackAssetId ?? null,
        timingOnly: sb?.music.timingOnly === true,
        tempo: sb?.music.grid?.tempo ?? null,
      },
      progress: {
        slots: picture.length,
        slotsFilled: picture.filter((x) => x.chosen).length,
        lines: voiceLines.length,
        linesRecorded: voiceLines.filter((v) => v.chosen).length,
      },
      cut: {
        built: !!tl,
        mode: mode === 'voice' || mode === 'beat' || mode === 'plain' ? mode : null,
        seconds: tl ? Math.round((timelineDuration(tl) / FLICKS_PER_SECOND) * 10) / 10 : null,
      },
    };
  });
  return { shorts, concepts: project.concepts, voice: await voiceStatusOp(engine) };
}

// ---- making a TikTok and filling it ------------------------------------------------------------

export interface CreateShortOptions extends Pick<BuildShortOptions, 'wording' | 'signal'> {
  /** Pick a waiting concept… */
  conceptId?: string | undefined;
  /** …or give your own. */
  concept?: Omit<ConceptInput, 'id' | 'createdAt'> | undefined;
  name?: string | undefined;
  formatTargetId?: string | undefined;
  /** Build the template straight away (default true). */
  build?: boolean | undefined;
}

export async function createShortOp(
  engine: Engine,
  store: ProjectStore,
  opts: CreateShortOptions,
): Promise<{ shortId: string; build: BuildShortOutcome | null }> {
  const had = new Set(store.state.shorts.map((s) => s.id));
  if ((opts.conceptId === undefined) === (opts.concept === undefined))
    throw new OpError('usage', 'give exactly one of a concept id and a concept');
  try {
    store.dispatch('core/shorts.add', {
      ...(opts.conceptId ? { conceptId: opts.conceptId } : {}),
      ...(opts.concept ? { concept: opts.concept } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.formatTargetId ? { formatTargetId: opts.formatTargetId } : {}),
    });
  } catch (err) {
    throw new OpError('usage', err instanceof Error ? err.message : String(err));
  }
  const made = store.state.shorts.find((s) => !had.has(s.id))!;
  const build =
    opts.build === false
      ? null
      : await buildShortOp(engine, store, made.id, {
          ...(opts.wording !== undefined ? { wording: opts.wording } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
  return { shortId: made.id, build };
}

export interface FillSlotOptions {
  slotId?: string | undefined;
  voLineId?: string | undefined;
  /** A file already in the library… */
  assetId?: string | undefined;
  /** …or one to import first (a path on this computer). */
  path?: string | undefined;
  /** Gameplay, image, video or voiceover; default from the file and what the slot takes. */
  input?: TakeInput | undefined;
  sourceIn?: number | undefined;
  sourceOut?: number | undefined;
  signal?: AbortSignal | undefined;
}

async function importOne(engine: Engine, store: ProjectStore, path: string, signal?: AbortSignal) {
  const r = await engine.ingestor.importPaths([path], {
    projectId: store.state.id,
    ...(signal ? { signal } : {}),
  });
  const job = r.jobs[0];
  if (!job)
    throw new OpError(
      'usage',
      `cannot import "${path}": ${r.skipped[0]?.reason ?? 'not a media file'}`,
    );
  const end = Date.now() + 120_000;
  for (;;) {
    signal?.throwIfAborted();
    const j = engine.jobs.get(job.jobId);
    if (j?.status === 'succeeded') return (j.output as { assetId: string }).assetId;
    if (j?.status === 'failed')
      throw new OpError('usage', `cannot import "${path}": ${j.error?.message ?? 'failed'}`);
    if (Date.now() > end) throw new OpError('usage', `importing "${path}" took too long`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

/** Put a file into a picture slot or a voiceover line of a TikTok (importing it first if given a path). */
export async function fillSlotOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: FillSlotOptions,
): Promise<{ assetId: string; input: TakeInput; target: string }> {
  const short = findShort(store, shortId);
  if ((opts.slotId === undefined) === (opts.voLineId === undefined))
    throw new OpError('usage', 'give exactly one of a slot id and a voiceover line id');
  if ((opts.assetId === undefined) === (opts.path === undefined))
    throw new OpError('usage', 'give exactly one of a library file id and a path');
  const assetId = opts.assetId ?? (await importOne(engine, store, opts.path!, opts.signal));
  await engine.library.reload();
  const asset = engine.library.get(assetId);
  if (!asset) throw new OpError('not-found', `no library file "${assetId}"`);

  let input = opts.input;
  if (!input) {
    if (opts.voLineId) input = 'voiceover';
    else {
      const slot = short.storyboard?.sections
        .flatMap((s) => s.slots)
        .find((x) => x.id === opts.slotId);
      const accepts = slot?.kind === 'shot' ? (slot.accepts ?? ['gameplay']) : [];
      input =
        asset.kind === 'image'
          ? 'image'
          : asset.kind === 'video'
            ? accepts.includes('gameplay')
              ? 'gameplay'
              : 'video'
            : undefined;
      if (!input)
        throw new OpError(
          'usage',
          `"${asset.originalName}" is ${asset.kind}: a picture slot takes video or images`,
        );
    }
  }
  try {
    store.dispatch('core/shorts.fill-slot', {
      shortId,
      target: opts.voLineId ? { voLineId: opts.voLineId } : { slotId: opts.slotId! },
      assetId,
      input,
      ...(opts.sourceIn !== undefined ? { sourceIn: opts.sourceIn } : {}),
      ...(opts.sourceOut !== undefined ? { sourceOut: opts.sourceOut } : {}),
    });
  } catch (err) {
    throw new OpError('usage', err instanceof Error ? err.message : String(err));
  }
  return { assetId, input, target: opts.voLineId ?? opts.slotId! };
}
