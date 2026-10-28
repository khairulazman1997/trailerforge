import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flashViolations, type FlashEvent } from '@trailerforge/effects';
import type { Rate } from '@trailerforge/schema';
import { resolveTools, type FfmpegTools } from './detect.js';
import { MediaError } from './errors.js';
import { measureLoudness, type LoudnessMeasurement } from './loudness.js';
import { runTool } from './process.js';
import type { QualityFinding } from './quality-gate.js';

/**
 * The Quality Gate's checks on a rendered file: what the viewer actually gets. The picture is
 * decoded small (64×36 RGB, area-averaged) and analysed frame by frame for photosensitive flash
 * risk (general and red flashes over a quarter of the frame, WCAG 2.3.1 / Harding style: a
 * flash is a pair of opposing luminance changes of 10% where the darker state is below 0.8),
 * black runs inside the picture and single flash frames; the sound for loudness, true peak and
 * clipping; the streams for size, rate, length and sync. Findings use the gate's tiers (see
 * `GATE_POLICY` in `@trailerforge/cut`). Reports are cached by the file's content hash.
 *
 * The flash analysis is whole-frame-area based on a small picture: it catches strobes and
 * flashing cuts, not a small flashing detail (under a quarter of the frame, which WCAG allows).
 */

export const OUTPUT_GATE_VERSION = 1;

export interface OutputExpectations {
  width: number;
  height: number;
  rate: Rate;
  /** Length in frames. */
  frames: number;
  /** Loudness target; null skips the loudness checks (no audio expected). */
  loudness: { lufs: number; truePeakDb: number; toleranceLu?: number } | null;
}

export interface PictureAnalysis {
  frames: number;
  /** Seconds of each flash (second change of an opposing pair), general and red. */
  flashes: FlashEvent[];
  /** Black stretches not touching the start or end, seconds. */
  black: { start: number; end: number }[];
  /** Single frames much brighter or darker than both neighbours, seconds. */
  flashFrames: number[];
}

export interface OutputFacts {
  video: {
    width: number;
    height: number;
    rate: string;
    frames: number;
    duration: number;
    start: number;
  };
  audio: { duration: number; start: number; sampleRate: number } | null;
  picture: PictureAnalysis;
  loudness: LoudnessMeasurement | null;
  /** Highest sample, dBFS (0 = full scale). */
  samplePeakDb: number | null;
}

export interface OutputGateReport {
  version: number;
  sha256: string;
  facts: OutputFacts;
  findings: QualityFinding[];
}

const W = 64;
const H = 36;
const AREA = 0.25;

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const LIN = Float64Array.from({ length: 256 }, (_, i) => lin(i));

