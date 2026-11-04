import {
  FLICKS_PER_SECOND,
  Timeline,
  flicksPerFrame,
  type Rate,
  type TimelineItem,
} from '@trailerforge/schema';
import { stableHash } from './rough-cut.js';
import { tokens } from './voice-align.js';

/**
 * Subtitles synced to the voiceover. Each voiceover line on the timeline, with the words heard in
 * it (from the local transcription, in timeline time), is cut into cues: for `lines`, sentences of
 * up to two lines of 32 characters, broken where the speaker pauses or punctuation falls; for
 * `word-pop`, a few words at a time, each word keeping its own timing so the template can
 * highlight the one being said. Every cue starts on its first word and ends on its last, on the
 * frame grid, stays at least 0.6 s, and a gap shorter than two frames is closed. Without words,
 * the line's script is spread over its recording by length, with a warning. Hand edits (text,
 * nudges) apply while the cue's words still match. Pure and browser-safe.
 */

export type SubtitleStyleName = 'lines' | 'word-pop';

export interface SubtitleWord {
  /** Timeline flicks. */
  start: number;
  end: number;
  text: string;
}

export interface SubtitleLineInput {
  voLineId: string;
  /** The script line, used when there are no words. */
  text: string;
  /** Where the line's recording sits on the timeline, flicks. */
  start: number;
  end: number;
  words?: readonly SubtitleWord[];
}

export interface Cue {
  /** `<voLineId>#<n>`: stable while the line is cut the same way. */
  key: string;
  voLineId: string;
  start: number;
  end: number;
  text: string;
  /** Normalised words as heard (or written), to match hand edits. */
  words: string;
  /** Word timings for `word-pop` (timeline flicks). */
  timing?: SubtitleWord[];
  edited?: boolean;
  fromScript?: boolean;
}

export interface CueOptions {
  style: SubtitleStyleName;
  rate: Rate;
  maxChars?: number;
  maxLines?: number;
  /** Fewest seconds on screen (default 0.6). */
  minSeconds?: number;
  /** Gaps shorter than this many frames are closed (default 2). */
  bridgeFrames?: number;
  /** Most words per word-pop cue (default 3) and characters (default 18). */
  popWords?: number;
  popChars?: number;
}

export interface CueEditInput {
  key: string;
  words: string;
  text?: string | undefined;
  nudgeIn?: number | undefined;
  nudgeOut?: number | undefined;
}

const S = FLICKS_PER_SECOND;
const PAUSE = 0.35 * S;
const ends = (w: string) => /[,.;:!?…—–-]["')\]]*$/.test(w);
export const cueWords = (text: string) => tokens(text).join(' ');

/** Whether `words` wrap into `maxLines` lines of at most `maxChars` characters. */
function fits(words: readonly string[], maxChars: number, maxLines: number): boolean {
  let lines = 1;
  let len = 0;
  for (const w of words) {
    if (w.length > maxChars) return false;
    if (len === 0) len = w.length;
    else if (len + 1 + w.length <= maxChars) len += 1 + w.length;
    else {
      lines++;
      len = w.length;
    }
  }
  return lines <= maxLines;
}

/** The line's script spread over its time by length: one pseudo word per written word. */
function scriptWords(l: SubtitleLineInput): SubtitleWord[] {
  const ws = l.text.trim().split(/\s+/).filter(Boolean);
  const total = ws.reduce((n, w) => n + w.length + 1, 0);
  let at = l.start;
  return ws.map((text) => {
    const len = ((l.end - l.start) * (text.length + 1)) / total;
    const w = { start: Math.round(at), end: Math.round(at + len), text };
    at += len;
    return w;
  });
}

export function buildCues(
  lines: readonly SubtitleLineInput[],
  o: CueOptions,
): { cues: Cue[]; warnings: string[] } {
  const fpf = flicksPerFrame(o.rate);
  const grid = (t: number) => Math.round(Math.round(t / fpf) * fpf);
  const maxChars = o.maxChars ?? 32;
  const maxLines = o.maxLines ?? 2;
  const popWords = o.popWords ?? 3;
  const popChars = o.popChars ?? 18;
  const warnings: string[] = [];
  const cues: Cue[] = [];

  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const heard = (l.words ?? []).filter((w) => w.text.trim());
    const fromScript = heard.length === 0;
    if (fromScript && l.text.trim())
      warnings.push(`subtitles for "${l.text}" follow the script: there are no transcribed words for it`); // prettier-ignore
    const words = fromScript ? scriptWords(l) : heard;
    const chunks: SubtitleWord[][] = [];
    let cur: SubtitleWord[] = [];
    words.forEach((w, i) => {
      const texts = [...cur, w].map((x) => x.text);
      const full =
        o.style === 'lines'
          ? !fits(texts, maxChars, maxLines)
          : texts.length > popWords || texts.join(' ').length > popChars;
      if (cur.length && full) {
        chunks.push(cur);
        cur = [];
      }
      cur.push(w);
      const next = words[i + 1];
      const pause = next ? next.start - w.end >= PAUSE : false;
      const used = cur.map((x) => x.text).join(' ').length;
      const enough = o.style === 'lines' ? used >= maxChars * 0.5 : cur.length >= 2;
      if (next && (pause || (ends(w.text) && enough))) {
        chunks.push(cur);
        cur = [];
      }
    });
    if (cur.length) chunks.push(cur);
    chunks.forEach((c, n) => {
      const text = c.map((w) => w.text).join(' ');
      cues.push({
        key: `${l.voLineId}#${n}`,
        voLineId: l.voLineId,
        start: grid(Math.max(l.start, c[0]!.start)),
        end: grid(Math.min(l.end, c.at(-1)!.end)),
        text,
        words: cueWords(text),
        ...(o.style === 'word-pop' ? { timing: c.map((w) => ({ ...w })) } : {}),
        ...(fromScript ? { fromScript: true } : {}),
      });
    });
  }
  return { cues: settle(cues, fpf, o), warnings };
}

