import { FLICKS_PER_SECOND, Timeline, flicksPerFrame, rate } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { checkPlan } from './quality.js';
import {
  applyCueEdits,
  buildCues,
  cueWords,
  placeSubtitles,
  toSrt,
  toVtt,
  type SubtitleWord,
} from './subtitles.js';

const S = FLICKS_PER_SECOND;
const R = rate(30);
const fpf = flicksPerFrame(R);
const s = (x: number) => Math.round(x * S);
const onGrid = (t: number) => Math.abs(t / fpf - Math.round(t / fpf)) < 1e-6;

/** Words spoken from `at` seconds, 0.3 s each with 0.05 s between. */
function say(text: string, at: number): SubtitleWord[] {
  return text.split(' ').map((w, i) => ({ start: s(at + i * 0.35), end: s(at + i * 0.35 + 0.3), text: w })); // prettier-ignore
}
const line = (id: string, text: string, at: number, words = say(text, at)) => ({
  voLineId: id,
  text,
  start: s(at),
  end: words.at(-1)!.end,
  words,
});

describe('buildCues: lines', () => {
  it('cuts a long line where punctuation falls, two lines of 32 at most, on the first and last word', () => {
    const text =
      'Miss it once, and the Ash Warden takes everything you have, every single time you try.';
    const { cues } = buildCues([line('vo1', text, 1)], { style: 'lines', rate: R });
    expect(cues.map((c) => c.text)).toEqual([
      'Miss it once, and the Ash Warden takes everything you have,',
      'every single time you try.',
    ]);
    expect(cues.map((c) => c.key)).toEqual(['vo1#0', 'vo1#1']);
    for (const c of cues) {
      expect(onGrid(c.start) && onGrid(c.end)).toBe(true);
      const rows = c.text.split(' ').reduce<string[]>((acc, w) => {
        const last = acc.at(-1);
        if (last !== undefined && last.length + 1 + w.length <= 32)
          acc[acc.length - 1] = `${last} ${w}`;
        else acc.push(w);
        return acc;
      }, []);
      expect(rows.length).toBeLessThanOrEqual(2);
    }
    expect(cues[0]!.start).toBe(s(1));
    // A 0.05 s gap between words stays at most two frames between cues.
    expect(cues[1]!.start - cues[0]!.end).toBeLessThanOrEqual(2 * fpf);
    expect(cues[1]!.end).toBe(Math.round(Math.round(say(text, 1).at(-1)!.end / fpf) * fpf));
    expect(cues[0]!.words).toBe(cueWords(cues[0]!.text));
  });

  it('breaks at a pause and keeps a short cue on screen 0.6 s', () => {
    const words = [...say('Ready?', 0), ...say('Go now.', 1)];
    const { cues } = buildCues([line('vo1', 'Ready? Go now.', 0, words)], {
      style: 'lines',
      rate: R,
    });
    expect(cues.map((c) => c.text)).toEqual(['Ready?', 'Go now.']);
    expect(cues[0]!.end).toBe(s(0.6));
    expect(cues[1]!.end - cues[1]!.start).toBeGreaterThanOrEqual(s(0.6));
  });

  it('closes a gap under two frames and never overlaps the next cue', () => {
    const words = [...say('Ready?', 0), ...say('Go now.', 0.62)];
    const { cues } = buildCues([line('vo1', 'Ready? Go now.', 0, words)], { style: 'lines', rate: R, maxChars: 6 }); // prettier-ignore
    expect(cues.map((c) => c.text)).toEqual(['Ready?', 'Go now.']);
    expect(cues[0]!.end).toBe(cues[1]!.start); // stretched to 0.6 s, then the 1-frame gap closed
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  });

  it('follows the script by length when there are no words, and says so', () => {
    const { cues, warnings } = buildCues([{ voLineId: 'vo2', text: 'Wishlist Ember Knight now.', start: s(2), end: s(4) }], { style: 'lines', rate: R }); // prettier-ignore
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: s(2), end: s(4), text: 'Wishlist Ember Knight now.', fromScript: true }); // prettier-ignore
    expect(warnings[0]).toMatch(/follow the script/);
  });
});

describe('buildCues: word-pop', () => {
  it('a few words at a time, each with its own timing', () => {
    const { cues } = buildCues([line('vo1', 'This boss has one tell, so watch it.', 0)], { style: 'word-pop', rate: R }); // prettier-ignore
    expect(cues.map((c) => c.text)).toEqual(['This boss has', 'one tell,', 'so watch it.']);
    expect(cues[0]!.timing!.map((w) => w.text)).toEqual(['This', 'boss', 'has']);
    expect(cues[1]!.timing![0]!.start).toBe(s(3 * 0.35));
  });
});

