import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  compileAudio,
  compileRender,
  ffmpegArgs,
  ffmpegAudioArgs,
  masterFor,
  type CompileInput,
  type EncodeSettings,
  type FrameRange,
  type GraphicFrames,
  type LoudnessTarget,
  type MasterSettings,
  type SourceMedia,
} from '@trailerforge/compile';
import { JobError, defineJob, type JobQueue } from '@trailerforge/jobs';
import {
  MediaError,
  ensureFreeSpace,
  measureLoudness,
  resolveTools,
  runTool,
  type FfmpegTools,
} from '@trailerforge/media';
import type { Rate, Timeline } from '@trailerforge/schema';
import { z } from 'zod';

/**
 * Crash-safe, resumable video renders. A render is cut into fixed-length segments on frame
 * boundaries; each is compiled for its frame range (the compiler guarantees the same frames as a
 * full render), encoded to a temp file, checked by frame count, hashed and renamed into
 * `<workRoot>/<planHash>/`, then recorded in `manifest.json` (written atomically). The audio is
 * mixed once, measured, and mastered to the loudness target. The segments are joined without
 * re-encoding and muxed with the audio into a temp file that is renamed onto the output.
 *
 * Rerunning the same spec after a crash or a cancel renders only what the manifest does not
 * vouch for; with a software encoder the output is byte-identical to an uninterrupted run. A
 * different FFmpeg build starts the segments over (the manifest records the build).
 */

export const VIDEO_RENDER_VERSION = 1;

/** Everything a render needs, serialisable so a job can carry it as a file. */
export interface RenderSpec {
  timeline: Timeline;
  sources: [string, SourceMedia][];
  graphics?: [string, GraphicFrames][];
  encode: EncodeSettings;
  /** FFmpeg audio codec arguments for the final file; default AAC 320k. */
  audioCodec?: string[];
  /** Loudness target; null keeps the raw mix. */
  loudness: LoudnessTarget | null;
  retime?: CompileInput['retime'];
  slateFont?: CompileInput['slateFont'];
  /** Segment length in seconds (rounded to whole frames). Default 10. */
  segmentSeconds?: number;
  output: string;
}

export interface SegmentEntry {
  index: number;
  start: number;
  frames: number;
  planHash: string;
  file: string;
  sha256: string;
}

export interface RenderManifest {
  version: number;
  planHash: string;
  ffmpeg: string;
  /** False when a hardware encoder made the picture: the bytes depend on the machine. */
  reproducible: boolean;
  segments: SegmentEntry[];
  audio?: { mixHash: string; master: MasterSettings | null; file: string; sha256: string };
  output?: { file: string; sha256: string; bytes: number };
}

export interface RenderProgress {
  phase: 'segments' | 'audio' | 'mux' | 'done';
  segmentsDone: number;
  segments: number;
}

export interface RenderResult {
  output: string;
  sha256: string;
  planHash: string;
  workDir: string;
  rendered: number;
  reused: number;
  manifest: RenderManifest;
  warnings: string[];
}

export interface RenderOptions {
  /** Cache root, e.g. `<project>/cache/render`. */
  workRoot: string;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  tools?: FfmpegTools;
}

const DEFAULT_AUDIO = ['-c:a', 'aac', '-b:a', '320k'];

/** Frame ranges of `seconds` each (the last one shorter). */
export function planSegments(frames: number, rate: Rate, seconds = 10): FrameRange[] {
  const per = Math.max(1, Math.round((seconds * rate.num) / rate.den));
  const out: FrameRange[] = [];
  for (let start = 0; start < frames; start += per)
    out.push({ start, frames: Math.min(per, frames - start) });
  return out;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function frameCount(tools: FfmpegTools, file: string, signal?: AbortSignal) {
  const { stdout } = await runTool(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
      'stream=nb_read_packets', '-of', 'csv=p=0', file], // prettier-ignore
    signal ? { signal } : {},
  );
  return Number(stdout.trim());
}

async function ffmpegBuild(tools: FfmpegTools): Promise<string> {
  const { stdout } = await runTool(tools.ffmpeg, ['-hide_banner', '-version']);
  return stdout.split('\n')[0]!.trim();
}

