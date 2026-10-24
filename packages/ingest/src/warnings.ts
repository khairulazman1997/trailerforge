import type { MediaInfo } from '@trailerforge/schema';

export interface MediaWarning {
  code:
    | 'variable-frame-rate'
    | 'hdr'
    | 'low-resolution'
    | 'very-short'
    | 'no-audio'
    | 'multiple-audio-tracks'
    | 'rotated'
    | 'high-bit-depth'
    | 'audio-only';
  /** `warn` can hurt the edit; `info` is worth knowing. */
  severity: 'warn' | 'info';
  message: string;
}

/**
 * Things worth telling the user about a recording, computed from its probe data (never stored,
 * so a better rule shows up for files already imported).
 */
export function mediaWarnings(info: MediaInfo): MediaWarning[] {
  const out: MediaWarning[] = [];
  const add = (code: MediaWarning['code'], severity: MediaWarning['severity'], message: string) =>
    out.push({ code, severity, message });
  const v = info.video[0];

  if (!v) {
    if (info.audio.length > 0) add('audio-only', 'info', 'This file has sound only, no picture.');
    return out;
  }
  if (info.video.some((s) => s.variableFrameRate)) {
    add(
      'variable-frame-rate',
      'warn',
      'Variable frame rate (common with game capture): cuts can drift by a frame or two against the music. The capture pack recommends a fixed frame rate.',
    );
  }
  if (info.video.some((s) => s.hdr)) {
    add(
      'hdr',
      'warn',
      'HDR footage looks washed out unless it is tone-mapped. Recording in SDR avoids this.',
    );
  }
  if (v.height < 720) {
    add(
      'low-resolution',
      'warn',
      `Low resolution (${v.width}×${v.height}); it will look soft in a 1080p trailer.`,
    );
  }
  if (info.duration < 0.5) add('very-short', 'warn', 'This clip is shorter than half a second.');
  if (info.audio.length === 0) add('no-audio', 'info', 'No audio track.');
  if (info.audio.length > 1) {
    add(
      'multiple-audio-tracks',
      'info',
      `${info.audio.length} audio tracks (for example game and microphone recorded separately).`,
    );
  }
  if (v.rotation !== 0)
    add('rotated', 'info', `Rotated ${v.rotation}° in the file; it is shown upright.`);
  if ((v.bitDepth ?? 8) > 8) add('high-bit-depth', 'info', `${v.bitDepth}-bit video.`);
  return out;
}
