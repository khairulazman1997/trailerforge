import { describe, expect, it } from 'vitest';
import {
  DecisionRecord,
  Timeline,
  framesToFlicks,
  rate,
  type TimelineItem,
} from '@trailerforge/schema';
import { checkPlan, gateVerdict, overrideDecision, type GateFinding } from './quality.js';
import type { TakeSource } from './rough-cut.js';

const R = rate(24);
const f = (n: number) => framesToFlicks(n, R);
const S = 705_600_000;

const clip = (id: string, start: number, frames: number, extra: object = {}) =>
  ({
    id,
    kind: 'clip',
    start: f(start),
    duration: f(frames),
    assetId: 'a',
    sourceIn: 0,
    ...extra,
  }) as TimelineItem;

function tl(
  items: TimelineItem[],
  extra: { transitions?: object[]; graphics?: TimelineItem[] } = {},
) {
  return Timeline.parse({
    id: 'tl_v',
    name: 'V',
    frameRate: R,
    resolution: { width: 1920, height: 1080 },
    tracks: [
      { id: 'trk_v', kind: 'video', items, transitions: extra.transitions ?? [] },
      ...(extra.graphics ? [{ id: 'trk_g', kind: 'graphics', items: extra.graphics }] : []),
    ],
  });
}

const facts = (focusX?: (i: number) => number): TakeSource => ({
  duration: 60 * S,
  footage: {
    rate: R,
    frameCount: 1440,
    duration: 60 * S,
    scenes: [],
    black: [],
    flashes: [],
    frozen: [],
    motion: [],
    ...(focusX ? { focus: Array.from({ length: 1440 }, (_, i) => [focusX(i), 500, 50, 50]) } : {}),
  },
});
const ids = (fs: GateFinding[]) => fs.map((x) => x.checkId);

describe('checkPlan', () => {
  // Two different recordings, 12 frames each, cut on the beat (beats every 12 frames, one frame early).
  const clean = tl([clip('c1', 0, 11), clip('c2', 11, 13, { assetId: 'b', sourceIn: f(100) })]);
  const sources = new Map([
    ['a', facts()],
    ['b', facts()],
  ]);
  const beats = Array.from({ length: 20 }, (_, i) => f(12 * i));

  it('a clean cut passes every check', () => {
    expect(checkPlan({ timeline: clean, sources, beats })).toEqual([]);
  });

  it('placeholders and missing recordings block hard', () => {
    const t = tl([
      clip('c1', 0, 12),
      {
        id: 'p',
        kind: 'placeholder',
        start: f(12),
        duration: f(12),
        reason: 'missing-footage',
      } as TimelineItem,
    ]);
    const fs = checkPlan({ timeline: t, sources: new Map() });
    expect(fs.map((x) => [x.checkId, x.tier, x.itemId])).toEqual([
      ['core/missing-media', 'hard', 'c1'],
      ['core/placeholders', 'hard', 'p'],
    ]);
  });

  it('declared flashes over three a second block hard', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      clip(`c${i}`, i * 5, 5, { assetId: i % 2 ? 'b' : 'a', sourceIn: f(i * 40) }),
    );
    const transitions = items.slice(1).map((it, i) => ({
      id: `t${i}`, transitionId: 'core/flash', fromItemId: items[i]!.id, toItemId: it.id, duration: f(2),
    })); // prettier-ignore
    const fs = checkPlan({ timeline: tl(items, { transitions }), sources });
    expect(fs.find((x) => x.checkId === 'core/flash-plan')).toMatchObject({
      tier: 'hard',
      severity: 'error',
    });
    expect(
      ids(checkPlan({ timeline: tl(items, { transitions: transitions.slice(0, 2) }), sources })),
    ).not.toContain('core/flash-plan');
  });

  it('warns about a jump cut within the same recording, not about a continuous one', () => {
    const jump = tl([clip('c1', 0, 12), clip('c2', 12, 12, { sourceIn: f(12 + 10) })]);
    expect(ids(checkPlan({ timeline: jump, sources }))).toEqual(['core/jump-cut']);
    const cont = tl([clip('c1', 0, 12), clip('c2', 12, 12, { sourceIn: f(12) })]);
    expect(ids(checkPlan({ timeline: cont, sources }))).toEqual([]);
  });

  it('warns when the action reverses direction across a cut', () => {
    const right = facts((i) => Math.min(1000, i * 4)); // ~0.1 frame widths a second
    const left = facts((i) => Math.max(0, 1000 - i * 4));
    const t = tl([clip('c1', 0, 48), clip('c2', 48, 48, { assetId: 'b', sourceIn: f(10) })]);
    const fs = checkPlan({
      timeline: t,
      sources: new Map([
        ['a', right],
        ['b', left],
      ]),
    });
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ checkId: 'core/screen-direction', severity: 'warning' });
    expect(fs[0]!.message).toMatch(/moves right .* and left/);
    expect(
      checkPlan({
        timeline: t,
        sources: new Map([
          ['a', right],
          ['b', right],
        ]),
      }),
    ).toEqual([]);
  });

  it('warns when the cut slows down toward the end', () => {
    const lens = [12, 12, 12, 12, 12, 30, 30, 30];
    let at = 0;
    const items = lens.map((n, i) => {
      const c = clip(`c${i}`, at, n, { assetId: i % 2 ? 'b' : 'a', sourceIn: f(at) });
      at += n;
      return c;
    });
    expect(ids(checkPlan({ timeline: tl(items), sources }))).toEqual(['core/pacing']);
    let at2 = 0;
    const faster = [30, 30, 30, 12, 12, 12, 12, 12].map((n, i) => {
      const c = clip(`c${i}`, at2, n, { assetId: i % 2 ? 'b' : 'a', sourceIn: f(at2) });
      at2 += n;
      return c;
    });
    expect(ids(checkPlan({ timeline: tl(faster), sources }))).toEqual([]);
  });

  it('warns about cuts off the beat', () => {
    const off = tl([clip('c1', 0, 7), clip('c2', 7, 17, { assetId: 'b' })]);
    const fs = checkPlan({ timeline: off, sources, beats });
    expect(fs.map((x) => [x.checkId, x.at?.start])).toEqual([['core/off-beat', 0.292]]);
  });

  it('turns graphics messages into safe-area (override) and read-time (warning) findings', () => {
    const card = {
      id: 'g1',
      kind: 'graphic',
      start: 0,
      duration: f(24),
      templateId: 'core/title-card',
    } as TimelineItem;
    const fs = checkPlan({
      timeline: tl([clip('c1', 0, 24)], { graphics: [card] }),
      graphicsIssues: [{ itemId: 'g1', messages: ['text "BOSS" reaches outside the safe area', '"Out now" is on screen for 0.5 s; reading it takes about 1 s', 'shrunk to fit'] }],
      contrastIssues: ['text on background is 2.1:1, under 4.5:1'],
    }); // prettier-ignore
    expect(fs.map((x) => [x.checkId, x.tier])).toEqual([
      ['core/safe-area', 'override'],
      ['core/contrast', 'warning'],
      ['core/read-time', 'warning'],
    ]);
  });

  it('is deterministic', () => {
    const t = tl([clip('c1', 0, 7), clip('c2', 7, 17, { sourceIn: f(10) })]);
    expect(JSON.stringify(checkPlan({ timeline: t, sources, beats }))).toBe(
      JSON.stringify(checkPlan({ timeline: structuredClone(t), sources, beats })),
    );
  });
});