/** Render (or resume) a spec. Throws `MediaError('cancelled')` when aborted. */
export async function renderVideo(spec: RenderSpec, opts: RenderOptions): Promise<RenderResult> {
  const tools = opts.tools ?? resolveTools();
  const signal = opts.signal;
  const run = (args: string[]) => runTool(tools.ffmpeg, args, signal ? { signal } : {});
  const sources = new Map(spec.sources);
  const base: CompileInput = {
    timeline: spec.timeline,
    sources,
    ...(spec.graphics ? { graphics: new Map(spec.graphics) } : {}),
    encode: spec.encode,
    ...(spec.retime ? { retime: spec.retime } : {}),
    ...(spec.slateFont ? { slateFont: spec.slateFont } : {}),
  };
  const full = compileRender(base);
  const workDir = join(opts.workRoot, full.planHash);
  await mkdir(workDir, { recursive: true });
  // Leftovers of a crashed run are never trusted.
  for (const f of await readdir(workDir)) if (f.includes('.tmp')) await rm(join(workDir, f));

  const manifestPath = join(workDir, 'manifest.json');
  const build = await ffmpegBuild(tools);
  let manifest: RenderManifest = {
    version: VIDEO_RENDER_VERSION,
    planHash: full.planHash,
    ffmpeg: build,
    reproducible: !spec.encode.video.hardware,
    segments: [],
  };
  try {
    const prev = JSON.parse(await readFile(manifestPath, 'utf8')) as RenderManifest;
    if (
      prev.version === VIDEO_RENDER_VERSION &&
      prev.planHash === full.planHash &&
      prev.ffmpeg === build
    )
      manifest = { ...prev };
    delete manifest.output;
  } catch {
    // no manifest yet, or a damaged one: start over
  }
  const save = () => writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  const { width: W, height: H } = spec.timeline.resolution;
  const ranges = planSegments(full.range.frames, spec.timeline.frameRate, spec.segmentSeconds);
  await ensureFreeSpace(opts.workRoot, Math.round((W * H * full.range.frames) / 8));
  const segEncode: EncodeSettings = { ...spec.encode, container: 'mkv' };
  const warnings = [...full.warnings];
  let rendered = 0;
  let reused = 0;
  const report = (phase: RenderProgress['phase']) =>
    opts.onProgress?.({ phase, segmentsDone: rendered + reused, segments: ranges.length });
  const tmps = new Set<string>();
  const tmp = (p: string) => {
    const t = `${p}.tmp-${process.pid}`;
    tmps.add(t);
    return t;
  };

  try {
    const segments: SegmentEntry[] = [];
    for (const [index, range] of ranges.entries()) {
      signal?.throwIfAborted();
      const plan = compileRender({ ...base, encode: segEncode, range });
      const file = `seg_${String(index).padStart(5, '0')}.mkv`;
      const path = join(workDir, file);
      const known = manifest.segments.find(
        (s) => s.index === index && s.planHash === plan.planHash,
      );
      if (known && (await exists(path)) && (await sha256File(path)) === known.sha256) {
        segments.push(known);
        reused++;
        report('segments');
        continue;
      }
      const t = tmp(path);
      await run(ffmpegArgs(plan, t));
      const got = await frameCount(tools, t, signal);
      if (got !== range.frames)
        throw new JobError(
          `segment ${index}: ${got} frames written, ${range.frames} expected`,
          true,
        );
      const entry: SegmentEntry = {
        index,
        ...range,
        planHash: plan.planHash,
        file,
        sha256: await sha256File(t),
      };
      await rename(t, path);
      tmps.delete(t);
      segments.push(entry);
      manifest.segments = [...manifest.segments.filter((s) => s.index !== index), entry];
      await save();
      rendered++;
      report('segments');
    }

    // Audio: the mix, measured, then mastered (each step reused when its file is intact).
    report('audio');
    const mixPlan = compileAudio({ timeline: spec.timeline, sources });
    warnings.push(...mixPlan.warnings);
    let master: MasterSettings | null = null;
    const audioFile = join(workDir, 'audio.wav');
    const a = manifest.audio;
    if (!(
      a &&
      a.mixHash === mixPlan.planHash &&
      (await exists(audioFile)) &&
      (await sha256File(audioFile)) === a.sha256
    )) {
      const mixFile = join(workDir, 'mix.wav');
      const t = tmp(mixFile);
      await run(ffmpegAudioArgs(mixPlan, t));
      await rename(t, mixFile);
      tmps.delete(t);
      if (spec.loudness) {
        master = masterFor(await measureLoudness(mixFile, signal ? { signal } : {}), spec.loudness);
        const t2 = tmp(audioFile);
        await run(ffmpegAudioArgs(compileAudio({ timeline: spec.timeline, sources, master }), t2));
        await rename(t2, audioFile);
        tmps.delete(t2);
      } else await rename(mixFile, audioFile);
      manifest.audio = {
        mixHash: mixPlan.planHash,
        master,
        file: 'audio.wav',
        sha256: await sha256File(audioFile),
      };
      await save();
    }

    // Join and mux.
    report('mux');
    signal?.throwIfAborted();
    const list = join(workDir, 'segments.txt');
    await writeAtomic(
      list,
      segments.map((s) => `file '${join(workDir, s.file).replace(/'/g, "'\\''")}'`).join('\n') +
        '\n',
    );
    await mkdir(dirname(spec.output), { recursive: true });
    const outTmp = tmp(spec.output);
    const container = spec.encode.container === 'mkv' ? 'matroska' : spec.encode.container;
    await run([
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', audioFile,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      ...(spec.audioCodec ?? DEFAULT_AUDIO),
      ...(container === 'mp4' || container === 'mov' ? ['-movflags', '+faststart'] : []),
      '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', '-map_chapters', '-1',
      '-f', container, outTmp,
    ]); // prettier-ignore
    const sha = await sha256File(outTmp);
    const bytes = (await stat(outTmp)).size;
    await rename(outTmp, spec.output);
    tmps.delete(outTmp);
    manifest.output = { file: spec.output, sha256: sha, bytes };
    await save();
    report('done');
    return {
      output: spec.output,
      sha256: sha,
      planHash: full.planHash,
      workDir,
      rendered,
      reused,
      manifest,
      warnings,
    };
  } catch (err) {
    for (const t of tmps) await rm(t, { force: true });
    if (signal?.aborted && !(err instanceof MediaError && err.code === 'cancelled'))
      throw new MediaError('cancelled', 'render cancelled');
    throw err;
  }
}

