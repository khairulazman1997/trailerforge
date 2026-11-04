import { createHash } from 'node:crypto';
import {
  analysisCacheFile,
  readAnalysisCache,
  writeAnalysisCache,
  type Egress,
} from '@trailerforge/core';
import { resolveTools } from '@trailerforge/media';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { z } from 'zod';
import {
  downloadModel,
  modelDir,
  modelDisclosure,
  modelStatus,
  ModelConsentRequired,
  type ModelManifest,
  type ModelStatus,
} from './models.js';
import { callSidecar, type SidecarCommand } from './sidecar.js';

/**
 * Voiceover recordings: a loudness envelope (no model; used to trim silence and breaths around
 * each line) and an opt-in, local, word-timed transcription with faster-whisper. Both come from
 * the sidecar in seconds and are converted to flicks here, the one boundary. Results are cached
 * by the recording's quick hash; a transcript also by model, language and prompt.
 */

export const voiceModelDir = (home: string, m: Pick<ModelManifest, 'id'>) => modelDir(home, m);
export const voiceModelStatus = (home: string, m: ModelManifest | null): Promise<ModelStatus> =>
  modelStatus(home, m);
export const voiceDownloadDisclosure = (m: ModelManifest) =>
  modelDisclosure(m, 'Transcription runs on this computer; your recordings never leave it.');