/** Analyse decoded RGB24 frames (W×H each) at `fps`. Pure. */
export function analyzePicture(
  frames: readonly Uint8Array[],
  fps: number,
  size = { width: W, height: H },
): PictureAnalysis {
  const px = size.width * size.height;
  const L: Float64Array[] = [];
  const red: Float64Array[] = [];
  const luma: number[] = [];
  for (const f of frames) {
    const l = new Float64Array(px);
    const r = new Float64Array(px); // redness (Harding: (R-G-B)*320 on 0..1 values), 0 if not saturated
    let y = 0;
    for (let i = 0; i < px; i++) {
      const R = f[i * 3]!;
      const G = f[i * 3 + 1]!;
      const B = f[i * 3 + 2]!;
      const lr = LIN[R]!;
      const lg = LIN[G]!;
      const lb = LIN[B]!;
      l[i] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const sum = lr + lg + lb;
      r[i] = sum > 0 && lr / sum >= 0.8 ? Math.max(0, (R - G - B) / 255) * 320 : 0;
      y += (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
    }
    L.push(l);
    red.push(r);
    luma.push(y / px);
  }
  // Opposing transitions over a quarter of the frame; each completed pair is a flash.
  const flashes: FlashEvent[] = [];
  const track = (kind: string, step: (i: number) => 1 | -1 | 0) => {
    let last: 1 | -1 | 0 = 0;
    for (let i = 1; i < frames.length; i++) {
      const d = step(i);
      if (!d) continue;
      if (last && d !== last) flashes.push({ at: round(i / fps), source: kind });
      last = d;
    }
  };
  track('luminance flash', (i) => {
    const a = L[i - 1]!;
    const b = L[i]!;
    let up = 0;
    let down = 0;
    for (let k = 0; k < px; k++) {
      const d = b[k]! - a[k]!;
      if (Math.min(a[k]!, b[k]!) >= 0.8) continue;
      if (d >= 0.1) up++;
      else if (d <= -0.1) down++;
    }
    return up >= AREA * px ? 1 : down >= AREA * px ? -1 : 0;
  });
  track('red flash', (i) => {
    const a = red[i - 1]!;
    const b = red[i]!;
    let up = 0;
    let down = 0;
    for (let k = 0; k < px; k++) {
      const d = b[k]! - a[k]!;
      if (d > 20) up++;
      else if (d < -20) down++;
    }
    return up >= AREA * px ? 1 : down >= AREA * px ? -1 : 0;
  });
  // Black runs (mean luma under 4%) that do not touch either end.
  const black: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let i = 0; i <= luma.length; i++) {
    const isBlack = i < luma.length && luma[i]! < 0.04;
    if (isBlack && runStart < 0) runStart = i;
    if (!isBlack && runStart >= 0) {
      if (runStart > 0 && i < luma.length)
        black.push({ start: round(runStart / fps), end: round(i / fps) });
      runStart = -1;
    }
  }
  const flashFrames: number[] = [];
  for (let i = 1; i + 1 < luma.length; i++) {
    const [a, b, c] = [luma[i - 1]!, luma[i]!, luma[i + 1]!];
    if (
      Math.abs(b - a) >= 0.2 &&
      Math.abs(b - c) >= 0.2 &&
      Math.abs(a - c) < 0.1 &&
      Math.sign(b - a) === Math.sign(b - c)
    )
      flashFrames.push(round(i / fps));
  }
  return { frames: frames.length, flashes, black, flashFrames };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Decode a file's picture at 64×36 RGB24, frame by frame. */
async function decodeSmall(
  file: string,
  tools: FfmpegTools,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:v:0',
        '-vf', `scale=${W}:${H}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], // prettier-ignore
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const size = W * H * 3;
    const frames: Uint8Array[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        frames.push(Uint8Array.from(pending.subarray(0, size)));
        pending = pending.subarray(size);
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new MediaError('cancelled', 'quality check cancelled'));
      else if (code !== 0)
        reject(
          new MediaError('process-failed', 'could not decode the picture', stderr.slice(-2000)),
        );
      else resolve(frames);
    });
  });
}

interface StreamFacts {
  codec_type: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_packets?: string;
  duration?: string;
  start_time?: string;
  sample_rate?: string;
}

/** Measure everything the output checks need. */
export async function measureOutput(
  file: string,
  opts: { tools?: FfmpegTools; signal?: AbortSignal } = {},
): Promise<OutputFacts> {
  const tools = opts.tools ?? resolveTools();
  const sig = opts.signal ? { signal: opts.signal } : {};
  const { stdout } = await runTool(
    tools.ffprobe,
    ['-v', 'error', '-count_packets', '-show_entries',
      'stream=codec_type,width,height,r_frame_rate,nb_read_packets,duration,start_time,sample_rate',
      '-of', 'json', file], // prettier-ignore
    sig,
  );
  const streams = (JSON.parse(stdout) as { streams: StreamFacts[] }).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new MediaError('process-failed', 'the file has no picture');
  const a = streams.find((s) => s.codec_type === 'audio');
  const [rn, rd] = (v.r_frame_rate ?? '0/1').split('/').map(Number) as [number, number];
  const fps = rn / (rd || 1);
  const frames = await decodeSmall(file, tools, opts.signal);
  let samplePeakDb: number | null = null;
  let samples: number | null = null;
  let loudness: LoudnessMeasurement | null = null;
  if (a) {
    const { stderr } = await runTool(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-af',
        'astats=metadata=0',
        '-f',
        'null',
        '-',
      ],
      sig,
    );
    const peaks = [...stderr.matchAll(/Peak level dB:\s*(-?[\d.]+|-inf)/g)].map((m) =>
      m[1] === '-inf' ? -Infinity : Number(m[1]),
    );
    samplePeakDb = peaks.length ? round(peaks.at(-1)!) : null;
    const counts = [...stderr.matchAll(/Number of samples:\s*(\d+)/g)].map((m) => Number(m[1]));
    if (counts.length) samples = counts.at(-1)!;
    loudness = await measureLoudness(file, { tools, ...sig });
  }
  return {
    video: {
      width: v.width ?? 0,
      height: v.height ?? 0,
      rate: v.r_frame_rate ?? '0/1',
      frames: Number(v.nb_read_packets ?? frames.length),
      // Counted, not read from the container (Matroska has no per-stream duration).
      duration: round(Number(v.nb_read_packets ?? frames.length) / (fps || 1)),
      start: round(Number(v.start_time ?? 0)),
    },
    audio: a
      ? {
          duration:
            samples !== null && Number(a.sample_rate)
              ? round(samples / Number(a.sample_rate))
              : round(Number(a.duration ?? 0)),
          start: round(Number(a.start_time ?? 0)),
          sampleRate: Number(a.sample_rate ?? 0),
        }
      : null,
    picture: analyzePicture(frames, fps || 1),
    loudness: loudness
      ? {
          integratedLufs: round(loudness.integratedLufs),
          truePeakDb: round(loudness.truePeakDb),
          rangeLu: round(loudness.rangeLu),
          thresholdLufs: round(loudness.thresholdLufs),
        }
      : null,
    samplePeakDb,
  };
}

const f = (
  checkId: string,
  tier: 'hard' | 'override',
  message: string,
  extra: Partial<QualityFinding> = {},
): QualityFinding => ({ checkId, severity: 'error', tier, message, ...extra });

/** The output checks over measured facts. Pure. */
export function checkOutput(facts: OutputFacts, exp: OutputExpectations): QualityFinding[] {
  const out: QualityFinding[] = [];
  const v = facts.video;
  const rate = `${exp.rate.num}/${exp.rate.den}`;
  const fps = exp.rate.num / exp.rate.den;
  if (v.width !== exp.width || v.height !== exp.height)
    out.push(
      f(
        'core/output-format',
        'hard',
        `the file is ${v.width}×${v.height}; the version is ${exp.width}×${exp.height}`,
      ),
    );
  const [rn, rd] = v.rate.split('/').map(Number) as [number, number];
  if (Math.abs(rn / (rd || 1) - fps) > 1e-3)
    out.push(
      f('core/output-format', 'hard', `the file runs at ${v.rate} fps; the version at ${rate}`),
    );
  if (v.frames !== exp.frames)
    out.push(
      f(
        'core/output-format',
        'hard',
        `the file has ${v.frames} frames; the version has ${exp.frames}`,
      ),
    );

  for (const x of flashViolations(facts.picture.flashes))
    out.push(
      f(
        'core/flash-risk',
        'hard',
        `${x.count} flashes in one second (${x.sources.join(', ')}): unsafe for viewers with photosensitive epilepsy`,
        {
          at: { start: x.from, end: x.to },
          suggestion: 'Remove the strobing, or slow it to three flashes a second or fewer',
        },
      ),
    );
  for (const b of facts.picture.black)
    out.push(
      f('core/black-frames', 'override', `black picture from ${b.start} s to ${b.end} s`, {
        at: b,
        suggestion: 'Fill the gap, or override if the black is intended (a dip)',
      }),
    );
  for (const t of facts.picture.flashFrames)
    out.push(
      f('core/flash-frames', 'override', `a single flash frame at ${t} s`, {
        at: { start: t, end: round(t + 1 / fps) },
        suggestion: 'Trim the stray frame at the cut',
      }),
    );

  if (exp.loudness) {
    if (!facts.audio || !facts.loudness)
      out.push(f('core/loudness', 'override', 'the file has no sound'));
    else {
      const { integratedLufs, truePeakDb } = facts.loudness;
      const tol = exp.loudness.toleranceLu ?? 1;
      if (Math.abs(integratedLufs - exp.loudness.lufs) > tol)
        out.push(
          f(
            'core/loudness',
            'override',
            `loudness is ${integratedLufs} LUFS; the target is ${exp.loudness.lufs} LUFS (±${tol})`,
          ),
        );
      if (truePeakDb > exp.loudness.truePeakDb)
        out.push(f('core/true-peak', 'hard', `true peak is ${truePeakDb} dBTP; the limit is ${exp.loudness.truePeakDb} dBTP`, {
          suggestion: 'Render again with the loudness target on (the limiter keeps peaks under the ceiling)',
        })); // prettier-ignore
    }
  }
  if (facts.samplePeakDb !== null && facts.samplePeakDb >= -0.001)
    out.push(
      f(
        'core/clipping',
        'hard',
        `the sound reaches full scale (${facts.samplePeakDb} dBFS): it clips`,
      ),
    );

  if (facts.audio) {
    const half = 0.5 / fps;
    const drift = Math.max(Math.abs(facts.audio.start - v.start), Math.abs(facts.audio.start + facts.audio.duration - (v.start + v.duration)));
    if (drift > half + 0.025) // AAC frames are ~21 ms: allow one past half a picture frame
      out.push(f('core/av-sync', 'override', `sound and picture differ by ${round(drift)} s`));
  } // prettier-ignore
  const order = { error: 0, warning: 1, info: 2 } as const;
  return out.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.at?.start ?? -1) - (b.at?.start ?? -1) ||
      (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0) ||
      (a.message < b.message ? -1 : 1),
  );
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Measure and check a rendered file; with `cacheDir`, the report is kept by the file's content
 * hash (and the expectations), so checking the same file again costs a hash.
 */
export async function runOutputGate(
  file: string,
  exp: OutputExpectations,
  opts: { cacheDir?: string; tools?: FfmpegTools; signal?: AbortSignal } = {},
): Promise<OutputGateReport> {
  const sha256 = await sha256File(file);
  const key = createHash('sha256')
    .update(JSON.stringify([OUTPUT_GATE_VERSION, sha256, exp]))
    .digest('hex');
  const cached = opts.cacheDir ? join(opts.cacheDir, `${key}.json`) : undefined;
  if (cached) {
    try {
      return JSON.parse(await readFile(cached, 'utf8')) as OutputGateReport;
    } catch {
      // not cached yet
    }
  }
  const facts = await measureOutput(file, opts);
  const report: OutputGateReport = {
    version: OUTPUT_GATE_VERSION,
    sha256,
    facts,
    findings: checkOutput(facts, exp),
  };
  if (cached && opts.cacheDir) {
    await mkdir(opts.cacheDir, { recursive: true });
    const tmp = `${cached}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(report, null, 2));
    await rename(tmp, cached);
  }
  return report;
}