/** A render as a queue job: the spec lives in a JSON file, so the job input stays small. */
export const renderVideoJob = (deps: { tools?: FfmpegTools }) =>
  defineJob<{ specFile: string; workRoot: string }, never, { output: string; sha256: string }>({
    type: 'render/video',
    input: z.strictObject({ specFile: z.string().min(1), workRoot: z.string().min(1) }),
    concurrency: 1,
    maxAttempts: 2,
    run: async (ctx) => {
      const spec = JSON.parse(await readFile(ctx.input.specFile, 'utf8')) as RenderSpec;
      const r = await renderVideo(spec, {
        workRoot: ctx.input.workRoot,
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(p.segments ? p.segmentsDone / p.segments : 0, p.phase),
        ...(deps.tools ? { tools: deps.tools } : {}),
      });
      return { output: r.output, sha256: r.sha256 };
    },
  });

export function registerRenderJobs(queue: JobQueue, deps: { tools?: FfmpegTools } = {}): void {
  queue.register(renderVideoJob(deps));
}

/**
 * The poster frame of a finished file as a PNG (written to a temp file, then renamed). `seconds`
 * is clamped by the caller (`posterTime` in `@trailerforge/compile`).
 */
export async function writePoster(
  video: string,
  seconds: number,
  dest: string,
  opts: { signal?: AbortSignal; tools?: FfmpegTools } = {},
): Promise<void> {
  const tools = opts.tools ?? resolveTools();
  await mkdir(dirname(dest), { recursive: true });
  const t = `${dest}.tmp-${process.pid}`;
  try {
    await runTool(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', String(seconds), '-i', video,
        '-frames:v', '1', '-an', '-f', 'image2', '-c:v', 'png', t], // prettier-ignore
      opts.signal ? { signal: opts.signal } : {},
    );
    await rename(t, dest);
  } finally {
    await rm(t, { force: true });
  }
}

/**
 * A card's or caption's PNG frames (straight alpha) as a ProRes 4444 clip with alpha, for NLE
 * handoff. Written to a temp file and renamed; deterministic for the same frames.
 */
export async function encodeAlphaClip(
  frames: { pattern: string; frames: number },
  rate: Rate,
  dest: string,
  opts: { signal?: AbortSignal; tools?: FfmpegTools } = {},
): Promise<void> {
  const tools = opts.tools ?? resolveTools();
  await mkdir(dirname(dest), { recursive: true });
  const t = `${dest}.tmp-${process.pid}`;
  try {
    await runTool(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
        '-framerate', `${rate.num}/${rate.den}`, '-start_number', '0', '-i', frames.pattern,
        '-frames:v', String(frames.frames), '-c:v', 'prores_ks', '-profile:v', '4444',
        '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0',
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', '-f', 'mov', t], // prettier-ignore
      opts.signal ? { signal: opts.signal } : {},
    );
    await rename(t, dest);
  } finally {
    await rm(t, { force: true });
  }
}