export async function downloadVoiceModel(o: {
  home: string;
  egress: Egress;
  manifest: ModelManifest | null;
  consent: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  if (!o.manifest) throw new Error('no voice model is pinned in this build');
  if (o.consent !== true) throw new ModelConsentRequired('voice model');
  const m = o.manifest;
  await downloadModel({
    home: o.home,
    egress: o.egress,
    manifest: m,
    purpose: `Download the local voice transcription model (${m.title}, ${m.license}): one time, nothing is uploaded`,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
}

// ---- what the sidecar returns (seconds) ------------------------------------------------------

const RawEnvelope = z.strictObject({ hop: z.number().positive(), db: z.array(z.number()) });
export const RawEnvelopeResult = z.strictObject({
  duration: z.number().nonnegative(),
  envelope: RawEnvelope,
});
export const RawTranscript = z.strictObject({
  duration: z.number().nonnegative(),
  language: z.string(),
  languageProbability: z.number(),
  segments: z.array(z.strictObject({ start: z.number(), end: z.number(), text: z.string() })),
  words: z.array(
    z.strictObject({ start: z.number(), end: z.number(), text: z.string(), p: z.number() }),
  ),
  envelope: RawEnvelope,
});
export type RawTranscript = z.infer<typeof RawTranscript>;

// ---- what the app uses (flicks) --------------------------------------------------------------

/** Loudness every `hop` flicks, dBFS (floor −90). */
export const VoiceEnvelope = z.strictObject({
  hop: z.int().positive(),
  db: z.array(z.number()),
});
export type VoiceEnvelope = z.infer<typeof VoiceEnvelope>;

export const TranscriptWord = z.strictObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  text: z.string(),
  /** The model's confidence, 0..1. */
  p: z.number(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.strictObject({
  modelId: z.string(),
  language: z.string(),
  languageProbability: z.number(),
  /** Flicks. */
  duration: z.int().nonnegative(),
  words: z.array(TranscriptWord),
  segments: z.array(
    z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative(), text: z.string() }),
  ),
  envelope: VoiceEnvelope,
});
export type Transcript = z.infer<typeof Transcript>;

const fl = (s: number) => Math.max(0, Math.round(s * FLICKS_PER_SECOND));

export function toEnvelope(raw: z.infer<typeof RawEnvelope>): VoiceEnvelope {
  return { hop: fl(raw.hop), db: raw.db };
}

export function toTranscript(raw: RawTranscript, modelId: string): Transcript {
  return {
    modelId,
    language: raw.language,
    languageProbability: raw.languageProbability,
    duration: fl(raw.duration),
    words: raw.words.map((w) => ({
      start: fl(w.start),
      end: Math.max(fl(w.start), fl(w.end)),
      text: w.text,
      p: w.p,
    })),
    segments: raw.segments.map((s) => ({ start: fl(s.start), end: fl(s.end), text: s.text })),
    envelope: toEnvelope(raw.envelope),
  };
}

export interface TranscribeOptions {
  /** ISO 639-1 code; unset lets the model tell. */
  language?: string;
  /** Words the speaker is likely to say (the script), so names come out right. */
  prompt?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Turns a voice recording into timed words. */
export interface Transcriber {
  /** Part of cache keys: another model never reuses these words. */
  readonly modelId: string;
  transcribe(path: string, opts?: TranscribeOptions): Promise<RawTranscript>;
}

/** The real one: faster-whisper in the sidecar, on the CPU, offline. */
export function sidecarTranscriber(
  dir: string,
  modelId: string,
  opts: { command?: SidecarCommand; ffmpeg?: string } = {},
): Transcriber {
  return {
    modelId,
    transcribe: async (path, o = {}) =>
      RawTranscript.parse(
        await callSidecar(
          'voice.transcribe',
          {
            path,
            modelDir: dir,
            ffmpeg: opts.ffmpeg ?? resolveTools().ffmpeg,
            ...(o.language ? { language: o.language } : {}),
            ...(o.prompt ? { prompt: o.prompt } : {}),
          },
          {
            ...(opts.command ? { command: opts.command } : {}),
            ...(o.signal ? { signal: o.signal } : {}),
            ...(o.onProgress ? { onProgress: o.onProgress } : {}),
          },
        ),
      ),
  };
}

/** A transcriber that answers from a function: for tests and for checking callers. */
export function stubTranscriber(
  answer: (path: string, opts: TranscribeOptions) => RawTranscript,
  modelId = 'stub',
): Transcriber & { calls: number } {
  const t = {
    modelId,
    calls: 0,
    transcribe: async (path: string, opts: TranscribeOptions = {}) => {
      opts.signal?.throwIfAborted();
      t.calls++;
      return answer(path, opts);
    },
  };
  return t;
}

const TranscriptCache = z.strictObject({
  key: z.string(),
  transcript: Transcript,
});

const paramsKey = (modelId: string, o: TranscribeOptions) =>
  createHash('sha256')
    .update(JSON.stringify([modelId, o.language ?? null, o.prompt ?? null]))
    .digest('hex');

const transcriptFile = (analysisDir: string, quickHash: string, modelId: string) =>
  analysisCacheFile(analysisDir, quickHash, 'voice-transcript', `${modelId}.1`.slice(0, 32));

/** The cached transcript of a recording, or null; never runs the model. */
export async function readTranscript(
  modelId: string,
  rec: { quickHash: string; analysisDir: string },
  o: Pick<TranscribeOptions, 'language' | 'prompt'> = {},
): Promise<Transcript | null> {
  const hit = await readAnalysisCache(
    transcriptFile(rec.analysisDir, rec.quickHash, modelId),
    TranscriptCache,
  );
  return hit && hit.key === paramsKey(modelId, o) ? hit.transcript : null;
}

/** Words of a recording, cached by its quick hash, the model, the language and the prompt. */
export async function transcribeRecording(
  t: Transcriber,
  rec: { path: string; quickHash: string; analysisDir: string },
  o: TranscribeOptions = {},
): Promise<{ transcript: Transcript; cached: boolean }> {
  const hit = await readTranscript(t.modelId, rec, o);
  if (hit) return { transcript: hit, cached: true };
  const transcript = toTranscript(await t.transcribe(rec.path, o), t.modelId);
  await writeAnalysisCache(transcriptFile(rec.analysisDir, rec.quickHash, t.modelId), {
    key: paramsKey(t.modelId, o),
    transcript,
  });
  return { transcript, cached: false };
}

const EnvelopeCache = z.strictObject({ duration: z.int().nonnegative(), envelope: VoiceEnvelope });

/** The loudness envelope of a recording (no model needed), cached by its quick hash. */
export async function voiceEnvelope(
  rec: { path: string; quickHash: string; analysisDir: string },
  o: { command?: SidecarCommand; ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<{ duration: number; envelope: VoiceEnvelope; cached: boolean }> {
  const file = analysisCacheFile(rec.analysisDir, rec.quickHash, 'voice-envelope', '1');
  const hit = await readAnalysisCache(file, EnvelopeCache);
  if (hit) return { ...hit, cached: true };
  const raw = RawEnvelopeResult.parse(
    await callSidecar(
      'voice.envelope',
      { path: rec.path, ffmpeg: o.ffmpeg ?? resolveTools().ffmpeg },
      {
        ...(o.command ? { command: o.command } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
    ),
  );
  const out = { duration: fl(raw.duration), envelope: toEnvelope(raw.envelope) };
  await writeAnalysisCache(file, out);
  return { ...out, cached: false };
}
