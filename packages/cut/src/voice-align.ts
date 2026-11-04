import { FLICKS_PER_SECOND } from '@trailerforge/schema';

/**
 * Lining a voiceover script up with what was recorded. Words come from a local transcription
 * (flicks), the script is the short's voiceover lines; the result says, for each line, where it
 * sits in the recording (in/out, flicks), how closely it was said, and what differs. One long take
 * can hold every line, in order, with retakes: when a line was said more than once, the last good
 * take wins. In and out points are then tightened on the loudness envelope: a little room before
 * the first word and after the last, never into the neighbouring words. Pure and browser-safe.
 */

export interface AlignWord {
  start: number;
  end: number;
  text: string;
}

export interface ScriptLine {
  id: string;
  text: string;
}

export interface Envelope {
  /** Flicks per value. */
  hop: number;
  /** dBFS per hop (floor −90). */
  db: readonly number[];
}

export interface AlignOptions {
  envelope?: Envelope;
  /** Length of the recording, flicks; out points never pass it. */
  duration?: number;
  /** Room before the first word and after the last (defaults 0.06 s and 0.15 s). */
  padIn?: number;
  padOut?: number;
}

export type LineStatus = 'matched' | 'differs' | 'missing';

export interface Difference {
  /** A script word that was not said (or was said differently). */
  expected?: string;
  /** A word that was said instead (or as well). */
  heard?: string;
}

export interface LineAlignment {
  lineId: string;
  status: LineStatus;
  /** In and out in the recording, flicks; absent when the line was not found. */
  in?: number;
  out?: number;
  /** The words heard for this line, as transcribed. */
  heard: string;
  /** 1 = word for word, 0 = nothing alike. */
  score: number;
  differences: Difference[];
}

export interface AlignResult {
  lines: LineAlignment[];
  /** Runs of words that belong to no line: retakes, ad-libs, chatter. */
  unused: { start: number; end: number; text: string }[];
}

/** A line counts as said word for word at this score, and as not found below `FOUND`. */
export const MATCHED = 0.9;
export const FOUND = 0.4;
const INSERT = 0.6;
const LOOK_BACK = 0.15 * FLICKS_PER_SECOND;
const LOOK_AHEAD = 0.4 * FLICKS_PER_SECOND;

const NUMBERS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' '); // prettier-ignore

/** Lower case, no accents or punctuation, digits up to 20 as words. */
export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) && Number(t) <= 20 ? NUMBERS[Number(t)]! : t));
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

/** Cost of hearing `b` for `a`: 0 when equal, small for a near miss, 1 when unrelated. */
const sub = (a: string, b: string) => {
  const s = similarity(a, b);
  return s >= 0.7 ? 1 - s : 1;
};

interface Tok {
  text: string;
  word: number;
}

/** Best way to say line `s` ending at each transcript position: cost and where it starts. */
function lineCandidates(s: readonly string[], t: readonly Tok[]) {
  const n = t.length;
  let cost = new Float64Array(n + 1);
  let from = Int32Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const c = new Float64Array(n + 1);
    const f = new Int32Array(n + 1);
    c[0] = cost[0]! + 1;
    f[0] = from[0]!;
    for (let j = 1; j <= n; j++) {
      let best = cost[j - 1]! + sub(s[i - 1]!, t[j - 1]!.text);
      let start = from[j - 1]!;
      if (cost[j]! + 1 < best) {
        best = cost[j]! + 1;
        start = from[j]!;
      }
      if (c[j - 1]! + INSERT < best) {
        best = c[j - 1]! + INSERT;
        start = f[j - 1]!;
      }
      c[j] = best;
      f[j] = start;
    }
    cost = c;
    from = f;
  }
  return { cost, from };
}

/** The word-by-word alignment of a line with the tokens it was matched to. */
function differences(s: readonly string[], t: readonly Tok[]): Difference[] {
  const m = s.length;
  const n = t.length;
  const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j * INSERT : j === 0 ? i : 0))); // prettier-ignore
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i]![j] = Math.min(d[i - 1]![j - 1]! + sub(s[i - 1]!, t[j - 1]!.text), d[i - 1]![j]! + 1, d[i]![j - 1]! + INSERT); // prettier-ignore
  const out: Difference[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + sub(s[i - 1]!, t[j - 1]!.text)) {
      if (s[i - 1] !== t[j - 1]!.text) out.push({ expected: s[i - 1]!, heard: t[j - 1]!.text });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      out.push({ expected: s[i - 1]! });
      i--;
    } else {
      out.push({ heard: t[j - 1]!.text });
      j--;
    }
  }
  return out.reverse();
}

