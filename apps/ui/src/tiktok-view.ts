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
