import {
  FLICKS_PER_SECOND,
  Storyboard,
  flicksPerFrame,
  rate,
  type TimelineItem,
} from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import type { MusicGrid } from './grid.js';
import { mergeRoughCut } from './merge.js';
import { timelineHash, type TakeSource } from './rough-cut.js';
import { addGain, buildShortCut, type ShortCutInput } from './short-cut.js';

const S = FLICKS_PER_SECOND;
/** A linear-keyframe gain at time t (holds before the first and after the last key). */
function evaluateNumber(a: unknown, t: number): number {
  if (typeof a === 'number') return a;
  const ks = (a as { keyframes: { at: number; value: number }[] }).keyframes;
  if (t <= ks[0]!.at) return ks[0]!.value;
  for (let i = 0; i + 1 < ks.length; i++)
    if (t <= ks[i + 1]!.at) {
      const x = ks[i]!;
      const y = ks[i + 1]!;
      return x.value + ((t - x.at) * (y.value - x.value)) / (y.at - x.at);
    }
  return ks.at(-1)!.value;
}
const R = rate(30);
const fpf = flicksPerFrame(R);
const T0 = '2026-11-04T10:00:00.000Z';
const take = (id: string, assetId: string, extra: object = {}) => ({ id, assetId, matchedBy: 'manual', attachedAt: T0, ...extra }); // prettier-ignore
const dur = (ideal: number) => ({ min: ideal * 0.7, ideal, max: ideal * 1.4 });

function storyboard(withVoice = true) {
  return Storyboard.parse({
    id: 'sb_s',
    meta: { videoTypeId: 'game-trailer/tiktok', targetDuration: 12 },
    sections: [
      { id: 's_hook', name: 'Hook', role: 'hook', slots: [
        { id: 'hook', kind: 'shot', title: 'Hook', duration: dur(2), accepts: ['gameplay'], takes: [take('tk_h', 'g1')], overlays: [{ id: 'hook_t', templateId: 'core/caption', text: 'One tell.', offset: 0, duration: 1.5 }] },
      ] },
      { id: 's_story', name: 'Story', role: 'story', slots: [
        { id: 'b1', kind: 'shot', title: 'Key art', duration: dur(3), accepts: ['image'], takes: [take('tk_art', 'art')] },
        { id: 'b2', kind: 'shot', title: 'Parry', duration: dur(3), takes: [take('tk_a', 'v2a'), take('tk_b', 'v2b')] },
        { id: 'b3', kind: 'shot', title: 'Not filmed', duration: dur(2) },
      ] },
      { id: 's_end', name: 'Call to action', role: 'end-slate', slots: [
        { id: 'cta', kind: 'card', cardKind: 'cta', templateId: 'core/cta-card', text: 'Wishlist now', duration: dur(2) },
      ] },
    ],
    voLines: withVoice
      ? [
          { id: 'vo1', text: 'This boss has one tell.', linkedSlotIds: ['b1'], takes: [take('vt1', 'vo', { sourceIn: 0, sourceOut: 1.5 * S })], chosenTakeId: 'vt1' }, // prettier-ignore
          { id: 'vo2', text: 'Miss it, and you are done, every single time.', linkedSlotIds: ['b2'], takes: [take('vt2', 'vo', { sourceIn: 2 * S, sourceOut: 5.2 * S })], chosenTakeId: 'vt2' }, // prettier-ignore
          { id: 'vo3', text: 'Not recorded yet.', linkedSlotIds: ['b3'] },
        ]
      : [],
    music: { trackAssetId: 'music' },
  }); // prettier-ignore
}

const sources = new Map<string, TakeSource>([
  ['g1', { duration: 10 * S }],
  ['art', { duration: 3600 * S, still: true }],
  ['v2a', { duration: 8 * S }],
  ['v2b', { duration: 8 * S }],
  ['vo', { duration: 8 * S }],
  ['music', { duration: 30 * S }],
]);

const input = (o: Partial<ShortCutInput> = {}): ShortCutInput => ({
  storyboard: storyboard(),
  sources,
  timeline: { id: 'tl_short_x', frameRate: R, resolution: { width: 1080, height: 1920 } },
  now: new Date(T0),
  ...o,
});
const items = (r: ReturnType<typeof buildShortCut>, track: string) =>
  r.timeline.tracks.find((t) => t.id === track)?.items ?? [];
const byId = (r: ReturnType<typeof buildShortCut>, id: string) =>
  r.timeline.tracks.flatMap((t) => t.items).find((i) => i.id === id)! as TimelineItem & Record<string, unknown>; // prettier-ignore
const onGrid = (t: number) => Math.abs(t / fpf - Math.round(t / fpf)) < 1e-6;

