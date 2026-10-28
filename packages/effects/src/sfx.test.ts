import { createHash } from 'node:crypto';
import { FLICKS_PER_SECOND, Timeline, flicksPerFrame, type Track } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  SFX_KINDS,
  SFX_PEAK,
  SFX_SPECS,
  applyMixRules,
  encodeWav,
  generatedCatalog,
  pickSfx,
  planSfx,
  sfxTracks,
  synthSfx,
  type SfxKind,
  type SfxOption,
  type SfxPlacement,
} from './index.js';

const F = FLICKS_PER_SECOND;
const SR = 48_000;
const RATE = { num: 30, den: 1 };
const FPF = flicksPerFrame(RATE);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};
const zeroCrossings = (x: Float32Array) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
  return n / (x.length / SR);
};

describe('generated sound effects', { timeout: 30_000 }, () => {
  it('are deterministic: the same samples and the same bytes every time', () => {
    for (const kind of SFX_KINDS) {
      const a = synthSfx(kind, { sampleRate: SR });
      const b = synthSfx(kind, { sampleRate: SR });
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), kind).toBe(true);
      expect(Buffer.from(encodeWav(a, SR)).equals(Buffer.from(encodeWav(b, SR)))).toBe(true);
    }
    // Noise-based sounds change with the seed, tonal ones do not need to.
    expect(synthSfx('whoosh', { seed: 1 })).not.toEqual(synthSfx('whoosh', { seed: 2 }));
  });

  it('have the length and level they promise, with no clicks or bad values', () => {
    for (const kind of SFX_KINDS) {
      const x = synthSfx(kind, { sampleRate: SR });
      expect(x.length, kind).toBe(Math.round(SFX_SPECS[kind].seconds * SR));
      let peak = 0;
      for (const v of x) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeCloseTo(SFX_PEAK, 3);
      expect(Math.abs(x[0]!)).toBeLessThan(0.01);
      expect(Math.abs(x.at(-1)!)).toBeLessThan(0.01);
    }
  });

  it('sound like what they are called', () => {
    const riser = synthSfx('riser', { sampleRate: SR });
    const q = riser.length / 4;
    expect(rms(riser, 3 * q, 4 * q)).toBeGreaterThan(rms(riser, 0, q) * 5); // gets louder
    expect(zeroCrossings(riser.subarray(3 * q))).toBeGreaterThan(
      zeroCrossings(riser.subarray(0, q)) * 2,
    ); // and higher
    const whoosh = synthSfx('whoosh', { sampleRate: SR });
    const peakAt =
      whoosh.reduce((best, v, i) => (Math.abs(v) > Math.abs(whoosh[best]!) ? i : best), 0) /
      whoosh.length;
    expect(peakAt).toBeGreaterThan(0.3);
    expect(peakAt).toBeLessThan(0.7);
    const impact = synthSfx('impact', { sampleRate: SR });
    expect(rms(impact, 0, 4800)).toBeGreaterThan(rms(impact, 24000, 28800) * 4); // loud first, then dies away
    const sub = synthSfx('sub-drop', { sampleRate: SR });
    expect(zeroCrossings(sub)).toBeLessThan(120); // all below about 60 Hz
    expect(zeroCrossings(whoosh)).toBeGreaterThan(300);
  });

  it('encode to a valid 16-bit mono WAV', () => {
    const x = synthSfx('impact', { sampleRate: SR });
    const wav = encodeWav(x, SR);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe('WAVEfmt ');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(SR);
    expect(v.getUint32(40, true)).toBe(x.length * 2);
    expect(wav.length).toBe(44 + x.length * 2);
  });

  it('are pinned: a change to a sound is a decision, not an accident', () => {
    const hashes = Object.fromEntries(
      SFX_KINDS.map((k) => [
        k,
        createHash('sha256')
          .update(encodeWav(synthSfx(k, { sampleRate: SR }), SR))
          .digest('hex')
          .slice(0, 16),
      ]),
    );
    expect(hashes).toMatchInlineSnapshot(`
      {
        "impact": "d366767497a74b68",
        "riser": "420866f05eb52a69",
        "sub-drop": "bcd75e64c401cfa2",
        "whoosh": "801d4a0ddccebd1a",
      }
    `);
  });
});

