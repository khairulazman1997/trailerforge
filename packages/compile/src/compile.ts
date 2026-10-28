import { n } from '@trailerforge/effects';
import { evaluateVector } from '@trailerforge/graphics';
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  flicksToFrames,
  framesToFlicks,
  timelineDuration,
  type Animatable,
  type Rate,
  type Timeline,
  type TimelineItem,
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
 * fill behind the whole picture. Processing is 4:4:4 10-bit; the output is tagged BT.709.
 */

export const COMPILER_VERSION = 1;

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
  encode?: EncodeSettings;
  range?: FrameRange;
  /** Font for placeholder slate labels; without it the slate is plain. */
  slateFont?: { path: string; contentHash: string };
}

export interface PlanInput {
  assetId: string;
  path: string;
  contentHash: string;
  /** Input `-ss` and `-t`, seconds as FFmpeg reads them. */
  seek: string;
  duration: string;
}

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

type Segment =
  | { kind: 'gap'; frames: number }
  | { kind: 'clip'; frames: number; item: Extract<TimelineItem, { kind: 'clip' }>; skip: number }
  | { kind: 'slate'; frames: number; label: string };

export function compileRender(input: CompileInput): RenderPlan {
  const { timeline } = input;
  const rate = timeline.frameRate;
  const { width: W, height: H } = timeline.resolution;
  const encode = input.encode ?? DRAFT_ENCODE;
  const total = flicksToFrames(timelineDuration(timeline), rate);
  const range = input.range ?? { start: 0, frames: total };
  if (range.frames <= 0 || range.start < 0 || !Number.isInteger(range.frames + range.start))
    throw new CompileError(`nothing to render: range ${range.start}+${range.frames}`);
  const rangeEnd = range.start + range.frames;
  const warnings: string[] = [];
  const inputs: PlanInput[] = [];
  const chains: string[] = [];
  const fpf = flicksPerFrame(rate);

  const videoTracks = timeline.tracks.filter((t) => t.kind === 'video' && !t.muted);
  const trackOuts: string[] = [];

  videoTracks.forEach((track, ti) => {
    const alpha = ti > 0;
    const segments: Segment[] = [];
    let cursor = range.start;
    const items = [...track.items].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (const item of items) {
      const fs = flicksToFrames(item.start, rate);
      const fe = flicksToFrames(item.start + item.duration, rate);
      const a = Math.max(fs, cursor);
      const b = Math.min(fe, rangeEnd);
      if (b <= a) continue;
      if (a > cursor) segments.push({ kind: 'gap', frames: a - cursor });
      const frames = b - a;
      if (item.kind === 'clip') {
        if (input.sources.has(item.assetId)) {
          segments.push({ kind: 'clip', frames, item, skip: a - fs });
        } else {
          warnings.push(
            `clip "${item.id}": recording ${item.assetId} is missing; drawn as a slate`,
          );
          segments.push({ kind: 'slate', frames, label: item.label ?? 'Missing recording' });
        }
      } else if (item.kind === 'placeholder') {
        segments.push({ kind: 'slate', frames, label: item.label ?? slateText(item.reason) });
      } else {
        warnings.push(`item "${item.id}" (${item.kind}) on a video track is not rendered yet`);
        segments.push({ kind: 'gap', frames });
      }
      cursor = b;
    }
    if (cursor < rangeEnd) segments.push({ kind: 'gap', frames: rangeEnd - cursor });

    const segLabels: string[] = [];
    segments.forEach((seg, si) => {
      const out = `t${ti}s${si}`;
      segLabels.push(out);
      const fmt = alpha ? WORK_FMT_ALPHA : WORK_FMT;
      if (seg.kind === 'gap') {
        const c = alpha ? 'black@0' : 'black';
        chains.push(
          `color=${opts({ c, s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${seg.frames},format=${fmt},setsar=1[${out}]`,
        );
      } else if (seg.kind === 'slate') {
        const text = input.slateFont
          ? `,drawtext=${opts({
              fontfile: FONT_TOKEN,
              text: seg.label,
              expansion: 'none',
              fontcolor: 'white',
              fontsize: Math.round(Math.min(W, H) * 0.06),
              x: '(w-text_w)/2',
              y: '(h-text_h)/2',
            })}`
          : '';
        chains.push(
          `color=${opts({ c: SLATE_COLOR, s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${seg.frames}${text},format=${fmt},setsar=1[${out}]`,
        );
      } else {
        const src = input.sources.get(seg.item.assetId)!;
        const k = inputs.length;
        const item = seg.item;
        const speed = item.speed;
        const startFlicks = item.sourceIn + framesToFlicks(seg.skip, rate) * speed;
        const startSec = startFlicks / FLICKS_PER_SECOND;
        const half = (0.5 * src.frameRate.den) / src.frameRate.num;
        const needSec = (seg.frames / (rate.num / rate.den)) * speed;
        if (startSec >= src.duration) {
          warnings.push(`clip "${item.id}" starts past the end of its recording; drawn as a slate`);
          chains.push(
            `color=${opts({ c: SLATE_COLOR, s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${seg.frames},format=${fmt},setsar=1[${out}]`,
          );
          return;
        }
        const lastWanted = startSec + needSec - (speed * rate.den) / rate.num;
        if (lastWanted > src.duration - half)
          warnings.push(`clip "${item.id}" runs past the end of its recording; last frame held`);
        const seek = Math.max(0, Math.floor((startSec - half) * 1e6) / 1e6);
        inputs.push({
          assetId: item.assetId,
          path: src.path,
          contentHash: src.contentHash,
          seek: n(seek),
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
          'tpad=stop_mode=clone:stop=-1',
          `trim=end_frame=${seg.frames}`,
          'setpts=PTS-STARTPTS',
        ];
        const geo = geometry(item, src, W, H, seg.skip, fpf, warnings);
        const fmtTail = `format=${fmt},setsar=1`;
        if (geo.fill) {
          const bw = Math.max(2, Math.round(W / 8));
          const bh = Math.max(2, Math.round(H / 8));
          const blur = Math.max(1, Math.min(4, Math.floor(Math.min(bw, bh) / 2) - 1));
          chains.push(`[${k}:v]${parts.join(',')}${geo.crop},split=2[${out}a][${out}b]`);
          chains.push(
            `[${out}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bw}:${bh},format=${WORK_FMT},boxblur=${opts({ luma_radius: blur, luma_power: 2, chroma_radius: blur, chroma_power: 2 })},scale=${W}:${H}:flags=bicubic,format=${WORK_FMT}[${out}bg]`,
          );
          chains.push(`[${out}b]${geo.scale},format=${WORK_FMT}[${out}fg]`);
          chains.push(
            `[${out}bg][${out}fg]overlay=x=${esc('(W-w)/2')}:y=${esc('(H-h)/2')}:format=yuv444p10,${fmtTail}[${out}]`,
          );
        } else {
          chains.push(`[${k}:v]${parts.join(',')}${geo.crop},${geo.scale},${fmtTail}[${out}]`);
        }
      }
    });
    const trackOut = `trk${ti}`;
    chains.push(
      `${segLabels.map((l) => `[${l}]`).join('')}concat=n=${segLabels.length}:v=1:a=0[${trackOut}]`,
    );
    trackOuts.push(trackOut);
  });

  // No picture track at all: black.
  if (trackOuts.length === 0) {
    chains.push(
      `color=${opts({ c: 'black', s: `${W}x${H}`, r: rateText(rate) })},trim=end_frame=${range.frames},format=${WORK_FMT},setsar=1[trk0]`,
    );
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
    ...plan.inputs.flatMap((i) => ['-ss', i.seek, '-t', i.duration, '-i', i.path]),
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