describe('gateVerdict and overrides', () => {
  const fs: GateFinding[] = [
    { checkId: 'core/loudness', severity: 'error', tier: 'override', message: 'loud' },
    { checkId: 'core/jump-cut', severity: 'warning', tier: 'warning', message: 'jump' },
  ];

  it('needs an override with a reason for override-tier errors; hard errors never pass', () => {
    expect(gateVerdict(fs)).toMatchObject({ allowed: false, needsOverride: [{ checkId: 'core/loudness' }] });
    expect(gateVerdict(fs, [{ checkId: 'core/loudness', reason: '  ' }]).allowed).toBe(false);
    const ok = gateVerdict(fs, [{ checkId: 'core/loudness', reason: 'the platform normalises' }]);
    expect(ok).toMatchObject({ allowed: true, overridden: [{ reason: 'the platform normalises' }], warnings: [{ checkId: 'core/jump-cut' }] });
    const hard = [...fs, { checkId: 'core/flash-risk', severity: 'error' as const, tier: 'hard' as const, message: 'strobe' }];
    const v = gateVerdict(hard, [{ checkId: 'core/flash-risk', reason: 'art' }, { checkId: 'core/loudness', reason: 'x' }]);
    expect(v.allowed).toBe(false);
    expect(v.blocking.map((x) => x.checkId)).toEqual(['core/flash-risk']);
  }); // prettier-ignore

  it('logs an override as a valid decision record; refuses hard checks and warnings', () => {
    const rec = overrideDecision({
      override: { checkId: 'core/loudness', reason: 'the platform normalises' },
      variantId: 'var_tt',
      planHash: 'h'.repeat(64),
      findings: fs,
      now: new Date('2026-10-28T12:00:00Z'),
    });
    expect(DecisionRecord.parse(rec)).toEqual(rec);
    expect(rec.summary).toMatch(/despite "loudness": the platform normalises/);
    const base = { variantId: 'v', planHash: 'h', findings: fs, now: new Date(0) };
    expect(() =>
      overrideDecision({ ...base, override: { checkId: 'core/flash-risk', reason: 'x' } }),
    ).toThrow(/always blocks/);
    expect(() =>
      overrideDecision({ ...base, override: { checkId: 'core/jump-cut', reason: 'x' } }),
    ).toThrow(/only a warning/);
  });
});
