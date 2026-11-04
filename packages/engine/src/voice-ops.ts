import {
  downloadVoiceModel,
  ModelConsentRequired,
  transcribeRecording,
  voiceDownloadDisclosure,
  voiceEnvelope,
  voiceModelDir,
  voiceModelStatus,
  type ModelStatus,
} from '@trailerforge/analysis';
import type { ProjectStore } from '@trailerforge/core';
import { alignScript, voiceSpan, type Difference, type LineStatus } from '@trailerforge/cut';
import type { Take, VoLine } from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { voiceCleanFor, voiceCleanOn } from './voice-clean.js';
import { OpError } from './ops.js';
import { findShort } from './shorts-ops.js';

/**
 * Voiceover for TikToks: the opt-in local transcription model (state and consented download),
 * and placing recorded lines. One long take is split into the short's lines by its words
 * (local transcription, then the script lined up with what was said, the last good take of a
 * line winning); a file per line is checked against its line and trimmed. Without the model, a
 * file per line is still trimmed of the silence around it, and a long take waits for the model
 * or for hand placing. Everything runs on this computer; recordings never leave it.
 */

export interface VoiceView {
  status: ModelStatus;
  disclosure: ReturnType<typeof voiceDownloadDisclosure> | null;
}

export async function voiceStatusOp(engine: Engine): Promise<VoiceView> {
  const m = engine.voice.manifest;
  return {
    status: await voiceModelStatus(engine.home, m),
    disclosure: m ? voiceDownloadDisclosure(m) : null,
  };
}

export async function voiceDownloadOp(
  engine: Engine,
  opts: {
    consent: boolean;
    signal?: AbortSignal | undefined;
    onProgress?: ((fraction: number) => void) | undefined;
  },
): Promise<VoiceView> {
  if (!engine.voice.manifest) throw new OpError('usage', 'no voice model is pinned in this build');
  try {
    await downloadVoiceModel({
      home: engine.home,
      egress: engine.egress,
      manifest: engine.voice.manifest,
      consent: opts.consent,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (err) {
    if (err instanceof ModelConsentRequired) throw new OpError('usage', err.message);
    throw err;
  }
  return voiceStatusOp(engine);
}

export type PlacedStatus = LineStatus | 'trimmed' | 'no-recording' | 'needs-model';

export interface PlacedLine {
  voLineId: string;
  /** The recording it was found in. */
  assetId?: string;
  status: PlacedStatus;
  /** Where the line sits in the recording, flicks. */
  in?: number;
  out?: number;
  heard?: string;
  score?: number;
  differences?: Difference[];
}

export interface PlaceVoiceOutcome {
  /** `transcript` when the model ran, `envelope` when only silence was trimmed. */
  method: 'transcript' | 'envelope';
  lines: PlacedLine[];
  /** Words in the recordings that belong to no line (retakes, ad-libs), flicks. */
  unused: { assetId: string; start: number; end: number; text: string }[];
  /** Lines placed (as one undo step). */
  placed: number;
}

export interface PlaceVoiceOptions {
  /** One recording holding every line, in order; default each line's own chosen recording. */
  assetId?: string | undefined;
  /** ISO 639-1; unset lets the model tell. */
  language?: string | undefined;
  signal?: AbortSignal | undefined;
}

const chosenTake = (v: VoLine): Take | undefined =>
  v.takes.find((t) => t.id === v.chosenTakeId) ?? v.takes.filter((t) => !t.rejected).at(-1);

export async function placeVoiceOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: PlaceVoiceOptions = {},
): Promise<PlaceVoiceOutcome> {
  const short = findShort(store, shortId);
  const lines = short.storyboard?.voLines ?? [];
  if (lines.length === 0) throw new OpError('usage', `"${short.name}" has no voiceover lines`);
  const m = engine.voice.manifest;
  const ready = m !== null && (await voiceModelStatus(engine.home, m)) === 'ready';
  const transcriber = ready ? engine.voice.transcriber(voiceModelDir(engine.home, m), m.id) : null;
  const analysisDir = store.paths.analysisCache;
  await engine.library.reload();

  const recording = async (assetId: string) => {
    const a = engine.library.get(assetId);
    if (!a) throw new OpError('not-found', `no recording "${assetId}" in the library`);
    if ((await engine.library.status(assetId)) !== 'ok')
      throw new OpError('not-found', `the recording "${a.originalName}" is missing or changed`);
    return { path: a.uri, quickHash: a.quickHash, analysisDir };
  };
  // With clean-up on, the words are heard in the cleaned audio (the same length as the original).
  const clean = voiceCleanOn(short);
  const forTranscript = async (assetId: string) => {
    const rec = await recording(assetId);
    if (!clean) return rec;
    try {
      const c = await voiceCleanFor(engine, store, assetId, opts.signal);
      return { path: c.cleanedPath, quickHash: c.quickHash, analysisDir };
    } catch {
      opts.signal?.throwIfAborted();
      return rec; // the clean-up could not run: transcribe the original
    }
  };

  // Which recording each line comes from.
  const groups = new Map<string, VoLine[]>();
  const out = new Map<string, PlacedLine>();
  for (const v of lines) {
    const assetId = opts.assetId ?? chosenTake(v)?.assetId;
    if (!assetId) {
      out.set(v.id, { voLineId: v.id, status: 'no-recording' });
      continue;
    }
    groups.set(assetId, [...(groups.get(assetId) ?? []), v]);
  }

  const unused: PlaceVoiceOutcome['unused'] = [];
  for (const [assetId, group] of groups) {
    opts.signal?.throwIfAborted();
    const rec = await recording(assetId);
    if (transcriber) {
      const { transcript } = await transcribeRecording(transcriber, await forTranscript(assetId), {
        prompt: group
          .map((v) => v.text)
          .join(' ')
          .slice(0, 1000),
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const r = alignScript(
        group.map((v) => ({ id: v.id, text: v.text })),
        transcript.words,
        { envelope: transcript.envelope, duration: transcript.duration },
      );
      for (const l of r.lines)
        out.set(l.lineId, {
          voLineId: l.lineId,
          assetId,
          status: l.status,
          ...(l.in !== undefined ? { in: l.in, out: l.out! } : {}),
          heard: l.heard,
          score: l.score,
          differences: l.differences,
        });
      unused.push(...r.unused.map((u) => ({ assetId, ...u })));
      continue;
    }
    // No model: a file per line is trimmed; a take of several lines needs the words.
    if (group.length > 1) {
      for (const v of group) out.set(v.id, { voLineId: v.id, assetId, status: 'needs-model' });
      continue;
    }
    const env = await voiceEnvelope(rec, opts.signal ? { signal: opts.signal } : {});
    const span = voiceSpan(env.envelope, 0, env.duration);
    out.set(group[0]!.id, {
      voLineId: group[0]!.id,
      assetId,
      status: span ? 'trimmed' : 'missing',
      ...(span ? { in: span.in, out: span.out } : {}),
    });
  }
  opts.signal?.throwIfAborted();

  const placed = lines
    .map((v) => out.get(v.id)!)
    .filter((l) => l.in !== undefined && l.out !== undefined && l.out > l.in);
  if (placed.length > 0)
    store.dispatch('core/shorts.fill-voice', {
      shortId,
      lines: placed.map((l) => ({
        voLineId: l.voLineId,
        assetId: l.assetId!,
        sourceIn: l.in!,
        sourceOut: l.out!,
      })),
    });
  return {
    method: transcriber ? 'transcript' : 'envelope',
    lines: lines.map((v) => out.get(v.id)!),
    unused,
    placed: placed.length,
  };
}