// -- placement ------------------------------------------------------------------------------------

const frames = (n: number) => Math.round(n * FPF);
const clip = (id: string, slotId: string, start: number, len: number) => ({
  id,
  kind: 'clip' as const,
  start: frames(start),
  duration: frames(len),
  slotId,
  assetId: 'asset_a',
  sourceIn: 0,
  speed: 1,
  effects: [],
  gainDb: 0,
  muted: false,
  extensions: {},
});

/** Three shots back to back on 30 fps; a whip into shot 2, a crossfade into shot 3. */
function timeline(over: Partial<Timeline> = {}): Timeline {
  const items = [clip('c1', 's1', 0, 60), clip('c2', 's2', 60, 90), clip('c3', 's3', 150, 60)];
  const picture: Track = {
    id: 'trk_picture',
    kind: 'video',
    name: '',
    muted: false,
    locked: false,
    items,
    transitions: [
      {
        id: 'tr1',
        transitionId: 'core/whip',
        fromItemId: 'c1',
        toItemId: 'c2',
        duration: frames(8),
        params: {},
      },
      {
        id: 'tr2',
        transitionId: 'core/crossfade',
        fromItemId: 'c2',
        toItemId: 'c3',
        duration: frames(12),
        params: {},
      },
    ],
  };
  return Timeline.parse({
    id: 'tl_x',
    name: 'x',
    frameRate: RATE,
    resolution: { width: 1920, height: 1080 },
    tracks: [picture],
    markers: [{ id: 'mk_hit_h2', at: frames(61) + 123_456, kind: 'hit', label: 'impact' }],
    ...over,
  });
}
const music = (cues: unknown[], hits: unknown[] = []) =>
  ({ music: { direction: '', structure: [], hitPoints: hits, sfxCues: cues } }) as never;
const catalog = generatedCatalog();
const peakTime = (p: SfxPlacement) =>
  p.start - p.sourceIn + Math.round(p.option.peakOffset * p.option.duration);

