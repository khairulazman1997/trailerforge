import { n } from '@trailerforge/effects';
import { evaluateNumber } from '@trailerforge/graphics';
import {
  FLICKS_PER_SECOND,
  timelineDuration,
  type Animatable,
  type Timeline,
  type TimelineItem,
} from '@trailerforge/schema';
import { esc, piecewise, type SourceMedia } from './compile.js';
import { sha256 } from './sha256.js';

/**
 * The audio half of the render compiler: one timeline → one FFmpeg graph that mixes the music,
 * the sound effects and any clip audio into 48 kHz stereo float, sample-exact.
 *
 * Every audio item is cut from its file (seek, then an exact sample count), its gain (static or
 * keyframed in dB, which is how ducks and fades are stored) applied in 64-sample blocks, then
 * delayed to its place on the timeline and mixed without normalising. Clip audio on picture
 * tracks is off unless the clip turns it on (`extensions.core.clipAudio`), with optional J/L
 * offsets: the sound may start before the picture (`lead`) or run on after it (`lag`).
 *
 * Loudness is two passes, both deterministic: render the mix (no `master`), measure it (EBU
 * R128), then compile again with `master: masterFor(measured, target)` to apply one linear gain
 * and a true-peak limiter (4x oversampled, latency compensated, no auto level).
 */

export const AUDIO_COMPILER_VERSION = 1;
export const MIX_RATE = 48_000;
const FLICKS_PER_SAMPLE = FLICKS_PER_SECOND / MIX_RATE; // 14700, exact
/** J and L offsets are capped at one second. */
export const MAX_AUDIO_OFFSET = FLICKS_PER_SECOND;

/** Clip audio settings, stored on a clip at `extensions.core.clipAudio`. */
export interface ClipAudio {
  enabled: boolean;
  /** Flicks the sound starts before the picture (J cut). */
  lead?: number;
  /** Flicks the sound runs on after the picture (L cut). */
  lag?: number;
}

export function clipAudioOf(item: TimelineItem): ClipAudio | undefined {
  const raw = (item.extensions.core as { clipAudio?: Partial<ClipAudio> } | undefined)?.clipAudio;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return undefined;
  const cap = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(0, Math.min(MAX_AUDIO_OFFSET, Math.round(v)))
      : 0;
  return { enabled: true, lead: cap(raw.lead), lag: cap(raw.lag) };
}

export interface LoudnessTarget {
  /** Integrated loudness, LUFS. */
  lufs: number;
  /** True-peak ceiling, dBTP. */
  truePeakDb: number;
}

/**
 * Voice clean-up (TikTok voiceover): high-pass, FFT noise reduction against a fixed floor (no
 * adaptive tracking, so the result depends only on the input), de-esser, gentle compression and
 * a level gain. Runs on mono at 48 kHz. Deterministic: the same input gives the same samples.
 * Change any number and `VOICE_CLEAN_VERSION` with it: cached cleaned files are keyed by it.
 */
export const VOICE_CLEAN_VERSION = 1;

export function voiceChain(o: { gainDb?: number; noiseFloorDb?: number } = {}): string {
  const nf = Math.round(Math.max(-80, Math.min(-20, o.noiseFloorDb ?? -50)));
  return [
    'highpass=f=80:poles=2',
    `afftdn=nr=12:nf=${nf}:tn=0`,
    'deesser=i=0.4:m=0.5:f=0.5:s=o',
    'acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1:knee=2.8',
    ...(o.gainDb ? [`volume=${esc(`${n(o.gainDb)}dB`)}`] : []),
  ].join(',');
}

/** Voice clean-up on a clip, stored at `extensions.core.voiceClean` (set by the engine at render). */
export interface VoiceClean {
  version: number;
  /** Level gain after the chain, dB (brings the cleaned voice to the voice target). */
  gainDb: number;
  /** The recording's own noise floor, dBFS (measured between words); what noise reduction removes. */
  noiseFloorDb: number;
}

export function voiceCleanOf(item: TimelineItem): VoiceClean | undefined {
  const raw = (item.extensions.core as { voiceClean?: Partial<VoiceClean> } | undefined)
    ?.voiceClean;
  if (!raw || typeof raw.version !== 'number') return undefined;
  const g = typeof raw.gainDb === 'number' && Number.isFinite(raw.gainDb) ? raw.gainDb : 0;
  const nf = typeof raw.noiseFloorDb === 'number' && Number.isFinite(raw.noiseFloorDb) ? raw.noiseFloorDb : -50; // prettier-ignore
  return {
    version: raw.version,
    gainDb: Math.max(-24, Math.min(24, g)),
    noiseFloorDb: Math.max(-80, Math.min(-20, nf)),
  };
}

