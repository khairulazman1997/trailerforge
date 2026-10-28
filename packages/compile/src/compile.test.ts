import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Timeline, framesToFlicks, rate, type TimelineItem } from '@trailerforge/schema';
import { compileRender, cropPath, esc, piecewise, type SourceMedia } from './compile.js';
import { sha256 } from './sha256.js';

const R = rate(24);
const f = (frames: number) => framesToFlicks(frames, R);

export const src = (path: string, hash: string, extra: Partial<SourceMedia> = {}): SourceMedia => ({
  path,
  contentHash: hash.padEnd(64, '0'),
  width: 320,
  height: 180,
  frameRate: rate(30),
  duration: 3,
  hasAudio: false,
  ...extra,
});

const clip = (id: string, start: number, frames: number, assetId: string, extra: object = {}) =>
  ({
    id,
    kind: 'clip',
    start: f(start),
    duration: f(frames),
    assetId,
    sourceIn: 0,
    ...extra,
  }) as TimelineItem;

export function timeline(items: TimelineItem[], res = { width: 160, height: 90 }): Timeline {
  return Timeline.parse({
    id: 'tl_test',
    name: 'Test',
    frameRate: R,
    resolution: res,
    tracks: [{ id: 'trk_v', kind: 'video', items }],
  });
}

describe('sha256', () => {
  it('matches Node for short, block-edge and long inputs', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ü€😀'.repeat(300)])
      expect(sha256(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

describe('compileRender', () => {
  const sources = new Map([
    ['a1', src('/m/a.mp4', 'aa')],
    ['a2', src('/m/b.mp4', 'bb')],
  ]);
  const items = [
    clip('i1', 0, 24, 'a1', { sourceIn: f(12) }),
    { id: 'p1', kind: 'placeholder', start: f(24), duration: f(12), reason: 'missing-footage' },
    clip('i2', 36, 24, 'a2', { speed: 2 }),
  ] as TimelineItem[];

  it('gives a stable plan; the hash ignores paths and item order, not content', () => {
    const plan = compileRender({ timeline: timeline(items), sources });
    expect(plan.filtergraph).toMatchSnapshot();
    expect(plan.inputs.map((i) => [i.seek, i.duration])).toEqual([
      ['0.483333', '1.133334'],
      ['0', '2.133334'],
    ]);
    expect(plan.range).toEqual({ start: 0, frames: 60 });
    const again = compileRender({ timeline: timeline([...items].reverse()), sources });
    expect(again.planHash).toBe(plan.planHash);
    const moved = new Map([...sources].map(([k, v]) => [k, { ...v, path: `/elsewhere${v.path}` }]));
    expect(compileRender({ timeline: timeline(items), sources: moved }).planHash).toBe(
      plan.planHash,
    );
    const changed = new Map(sources);
    changed.set('a2', src('/m/b.mp4', 'cc'));
    expect(compileRender({ timeline: timeline(items), sources: changed }).planHash).not.toBe(
      plan.planHash,
    );
  });

  it('renders a range with only the clips it touches, seeking into them', () => {
    const plan = compileRender({
      timeline: timeline(items),
      sources,
      range: { start: 42, frames: 12 },
    });
    expect(plan.inputs.map((i) => i.assetId)).toEqual(['a2']);
    // 6 frames into i2 at 2x speed: 0.5 s into the recording, half a source frame early.
    expect(plan.inputs[0]!.seek).toBe('0.483333');
    expect(plan.filtergraph).toContain('trim=end_frame=12');
  });

  it('draws missing recordings as slates and warns', () => {
    const plan = compileRender({ timeline: timeline(items), sources: new Map() });
    expect(plan.inputs).toEqual([]);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.filtergraph.match(/0x1f2933/g)).toHaveLength(3);
  });

  it('escapes slate labels and font paths', () => {
    const plan = compileRender({
      timeline: timeline([{ ...items[1]!, label: "Boss: it's [big], ok;" } as TimelineItem]),
      sources,
      slateFont: { path: 'C:\\fonts\\Inter.ttf', contentHash: 'f'.repeat(64) },
    });
    expect(plan.filtergraph).toContain(`text=${esc("Boss: it's [big], ok;")}`);
    expect(plan.filtergraph).toContain(`fontfile=${esc('C:\\fonts\\Inter.ttf')}`);
  });
});

describe('crop expressions', () => {
  it('interpolates linearly between keyframes and holds outside', () => {
    expect(piecewise([{ f: 0, v: 10 }])).toBe('10');
    expect(
      piecewise([
        { f: 0, v: 0 },
        { f: 10, v: 20 },
      ]),
    ).toBe('if(lt(n,10),0+(n-0)*2,20)');
  });

  it('samples keyframes on the frame grid, shifted by a skip', () => {
    const fpf = f(1);
    const anim = {
      keyframes: [
        { at: 0, value: [0, 0, 0.5, 0], easing: 'linear' as const },
        { at: f(10), value: [0.5, 0, 0, 0], easing: 'hold' as const },
        { at: f(20), value: [0.25, 0, 0.25, 0], easing: 'linear' as const },
      ],
    };
    expect(cropPath(anim, f(30), 0, fpf).map((p) => [p.f, p.v[0]])).toEqual([
      [0, 0],
      [10, 0.5],
      [19, 0.5],
      [20, 0.25],
    ]);
    expect(cropPath(anim, f(30), 5, fpf).map((p) => [p.f, p.v[0]])).toEqual([
      [0, 0.25],
      [5, 0.5],
      [14, 0.5],
      [15, 0.25],
    ]);
  });
});

describe('plan hash (seeded property test)', () => {
  it('is a function of the content, over 200 random timelines', () => {
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % k;
    };
    const sources = new Map([
      ['a1', src('/m/a.mp4', 'aa')],
      ['a2', src('/m/b.mp4', 'bb', { variableFrameRate: true })],
    ]);
    for (let c = 0; c < 200; c++) {
      const its: TimelineItem[] = [];
      let at = rnd(5);
      for (let i = 0; i < 1 + rnd(6); i++) {
        const len = 1 + rnd(40);
        its.push(
          rnd(4) === 0
            ? ({ id: `p${i}`, kind: 'placeholder', start: f(at), duration: f(len), reason: 'missing-footage' } as TimelineItem)
            : clip(`c${i}`, at, len, rnd(2) ? 'a1' : 'a2', { sourceIn: f(rnd(30)), speed: [1, 2, 0.5][rnd(3)] }),
        ); // prettier-ignore
        at += len + rnd(3);
      }
      const a = compileRender({ timeline: timeline(its), sources });
      const b = compileRender({ timeline: timeline([...its].reverse()), sources });
      expect(b.planHash).toBe(a.planHash);
      expect(b.filtergraph).toBe(a.filtergraph);
      const last = its[its.length - 1]!;
      const longer = its.map((it) => (it === last ? { ...it, duration: it.duration + f(1) } : it));
      expect(compileRender({ timeline: timeline(longer), sources }).planHash).not.toBe(a.planHash);
    }
  });
});
