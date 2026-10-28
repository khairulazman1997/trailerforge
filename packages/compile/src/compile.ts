import {
  FlashRiskError,
  assertFlashSafe,
  builtinFilters,
  checkParams,
  flashEvents,
  n,
  type EffectDef,
  type FilterRegistry,
  type FlashEvent,
  type TransitionDef,
} from '@trailerforge/effects';
import { evaluateVector } from '@trailerforge/graphics';
import {
  FLICKS_PER_SECOND,
  Transition,
  flicksPerFrame,
  flicksToFrames,
  framesToFlicks,
  itemEnd,
  timelineDuration,
  type Animatable,
  type Rate,
  type Timeline,
  type TimelineItem,
  type Track,
} from '@trailerforge/schema';
import { sha256 } from './sha256.js';

/**
 * The render compiler: one timeline → one FFmpeg invocation (inputs, a single filtergraph,
 * encoder arguments). Pure and deterministic: the same timeline, sources and settings give the
 * same plan and the same `planHash`, which keys render caches. File paths are left out of the
 * hash (content hashes stand in for them), so moving a recording does not invalidate a render.
 *
 * Picture pipeline per clip: accurate seek half a source frame early (the wanted frame is the
 * first one kept, whatever the container's rounding), speed via `setpts`, conversion to the
 * timeline rate with `fps`, the last frame held if the recording ends early, an exact frame
 * count with `trim`, then the reframe crop (keyframed insets as piecewise expressions on the
 * frame number), Lanczos scaling into the frame (padded when the shape differs), or a blurred
 * fill behind the whole picture, then the item's effects. Processing is 4:4:4 10-bit; the
 * output is tagged BT.709.
 *
 * Tracks composite in timeline order (first = bottom). Items joined by transitions form a run:
 * each member is rendered with handles (half the overlap from its source on either side of the
 * cut) and the run is folded with the transitions' `xfade`-based fragments, so the run keeps
 * its length and the cut stays where the timeline has it. Cards and captions are PNG frame
 * sequences with alpha (rendered beforehand, see `@trailerforge/render`), overlaid in place.
 * A card that meets a shot on the bottom picture track can take a transition from the shot
 * (`timeline.extensions.core.crossTransitions`): it is then drawn on the picture track itself.
 */

export const COMPILER_VERSION = 2;

/** What the compiler needs to know about a recording (from the probe and the library). */
export interface SourceMedia {
  path: string;
  /** Content hash (quick or full): stands in for the path in `planHash`. */
  contentHash: string;
  /** Display size (after rotation). */
  width: number;
  height: number;
  frameRate: Rate;
  /** Seconds. */
  duration: number;
  hasAudio: boolean;
  /** Variable frame rate: real timestamps are kept instead of a regular frame grid. */
  variableFrameRate?: boolean;
}

/** A card's or caption's rendered frames: `pattern` holds `%06d`, frame 0 = the item's start. */
export interface GraphicFrames {
  pattern: string;
  /** Hash of the frames' content (e.g. of the scene and renderer version). */
  contentHash: string;
  frames: number;
}

export interface VideoEncode {
  codec: string;
  pixFmt: string;
  args: readonly string[];
  /** Hardware encoders are not bit-identical across machines and drivers. */
  hardware?: boolean;
}

export interface EncodeSettings {
  container: 'mp4' | 'mov' | 'mkv' | 'nut';
  video: VideoEncode;
  /** Pinned: x264/x265 output depends on the thread count. */
  threads: number;
}

/** Until the export presets (6.6): a quick software H.264 for drafts and tests. */
export const DRAFT_ENCODE: EncodeSettings = {
  container: 'mp4',
  threads: 4,
  video: {
    codec: 'libx264',
    pixFmt: 'yuv420p',
    args: ['-preset', 'veryfast', '-crf', '23', '-profile:v', 'high'],
  },
};

/** Frames of the timeline to render, `[start, start + frames)`. */
export interface FrameRange {
  start: number;
  frames: number;
}

