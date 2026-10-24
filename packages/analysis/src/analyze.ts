import { analysisCacheFile, readAnalysisCache, writeAnalysisCache } from '@trailerforge/core';
import { resolveTools } from '@trailerforge/media';
import type { Rate } from '@trailerforge/schema';
import { callSidecar, type CallOptions } from './sidecar.js';
import { FOOTAGE_ANALYZER, MUSIC_ANALYZER, toFootageAnalysis, toMusicAnalysis } from './convert.js';
import { FootageAnalysis, FootageRaw, MusicAnalysis, MusicRaw } from './schemas.js';

export interface AnalyzeOptions extends CallOptions {
  /** FFmpeg binary for the sidecar (default: the one `@trailerforge/media` resolves). */
  ffmpeg?: string;
}

const ffmpegOf = (opts: AnalyzeOptions) => opts.ffmpeg ?? resolveTools().ffmpeg;

export async function analyzeMusic(
  path: string,
  opts: AnalyzeOptions = {},
): Promise<MusicAnalysis> {
  const raw = MusicRaw.parse(
    await callSidecar('analyze.music', { path, ffmpeg: ffmpegOf(opts) }, opts),
  );
  return MusicAnalysis.parse(toMusicAnalysis(raw));
}

/** `rate` is the constant rate to analyse at (the recording's average rate from its probe). */
export async function analyzeFootage(
  path: string,
  media: { rate: Rate; duration: number },
  opts: AnalyzeOptions = {},
): Promise<FootageAnalysis> {
  const raw = FootageRaw.parse(
    await callSidecar(
      'analyze.footage',
      { path, rate: media.rate, duration: media.duration, ffmpeg: ffmpegOf(opts) },
      opts,
    ),
  );
  return FootageAnalysis.parse(toFootageAnalysis(raw));
}

export const musicCacheFile = (analysisDir: string, quickHash: string) =>
  analysisCacheFile(analysisDir, quickHash, MUSIC_ANALYZER.name, MUSIC_ANALYZER.version);
export const footageCacheFile = (analysisDir: string, quickHash: string) =>
  analysisCacheFile(analysisDir, quickHash, FOOTAGE_ANALYZER.name, FOOTAGE_ANALYZER.version);

/** Cached music analysis for an asset, or null (absent, stale analyzer version, or unreadable). */
export const readMusicAnalysis = (analysisDir: string, quickHash: string) =>
  readAnalysisCache(musicCacheFile(analysisDir, quickHash), MusicAnalysis);
export const readFootageAnalysis = (analysisDir: string, quickHash: string) =>
  readAnalysisCache(footageCacheFile(analysisDir, quickHash), FootageAnalysis);

/** Read the cache, or compute and store (atomically, only when the analysis finished). */
export async function cached<T>(
  file: string,
  read: () => Promise<T | null>,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const hit = await read();
  if (hit) return { value: hit, cached: true };
  const value = await compute();
  await writeAnalysisCache(file, value);
  return { value, cached: false };
}
