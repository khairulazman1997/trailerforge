import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { alignScript, tokens, voiceSpan, type AlignWord, type Envelope } from './voice-align.js';

const F = FLICKS_PER_SECOND;
const s = (x: number) => Math.round(x * F);

/** Words spoken one after another from `at` seconds, `len` seconds each with `gap` between. */
function say(text: string, at: number, len = 0.3, gap = 0.05): AlignWord[] {
  return text.split(' ').map((w, i) => ({
    start: s(at + i * (len + gap)),
    end: s(at + i * (len + gap) + len),
    text: w,
  }));
}
const lines = [
  { id: 'vo1', text: 'This boss has one tell.' },
  { id: 'vo2', text: 'Miss it and you are done.' },
];

describe('tokens', () => {
  it('compares words, not punctuation, case, accents or digits', () => {
    expect(tokens('This boss — has ONE tell!')).toEqual(['this', 'boss', 'has', 'one', 'tell']);
    expect(tokens('Don’t miss 3 parries, café')).toEqual([
      "don't",
      'miss',
      'three',
      'parries',
      'cafe',
    ]);
    expect(tokens('Level 42')).toEqual(['level', '42']);
  });
});

describe('alignScript', () => {
  it('splits one take into its lines, in order, with in/out around the words', () => {
    const words = [...say('This boss has one tell.', 0.5), ...say('Miss it and you are done.', 3)];
    const r = alignScript(lines, words, { duration: s(6) });
    expect(r.lines.map((l) => [l.lineId, l.status, l.score])).toEqual([
      ['vo1', 'matched', 1],
      ['vo2', 'matched', 1],
    ]);
    const [a, b] = r.lines;
    expect(a!.in).toBe(s(0.5) - s(0.06));
    expect(a!.out).toBe(words[4]!.end + s(0.15));
    expect(b!.in).toBe(s(3) - s(0.06));
    expect(a!.heard).toBe('This boss has one tell.');
    expect(r.unused).toEqual([]);
  });

  it('uses the last take when a line was said twice, and reports the first as unused', () => {
    const words = [
      ...say('This boss has one tell.', 0.5),
      ...say('This boss has one tell.', 2.5),
      ...say('Miss it and you are done.', 5),
    ];
    const r = alignScript(lines, words);
    expect(r.lines[0]!.in).toBe(s(2.5) - s(0.06));
    expect(r.unused).toEqual([
      { start: s(0.5), end: words[4]!.end, text: 'This boss has one tell.' },
    ]);
  });

  it('keeps the better take when the last one is flubbed', () => {
    const words = [
      ...say('This boss has one tell.', 0.5),
      ...say('This uh boss has two', 2.5),
      ...say('Miss it and you are done.', 5),
    ];
    const r = alignScript(lines, words);
    expect(r.lines[0]).toMatchObject({ status: 'matched', in: s(0.5) - s(0.06) });
    expect(r.unused[0]!.text).toBe('This uh boss has two');
  });

  it('reports what was said differently, missed or added', () => {
    const words = [
      ...say('This boss has uh one tel', 0.5),
      ...say('Miss it and you are finished.', 3),
    ];
    const r = alignScript(lines, words);
    expect(r.lines[0]!.status).toBe('differs');
    expect(r.lines[0]!.differences).toEqual([{ heard: 'uh' }, { expected: 'tell', heard: 'tel' }]);
    expect(r.lines[1]!.differences).toEqual([{ expected: 'done', heard: 'finished' }]);
    expect(r.lines[1]!.score).toBeGreaterThan(0.8);
  });

  it('a line that was not said is missing, and the others still find their place', () => {
    const r = alignScript(
      [...lines, { id: 'vo3', text: 'Wishlist Ember Knight now.' }],
      [...say('This boss has one tell.', 0.5), ...say('Wishlist Ember Knight now.', 3)],
    );
    expect(r.lines.map((l) => l.status)).toEqual(['matched', 'missing', 'matched']);
    expect(r.lines[1]!.in).toBeUndefined();
    expect(r.lines[1]!.differences.map((d) => d.expected)).toEqual(['miss', 'it', 'and', 'you', 'are', 'done']); // prettier-ignore
  });

  it('nothing heard: every line missing, nothing unused', () => {
    const r = alignScript(lines, []);
    expect(r.lines.map((l) => l.status)).toEqual(['missing', 'missing']);
    expect(r.unused).toEqual([]);
  });

  it('tightens on the envelope: back to the onset, on through the ring-out, never into the next word', () => {
    // 10 ms hops: voice from 0.45 s to 2.6 s; the transcript says the words run 0.5–2.2 s.
    const hop = s(0.01);
    const db = Array.from({ length: 400 }, (_, k) => (k >= 45 && k < 260 ? -20 : -80));
    const env: Envelope = { hop, db };
    const words = say('This boss has one tell.', 0.5, 0.3, 0.05);
    const next = { start: s(2.4), end: s(2.8), text: 'Miss' };
    const r = alignScript([lines[0]!], [...words, next], { envelope: env });
    // Onset found 50 ms early, then 60 ms room; the ring-out is cut by the next word at 2.4 s.
    expect(r.lines[0]!.in).toBe(s(0.45) - s(0.06));
    expect(r.lines[0]!.out).toBe(s(2.4));
    const alone = alignScript([lines[0]!], words, { envelope: env, duration: s(4) });
    expect(alone.lines[0]!.out).toBe(s(2.6) + s(0.15));
  });

  it('is deterministic', () => {
    const words = [...say('This boss has one tell.', 0.5), ...say('Miss it and you are done.', 3)];
    expect(alignScript(lines, words)).toEqual(alignScript(lines, words));
  });
});

describe('voiceSpan', () => {
  const hop = s(0.01);
  const env: Envelope = {
    hop,
    db: Array.from({ length: 300 }, (_, k) => (k >= 50 && k < 150 ? -18 : -85)),
  };
  it('trims the silence around the voice and pads it, within the window asked for', () => {
    expect(voiceSpan(env)).toEqual({ in: s(0.5) - s(0.06), out: s(1.5) + s(0.15) });
    expect(voiceSpan(env, s(0.7), s(1.2))).toEqual({ in: s(0.7), out: s(1.2) });
    expect(voiceSpan(env, s(2), s(3))).toBeNull();
  });
});