export interface MasterSettings {
  /** Linear gain applied to the whole mix, dB. */
  gainDb: number;
  /** True-peak ceiling, dBTP. */
  truePeakDb: number;
}

export interface AudioCompileInput {
  timeline: Timeline;
  sources: ReadonlyMap<string, SourceMedia>;
  /** Second pass: gain and limiter (see `masterFor`). Without it, the raw mix. */
  master?: MasterSettings;
}

export interface AudioInput {
  assetId: string;
  path: string;
  contentHash: string;
  seek: string;
  duration: string;
}

export interface AudioPlan {
  compilerVersion: number;
  timelineId: string;
  sampleRate: number;
  /** Length in samples. */
  samples: number;
  inputs: AudioInput[];
  filtergraph: string;
  audioOut: 'aout';
  master: MasterSettings | null;
  warnings: string[];
  planHash: string;
}

/** Gain that brings a measured mix to the target; silence gets none. */
export function masterFor(
  measured: { integratedLufs: number },
  target: LoudnessTarget,
): MasterSettings {
  const gain = Number.isFinite(measured.integratedLufs)
    ? Math.round((target.lufs - measured.integratedLufs) * 100) / 100
    : 0;
  return { gainDb: Math.max(-40, Math.min(40, gain)), truePeakDb: target.truePeakDb };
}

const toSamples = (flicks: number) => Math.round(flicks / FLICKS_PER_SAMPLE);

export function compileAudio(input: AudioCompileInput): AudioPlan {
  const { timeline } = input;
  const total = toSamples(timelineDuration(timeline));
  const warnings: string[] = [];
  const inputs: AudioInput[] = [];
  const chains: string[] = [];
  const mixed: string[] = [];
  const end = `apad=whole_len=${total},atrim=end_sample=${total}`;

  for (const track of timeline.tracks) {
    if (track.muted) continue;
    const audio = track.kind === 'audio';
    const items = [...track.items].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (const it of items) {
      if (it.kind !== 'clip' || it.muted) continue;
      const ca = audio ? undefined : clipAudioOf(it);
      if (!audio && !ca) continue;
      const src = input.sources.get(it.assetId);
      if (!src) {
        warnings.push(`audio of "${it.id}": recording ${it.assetId} is missing; silent`);
        continue;
      }
      if (!src.hasAudio) {
        if (audio) warnings.push(`audio of "${it.id}": ${it.assetId} has no sound; silent`);
        continue;
      }
      const lead = Math.min(ca?.lead ?? 0, it.start);
      const lag = ca?.lag ?? 0;
      const startS = toSamples(it.start - lead);
      const lenS = toSamples(it.duration + lead + lag);
      if (lenS <= 0 || startS >= total) continue;
      const speed = it.speed;
      let srcStart = (it.sourceIn - lead * speed) / FLICKS_PER_SECOND;
      let pad = 0;
      if (srcStart < 0) {
        pad = Math.round((-srcStart / speed) * MIX_RATE);
        srcStart = 0;
      }
      const needSec = (lenS / MIX_RATE) * speed;
      if (srcStart + needSec > src.duration + 0.01)
        warnings.push(`audio of "${it.id}" runs past the end of its recording; silence after`);
      const k = inputs.length;
      inputs.push({
        assetId: it.assetId,
        path: src.path,
        contentHash: src.contentHash,
        seek: n(Math.floor(srcStart * 1e6) / 1e6),
        duration: n(Math.ceil((needSec + 0.05) * 1e6) / 1e6),
      });
      const clean = audio ? voiceCleanOf(it) : undefined;
      if (clean && clean.version !== VOICE_CLEAN_VERSION)
        warnings.push(`audio of "${it.id}": voice clean-up v${clean.version} is not known; cleaned with v${VOICE_CLEAN_VERSION}`); // prettier-ignore
      const parts = [
        `aresample=${MIX_RATE}`,
        ...(clean ? ['aformat=sample_fmts=fltp:channel_layouts=mono', voiceChain(clean)] : []),
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        'asetpts=PTS-STARTPTS',
        ...tempo(speed),
        ...(pad ? [`adelay=delays=${pad}S:all=1`] : []),
        `apad=whole_len=${lenS}`,
        `atrim=end_sample=${lenS}`,
        'asetpts=PTS-STARTPTS',
        ...gainFilters(it.gainDb, lead),
        ...(startS > 0 ? [`adelay=delays=${startS}S:all=1`] : []),
        end,
      ];
      const out = `a${k}`;
      chains.push(`[${k}:a]${parts.join(',')}[${out}]`);
      mixed.push(out);
    }
  }

  if (mixed.length === 0) {
    chains.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${total}[mix]`);
  } else if (mixed.length === 1) {
    chains.push(`[${mixed[0]}]anull[mix]`);
  } else {
    chains.push(
      `${mixed.map((l) => `[${l}]`).join('')}amix=inputs=${mixed.length}:normalize=0:duration=longest:dropout_transition=0,${end}[mix]`,
    );
  }
  const m = input.master;
  if (m) {
    // Limit half a dB under the ceiling: the 4x oversampled limiter catches inter-sample
    // peaks, the margin covers what resampling back to 48 kHz adds.
    const limit = Math.min(1, Math.max(0.0625, 10 ** ((m.truePeakDb - 0.5) / 20)));
    chains.push(
      `[mix]volume=${esc(`${n(m.gainDb)}dB`)},aresample=${MIX_RATE * 4},alimiter=limit=${n(limit)}:attack=1:release=50:level=0:latency=1,aresample=${MIX_RATE},${end},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`,
    );
  } else {
    chains.push(`[mix]aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  }

  const graph = chains.join(';');
  const hashed = {
    compilerVersion: AUDIO_COMPILER_VERSION,
    timelineId: timeline.id,
    sampleRate: MIX_RATE,
    samples: total,
    inputs: inputs.map(({ path: _path, ...rest }) => rest),
    filtergraph: graph,
    master: m ?? null,
  };
  return {
    ...hashed,
    inputs,
    audioOut: 'aout',
    warnings,
    planHash: sha256(JSON.stringify(hashed)),
  };
}

