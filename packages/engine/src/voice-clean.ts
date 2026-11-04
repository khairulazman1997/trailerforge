import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceChain, VOICE_CLEAN_VERSION } from '@trailerforge/compile';
import type { ProjectStore } from '@trailerforge/core';
import { ffmpeg, measureLoudness } from '@trailerforge/media';
import type { Short, Timeline } from '@trailerforge/schema';
import { z } from 'zod';
import type { Engine } from './engine.js';
import { findShort } from './shorts-ops.js';

/**
 * Voice clean-up for TikTok voiceover. The chain itself lives in the compiler (`voiceChain`) and
 * runs when the TikTok renders; here each recording is measured once (its noise floor between
 * words, and its loudness before and after the chain) so the chain can be tuned to it and the
 * voice lands on `VOICE_TARGET_LUFS`. A cleaned copy is kept in the project cache for the
 * transcription to read. The recording itself is never changed.
 */

/** Loudness the cleaned voice is brought to before the mix (the master pass sets the final level). */
export const VOICE_TARGET_LUFS = -16;
/** Noise reduction never aims above this floor, so a recording with no pauses keeps its voice. */
const FLOOR_CEILING_DB = -30;
const FLOOR_MIN_DB = -80;

export const VoiceCleanInfo = z.strictObject({
  version: z.int(),
  noiseFloorDb: z.number(),
  before: z.strictObject({ lufs: z.number().nullable(), truePeakDb: z.number().nullable() }),
  after: z.strictObject({ lufs: z.number().nullable(), truePeakDb: z.number().nullable() }),
  gainDb: z.number(),
});
export type VoiceCleanInfo = z.infer<typeof VoiceCleanInfo>;

export const voiceCleanOn = (short: Pick<Short, 'voiceClean'>): boolean =>
  short.voiceClean !== false;

/** The key a recording's transcript is cached under: the cleaned audio is a different input. */
export const transcriptHash = (quickHash: string, cleaned: boolean): string =>
  cleaned
    ? createHash('sha256').update(`${quickHash}:voice-clean:${VOICE_CLEAN_VERSION}`).digest('hex')
    : quickHash;

/**
 * The noise floor of mono samples, dBFS: the 5th percentile of 20 ms RMS windows, rounded and kept
 * within [-80, -30] (a recording with no pauses never gets a floor above -30).
 */
export function noiseFloorDb(samples: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(rate * 0.02));
  const levels: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += samples[k]! ** 2;
    // Digital silence (a gated microphone) counts as no noise at all.
    levels.push(Math.max(-90, 10 * Math.log10(sum / win || 1e-12)));
  }
  if (levels.length === 0) return FLOOR_MIN_DB;
  levels.sort((a, b) => a - b);
  const p = levels[Math.floor((levels.length - 1) * 0.05)]!;
  return Math.round(Math.max(FLOOR_MIN_DB, Math.min(FLOOR_CEILING_DB, p)));
}

const finite = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/**
 * Measure (once, cached by the file's quick hash and the chain version) and write the cleaned copy.
 */
