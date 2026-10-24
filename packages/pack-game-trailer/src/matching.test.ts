import { Project, ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { buildCapturePlan } from './capture.js';
import { acceptMatchesPayload, suggestMatches, type MatchRecording } from './matching.js';
import { shotCodes } from './shot-codes.js';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = <T>(r: () => number, xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** 12 shots in 3 locations with different lengths, in one section. */
function project(): Project {
  const base = sampleProject() as unknown as Record<string, unknown> & {
    storyboard: Record<string, unknown>;
  };
  const locations = ['Forest', 'Castle', 'Harbour'];
  const slots = Array.from({ length: 12 }, (_, i) =>
    ShotSlot.parse({
      id: `sh_${i}`,
      kind: 'shot',
      title: `Shot ${i}`,
      duration: { min: 1 + (i % 4), ideal: 2 + (i % 4), max: 3 + (i % 4) },
      location: locations[Math.floor(i / 4)],
      captureInstruction: `Do thing ${i}`,
    }),
  );
  const sb = base.storyboard;
  const p = {
    ...base,
    storyboard: {
      ...sb,
      sections: [{ id: 'sec_all', name: 'All', slots }],
      voLines: [],
      music: {
        ...(sb.music as object),
        hitPoints: [],
        sfxCues: [],
        structure: [],
        trackAssetId: undefined,
      },
    },
    timelines: [],
  };
  return Project.parse(p);
}

interface Session {
  recordings: MatchRecording[];
  truth: Map<string, string>; // assetId -> slotId (absent: junk)
  vision: Map<string, Map<string, number>>;
}

/** Recordings made in checklist order (sometimes two takes), some named with codes, plus junk. */
function session(p: Project, seed: number, codedShare = 0.3): Session {
  const r = rng(seed);
  const plan = buildCapturePlan(p.storyboard!, p.knowledge);
  const items = plan.groups.flatMap((g) => g.items.map((it) => ({ it, group: g.key })));
  const codes = shotCodes(p);
  let t = Date.parse('2026-10-24T14:00:00Z') / 1000;
  let lastGroup = items[0]!.group;
  const recordings: MatchRecording[] = [];
  const truth = new Map<string, string>();
  let n = 0;
  const stamp = (sec: number) => new Date(sec * 1000).toISOString();
  for (const { it, group } of items) {
    if (group !== lastGroup) t += 1800; // a break between locations
    lastGroup = group;
    const takes = r() < 0.3 ? 2 : 1;
    for (let k = 0; k < takes; k++) {
      const dur = it.recordSeconds * (0.9 + r() * 0.6);
      t += 20 + r() * 60 + dur;
      const id = `asset_${seed}_${n++}`;
      const coded = r() < codedShare;
      recordings.push({
        assetId: id,
        name: coded
          ? `${codes.get(it.slotId)} take${k + 1}.mp4`
          : `${stamp(t).slice(0, 19).replace(/[T:]/g, '-')}.mkv`,
        recordedAt: stamp(t),
        durationSec: Math.round(dur * 100) / 100,
      });
      truth.set(id, it.slotId);
    }
  }
  for (const d of [0.4, 900]) {
    t += 120 + d;
    recordings.push({
      assetId: `asset_${seed}_junk_${d}`,
      name: `junk ${d}.mp4`,
      recordedAt: stamp(t),
      durationSec: d,
    });
  }
  const vision = new Map<string, Map<string, number>>();
  for (const rec of recordings) {
    const row = new Map<string, number>();
    for (const { it } of items) {
      const noise = (r() - 0.5) * 0.05;
      row.set(it.slotId, (truth.get(rec.assetId) === it.slotId ? 0.3 : 0.24) + noise);
    }
    vision.set(rec.assetId, row);
  }
  return { recordings: shuffle(r, recordings), truth, vision };
}

function accuracy(seeds: number, withVision: boolean) {
  const p = project();
  let right = 0;
  let total = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const s = session(p, seed);
    const { matches } = suggestMatches({
      project: p,
      recordings: s.recordings,
      ...(withVision ? { vision: s.vision } : {}),
    });
    for (const m of matches) {
      const want = s.truth.get(m.assetId);
      if (!want || m.kind === 'code') continue;
      total++;
      if (m.candidates[0]?.slotId === want) right++;
    }
  }
  return right / total;
}

describe('suggestMatches', () => {
  it('attaches by code with certainty and reads the take number', () => {
    const p = project();
    const code = shotCodes(p).get('sh_5')!;
    const { matches } = suggestMatches({
      project: p,
      recordings: [{ assetId: 'asset_a', name: `${code.toLowerCase()} take3.mkv` }],
    });
    expect(matches[0]).toMatchObject({
      kind: 'code',
      confidence: 'certain',
      take: 3,
      candidates: [{ slotId: 'sh_5', score: 1 }],
    });
    expect(matches[0]!.candidates[0]!.reasons[0]).toMatchObject({ signal: 'code' });
  });

  it('reaches the target top-1 accuracy on synthetic sessions', () => {
    const withVision = accuracy(20, true);
    const without = accuracy(20, false);
    console.log(
      `matcher top-1: with vision ${withVision.toFixed(3)}, without ${without.toFixed(3)}`,
    );
    expect(withVision).toBeGreaterThanOrEqual(0.9);
    expect(without).toBeGreaterThanOrEqual(0.8);
  });

  it('is deterministic whatever the input order, and never offers a recording twice', () => {
    const p = project();
    for (let seed = 1; seed <= 10; seed++) {
      const s = session(p, seed);
      const a = suggestMatches({ project: p, recordings: s.recordings, vision: s.vision });
      const b = suggestMatches({
        project: p,
        recordings: shuffle(rng(seed + 99), [...s.recordings, ...s.recordings]),
        vision: s.vision,
      });
      expect(b).toEqual(a);
      const ids = a.matches.map((m) => m.assetId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const m of a.matches) {
        expect(m.candidates.length).toBeLessThanOrEqual(3);
        for (const c of m.candidates) {
          expect(c.score).toBeGreaterThanOrEqual(0);
          expect(c.score).toBeLessThanOrEqual(1);
          expect(c.reasons.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('leaves out recordings that are already takes, and junk gets low confidence', () => {
    const p = project();
    const s = session(p, 3, 0);
    const first = s.recordings.find((x) => s.truth.has(x.assetId))!;
    const slot = p.storyboard!.sections[0]!.slots.find((x) => x.id === s.truth.get(first.assetId))!;
    if (slot.kind === 'shot')
      slot.takes.push({
        id: 'take_x',
        assetId: first.assetId,
        matchedBy: 'manual',
        rejected: false,
        note: '',
        attachedAt: '2026-10-24T10:00:00.000Z',
      });
    p.assets.push({ assetId: first.assetId, role: 'footage', addedAt: '2026-10-24T10:00:00.000Z' });
    const { matches } = suggestMatches({ project: p, recordings: s.recordings });
    expect(matches.some((m) => m.assetId === first.assetId)).toBe(false);
    const junk = matches.find((m) => m.assetId.endsWith('junk_0.4'))!;
    expect(junk.confidence).toBe('low');
  });

  it('reports codes of other projects and several codes in one name', () => {
    const p = project();
    const codes = shotCodes(p);
    const { matches } = suggestMatches({
      project: p,
      recordings: [
        { assetId: 'asset_u', name: 'TF-22222 boss.mp4' },
        { assetId: 'asset_m', name: `${codes.get('sh_1')} ${codes.get('sh_2')}.mp4` },
      ],
    });
    const unknown = matches.find((m) => m.assetId === 'asset_u')!;
    expect(unknown.kind).toBe('suggested');
    if (![...codes.values()].includes('TF-22222'))
      expect(unknown.unknownCodes).toEqual(['TF-22222']);
    const multi = matches.find((m) => m.assetId === 'asset_m')!;
    expect(multi.kind).toBe('ambiguous-code');
    expect(multi.candidates.map((c) => c.slotId).sort()).toEqual(['sh_1', 'sh_2']);
  });

  it('handles empty inputs', () => {
    expect(suggestMatches({ project: project(), recordings: [] })).toEqual({ matches: [] });
    const noSb = Project.parse({ ...sampleProject(), storyboard: undefined });
    expect(
      suggestMatches({ project: noSb, recordings: [{ assetId: 'a', name: 'x.mp4' }] }),
    ).toEqual({ matches: [] });
  });
});

describe('acceptMatchesPayload', () => {
  it('accepts codes and confident suggestions, one recording each, never ambiguous ones', () => {
    const p = project();
    let accepted = 0;
    const stats = { v: { right: 0, total: 0 }, n: { right: 0, total: 0 } };
    for (const vision of [true, false]) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = session(p, seed);
        const { matches } = suggestMatches({
          project: p,
          recordings: s.recordings,
          ...(vision ? { vision: s.vision } : {}),
        });
        const { items } = acceptMatchesPayload(matches, { attachedAt: '2026-10-24T12:00:00.000Z' });
        const ids = items.map((i) => i.assetId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(items.filter((i) => i.matchedBy === 'code')).toHaveLength(
          matches.filter((m) => m.kind === 'code').length,
        );
        for (const i of items) {
          if (i.matchedBy === 'code') continue;
          const st = stats[vision ? 'v' : 'n'];
          st.total++;
          if (s.truth.get(i.assetId) === i.slotId) st.right++;
        }
        accepted += items.length;
      }
    }
    // Accepting in bulk must be right every time on these sessions; most high-confidence
    // suggestions need vision, without it the user confirms nearly everything.
    expect(stats.v.right).toBe(stats.v.total);
    expect(stats.n.right).toBe(stats.n.total);
    expect(stats.v.total).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(stats.v.total);
  });
});
