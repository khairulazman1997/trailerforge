import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  SHOT_CODE_ALPHABET,
  assignShotCodes,
  candidateShotCode,
  matchRecordingName,
  parseRecordingName,
  shotCodes,
} from './shot-codes.js';

/** Small seeded PRNG (mulberry32) so property cases are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomIds = (r: () => number, n: number) =>
  Array.from({ length: n }, (_, i) => `sh_${Math.floor(r() * 1e9).toString(36)}_${i}`);
const shuffle = <T>(r: () => number, xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe('shot codes', () => {
  it('have the TF- prefix and five unambiguous characters', () => {
    const code = candidateShotCode('sh_perfect_parry');
    expect(code).toMatch(new RegExp(`^TF-[${SHOT_CODE_ALPHABET}]{5}$`));
    expect(SHOT_CODE_ALPHABET).not.toMatch(/[01ILOU]/);
    expect(candidateShotCode('sh_perfect_parry')).toBe(code); // pure
  });

  it('pins known values so codes never change between releases', () => {
    expect([candidateShotCode('shot_parry'), candidateShotCode('a'), candidateShotCode('a', 1)])
      .toMatchInlineSnapshot(`
      [
        "TF-PX9B8",
        "TF-3R9AH",
        "TF-EQ8HW",
      ]
    `);
  });

  it('property: unique, and independent of order and of unrelated shots', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      const ids = randomIds(r, 1 + Math.floor(r() * 300));
      const codes = assignShotCodes(ids);
      expect(new Set(codes.values()).size).toBe(ids.length);
      expect(assignShotCodes(shuffle(r, ids))).toEqual(codes);
      // removing shots never recodes the others unless they had collided
      const kept = ids.filter(() => r() < 0.5);
      const after = assignShotCodes(kept);
      for (const id of kept) {
        if (codes.get(id) === candidateShotCode(id)) expect(after.get(id)).toBe(codes.get(id));
      }
    }
  });

  it('resolves collisions deterministically: lowest slot id keeps the code', () => {
    // find two ids that collide on their first candidate
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair && i < 2_000_000; i++) {
      const id = `s${i}`;
      const c = candidateShotCode(id);
      const other = seen.get(c);
      if (other) pair = [other, id];
      else seen.set(c, id);
    }
    expect(pair).not.toBeNull();
    const [a, b] = pair!.sort();
    const codes = assignShotCodes([b!, a!]);
    expect(codes.get(a!)).toBe(candidateShotCode(a!));
    expect(codes.get(b!)).toBe(candidateShotCode(b!, 1));
  });

  it('cover every shot slot in a project, skipped ones included', () => {
    const project = Project.parse(sampleProject());
    const codes = shotCodes(project);
    const shots = project
      .storyboard!.sections.flatMap((s) => s.slots)
      .filter((s) => s.kind === 'shot');
    expect([...codes.keys()].sort()).toEqual(shots.map((s) => s.id).sort());
    expect(shotCodes(Project.parse({ ...sampleProject(), storyboard: undefined })).size).toBe(0);
  });
});

describe('parseRecordingName', () => {
  const cases: [string, string[], number | null][] = [
    ['TF-K7QF2.mp4', ['TF-K7QF2'], null],
    ['tf-k7qf2.mkv', ['TF-K7QF2'], null],
    ['TF_K7QF2 take2.mp4', ['TF-K7QF2'], 2],
    ['TFK7QF2-take_03.mov', ['TF-K7QF2'], 3],
    ['tf.k7qf2 tk4.mp4', ['TF-K7QF2'], 4],
    ['2026-10-24 14-03-22 TF K7QF2.mkv', ['TF-K7QF2'], null],
    ['C:\\Users\\me\\Videos\\TF-K7QF2 boss.mp4', ['TF-K7QF2'], null],
    ['/rec/TF-AAAAA/clip.mp4', [], null], // folders are not read
    ['TF-K7QF2 TF-22222 TF-K7QF2.mp4', ['TF-K7QF2', 'TF-22222'], null],
    ['TF-K7QF0.mp4', [], null], // 0 is not in the alphabet
    ['TF-OIL12.mp4', [], null],
    ['XTF-K7QF2.mp4', [], null], // glued to a word
    ['TF-K7QF22.mp4', [], null], // too long
    ['TF-K7QF.mp4', [], null], // too short
    ['2026-10-24 14-03-22.mkv', [], null],
    ['mistake2.mp4', [], null],
    ['take12345.mp4', [], null],
    ['', [], null],
  ];
  it.each(cases)('%s', (name, codes, take) => {
    expect(parseRecordingName(name)).toEqual({ codes, take });
  });
});

describe('matchRecordingName', () => {
  it('maps codes to shots, and reports unknown and ambiguous names', () => {
    const codes = assignShotCodes(['sh_a', 'sh_b']);
    const a = codes.get('sh_a')!;
    const b = codes.get('sh_b')!;
    expect(matchRecordingName(`${a.toLowerCase()} take2.mp4`, codes)).toEqual({
      slotIds: ['sh_a'],
      take: 2,
      unknownCodes: [],
    });
    expect(matchRecordingName(`${a} ${b}.mp4`, codes).slotIds).toEqual(['sh_a', 'sh_b']);
    expect(matchRecordingName('TF-22222.mp4', codes)).toEqual({
      slotIds: [],
      take: null,
      unknownCodes: [...codes.values()].includes('TF-22222') ? [] : ['TF-22222'],
    });
  });
});
