/**
 * Procedural sound effects, made locally and deterministically: the same call gives the same
 * samples on every machine (a seeded noise source, no clock, no random). Mono floats at the
 * given sample rate, peak-normalised to 0.5 (-6 dBFS) so level decisions start from a known
 * value. Browser-safe.
 */

export const SFX_KINDS = ['whoosh', 'riser', 'impact', 'sub-drop'] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

/** Bumped when a generated sound changes; part of the file name so old files are not reused. */
export const SFX_SYNTH_VERSION = 1;

/** Peak of every generated sound, linear. */
export const SFX_PEAK = 0.5;

export interface SfxSpec {
  /** Default length, seconds. */
  seconds: number;
  /** Where the loudest moment is, as a share of the length (the part to line up with a cut or hit). */
  peakOffset: number;
  /** Level relative to the generated peak, dB: loud hits sit higher than risers and whooshes. */
  gainDb: number;
}

export const SFX_SPECS: Record<SfxKind, SfxSpec> = {
  whoosh: { seconds: 0.9, peakOffset: 0.5, gainDb: -8 },
  riser: { seconds: 3, peakOffset: 1, gainDb: -10 },
  impact: { seconds: 1.6, peakOffset: 0, gainDb: -2 },
  'sub-drop': { seconds: 2.2, peakOffset: 0, gainDb: -4 },
};

/** mulberry32: a small seeded generator. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Chamberlin state-variable band-pass, cutoff `fc` Hz changing per sample. */
function bandpass(
  input: Float32Array,
  sr: number,
  fc: (t: number) => number,
  q: number,
): Float32Array {
  const out = new Float32Array(input.length);
  let low = 0;
  let band = 0;
  for (let i = 0; i < input.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(fc(i / sr), sr * 0.2)) / sr);
    low += f * band;
    const high = input[i]! - low - band / q;
    band += f * high;
    out[i] = band;
  }
  return out;
}

/** One-pole low-pass. */
function lowpass(input: Float32Array, sr: number, fc: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) out[i] = y += a * (input[i]! - y);
  return out;
}

const noise = (n: number, seed: number) => {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => r() * 2);
};

/** Short fades at both ends so a sound never clicks, then scale to the common peak. */
function finish(x: Float32Array, sr: number): Float32Array {
  const fadeIn = Math.min(x.length, Math.round(0.001 * sr));
  const fadeOut = Math.min(x.length, Math.round(0.005 * sr));
  for (let i = 0; i < fadeIn; i++) x[i]! *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) x[x.length - 1 - i]! *= i / fadeOut;
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < x.length; i++) x[i]! *= SFX_PEAK / peak;
  return x;
}

/** The generated sound, `seconds` long (default per kind). */
export function synthSfx(
  kind: SfxKind,
  opts: { sampleRate?: number; seconds?: number; seed?: number } = {},
): Float32Array {
  const sr = opts.sampleRate ?? 48_000;
  const T = opts.seconds ?? SFX_SPECS[kind].seconds;
  const n = Math.max(1, Math.round(T * sr));
  const seed = opts.seed ?? 20_251_028;
  const x = new Float32Array(n);
  const t = (i: number) => i / sr;

  if (kind === 'whoosh') {
    // Noise through a band that sweeps up and down, under a bell-shaped level.
    const band = bandpass(
      noise(n, seed),
      sr,
      (s) => 300 + 3200 * Math.sin((Math.PI * s) / T) ** 2,
      1.4,
    );
    for (let i = 0; i < n; i++) x[i] = band[i]! * Math.sin((Math.PI * t(i)) / T) ** 2;
  } else if (kind === 'riser') {
    // Noise and a sine both sweeping up, getting louder, cut off at their peak.
    const band = bandpass(noise(n, seed), sr, (s) => 200 * 30 ** (s / T), 2);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const u = t(i) / T;
      phase += (2 * Math.PI * 200 * 8 ** u) / sr;
      x[i] = (0.7 * band[i]! + 0.35 * Math.sin(phase)) * u ** 2;
    }
  } else if (kind === 'impact') {
    // A dropping low tone and a short low-passed burst of noise.
    const burst = lowpass(noise(n, seed), sr, 1800);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const s = t(i);
      phase += (2 * Math.PI * (38 + 92 * Math.exp(-12 * s))) / sr;
      x[i] = Math.sin(phase) * Math.exp(-3.2 * s) + 1.4 * burst[i]! * Math.exp(-40 * s);
    }
  } else {
    // Sub-drop: a sine falling into the floor, with a soft attack.
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const s = t(i);
      phase += (2 * Math.PI * (28 + 57 * Math.exp(-2.2 * s))) / sr;
      x[i] = Math.sin(phase) * Math.exp(-1.6 * s) * Math.min(1, s / 0.02);
    }
  }
  return finish(x, sr);
}

/** 16-bit mono PCM WAV. Identical samples give identical bytes. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(
      44 + i * 2,
      Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))),
      true,
    );
  return out;
}

export const generatedSfxFileName = (kind: SfxKind) => `sfx-${kind}-v${SFX_SYNTH_VERSION}.wav`;