describe('planSfx', () => {
  it('puts the loudest moment on the cut, the hit point or the slot edge, within a frame', () => {
    const plan = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music(
        [
          { id: 'c_whoosh', kind: 'whoosh', slotId: 's2', position: 'before' },
          { id: 'c_impact', kind: 'impact', slotId: 's2', position: 'start' },
          { id: 'c_riser', kind: 'riser', slotId: 's3', position: 'before' },
          { id: 'c_end', kind: 'sub-drop', slotId: 's3', position: 'end' },
        ],
        [{ id: 'h2', kind: 'drop', slotId: 's2', position: 'start', note: '' }],
      ),
    });
    const by = Object.fromEntries(plan.placements.map((p) => [p.cueId ?? p.transitionId!, p]));
    // The impact lands on the music's hit point (61 frames in, not 60), the others on cut edges.
    expect(Math.abs(peakTime(by.c_impact!) - (frames(61) + 123_456))).toBeLessThanOrEqual(FPF);
    expect(Math.abs(peakTime(by.c_whoosh!) - frames(60))).toBeLessThanOrEqual(FPF);
    expect(Math.abs(peakTime(by.c_riser!) - frames(150))).toBeLessThanOrEqual(FPF);
    expect(Math.abs(peakTime(by.c_end!) - frames(210))).toBeLessThanOrEqual(FPF);
    // The riser ends at its cut; the whoosh is centred on its.
    expect(by.c_riser!.start + by.c_riser!.duration).toBeLessThanOrEqual(frames(150) + FPF);
    for (const p of plan.placements) {
      expect(p.start % FPF, p.id).toBe(0);
      expect(Number.isInteger(p.duration)).toBe(true);
      expect(p.reason.length).toBeGreaterThan(5);
    }
    expect(plan.placements.map((p) => p.start)).toEqual(
      [...plan.placements.map((p) => p.start)].sort((a, b) => a - b),
    );
  });

  it('adds a sound for a whip, a flash or a zoom punch, but not twice for the same cut', () => {
    const tl = timeline();
    const alone = planSfx({ timeline: tl, catalog, storyboard: music([]) });
    expect(alone.placements.map((p) => [p.transitionId, p.kind])).toEqual([['tr1', 'whoosh']]); // the crossfade has none
    expect(Math.abs(peakTime(alone.placements[0]!) - frames(60))).toBeLessThanOrEqual(FPF);
    const withCue = planSfx({
      timeline: tl,
      catalog,
      storyboard: music([{ id: 'c1', kind: 'whoosh', slotId: 's2', position: 'before' }]),
    });
    expect(withCue.placements.map((p) => p.id)).toEqual(['sfx_c1']);
  });

  it('starts a sound later in its file rather than before the cut begins', () => {
    const plan = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music([{ id: 'r', kind: 'riser', slotId: 's2', position: 'before' }]),
    });
    const p = plan.placements.find((x) => x.cueId === 'r')!;
    expect(p.start).toBe(0);
    expect(p.sourceIn).toBeGreaterThan(0);
    expect(p.duration).toBe(p.option.duration - p.sourceIn);
    expect(p.start - p.sourceIn + p.option.duration).toBe(p.target); // it still ends on the cut
  });

  it('leaves out a riser that would end before the first frame', () => {
    const first = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music([{ id: 'r1', kind: 'riser', slotId: 's1', position: 'before' }]),
    });
    expect(first.placements.some((x) => x.cueId === 'r1')).toBe(false);
    expect(first.warnings).toEqual(['r1: the sound would end before the cut starts; left out']);
  });

  it('skips slots that are not in this cut and tells about a missing sound', () => {
    const none = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music([{ id: 'x', kind: 'impact', slotId: 'gone', position: 'start' }]),
    });
    expect(none.placements.filter((p) => p.cueId)).toEqual([]);
    const empty = planSfx({
      timeline: timeline(),
      catalog: [],
      storyboard: music([{ id: 'x', kind: 'impact', slotId: 's2', position: 'start' }]),
    });
    expect(empty.warnings).toContain('no impact sound is available for x');
  });

  it("prefers the user's own sounds, and always picks the same one for the same cue", () => {
    const user = (name: string): SfxOption => ({
      id: `user:${name}`,
      source: 'user',
      kind: 'impact',
      duration: 2 * F,
      peakOffset: 0,
      peakDb: -3,
    });
    const cat = [...catalog, user('boom-a.wav'), user('boom-b.wav'), user('boom-c.wav')];
    const picks = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => pickSfx('impact', cat, k)!.id);
    expect(picks.every((id) => id.startsWith('user:'))).toBe(true);
    expect(new Set(picks).size).toBeGreaterThan(1);
    expect(picks).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => pickSfx('impact', [...cat].reverse(), k)!.id),
    );
    expect(pickSfx('whoosh', cat, 'k')!.source).toBe('generated');
  });

  it('is deterministic, and the same inputs give the same plan', () => {
    const sb = music([{ id: 'a', kind: 'impact', slotId: 's2', position: 'start' }]);
    expect(planSfx({ timeline: timeline(), catalog, storyboard: sb })).toEqual(
      planSfx({ timeline: timeline(), catalog: [...catalog], storyboard: sb }),
    );
  });
});