describe('buildShortCut, voice-led', () => {
  const r = buildShortCut(input());

  it('follows the voice: a quick hook, then each slot as long as its lines', () => {
    expect(r.mode).toBe('voice');
    const hook = byId(r, 'rc_hook');
    expect(hook.start).toBe(0);
    expect(hook.duration).toBe(1.5 * S);
    const [vo1, vo2] = items(r, 'trk_voice');
    expect(vo1).toMatchObject({ id: 'rc_vo_vo1', start: 1.5 * S, duration: 1.5 * S, assetId: 'vo', sourceIn: 0, slotId: 'b1' }); // prettier-ignore
    const gap = Math.round(Math.round((0.15 * S) / fpf) * fpf);
    expect(vo2).toMatchObject({ start: 3 * S + gap, assetId: 'vo', sourceIn: 2 * S, duration: 3.2 * S }); // prettier-ignore
    const art = byId(r, 'rc_b1');
    expect(art).toMatchObject({
      start: 1.5 * S,
      duration: 1.5 * S + gap,
      assetId: 'art',
      sourceIn: 0,
    });
    for (const i of r.timeline.tracks.flatMap((t) => t.items)) {
      expect(onGrid(i.start), i.id).toBe(true);
      expect(onGrid(i.duration), i.id).toBe(true);
    }
  });

  it('shows a long slot as several shots, taking its takes in turn', () => {
    const parts = items(r, 'trk_picture').filter((i) => i.slotId === 'b2');
    expect(parts.map((p) => p.id)).toEqual(['rc_b2', 'rc_b2_2']);
    expect(parts.map((p) => (p as { assetId: string }).assetId)).toEqual(['v2a', 'v2b']);
    const total = parts.reduce((n, p) => n + p.duration, 0);
    expect(total).toBe(byId(r, 'rc_vo_vo2').duration + Math.round(Math.round((0.15 * S) / fpf) * fpf)); // prettier-ignore
    for (const p of parts) expect(p.duration).toBeLessThanOrEqual(2.5 * S);
  });

  it('one take for a long slot: each shot looks in its own share of the take', () => {
    const sb = storyboard();
    const b2 = sb.sections[1]!.slots[1]!;
    if (b2.kind === 'shot') b2.takes = b2.takes.slice(0, 1);
    const one = buildShortCut(input({ storyboard: sb }));
    const parts = items(one, 'trk_picture').filter((i) => i.slotId === 'b2') as { sourceIn: number; assetId: string }[]; // prettier-ignore
    expect(parts.map((p) => p.assetId)).toEqual(['v2a', 'v2a']);
    expect(parts[1]!.sourceIn).toBeGreaterThanOrEqual(4 * S);
    expect(parts[0]!.sourceIn).toBeLessThan(4 * S);
  });

  it('an image gets a slow move; a line not recorded leaves room and a warning', () => {
    const art = byId(r, 'rc_b1') as { transform?: { scale: unknown } };
    expect(art.transform).toBeDefined();
    const b3 = byId(r, 'rc_b3');
    expect(b3.kind).toBe('placeholder');
    expect(b3.duration).toBeGreaterThan(S);
    expect(r.warnings.join('\n')).toMatch(/"Not recorded yet." is not recorded yet/);
  });

  it('the music dips under every line and fades out at the end', () => {
    const music = byId(r, 'rc_music') as { gainDb: unknown; duration: number };
    const vo2 = byId(r, 'rc_vo_vo2');
    expect(evaluateNumber(music.gainDb, 0.5 * S)).toBe(0); // over the hook, full
    expect(evaluateNumber(music.gainDb, vo2.start + S)).toBe(-12); // under the voice
    expect(evaluateNumber(music.gainDb, music.duration)).toBeLessThanOrEqual(-60);
  });

  it('cards and captions are placed as in the trailer cut', () => {
    expect(items(r, 'trk_cards').map((i) => i.id)).toEqual(['rc_cta']);
    expect(items(r, 'trk_captions').map((i) => (i as { text: string }).text)).toEqual([
      'One tell.',
    ]);
  });

  it('is deterministic (golden timeline)', () => {
    expect(timelineHash(buildShortCut(input()).timeline)).toBe(timelineHash(r.timeline));
    expect(r.timeline).toMatchSnapshot();
  });

  it('a rebuild keeps a hand edit', () => {
    const edited = structuredClone(r.timeline);
    const hook = edited.tracks[0]!.items[0]!;
    hook.duration -= 6 * fpf;
    hook.extensions = { core: { userEdited: true } };
    const merged = mergeRoughCut(edited, buildShortCut(input()).timeline, sources);
    expect(merged.kept).toContain('rc_hook');
  });
});

