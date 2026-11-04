import type { Timeline } from '@trailerforge/schema';
import { cuesOf, type Cue } from '@trailerforge/cut';

/** Pure helpers for the TikTok tab. */

/** One idea per line; blanks dropped, at most `max` kept. */
export function splitIdeas(text: string, max = 10): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}

const INPUT_LABEL: Record<string, string> = {
  gameplay: 'a gameplay recording',
  image: 'an image',
  video: 'a video',
};

/** "a gameplay recording, an image or a video" for what a slot takes. */
export function acceptsLabel(accepts: readonly string[]): string {
  const names = (accepts.length ? accepts : ['gameplay']).map((a) => INPUT_LABEL[a] ?? a);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
}

/** The input kind to tag a dropped file with: the slot's only choice, else the file's own kind. */
export function inputFor(accepts: readonly string[], path: string): 'gameplay' | 'image' | 'video' {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const image = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(ext);
  const set = accepts.length ? accepts : ['gameplay'];
  if (image && set.includes('image')) return 'image';
  if (set.length === 1) return set[0] as 'gameplay' | 'image' | 'video';
  return set.includes('video') ? 'video' : (set[0] as 'gameplay' | 'image' | 'video');
}

export function progressLabel(p: {
  slots: number;
  slotsFilled: number;
  lines: number;
  linesRecorded: number;
}): string {
  const parts = [`${p.slotsFilled} of ${p.slots} shots filled`];
  if (p.lines) parts.push(`${p.linesRecorded} of ${p.lines} voiceover lines recorded`);
  return parts.join(' · ');
}

/** `m:ss.s` for a time in flicks. */
export function cueTime(flicks: number): string {
  const s = flicks / 705_600_000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** The subtitle cues on a short's timeline (empty when no cut is built or subtitles are off). */
export function shortCues(timelines: readonly Timeline[], shortId: string): Cue[] {
  const tl = timelines.find((t) => t.id === `tl_short_${shortId}`);
  return tl ? cuesOf(tl) : [];
}

/** The first recording type this browser can make that the engine reads, or undefined if none. */
export function pickRecorderMime(
  supported: (mime: string) => boolean,
): 'audio/webm;codecs=opus' | 'audio/webm' | 'audio/ogg;codecs=opus' | 'audio/mp4' | undefined {
  return (['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const).find(supported); // prettier-ignore
}

/** The line to show after `index`: the next one without a recording, else the next, else the same. */
export function nextLine(recorded: readonly boolean[], index: number): number {
  for (let i = index + 1; i < recorded.length; i++) if (!recorded[i]) return i;
  return Math.min(index + 1, recorded.length - 1);
}

/** `m:ss` for seconds. */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Plain words for why the microphone could not be used. */
export function micProblem(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'The microphone is blocked. Allow it for this app in your system or browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found. Plug one in and try again.';
  if (name === 'NotReadableError')
    return 'The microphone is in use by another program. Close it and try again.';
  return 'The microphone could not be started.';
}