/** Minimum time, gap bridging and no overlaps, on the frame grid. */
function settle(
  cues: Cue[],
  fpf: number,
  o: Pick<CueOptions, 'minSeconds' | 'bridgeFrames'>,
): Cue[] {
  const min = Math.round((o.minSeconds ?? 0.6) * S);
  const bridge = (o.bridgeFrames ?? 2) * fpf;
  const out = [...cues].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  out.forEach((c, i) => {
    const next = out[i + 1];
    if (c.end - c.start < min) c.end = c.start + Math.round(Math.ceil(min / fpf) * fpf);
    if (next) {
      if (c.end > next.start) c.end = next.start;
      else if (next.start - c.end < bridge) c.end = next.start;
    }
    if (c.end <= c.start) c.end = c.start + fpf;
  });
  return out;
}

/** Hand edits applied where the cue's words still match; the others are returned as dropped. */
export function applyCueEdits(
  cues: readonly Cue[],
  edits: readonly CueEditInput[],
  rate: Rate,
): { cues: Cue[]; dropped: CueEditInput[] } {
  const fpf = flicksPerFrame(rate);
  const grid = (t: number) => Math.round(Math.round(t / fpf) * fpf);
  const out = cues.map((c) => ({ ...c }));
  const dropped: CueEditInput[] = [];
  for (const e of edits) {
    const i = out.findIndex((c) => c.key === e.key);
    const c = out[i];
    if (!c || c.words !== e.words) {
      dropped.push(e);
      continue;
    }
    const prev = out[i - 1];
    const next = out[i + 1];
    if (e.text !== undefined) c.text = e.text;
    if (e.nudgeIn !== undefined) c.start = grid(Math.max(prev?.end ?? 0, Math.min(c.end - fpf, c.start + e.nudgeIn))); // prettier-ignore
    if (e.nudgeOut !== undefined) c.end = grid(Math.max(c.start + fpf, Math.min(next?.start ?? Infinity, c.end + e.nudgeOut))); // prettier-ignore
    c.edited = true;
    // Word timings stay with their words; text edits drop them (the template shows the text).
    if (e.text !== undefined) delete c.timing;
  }
  return { cues: out, dropped };
}

export const SUBTITLE_TRACK_ID = 'trk_subtitles';
export const SUBTITLE_TEMPLATES: Record<SubtitleStyleName, string> = {
  lines: 'core/subtitle-line',
  'word-pop': 'core/word-caption',
};

const itemId = (key: string) => {
  const id = `sub_${key.replace('#', '_')}`;
  return id.length <= 64 ? id : `sub_${stableHash(key)}`;
};

/** The cues as graphic items on a Subtitles track (replacing an earlier one). */
export function placeSubtitles(
  timeline: Timeline,
  cues: readonly Cue[],
  style: SubtitleStyleName,
): Timeline {
  const items: TimelineItem[] = cues.map((c) => {
    const words =
      c.timing && style === 'word-pop' && !c.edited
        ? c.timing.map((w) => ({
            text: w.text.slice(0, 40),
            start: Math.max(0, w.start - c.start),
            end: Math.max(0, Math.min(c.end - c.start, w.end - c.start)),
          }))
        : undefined;
    return {
      id: itemId(c.key),
      kind: 'graphic',
      start: c.start,
      duration: c.end - c.start,
      label: c.text.slice(0, 60),
      templateId: words || style === 'lines' ? SUBTITLE_TEMPLATES[style] : SUBTITLE_TEMPLATES.lines,
      params: words ? { words } : { text: c.text },
      effects: [],
      extensions: { core: { subtitle: { key: c.key, words: c.words, text: c.text } } },
    };
  });
  const others = timeline.tracks.filter((t) => t.id !== SUBTITLE_TRACK_ID);
  return Timeline.parse({
    ...timeline,
    tracks: items.length
      ? [...others, { id: SUBTITLE_TRACK_ID, kind: 'graphics', name: 'Subtitles', muted: false, locked: false, items, transitions: [] }] // prettier-ignore
      : others,
  });
}

/** The cues a timeline carries on its Subtitles track (what `.srt` and `.vtt` are written from). */
export function cuesOf(timeline: Timeline): Cue[] {
  const track = timeline.tracks.find((t) => t.id === SUBTITLE_TRACK_ID);
  return (track?.items ?? []).flatMap((i) => {
    const sub = (i.extensions.core as { subtitle?: { key?: string; words?: string; text?: string } } | undefined)?.subtitle; // prettier-ignore
    if (i.kind !== 'graphic' || !sub?.key || !sub.text) return [];
    return [
      {
        key: sub.key,
        voLineId: sub.key.split('#')[0]!,
        start: i.start,
        end: i.start + i.duration,
        text: sub.text,
        words: sub.words ?? '',
      },
    ];
  });
}

function stamp(t: number, sep: ',' | '.'): string {
  const ms = Math.round((t / S) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

/** Wrap a cue's text into at most two lines of 32 characters (what the screen shows). */
function wrap(text: string, maxChars = 32): string {
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + w.length <= maxChars)
      lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines.join('\n');
}

/** SubRip: numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, CRLF-free. */
export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${wrap(c.text)}\n`)
    .join('\n');
}

/** WebVTT with the same cues. */
export function toVtt(cues: readonly Cue[]): string {
  return `WEBVTT\n\n${cues
    .map(
      (c) =>
        `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${wrap(c.text).replace(/-->/g, '→')}\n`,
    )
    .join('\n')}`;
}