/** The quiet level of a recording: its 10th percentile, and the level counted as voice. */
function voiceThreshold(env: Envelope): number {
  const sorted = [...env.db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
  return Math.max(floor + 15, -50);
}

/**
 * Where voice actually is around `[from, to]`: the onset is moved back (at most 0.15 s) while it
 * is still loud, the end forward (at most 0.4 s) while the voice rings on, then padded and kept
 * within `[min, max]`.
 */
function tighten(
  from: number,
  to: number,
  env: Envelope | undefined,
  o: { padIn: number; padOut: number; min: number; max: number },
): { in: number; out: number } {
  let a = from;
  let b = to;
  if (env && env.db.length > 0) {
    const thr = voiceThreshold(env);
    const loud = (k: number) => (env.db[k] ?? -90) >= thr;
    let k = Math.floor(from / env.hop);
    const stopBack = Math.max(0, Math.floor((from - LOOK_BACK) / env.hop));
    while (k - 1 >= stopBack && loud(k - 1)) k--;
    a = Math.min(from, k * env.hop);
    let e = Math.ceil(to / env.hop);
    const stopAhead = Math.min(env.db.length, Math.ceil((to + LOOK_AHEAD) / env.hop));
    while (e < stopAhead && loud(e)) e++;
    b = Math.max(to, e * env.hop);
  }
  return {
    in: Math.round(Math.max(o.min, a - o.padIn)),
    out: Math.round(Math.min(o.max, b + o.padOut)),
  };
}

export function alignScript(
  lines: readonly ScriptLine[],
  words: readonly AlignWord[],
  o: AlignOptions = {},
): AlignResult {
  const padIn = o.padIn ?? 0.06 * FLICKS_PER_SECOND;
  const padOut = o.padOut ?? 0.15 * FLICKS_PER_SECOND;
  const duration = o.duration ?? Math.max(0, ...words.map((w) => w.end)) + padOut;
  const t: Tok[] = words.flatMap((w, word) => tokens(w.text).map((text) => ({ text, word })));
  const n = t.length;
  const script = lines.map((l) => tokens(l.text));
  const cands = script.map((s) => lineCandidates(s, t));

  // F[i][e]: lowest cost of lines 0..i using transcript tokens before e. Ties go to the later
  // end, so of two takes of a line the last one is used.
  type Choice = 0 | 1 | 2; // carry, skip, place
  const F: Float64Array[] = [];
  const how: Uint8Array[] = [];
  let prev = new Float64Array(n + 1);
  for (let i = 0; i < lines.length; i++) {
    const s = script[i]!;
    const miss = Math.max(1, s.length);
    const cur = new Float64Array(n + 1);
    const h = new Uint8Array(n + 1);
    for (let e = 0; e <= n; e++) {
      let best = prev[e]! + miss;
      let choice: Choice = 1;
      if (e > 0 && cur[e - 1]! < best) {
        best = cur[e - 1]!;
        choice = 0;
      }
      const start = cands[i]!.from[e]!;
      if (e > 0 && start < e && s.length > 0) {
        const c = cands[i]!.cost[e]! + prev[start]!;
        if (c <= best) {
          best = c;
          choice = 2;
        }
      }
      cur[e] = best;
      h[e] = choice;
    }
    F.push(cur);
    how.push(h);
    prev = cur;
  }

  // Walk back to find each line's tokens.
  const spans: ({ s: number; e: number } | null)[] = lines.map(() => null);
  let e = n;
  for (let i = lines.length - 1; i >= 0; i--) {
    while (how[i]![e] === 0) e--;
    if (how[i]![e] === 1) continue;
    const s = cands[i]!.from[e]!;
    spans[i] = { s, e };
    e = s;
  }

  const used = new Set<number>();
  const out: LineAlignment[] = [];
  let lastOut = 0;
  lines.forEach((line, i) => {
    const span = spans[i];
    const s = script[i]!;
    if (!span) {
      out.push({ lineId: line.id, status: 'missing', heard: '', score: 0, differences: s.map((x) => ({ expected: x })) }); // prettier-ignore
      return;
    }
    const cost = cands[i]!.cost[span.e]!;
    const score = Math.max(0, Math.round((1 - cost / Math.max(1, s.length)) * 1000) / 1000);
    const toks = t.slice(span.s, span.e);
    const first = toks[0]!.word;
    const last = toks.at(-1)!.word;
    if (score < FOUND) {
      out.push({ lineId: line.id, status: 'missing', heard: '', score, differences: s.map((x) => ({ expected: x })) }); // prettier-ignore
      return;
    }
    for (let w = first; w <= last; w++) used.add(w);
    // Never into the words around it, nor before the previous line's out point.
    const min = Math.max(lastOut, first > 0 ? words[first - 1]!.end : 0);
    const max = Math.min(duration, last + 1 < words.length ? words[last + 1]!.start : duration);
    const span2 = tighten(words[first]!.start, words[last]!.end, o.envelope, { padIn, padOut, min, max }); // prettier-ignore
    lastOut = span2.out;
    out.push({
      lineId: line.id,
      status: score >= MATCHED ? 'matched' : 'differs',
      in: span2.in,
      out: span2.out,
      heard: words
        .slice(first, last + 1)
        .map((w) => w.text)
        .join(' '),
      score,
      differences: differences(s, toks),
    });
  });

  const unused: AlignResult['unused'] = [];
  words.forEach((w, k) => {
    if (used.has(k)) return;
    const run = unused.at(-1);
    if (run && k > 0 && !used.has(k - 1) && run.end === words[k - 1]!.end) {
      run.end = w.end;
      run.text = `${run.text} ${w.text}`;
    } else unused.push({ start: w.start, end: w.end, text: w.text });
  });
  return { lines: out, unused };
}

/**
 * Without a transcript: the voice inside `[from, to)` of a recording, trimmed of the silence
 * around it and padded, or null when it is silent there.
 */
export function voiceSpan(
  env: Envelope,
  from = 0,
  to = env.hop * env.db.length,
  o: { padIn?: number; padOut?: number } = {},
): { in: number; out: number } | null {
  const thr = voiceThreshold(env);
  const a = Math.floor(from / env.hop);
  const b = Math.min(env.db.length, Math.ceil(to / env.hop));
  let first = -1;
  let last = -1;
  for (let k = a; k < b; k++)
    if (env.db[k]! >= thr) {
      if (first < 0) first = k;
      last = k;
    }
  if (first < 0) return null;
  const padIn = o.padIn ?? 0.06 * FLICKS_PER_SECOND;
  const padOut = o.padOut ?? 0.15 * FLICKS_PER_SECOND;
  return {
    in: Math.round(Math.max(from, first * env.hop - padIn)),
    out: Math.round(Math.min(to, (last + 1) * env.hop + padOut)),
  };
}