describe('buildShortCut with subtitles', () => {
  // What the transcription heard in the voiceover file, in the file's own time.
  const heard = new Map([
    ['vo', [
      { start: 0.1 * S, end: 0.4 * S, text: 'This' }, { start: 0.45 * S, end: 0.7 * S, text: 'boss' },
      { start: 0.75 * S, end: 1.0 * S, text: 'has' }, { start: 1.05 * S, end: 1.2 * S, text: 'one' },
      { start: 1.25 * S, end: 1.45 * S, text: 'tell.' },
      { start: 2.1 * S, end: 2.5 * S, text: 'Miss' }, { start: 2.6 * S, end: 2.9 * S, text: 'it,' },
    ]],
  ]); // prettier-ignore

  it('places cues on the words, in timeline time, on a Subtitles track', () => {
    const r = buildShortCut(input({ subtitles: { style: 'lines', words: heard } }));
    const vo1 = byId(r, 'rc_vo_vo1');
    expect(r.cues[0]).toMatchObject({ key: 'vo1#0', text: 'This boss has one tell.' });
    expect(r.cues[0]!.start).toBe(Math.round(Math.round((vo1.start + 0.1 * S) / fpf) * fpf));
    const subs = items(r, 'trk_subtitles');
    expect(subs[0]).toMatchObject({ kind: 'graphic', templateId: 'core/subtitle-line', start: r.cues[0]!.start }); // prettier-ignore
    // vo2's take starts 2 s into the file: its words come from there.
    expect(r.cues.find((c) => c.voLineId === 'vo2')!.text).toBe('Miss it,');
  });

  it('keeps a hand change while the words match and says when one no longer fits', () => {
    const r = buildShortCut(
      input({ subtitles: { style: 'lines', words: heard, edits: [
        { key: 'vo1#0', words: 'this boss has one tell', text: 'This boss has ONE tell.' },
        { key: 'vo2#0', words: 'something else', text: 'x' },
      ] } }),
    ); // prettier-ignore
    expect(r.cues[0]!.text).toBe('This boss has ONE tell.');
    expect(r.warnings.join('\n')).toMatch(/subtitle vo2#0 no longer fits/);
  });

  it('word-pop cues carry their word timings; without voice there are no subtitles, with a warning', () => {
    const r = buildShortCut(input({ subtitles: { style: 'word-pop', words: heard } }));
    expect(items(r, 'trk_subtitles')[0]).toMatchObject({ templateId: 'core/word-caption' });
    const none = buildShortCut(
      input({ storyboard: storyboard(false), subtitles: { style: 'lines' } }),
    );
    expect(none.cues).toEqual([]);
    expect(none.warnings.join('\n')).toMatch(/subtitles follow the voiceover/);
  });
});

describe('buildShortCut without voice', () => {
  const beats = Array.from({ length: 61 }, (_, k) => k * 0.5 * S);
  const grid: MusicGrid = {
    duration: 30 * S,
    tempo: 120,
    beatsPerBar: 4,
    barsPerPhrase: 4,
    beats,
    bars: beats.filter((_, k) => k % 4 === 0),
    phrases: beats.filter((_, k) => k % 16 === 0),
    sections: [],
  };

  it('follows the beat grid when the music was analysed; images start at 0 and move', () => {
    const r = buildShortCut(input({ storyboard: storyboard(false), grid }));
    expect(r.mode).toBe('beat');
    const art = byId(r, 'rc_b1') as { sourceIn: number; transform?: unknown };
    expect(art.sourceIn).toBe(0);
    expect(art.transform).toBeDefined();
    expect(items(r, 'trk_voice')).toEqual([]);
    // Cuts land one frame ahead of a beat.
    const cut = byId(r, 'rc_b1').start;
    expect(beats.some((b) => Math.abs(b - fpf - cut) < 2)).toBe(true);
  });

  it('follows the storyboard lengths with no music analysis, and says so', () => {
    const r = buildShortCut(input({ storyboard: storyboard(false) }));
    expect(r.mode).toBe('plain');
    expect(byId(r, 'rc_hook').duration).toBe(2 * S);
    expect(r.warnings.join('\n')).toMatch(/follows the storyboard lengths/);
    // A 3 s slot is longer than a short-form shot should be: split in two.
    expect(items(r, 'trk_picture').filter((i) => i.slotId === 'b2')).toHaveLength(2);
  });
});

describe('addGain', () => {
  it('adds a dip curve to a fade, exactly at every breakpoint', () => {
    const fade = { keyframes: [{ at: 10, value: 0, easing: 'linear' as const }, { at: 20, value: -60, easing: 'linear' as const }] }; // prettier-ignore
    const g = addGain(fade, [{ at: 2, value: 0 }, { at: 3, value: -12 }, { at: 5, value: -12 }, { at: 6, value: 0 }]); // prettier-ignore
    expect(evaluateNumber(g, 4)).toBe(-12);
    expect(evaluateNumber(g, 15)).toBe(-30);
    expect(evaluateNumber(g, 0)).toBe(0);
    expect(addGain(-3, [])).toBe(-3);
    expect(
      evaluateNumber(
        addGain(-3, [
          { at: 0, value: 0 },
          { at: 1, value: -6 },
        ]),
        1,
      ),
    ).toBe(-9);
  });
});
