import type { Project } from '@trailerforge/schema';

/**
 * Shot codes: short labels such as `TF-K7QF2` printed in the capture pack, typed into recording
 * file names and read back at import to match a file to its shot. A code is derived from the slot
 * id, never stored, so it survives reordering, edits and reloads. Browser-safe (no Node imports).
 *
 * The alphabet leaves out 0, O, 1, I, L and U, so a code cannot be misread or mistyped as another.
 * Five characters give 24.3 million codes; with 100 shots the chance that two shots hash to the
 * same code is about 1 in 5,000. Collisions are resolved deterministically (lowest slot id keeps
 * the code, the other is re-hashed), so they can only ever recode the shots involved.
 */
export const SHOT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHOT_CODE_LENGTH = 5;
export const SHOT_CODE_PREFIX = 'TF-';

/** 53-bit string hash (cyrb53): deterministic everywhere JavaScript runs. */
function hash53(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Code for one slot id before collision handling; `attempt` > 0 re-hashes after a collision. */
export function candidateShotCode(slotId: string, attempt = 0): string {
  let n = hash53(attempt === 0 ? slotId : `${slotId}#${attempt}`);
  let body = '';
  for (let i = 0; i < SHOT_CODE_LENGTH; i++) {
    body += SHOT_CODE_ALPHABET[n % SHOT_CODE_ALPHABET.length];
    n = Math.floor(n / SHOT_CODE_ALPHABET.length);
  }
  return SHOT_CODE_PREFIX + body;
}

/** Codes for these slot ids, unique among them; independent of input order. */
export function assignShotCodes(slotIds: Iterable<string>): Map<string, string> {
  const ids = [...new Set(slotIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const taken = new Set<string>();
  const codes = new Map<string, string>();
  for (const id of ids) {
    let attempt = 0;
    let code = candidateShotCode(id);
    while (taken.has(code)) code = candidateShotCode(id, ++attempt);
    taken.add(code);
    codes.set(id, code);
  }
  return codes;
}

/** slot id → code for every shot slot in the project (skipped and locked shots included). */
export function shotCodes(project: Pick<Project, 'storyboard'>): Map<string, string> {
  const ids: string[] = [];
  for (const section of project.storyboard?.sections ?? [])
    for (const slot of section.slots) if (slot.kind === 'shot') ids.push(slot.id);
  return assignShotCodes(ids);
}

export interface ParsedFileName {
  /** Valid-looking codes found in the name, normalised to `TF-XXXXX`, in order, no repeats. */
  codes: string[];
  /** Take number from `take2`, `take_02`, `tk3`... when present. */
  take: number | null;
}

const CODE_RE = /(?<![A-Za-z0-9])tf[-_ .]?([A-Za-z0-9]{5})(?![A-Za-z0-9])/gi;
const TAKE_RE = /(?<![A-Za-z0-9])(?:take|tk)[-_ .]?(\d{1,3})(?![0-9])/i;
const VALID = new RegExp(`^[${SHOT_CODE_ALPHABET}]{${SHOT_CODE_LENGTH}}$`);

/**
 * Read shot codes and a take number from a file name or path. Tolerates case, `-`, `_`, `.` or
 * space (or nothing) between `TF` and the code, and anything around it such as OBS date stamps:
 * `2026-10-24 14-03-22 tf_k7qf2 take2.mkv`. Codes with characters outside the alphabet are
 * ignored rather than guessed.
 */
export function parseRecordingName(path: string): ParsedFileName {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  const codes: string[] = [];
  for (const m of name.matchAll(CODE_RE)) {
    const body = m[1]!.toUpperCase();
    const code = SHOT_CODE_PREFIX + body;
    if (VALID.test(body) && !codes.includes(code)) codes.push(code);
  }
  const t = TAKE_RE.exec(name);
  return { codes, take: t ? Number(t[1]) : null };
}

export interface CodeMatch {
  /** Shots whose code is in the name (empty: no match; more than one: ambiguous). */
  slotIds: string[];
  take: number | null;
  /** Codes in the name that belong to no shot in this project. */
  unknownCodes: string[];
}

/** Match a recording's file name against the project's shot codes. */
export function matchRecordingName(path: string, codes: Map<string, string>): CodeMatch {
  const parsed = parseRecordingName(path);
  const byCode = new Map([...codes].map(([slotId, code]) => [code, slotId]));
  const slotIds: string[] = [];
  const unknownCodes: string[] = [];
  for (const code of parsed.codes) {
    const slotId = byCode.get(code);
    if (slotId) slotIds.push(slotId);
    else unknownCodes.push(code);
  }
  return { slotIds, take: parsed.take, unknownCodes };
}