export async function voiceCleanFor(
  engine: Engine,
  store: ProjectStore,
  assetId: string,
  signal?: AbortSignal,
): Promise<{ info: VoiceCleanInfo; cleanedPath: string; quickHash: string }> {
  const a = engine.library.get(assetId);
  if (!a) throw new Error(`no recording "${assetId}" in the library`);
  const dir = join(store.paths.cache, 'voice-clean');
  const base = join(dir, `${a.quickHash}-v${VOICE_CLEAN_VERSION}`);
  const cleanedPath = `${base}.wav`;
  const quickHash = transcriptHash(a.quickHash, true);
  try {
    const hit = VoiceCleanInfo.safeParse(JSON.parse(await readFile(`${base}.json`, 'utf8')));
    if (hit.success && existsSync(cleanedPath)) return { info: hit.data, cleanedPath, quickHash };
  } catch {
    // Not measured yet.
  }
  await mkdir(dir, { recursive: true });
  const opts = { tools: engine.tools, ...(signal ? { signal } : {}) };

  // The floor between words, from 16 kHz mono samples.
  const pcm = `${base}.f32.tmp`;
  let floor: number;
  try {
    await ffmpeg(['-i', a.uri, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', pcm], 0, opts);
    const buf = await readFile(pcm);
    floor = noiseFloorDb(new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2), 16000);
  } finally {
    await rm(pcm, { force: true });
  }

  const tmp = `${base}.wav.tmp`;
  try {
    await ffmpeg(
      ['-i', a.uri, '-vn', '-af', `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,${voiceChain({ noiseFloorDb: floor })}`, '-c:a', 'pcm_s24le', '-bitexact', '-f', 'wav', tmp], // prettier-ignore
      0,
      opts,
    );
    await rename(tmp, cleanedPath);
  } finally {
    await rm(tmp, { force: true });
  }
  const [before, after] = await Promise.all([
    measureLoudness(a.uri, opts),
    measureLoudness(cleanedPath, opts),
  ]);
  const afterLufs = finite(after.integratedLufs);
  const info: VoiceCleanInfo = {
    version: VOICE_CLEAN_VERSION,
    noiseFloorDb: floor,
    before: { lufs: finite(before.integratedLufs), truePeakDb: finite(before.truePeakDb) },
    after: { lufs: afterLufs, truePeakDb: finite(after.truePeakDb) },
    gainDb:
      afterLufs === null
        ? 0
        : Math.max(-12, Math.min(18, Math.round((VOICE_TARGET_LUFS - afterLufs) * 10) / 10)),
  };
  await writeFile(`${base}.json.tmp`, JSON.stringify(info, null, 2));
  await rename(`${base}.json.tmp`, `${base}.json`);
  return { info, cleanedPath, quickHash };
}

/**
 * The timeline with clean-up settings on every voiceover clip (`extensions.core.voiceClean`), as
 * the renderer reads them; the stored cut is not changed. Clips whose recording cannot be
 * measured are left as they are, with a warning.
 */
export async function withVoiceClean(
  engine: Engine,
  store: ProjectStore,
  timeline: Timeline,
  signal?: AbortSignal,
): Promise<{ timeline: Timeline; warnings: string[] }> {
  const warnings: string[] = [];
  const tracks = [];
  for (const t of timeline.tracks) {
    if (t.id !== 'trk_voice') {
      tracks.push(t);
      continue;
    }
    const items = [];
    for (const it of t.items) {
      if (it.kind !== 'clip') {
        items.push(it);
        continue;
      }
      try {
        const { info } = await voiceCleanFor(engine, store, it.assetId, signal);
        const core = (it.extensions.core ?? {}) as Record<string, unknown>;
        items.push({
          ...it,
          extensions: {
            ...it.extensions,
            core: {
              ...core,
              voiceClean: { version: info.version, gainDb: info.gainDb, noiseFloorDb: info.noiseFloorDb }, // prettier-ignore
            },
          },
        });
      } catch (err) {
        signal?.throwIfAborted();
        warnings.push(`voice clean-up skipped for "${it.id}": ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); // prettier-ignore
        items.push(it);
      }
    }
    tracks.push({ ...t, items });
  }
  return { timeline: { ...timeline, tracks }, warnings };
}

export interface VoiceCleanReport {
  shortId: string;
  enabled: boolean;
  targetLufs: number;
  lines: {
    voLineId: string;
    text: string;
    assetId: string | null;
    name: string | null;
    info: VoiceCleanInfo | null;
    error?: string;
  }[];
}

/** Before/after loudness and the noise floor of each line's chosen recording. */
export async function voiceCleanReportOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  o: { signal?: AbortSignal } = {},
): Promise<VoiceCleanReport> {
  const short = findShort(store, shortId);
  await engine.library.reload();
  const lines: VoiceCleanReport['lines'] = [];
  for (const v of short.storyboard?.voLines ?? []) {
    const take =
      v.takes.find((t) => t.id === v.chosenTakeId) ?? v.takes.filter((t) => !t.rejected).at(-1);
    const a = take ? engine.library.get(take.assetId) : undefined;
    if (!take || !a) {
      lines.push({ voLineId: v.id, text: v.text, assetId: null, name: null, info: null });
      continue;
    }
    try {
      const { info } = await voiceCleanFor(engine, store, a.id, o.signal);
      lines.push({ voLineId: v.id, text: v.text, assetId: a.id, name: a.originalName, info });
    } catch (err) {
      o.signal?.throwIfAborted();
      lines.push({ voLineId: v.id, text: v.text, assetId: a.id, name: a.originalName, info: null, error: err instanceof Error ? err.message.split('\n')[0]! : String(err) }); // prettier-ignore
    }
  }
  return { shortId, enabled: voiceCleanOn(short), targetLufs: VOICE_TARGET_LUFS, lines };
}
