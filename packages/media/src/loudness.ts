import { resolveTools, type FfmpegTools } from './detect.js';
import { MediaError } from './errors.js';
import { runTool, type RunOptions } from './process.js';

export interface LoudnessMeasurement {
  /** Integrated loudness, LUFS. */
  integratedLufs: number;
  /** True peak, dBTP. */
  truePeakDb: number;
  /** Loudness range, LU. */
  rangeLu: number;
  /** Gating threshold, LUFS (needed for two-pass loudnorm in M4). */
  thresholdLufs: number;
}

/** EBU R128 measurement via loudnorm's analysis pass (first audio stream). */
export async function measureLoudness(
  input: string,
  opts: RunOptions & { tools?: FfmpegTools } = {},
): Promise<LoudnessMeasurement> {
  const { stderr } = await runTool(
    (opts.tools ?? resolveTools()).ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      input,
      '-map',
      '0:a:0',
      '-af',
      'loudnorm=print_format=json',
      '-f',
      'null',
      '-',
    ],
    opts,
  );
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
  if (!json)
    throw new MediaError(
      'process-failed',
      'loudnorm produced no measurement (no audio stream?)',
      stderr.slice(-2000),
    );
  const m = JSON.parse(json) as Record<string, string>;
  const num = (k: string) => {
    const v = Number(m[k]);
    return Number.isFinite(v) ? v : -Infinity; // "-inf" for digital silence
  };
  return {
    integratedLufs: num('input_i'),
    truePeakDb: num('input_tp'),
    rangeLu: num('input_lra'),
    thresholdLufs: num('input_thresh'),
  };
}