export interface CompileInput {
  timeline: Timeline;
  sources: ReadonlyMap<string, SourceMedia>;
  /** Rendered frames of graphic and caption items, by item id. */
  graphics?: ReadonlyMap<string, GraphicFrames>;
  /** Installed transitions and effects (default: the built-in set). */
  filters?: FilterRegistry;
  encode?: EncodeSettings;
  range?: FrameRange;
  /** Font for placeholder slate labels; without it the slate is plain. */
  slateFont?: { path: string; contentHash: string };
}

export type PlanInput =
  | {
      kind: 'media';
      assetId: string;
      path: string;
      contentHash: string;
      /** Input `-ss` and `-t`, seconds as FFmpeg reads them. */
      seek: string;
      duration: string;
    }
  | {
      kind: 'frames';
      itemId: string;
      /** `%06d` pattern of PNG files. */
      path: string;
      contentHash: string;
      rate: string;
      startNumber: number;
    };

export interface RenderPlan {
  compilerVersion: number;
  timelineId: string;
  width: number;
  height: number;
  rate: Rate;
  range: FrameRange;
  inputs: PlanInput[];
  filtergraph: string;
  videoOut: 'vout';
  encode: EncodeSettings;
  warnings: string[];
  planHash: string;
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

const WORK_FMT = 'yuv444p10le';
const WORK_FMT_ALPHA = 'yuva444p10le';
const SLATE_COLOR = '0x1f2933';
const FONT_TOKEN = '\u0000slatefont\u0000';

/** Escape an option value for a filter argument inside a filtergraph (both levels). */
export function esc(v: string | number): string {
  const s = typeof v === 'number' ? n(v) : v;
  const level1 = s.replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

const opts = (o: Record<string, string | number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${esc(v)}`)
    .join(':');

const rateText = (r: Rate) => `${r.num}/${r.den}`;

/** Cross-track transitions (a shot into or out of a card), kept on the timeline's extensions. */
export function crossTransitions(timeline: Timeline): Transition[] {
  const raw = (timeline.extensions.core as { crossTransitions?: unknown } | undefined)
    ?.crossTransitions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const r = Transition.safeParse(t);
    return r.success ? [r.data] : [];
  });
}

interface Member {
  item: TimelineItem;
  fs: number;
  fe: number;
  /** Frames rendered before the item's start (incoming overlap) and after its end. */
  head: number;
  tail: number;
  /** Frames of the item left out at its start and end (outside the range). */
  skip: number;
  cut: number;
  /** Transition into this member from the previous one in the run. */
  tIn?: { t: Transition; d: number };
}

interface Split {
  d: number;
  /** Frames of the overlap taken from after the first item's end, and before the second's start. */
  tailA: number;
  headB: number;
}

export function compileRender(input: CompileInput): RenderPlan {
  const rate = input.timeline.frameRate;
  const { width: W, height: H } = input.timeline.resolution;
  const encode = input.encode ?? DRAFT_ENCODE;
  const filters = input.filters ?? builtinFilters();
  const graphics = input.graphics ?? new Map<string, GraphicFrames>();
  const fpf = flicksPerFrame(rate);
  const fps = rate.num / rate.den;
  const warnings: string[] = [];
  const inputs: PlanInput[] = [];
  const chains: string[] = [];

  const timeline = withCrossTransitions(input.timeline, warnings);
  const total = flicksToFrames(timelineDuration(timeline), rate);
  const range = input.range ?? { start: 0, frames: total };
  if (range.frames <= 0 || range.start < 0 || !Number.isInteger(range.frames + range.start))
    throw new CompileError(`nothing to render: range ${range.start}+${range.frames}`);
  const rs = range.start;
  const re = range.start + range.frames;
  checkFlashes(timeline, filters, fpf, W, H);

  const frameOf = (fl: number) => flicksToFrames(fl, rate);
  const color = (c: string, frames: number, fmt: string) =>
    `color=${opts({ c, s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${frames},format=${fmt},setsar=1,settb=${rate.den}/${rate.num}`;

  const picture = timeline.tracks.filter((t) => t.kind !== 'audio' && !t.muted);
  const trackOuts: string[] = [];
  picture.forEach((track, ti) => {
    const alpha = ti > 0;
    const fmt = alpha ? WORK_FMT_ALPHA : WORK_FMT;
    const items = [...track.items].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const splits = new Map<string, Split>();
    const byTo = new Map<string, Transition>();
    const byFrom = new Map<string, Transition>();
    for (const t of track.transitions) {
      const def = filters.get(t.transitionId);
      if (def?.kind !== 'transition') {
        warnings.push(`transition "${t.id}": ${t.transitionId} is not installed; a hard cut`);
        continue;
      }
      const from = items.find((i) => i.id === t.fromItemId);
      const to = items.find((i) => i.id === t.toItemId);
      if (!from || !to) continue;
      const maxD = Math.min(frameOf(from.duration), frameOf(to.duration));
      const d = Math.min(maxD, Math.max(1, frameOf(t.duration)));
      const tailA = Math.floor(d / 2);
      splits.set(t.id, { d, tailA, headB: d - tailA });
      byTo.set(t.toItemId, t);
      byFrom.set(t.fromItemId, t);
    }
    const zone = (it: TimelineItem) => {
      const tin = byTo.get(it.id);
      const tout = byFrom.get(it.id);
      return [
        frameOf(it.start) - (tin ? splits.get(tin.id)!.headB : 0),
        frameOf(itemEnd(it)) + (tout ? splits.get(tout.id)!.tailA : 0),
      ] as const;
    };
    const included = items.filter((it) => {
      const [a, b] = zone(it);
      return a < re && b > rs && frameOf(itemEnd(it)) > frameOf(it.start);
    });
    // Runs of included items joined by transitions.
    const runs: Member[][] = [];
    for (const it of included) {
      const prev = runs.at(-1)?.at(-1);
      const t = byTo.get(it.id);
      const m: Member = {
        item: it,
        fs: frameOf(it.start),
        fe: frameOf(itemEnd(it)),
        head: 0,
        tail: 0,
        skip: 0,
        cut: 0,
      };
      if (prev && t && t.fromItemId === prev.item.id) {
        const s = splits.get(t.id)!;
        m.tIn = { t, d: s.d };
        m.head = s.headB;
        prev.tail = s.tailA;
        runs.at(-1)!.push(m);
      } else runs.push([m]);
    }
    for (const run of runs) {
      const first = run[0]!;
      const last = run.at(-1)!;
      const firstLimit = run.length > 1 ? first.fe - run[1]!.head : first.fe;
      first.skip = Math.max(0, Math.min(rs, firstLimit - 1) - first.fs);
      const lastLimit = run.length > 1 ? last.fs + run.at(-2)!.tail : last.fs;
      last.cut = Math.max(0, last.fe - Math.max(re, lastLimit + 1));
    }

    const pieces: string[] = [];
    let cursor = Math.min(rs, runs[0] ? runs[0][0]!.fs + runs[0][0]!.skip : rs);
    const windowStart = cursor;
    runs.forEach((run, ri) => {
      const start = run[0]!.fs + run[0]!.skip;
      if (start > cursor) {
        const out = `t${ti}g${ri}`;
        chains.push(`${color(alpha ? 'black@0' : 'black', start - cursor, fmt)}[${out}]`);
        pieces.push(out);
      }
      const labels = run.map((m, mi) => member(m, `t${ti}r${ri}m${mi}`, fmt, !alpha));
      let acc = labels[0]!;
      let accLen = memberLength(run[0]!);
      run.slice(1).forEach((m, mi) => {
        const t = m.tIn!.t;
        const def = filters.get(t.transitionId) as unknown as TransitionDef<unknown>;
        const out = `t${ti}r${ri}x${mi}`;
        const d = m.tIn!.d;
        const params = safeParams(def, t.params, `transition "${t.id}"`);
        chains.push(
          def.filter(
            params,
            { width: W, height: H, rate, duration: d / fps, offset: (accLen - d) / fps },
            { a: acc, b: labels[mi + 1]!, out },
          ),
        );
        acc = out;
        accLen += memberLength(m) - d;
      });
      if (run.length === 1) {
        pieces.push(acc);
        cursor = start + accLen;
        return;
      }
      // Fragments may leave other time bases or formats behind.
      const runOut = `t${ti}r${ri}`;
      chains.push(
        `[${acc}]format=${fmt},setsar=1,settb=${rate.den}/${rate.num},trim=end_frame=${accLen},setpts=PTS-STARTPTS[${runOut}]`,
      );
      pieces.push(runOut);
      cursor = start + accLen;
    });
    const windowEnd = Math.max(re, cursor);
    if (windowEnd > cursor) {
      const out = `t${ti}g${runs.length}`;
      chains.push(`${color(alpha ? 'black@0' : 'black', windowEnd - cursor, fmt)}[${out}]`);
      pieces.push(out);
    }
    const trackOut = `trk${ti}`;
    const trim =
      windowStart < rs || windowEnd > re
        ? `,trim=start_frame=${rs - windowStart}:end_frame=${re - windowStart},setpts=PTS-STARTPTS`
        : '';
    chains.push(
      pieces.length === 1
        ? `[${pieces[0]}]null${trim}[${trackOut}]`
        : `${pieces.map((l) => `[${l}]`).join('')}concat=n=${pieces.length}:v=1:a=0${trim}[${trackOut}]`,
    );
    trackOuts.push(trackOut);
  });

  function memberLength(m: Member): number {
    return m.fe - m.cut - (m.fs + m.skip) + m.head + m.tail;
  }

  /** Builds one member's stream (handles included); returns its label. */
  function member(m: Member, out: string, fmt: string, opaque: boolean): string {
    const it = m.item;
    const frames = memberLength(m);
    const lead = m.skip - m.head; // item frame shown first (negative: before the item)
    const fmtTail = `format=${fmt},setsar=1,settb=${rate.den}/${rate.num}`;
    let body: string;
    if (it.kind === 'clip' && input.sources.has(it.assetId)) {
      body = clipChain(it, input.sources.get(it.assetId)!, lead, frames);
    } else if ((it.kind === 'graphic' || it.kind === 'caption') && graphics.has(it.id)) {
      const g = graphics.get(it.id)!;
      const k = inputs.length;
      const startNumber = Math.min(Math.max(0, lead), g.frames - 1);
      inputs.push({
        kind: 'frames',
        itemId: it.id,
        path: g.pattern,
        contentHash: g.contentHash,
        rate: rateText(rate),
        startNumber,
      });
      const pre = Math.max(0, -lead);
      const png = `[${k}:v]settb=${rate.den}/${rate.num},setpts=N,format=${WORK_FMT_ALPHA}${pre ? `,tpad=start=${pre}:start_mode=clone` : ''},tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=PTS-STARTPTS`;
      if (opaque) {
        // On the picture track: over black, so the transitions see an opaque frame.
        chains.push(`${png}[${out}fg]`);
        chains.push(`${color('black', frames, WORK_FMT)}[${out}bk]`);
        body = `[${out}bk][${out}fg]overlay=format=yuv444p10:eof_action=repeat`;
      } else body = png;
    } else {
      if (it.kind === 'clip')
        warnings.push(`clip "${it.id}": recording ${it.assetId} is missing; drawn as a slate`);
      else if (it.kind === 'graphic' || it.kind === 'caption')
        warnings.push(`${it.kind} "${it.id}" has no rendered frames; left out`);
      else if (it.kind === 'sequence')
        warnings.push(`sequence "${it.id}" is not rendered yet; left out`);
      const label =
        it.kind === 'placeholder'
          ? (it.label ?? slateText(it.reason))
          : it.kind === 'clip'
            ? (it.label ?? 'Missing recording')
            : '';
      body = label
        ? slate(label, frames)
        : color(fmt === WORK_FMT_ALPHA ? 'black@0' : 'black', frames, fmt);
    }
    const effects = 'effects' in it ? it.effects.filter((e) => e.enabled) : [];
    if (!effects.length) {
      chains.push(`${body},${fmtTail}[${out}]`);
      return out;
    }
    // Effects see the item's own time: its first frame at t = 0.
    let cur = `${out}e0`;
    chains.push(`${body},${fmtTail},setpts=PTS+${lead}[${cur}]`);
    effects.forEach((e, ei) => {
      const def = filters.get(e.effectId);
      if (def?.kind !== 'effect') {
        warnings.push(`effect ${e.effectId} on "${it.id}" is not installed; left out`);
        return;
      }
      if (def.sourceSeconds) {
        warnings.push(`effect ${e.effectId} on "${it.id}" changes speed; not rendered yet (6.4)`);
        return;
      }
      const params = safeParams(def, e.params, `effect ${e.effectId} on "${it.id}"`);
      if (params === undefined) return;
      const next = `${out}e${ei + 1}`;
      chains.push(
        (def as unknown as EffectDef<unknown>).filter(
          params,
          { width: W, height: H, rate, duration: it.duration / FLICKS_PER_SECOND },
          { in: cur, out: next },
        ),
      );
      cur = next;
    });
    chains.push(
      `[${cur}]${fmtTail},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames}[${out}]`,
    );
    return out;
  }

  function slate(label: string, frames: number): string {
    const text = input.slateFont
      ? `,drawtext=${opts({
          fontfile: FONT_TOKEN,
          text: label,
          expansion: 'none',
          fontcolor: 'white',
          fontsize: Math.round(Math.min(W, H) * 0.06),
          x: '(w-text_w)/2',
          y: '(h-text_h)/2',
        })}`
      : '';
    return `color=${opts({ c: SLATE_COLOR, s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${frames}${text}`;
  }

  function clipChain(
    item: Extract<TimelineItem, { kind: 'clip' }>,
    src: SourceMedia,
    lead: number,
    frames: number,
  ): string {
    const speed = item.speed;
    const srcFrame = (speed * rate.den) / rate.num; // source seconds per output frame
    const half = (0.5 * src.frameRate.den) / src.frameRate.num;
    let startSec = (item.sourceIn + framesToFlicks(lead, rate) * speed) / FLICKS_PER_SECOND;
    let pre = 0;
    if (startSec < -1e-9) {
      pre = Math.ceil(-startSec / srcFrame - 1e-9);
      startSec += pre * srcFrame;
      warnings.push(`clip "${item.id}": no recording before its start; first frame held`);
    }
    if (startSec >= src.duration) {
      warnings.push(`clip "${item.id}" starts past the end of its recording; drawn as a slate`);
      return slate(item.label ?? 'Missing recording', frames);
    }
    const needSec = (frames - pre) * srcFrame;
    if (startSec + needSec - srcFrame > src.duration - half)
      warnings.push(`clip "${item.id}" runs past the end of its recording; last frame held`);
    const k = inputs.length;
    inputs.push({
      kind: 'media',
      assetId: item.assetId,
      path: src.path,
      contentHash: src.contentHash,
      seek: n(Math.max(0, Math.floor((startSec - half) * 1e6) / 1e6)),
      duration: n(Math.ceil((needSec + half * 8) * 1e6) / 1e6),
    });
    // Exact timestamps on a flick time base, shifted a hair early, then `fps` rounding up:
    // output frame k shows the newest source frame at or before k (sample and hold), with
    // no ties when source frames land exactly on, or halfway between, output frames.
    const eps = Math.floor(fpf / 1000);
    const pts = src.variableFrameRate
      ? `(PTS-STARTPTS)/${n(speed)}-${eps}`
      : `N*${src.frameRate.den * FLICKS_PER_SECOND}/(${src.frameRate.num}*${n(speed)})-${eps}`;
    const parts = [
      `settb=1/${FLICKS_PER_SECOND}`,
      `setpts=${esc(pts)}`,
      `fps=${rateText(rate)}:round=up`,
      ...(pre ? [`tpad=start=${pre}:start_mode=clone`] : []),
      'tpad=stop_mode=clone:stop=-1',
      `trim=end_frame=${frames}`,
      'setpts=PTS-STARTPTS',
    ];
    const geo = geometry(item, src, W, H, lead, fpf, warnings);
    if (!geo.fill) return `[${k}:v]${parts.join(',')}${geo.crop},${geo.scale}`;
    const out = `f${k}`;
    const bw = Math.max(2, Math.round(W / 8));
    const bh = Math.max(2, Math.round(H / 8));
    const blur = Math.max(1, Math.min(4, Math.floor(Math.min(bw, bh) / 2) - 1));
    chains.push(`[${k}:v]${parts.join(',')}${geo.crop},split=2[${out}a][${out}b]`);
    chains.push(
      `[${out}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bw}:${bh},format=${WORK_FMT},boxblur=${opts({ luma_radius: blur, luma_power: 2, chroma_radius: blur, chroma_power: 2 })},scale=${W}:${H}:flags=bicubic,format=${WORK_FMT}[${out}bg]`,
    );
    chains.push(`[${out}b]${geo.scale},format=${WORK_FMT}[${out}fg]`);
    return `[${out}bg][${out}fg]overlay=x=${esc('(W-w)/2')}:y=${esc('(H-h)/2')}:format=yuv444p10`;
  }

  function safeParams(
    def: { id: string; params: EffectDef<unknown>['params'] },
    params: unknown,
    what: string,
  ): unknown {
    try {
      return checkParams(def, params);
    } catch (err) {
      warnings.push(`${what}: ${(err as Error).message}; defaults used`);
      return checkParams(def, {});
    }
  }

  // No picture track at all: black.
  if (trackOuts.length === 0) {
    chains.push(`${color('black', range.frames, WORK_FMT)}[trk0]`);
    trackOuts.push('trk0');
  }
  let base = trackOuts[0]!;
  trackOuts.slice(1).forEach((top, i) => {
    const out = `ov${i}`;
    chains.push(`[${base}][${top}]overlay=format=yuv444p10:eof_action=pass[${out}]`);
    base = out;
  });
  chains.push(
    `[${base}]format=${encode.video.pixFmt},setparams=${opts({
      color_primaries: 'bt709',
      color_trc: 'bt709',
      colorspace: 'bt709',
      range: 'tv',
    })}[vout]`,
  );

  const graph = chains.join(';');
  const hashed = {
    compilerVersion: COMPILER_VERSION,
    timelineId: timeline.id,
    width: W,
    height: H,
    rate,
    range,
    inputs: inputs.map(({ path: _path, ...rest }) => rest),
    filtergraph: graph.replaceAll(FONT_TOKEN, `font:${input.slateFont?.contentHash ?? ''}`),
    encode,
  };
  const planHash = sha256(JSON.stringify(hashed));
  return {
    ...hashed,
    inputs,
    filtergraph: input.slateFont ? graph.replaceAll(FONT_TOKEN, esc(input.slateFont.path)) : graph,
    videoOut: 'vout',
    warnings,
    planHash,
  };
}

/**
 * Applies cross-track transitions: a card (graphic item) that meets a shot on the bottom
 * picture track, with nothing on that track while it shows, is moved onto the picture track
 * and the transition joins that track's list. Anything else is left as a hard cut, with a warning.
 */
function withCrossTransitions(timeline: Timeline, warnings: string[]): Timeline {
  const cross = crossTransitions(timeline);
  if (!cross.length) return timeline;
  const tracks: Track[] = timeline.tracks.map((t) => ({
    ...t,
    items: [...t.items],
    transitions: [...t.transitions],
  }));
  const base = tracks.find((t) => t.kind === 'video' && !t.muted);
  for (const t of cross) {
    const find = (id: string) => {
      for (const tr of tracks) {
        const it = tr.items.find((i) => i.id === id);
        if (it) return { tr, it };
      }
      return undefined;
    };
    const from = find(t.fromItemId);
    const to = find(t.toItemId);
    const card = [from, to].find((x) => x && x.tr !== base && x.it.kind === 'graphic');
    const shot = [from, to].find((x) => x && x.tr === base);
    const ok =
      base &&
      from &&
      to &&
      card &&
      shot &&
      itemEnd(from.it) === to.it.start &&
      !base.items.some((i) => i.start < itemEnd(card.it) && itemEnd(i) > card.it.start);
    if (!ok) {
      warnings.push(
        `transition "${t.id}": the card does not meet a shot on the picture track; a hard cut`,
      );
      continue;
    }
    card.tr.items = card.tr.items.filter((i) => i !== card.it);
    card.tr.transitions = card.tr.transitions.filter(
      (x) => x.fromItemId !== card.it.id && x.toItemId !== card.it.id,
    );
    base.items.push(card.it);
    base.transitions.push(t);
  }
  return { ...timeline, tracks };
}

/** The photosensitivity guard over the whole timeline (declared flashes of built-in filters). */
function checkFlashes(
  timeline: Timeline,
  filters: FilterRegistry,
  fpf: number,
  W: number,
  H: number,
): void {
  const rate = timeline.frameRate;
  const events: FlashEvent[] = [];
  const secs = (fl: number) => fl / FLICKS_PER_SECOND;
  for (const track of timeline.tracks) {
    if (track.kind === 'audio' || track.muted) continue;
    for (const t of track.transitions) {
      const def = filters.get(t.transitionId);
      const to = track.items.find((i) => i.id === t.toItemId);
      if (def?.kind !== 'transition' || !to) continue;
      const d = Math.max(1, Math.round(t.duration / fpf));
      const at = secs(to.start) - Math.ceil(d / 2) / (rate.num / rate.den);
      try {
        events.push(
          ...flashEvents(def, t.params, { width: W, height: H, rate, duration: d * secs(fpf) }, at),
        );
      } catch {
        // bad params are reported where the transition is compiled
      }
    }
    for (const it of track.items) {
      if (!('effects' in it)) continue;
      for (const e of it.effects) {
        const def = filters.get(e.effectId);
        if (!e.enabled || def?.kind !== 'effect') continue;
        try {
          events.push(
            ...flashEvents(
              def,
              e.params,
              { width: W, height: H, rate, duration: secs(it.duration) },
              secs(it.start),
            ),
          );
        } catch {
          // reported at compile
        }
      }
    }
  }
  try {
    assertFlashSafe(events);
  } catch (err) {
    if (err instanceof FlashRiskError) throw new CompileError(err.message);
    throw err;
  }
}

function slateText(reason: string): string {
  switch (reason) {
    case 'missing-footage':
      return 'Shot not recorded yet';
    case 'missing-voiceover':
      return 'Voice-over missing';
    case 'render-failed':
      return 'Render failed';
    default:
      return 'Missing media';
  }
}

/** Crop (on source pixels) and scale into the frame for one clip. Chains start with a comma. */
function geometry(
  item: Extract<TimelineItem, { kind: 'clip' }>,
  src: SourceMedia,
  W: number,
  H: number,
  skip: number,
  fpf: number,
  warnings: string[],
): { crop: string; scale: string; fill: boolean } {
  const t = item.transform;
  if (t) {
    const moved =
      JSON.stringify(t.position) !== '[0.5,0.5]' ||
      JSON.stringify(t.anchor) !== '[0.5,0.5]' ||
      t.scale !== 1 ||
      t.rotation !== 0 ||
      t.opacity !== 1;
    if (moved)
      warnings.push(
        `clip "${item.id}": position, scale, rotation and opacity are not rendered yet`,
      );
  }
  const reframe = (item.extensions.core as { reframe?: { mode?: string } } | undefined)?.reframe;
  const fill = reframe?.mode === 'fill';
  let crop = '';
  let cw = src.width;
  let ch = src.height;
  const insets = t?.crop;
  if (insets && !isZeroCrop(insets)) {
    const path = cropPath(insets, item.duration, skip, fpf);
    const first = path[0]!.v;
    cw = Math.max(2, Math.round(src.width * (1 - first[0]! - first[2]!)));
    ch = Math.max(2, Math.round(src.height * (1 - first[1]! - first[3]!)));
    const sizeMoves = path.some(
      (p) =>
        Math.round(src.width * (1 - p.v[0]! - p.v[2]!)) !== cw ||
        Math.round(src.height * (1 - p.v[1]! - p.v[3]!)) !== ch,
    );
    if (sizeMoves)
      warnings.push(`clip "${item.id}": the crop changes size; its first size is used`);
    const xs = path.map((p) => ({
      f: p.f,
      v: clamp(Math.round(src.width * p.v[0]!), 0, src.width - cw),
    }));
    const ys = path.map((p) => ({
      f: p.f,
      v: clamp(Math.round(src.height * p.v[1]!), 0, src.height - ch),
    }));
    crop = `,crop=${opts({ w: cw, h: ch, x: piecewise(xs), y: piecewise(ys), exact: 1 })}`;
  }
  const sameShape = Math.abs(cw / ch - W / H) <= 0.005 * (W / H);
  const scaleOpts =
    'flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv';
  let scale: string;
  if (sameShape) {
    scale = `scale=${W}:${H}:${scaleOpts}`;
  } else {
    const s = Math.min(W / cw, H / ch);
    const sw = Math.min(W, Math.round(cw * s));
    const sh = Math.min(H, Math.round(ch * s));
    scale = fill
      ? `scale=${sw}:${sh}:${scaleOpts}`
      : `scale=${sw}:${sh}:${scaleOpts},pad=${W}:${H}:${Math.floor((W - sw) / 2)}:${Math.floor((H - sh) / 2)}:black`;
  }
  return { crop, scale, fill: fill && !sameShape };
}

function isZeroCrop(a: Animatable): boolean {
  return Array.isArray(a) && a.every((v) => v === 0);
}

interface Point {
  /** Frame index within the rendered part of the clip. */
  f: number;
  v: number[];
}

/**
 * Crop insets sampled at frame indices: keyframes exactly, linear segments as straight lines,
 * holds as steps, other easings sampled every few frames (the same evaluator as the preview).
 */
export function cropPath(a: Animatable, duration: number, skip: number, fpf: number): Point[] {
  const at = (f: number) => evaluateVector(a, Math.round((f + skip) * fpf), 4);
  const frames = Math.max(1, Math.round(duration / fpf) - skip);
  if (typeof a === 'number' || Array.isArray(a)) return [{ f: 0, v: at(0) }];
  const ks = a.keyframes;
  const step = Math.max(2, Math.ceil(frames / 150));
  const pts: Point[] = [{ f: 0, v: at(0) }];
  for (let i = 0; i < ks.length; i++) {
    const f0 = Math.round(ks[i]!.at / fpf) - skip;
    const f1 = i + 1 < ks.length ? Math.round(ks[i + 1]!.at / fpf) - skip : Infinity;
    const easing = ks[i]!.easing;
    if (f1 <= 0 || f0 >= frames) continue;
    if (f0 > 0) pts.push({ f: f0, v: at(f0) });
    if (f1 === Infinity) break;
    if (easing === 'hold') {
      if (f1 - 1 > Math.max(0, f0)) pts.push({ f: f1 - 1, v: at(f1 - 1) });
    } else if (easing !== 'linear') {
      for (let f = Math.max(0, f0) + step; f < Math.min(f1, frames); f += step)
        pts.push({ f, v: at(f) });
    }
  }
  const out: Point[] = [];
  for (const p of pts) {
    if (p.f >= frames) continue;
    if (out.length && out[out.length - 1]!.f >= p.f) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** A piecewise-linear expression of the frame number `n` through the given points. */
export function piecewise(pts: readonly { f: number; v: number }[]): string {
  if (pts.length === 1 || pts.every((p) => p.v === pts[0]!.v)) return n(pts[0]!.v);
  let expr = n(pts[pts.length - 1]!.v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const slope = (b.v - a.v) / (b.f - a.f);
    const seg = slope === 0 ? n(a.v) : `${n(a.v)}+(n-${a.f})*${n(slope)}`;
    expr = `if(lt(n,${b.f}),${seg},${expr})`;
  }
  return expr;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The full FFmpeg argument list for a plan. With `graphFile`, the graph is read from that file. */
export function ffmpegArgs(
  plan: RenderPlan,
  output: string,
  opt: { graphFile?: string } = {},
): string[] {
  const e = plan.encode;
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...plan.inputs.flatMap((i) =>
      i.kind === 'media'
        ? ['-ss', i.seek, '-t', i.duration, '-i', i.path]
        : ['-framerate', i.rate, '-start_number', String(i.startNumber), '-i', i.path],
    ),
    ...(opt.graphFile
      ? ['-filter_complex_script', opt.graphFile]
      : ['-filter_complex', plan.filtergraph]),
    '-map',
    `[${plan.videoOut}]`,
    '-an',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-map_metadata',
    '-1',
    '-threads',
    String(e.threads),
    '-c:v',
    e.video.codec,
    ...e.video.args,
    '-pix_fmt',
    e.video.pixFmt,
    '-r',
    rateText(plan.rate),
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    '-frames:v',
    String(plan.range.frames),
    '-f',
    e.container === 'mkv' ? 'matroska' : e.container,
    output,
  ];
}