/** `atempo` takes 0.5–2 per instance; chain them for other speeds. */
function tempo(speed: number): string[] {
  if (speed === 1) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  out.push(`atempo=${n(s)}`);
  return out;
}

/**
 * Gain in dB: static as one `volume`; keyframed as a piecewise-linear expression of the time
 * since the item's start, evaluated per 64-sample block (1.3 ms). Keyframes count from the
 * picture's start, so a J cut's lead shifts them.
 */
function gainFilters(gain: Animatable, lead: number): string[] {
  if (typeof gain === 'number') return gain === 0 ? [] : [`volume=${esc(`${n(gain)}dB`)}`];
  if (Array.isArray(gain)) return gain[0] ? [`volume=${esc(`${n(gain[0])}dB`)}`] : [];
  const sec = (fl: number) => fl / FLICKS_PER_SECOND;
  const pts: { f: number; v: number }[] = [];
  const at = (fl: number) => ({ f: sec(fl + lead), v: evaluateNumber(gain, fl) });
  const ks = gain.keyframes;
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]!;
    pts.push(at(k.at));
    const next = ks[i + 1];
    if (!next) break;
    if (k.easing === 'hold') pts.push({ f: sec(next.at + lead) - 1e-4, v: k.value as number });
    else if (k.easing !== 'linear')
      for (let s = 1; s < 8; s++) pts.push(at(k.at + Math.round(((next.at - k.at) * s) / 8)));
  }
  if (pts[0]!.f > 0) pts.unshift({ f: 0, v: pts[0]!.v });
  const db = piecewise(pts, 't');
  return ['asetnsamples=n=64:p=0', `volume=${esc(`pow(10,(${db})/20)`)}:eval=frame`];
}

/** FFmpeg arguments that write the plan's mix (or master) as 24-bit PCM WAV. */
export function ffmpegAudioArgs(
  plan: AudioPlan,
  output: string,
  opt: { graphFile?: string; codec?: string[] } = {},
): string[] {
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
    `[${plan.audioOut}]`,
    '-vn',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-map_metadata',
    '-1',
    ...(opt.codec ?? ['-c:a', 'pcm_s24le', '-f', 'wav']),
    '-ar',
    String(plan.sampleRate),
    output,
  ];
}