describe('applyCueEdits', () => {
  const { cues } = buildCues([line('vo1', 'Ready? Go now.', 0, [...say('Ready?', 0), ...say('Go now.', 1)])], { style: 'lines', rate: R }); // prettier-ignore

  it('applies text and nudges while the words match, within the neighbours, on the frame grid', () => {
    const r = applyCueEdits(cues, [
      { key: 'vo1#0', words: 'ready', text: 'Ready…?', nudgeOut: s(0.2) },
      { key: 'vo1#1', words: 'go now', nudgeIn: -s(0.1) },
    ], R); // prettier-ignore
    expect(r.dropped).toEqual([]);
    expect(r.cues[0]).toMatchObject({ text: 'Ready…?', edited: true, end: s(0.8) });
    expect(r.cues[1]!.start).toBe(s(0.9));
    // A nudge never reaches into the neighbour.
    const far = applyCueEdits(cues, [{ key: 'vo1#0', words: 'ready', nudgeOut: s(1) }], R);
    expect(far.cues[0]!.end).toBe(cues[1]!.start);
  });

  it('drops an edit when the voice was transcribed again and the words changed', () => {
    const r = applyCueEdits(cues, [{ key: 'vo1#0', words: 'steady', text: 'x' }, { key: 'vo9#0', words: 'a', text: 'y' }], R); // prettier-ignore
    expect(r.dropped.map((e) => e.key)).toEqual(['vo1#0', 'vo9#0']);
    expect(r.cues).toEqual(cues);
  });
});

describe('placeSubtitles and files', () => {
  const base = Timeline.parse({ id: 'tl_x', name: 'X', frameRate: R, resolution: { width: 1080, height: 1920 }, tracks: [] }); // prettier-ignore
  const { cues } = buildCues([line('vo1', 'One tell.', 0.5)], { style: 'word-pop', rate: R });

  it('puts cues on a Subtitles track with the style’s template, word times relative to the cue', () => {
    const tl = placeSubtitles(base, cues, 'word-pop');
    const track = tl.tracks.find((t) => t.id === 'trk_subtitles')!;
    expect(track.kind).toBe('graphics');
    expect(track.items[0]).toMatchObject({ id: 'sub_vo1_0', templateId: 'core/word-caption', start: cues[0]!.start }); // prettier-ignore
    const words = (track.items[0] as unknown as { params: { words: { start: number }[] } }).params
      .words;
    expect(words[0]!.start).toBe(0);
    const lines = placeSubtitles(tl, cues, 'lines');
    expect(lines.tracks.filter((t) => t.id === 'trk_subtitles')).toHaveLength(1);
    expect(lines.tracks.at(-1)!.items[0]).toMatchObject({ templateId: 'core/subtitle-line', params: { text: 'One tell.' } }); // prettier-ignore
    expect(placeSubtitles(lines, [], 'lines').tracks).toEqual([]);
  });

  it('writes SubRip and WebVTT', () => {
    const c = [{ key: 'a#0', voLineId: 'a', start: s(1.5), end: s(3.25), text: 'Miss it once, and the Ash Warden takes everything', words: '' }]; // prettier-ignore
    expect(toSrt(c)).toBe(
      '1\n00:00:01,500 --> 00:00:03,250\nMiss it once, and the Ash Warden\ntakes everything\n',
    );
    expect(toVtt(c)).toBe(
      'WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nMiss it once, and the Ash Warden\ntakes everything\n',
    );
  });
});

describe('the Quality Gate', () => {
  it('reports text under the platform’s interface as an overridable check', () => {
    const tl = Timeline.parse({ id: 'tl_x', name: 'X', frameRate: R, resolution: { width: 1080, height: 1920 }, tracks: [{ id: 'trk_s', kind: 'graphics', items: [{ id: 'sub_a_0', kind: 'graphic', start: 0, duration: S, templateId: 'core/subtitle-line', params: {} }] }] }); // prettier-ignore
    const f = checkPlan({ timeline: tl, graphicsIssues: [{ itemId: 'sub_a_0', messages: [`text "Hi" sits where TikTok's interface covers it (the caption area at the bottom)`] }] }); // prettier-ignore
    expect(f.find((x) => x.checkId === 'core/platform-safe-area')).toMatchObject({ tier: 'override', itemId: 'sub_a_0' }); // prettier-ignore
  });
});