describe('level rules', () => {
  const ceilingLin = 10 ** (-1 / 20);

  it('keep music plus sounds under the ceiling in every overlap, for any music level', () => {
    const r = rng(42);
    for (let n = 0; n < 500; n++) {
      const count = r.int(1, 8);
      const placements: SfxPlacement[] = Array.from({ length: count }, (_, i) => {
        const kind = SFX_KINDS[r.int(0, 3)] as SfxKind;
        const option = catalog.find((o) => o.kind === kind)!;
        const loud = r.int(0, 1) === 0;
        return {
          id: `p${i}`,
          option: loud ? { ...option, peakDb: -1 } : option,
          kind,
          start: r.int(0, 20) * frames(10),
          duration: option.duration,
          sourceIn: 0,
          target: 0,
          gainDb: SFX_SPECS[kind].gainDb,
          reason: '',
        };
      });
      const musicPeakDb = -(r.int(0, 20) / 2);
      const { ducks } = applyMixRules(placements, { musicPeakDb });
      // Worst case in each overlapping cluster: the loudest instant adds every sound's peak.
      const sorted = [...placements].sort((a, b) => a.start - b.start);
      let cluster: SfxPlacement[] = [];
      let end = -Infinity;
      const groups: SfxPlacement[][] = [];
      for (const p of sorted) {
        if (cluster.length && p.start < end) cluster.push(p);
        else groups.push((cluster = [p]));
        end = Math.max(end, p.start + p.duration);
      }
      for (const g of groups) {
        const from = Math.min(...g.map((p) => p.start));
        const duck = ducks.find((d) => d.start === from)?.db ?? 0;
        expect(duck, `case ${n}`).toBeLessThanOrEqual(9);
        const sfx = g.reduce((a, p) => a + 10 ** ((p.option.peakDb + p.gainDb) / 20), 0);
        const total = 10 ** ((musicPeakDb - duck) / 20) + sfx;
        expect(total, `case ${n}`).toBeLessThanOrEqual(ceilingLin + 1e-3);
      }
    }
  });

  it('leave quiet scenes alone, duck the music under a hit, and ease sounds that still would not fit', () => {
    const impact = catalog.find((o) => o.kind === 'impact')!;
    const one = (gain: number): SfxPlacement => ({
      id: 'p',
      option: impact,
      kind: 'impact',
      start: 0,
      duration: impact.duration,
      sourceIn: 0,
      target: 0,
      gainDb: gain,
      reason: '',
    });
    const quiet = [one(-30)];
    expect(applyMixRules(quiet, { musicPeakDb: -12 }).ducks).toEqual([]);
    const hit = [one(-2)];
    const { ducks } = applyMixRules(hit, { musicPeakDb: -1 });
    expect(ducks).toHaveLength(1);
    expect(ducks[0]!.db).toBeGreaterThan(0);
    expect(ducks[0]!.db).toBeLessThanOrEqual(9);
    expect(hit[0]!.gainDb).toBe(-2); // the sound itself was fine
    const hot = [
      { ...one(0), option: { ...impact, peakDb: 0 } },
      { ...one(0), id: 'q', option: { ...impact, peakDb: 0 } },
    ];
    applyMixRules(hot, { musicPeakDb: -1, maxDuckDb: 3 });
    expect(hot[0]!.gainDb).toBeLessThan(0); // eased down to fit
  });

  it('leave the mix target intact for a whole plan', () => {
    const plan = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music([
        { id: 'a', kind: 'impact', slotId: 's2', position: 'start' },
        { id: 'b', kind: 'sub-drop', slotId: 's2', position: 'start' },
        { id: 'c', kind: 'riser', slotId: 's3', position: 'before' },
      ]),
    });
    expect(plan.ducks.length).toBeGreaterThan(0);
    for (const d of plan.ducks) expect(d.db).toBeLessThanOrEqual(9);
    for (const p of plan.placements) expect(p.option.peakDb + p.gainDb).toBeLessThanOrEqual(-5);
  });
});

describe('sfxTracks', () => {
  it('makes valid audio tracks, putting overlapping sounds on lanes of their own', () => {
    const plan = planSfx({
      timeline: timeline(),
      catalog,
      storyboard: music([
        { id: 'a', kind: 'impact', slotId: 's2', position: 'start' },
        { id: 'b', kind: 'sub-drop', slotId: 's2', position: 'start' },
        { id: 'c', kind: 'riser', slotId: 's3', position: 'before' },
      ]),
    });
    const assets = new Map([
      ['generated:impact', 'asset_imp'],
      ['generated:sub-drop', 'asset_sub'],
    ]);
    const { tracks, missing } = sfxTracks(plan, assets);
    expect([...missing].sort()).toEqual(['generated:riser', 'generated:whoosh']); // the riser, and the whip's whoosh
    expect(tracks.map((t) => t.id)).toEqual(['trk_sfx', 'trk_sfx_2']);
    expect(tracks.flatMap((t) => t.items.map((i) => i.id)).sort()).toEqual(['sfx_a', 'sfx_b']);
    const parsed = Timeline.parse({
      id: 'tl',
      name: 'x',
      frameRate: RATE,
      resolution: { width: 16, height: 9 },
      tracks,
    });
    expect(parsed.tracks).toHaveLength(2); // no overlaps within a lane
    expect(sfxTracks({ placements: [], ducks: [], warnings: [] }, assets).tracks).toEqual([]);
  });
});
