import { FLICKS_PER_SECOND, Project, flicksPerFrame, type Rate } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  cropInsets,
  cropSize,
  placeCrop,
  reframeClip,
  titleSafe,
  type CropRect,
  type ReframeInput,
  type ReframeResult,
} from './reframe.js';
import { deriveVariant } from './variants.js';

const F = FLICKS_PER_SECOND;
const R30: Rate = { num: 30, den: 1 };
const HD = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };
const SQUARE = { width: 1080, height: 1080 };

/** A subject crossing the frame left to right at `y`, with seeded jitter and a few gaps. */
function crossing(frames: number, seed = 1, opts: { spread?: number; y?: number } = {}) {
  let a = seed;
  const rnd = () => {
    a = (a * 1103515245 + 12345) % 2147483648;
    return a / 2147483648;
  };
  return Array.from({ length: frames }, (_, i) => {
    if (i === 0 || rnd() < 0.05) return null;
    const x = 150 + (700 * i) / (frames - 1) + (rnd() - 0.5) * 20;
    const y = (opts.y ?? 400) + (rnd() - 0.5) * 20;
    return [Math.round(x), Math.round(y), opts.spread ?? 30, opts.spread ?? 30];
  });
}

function input(over: Partial<ReframeInput> = {}): ReframeInput {
  return {
    source: HD,
    target: VERTICAL,
    rate: R30,
    sourceIn: 0,
    duration: 4 * F,
    footage: { rate: R30, focus: crossing(120) },
    ...over,
  };
}

/** The crop at frame k, interpolating the keyframes like the renderer. */
function rectAt(r: ReframeResult, at: number): CropRect {
  const p = r.path;
  if (p.length === 1 || at <= p[0]!.at) return p[0]!.rect;
  for (let i = 1; i < p.length; i++) {
    if (at <= p[i]!.at) {
      const t = (at - p[i - 1]!.at) / (p[i]!.at - p[i - 1]!.at);
      const a = p[i - 1]!.rect;
      const b = p[i]!.rect;
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), w: a.w, h: a.h };
    }
  }
  return p.at(-1)!.rect;
}

const inFrame = (r: CropRect) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;

describe('reframeClip', () => {
  it('sizes the crop to the target shape', () => {
    expect(cropSize(HD, VERTICAL)).toEqual({ w: 0.31640625, h: 1 });
    expect(cropSize(HD, SQUARE)).toEqual({ w: 0.5625, h: 1 });
    expect(cropSize(VERTICAL, HD).w).toBe(1);
    expect(placeCrop({ x: 0.99, y: 0.5 }, { w: 0.3, h: 1 })).toEqual({
      x: 0.7,
      y: 0,
      w: 0.3,
      h: 1,
    });
    expect(cropInsets({ x: 0.25, y: 0, w: 0.5, h: 1 })).toEqual([0.25, 0, 0.25, 0]);
    expect(titleSafe({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  });

  it('follows a moving subject and keeps it in the crop, inside the frame', () => {
    const focus = crossing(120);
    const r = reframeClip(input({ footage: { rate: R30, focus } }));
    expect(r.mode).toBe('crop');
    expect(r.path.length).toBeGreaterThan(2);
    const fpf = flicksPerFrame(R30);
    const first = rectAt(r, 0);
    const last = rectAt(r, 119 * fpf);
    expect(last.x - first.x).toBeGreaterThan(0.4);
    focus.forEach((f, k) => {
      const rect = rectAt(r, k * fpf);
      expect(inFrame(rect)).toBe(true);
      if (f && k > 15) {
        const x = f[0]! / 1000;
        expect(x).toBeGreaterThan(rect.x);
        expect(x).toBeLessThan(rect.x + rect.w);
      }
    });
    for (let i = 1; i < r.path.length; i++)
      expect(r.path[i]!.at).toBeGreaterThan(r.path[i - 1]!.at);
  });

  it('stays inside the frame for any focus, and is deterministic', () => {
    let seed = 7;
    for (let n = 0; n < 200; n++) {
      seed = (seed * 48271) % 2147483647;
      const focus = Array.from({ length: 60 }, (_, i) =>
        ((seed >> (i % 13)) & 3) === 0
          ? null
          : [(seed * (i + 1)) % 1001, (seed >> 3) % 1001, 20, 20],
      );
      const target = n % 2 ? VERTICAL : SQUARE;
      const a = reframeClip(input({ target, duration: 2 * F, footage: { rate: R30, focus } }));
      const b = reframeClip(
        input({ target, duration: 2 * F, footage: { rate: R30, focus: [...focus] } }),
      );
      expect(b).toEqual(a);
      for (const k of a.path) expect(inFrame(k.rect)).toBe(true);
    }
  });

  it('a focus point set by hand wins', () => {
    const r = reframeClip(input({ manual: { x: 0.9, y: 0.5 } }));
    expect(r).toEqual({
      mode: 'crop',
      path: [{ at: 0, rect: { x: 0.6836, y: 0, w: 0.3164, h: 1 } }],
      reason: 'focus point set by hand',
    });
  });

  it('shows a subject wider than the crop whole, over a blurred fill', () => {
    const r = reframeClip(
      input({ footage: { rate: R30, focus: crossing(120, 1, { spread: 120 }) } }),
    );
    expect(r.mode).toBe('fill');
    expect(r.reason).toMatch(/blurred fill/);
    // The same subject fits a square crop's safe area.
    expect(
      reframeClip(
        input({ target: SQUARE, footage: { rate: R30, focus: crossing(120, 1, { spread: 100 }) } }),
      ).mode,
    ).toBe('crop');
  });

  it('holds through pans and stillness, centres without analysis, and leaves the same shape alone', () => {
    const pan = Array.from({ length: 120 }, () => [500, 500, 290, 290]);
    expect(reframeClip(input({ footage: { rate: R30, focus: pan } })).reason).toMatch(/centred/);
    expect(reframeClip({ ...input(), footage: { rate: R30 } }).reason).toBe(
      'not analysed yet: centred',
    );
    expect(reframeClip(input({ target: HD })).mode).toBe('none');
    expect(reframeClip(input({ mode: 'fill' })).mode).toBe('fill');
    const still = Array.from({ length: 120 }, () => [300, 500, 20, 20]);
    const r = reframeClip(input({ footage: { rate: R30, focus: still } }));
    expect(r.path).toHaveLength(1);
    expect(r.reason).toMatch(/fixed crop/);
  });

  it("reads the recording at the clip's source position and speed", () => {
    const focus = crossing(240);
    const late = reframeClip(
      input({ sourceIn: 4 * F, duration: 2 * F, footage: { rate: R30, focus } }),
    );
    expect(late.path[0]!.rect.x).toBeGreaterThan(0.3);
  });

  it('golden crop paths, 16:9 to 9:16 and 1:1', () => {
    const footage = { rate: { num: 60, den: 1 }, focus: crossing(240, 3, { y: 300 }) };
    const paths = Object.fromEntries(
      [
        ['9:16', VERTICAL],
        ['1:1', SQUARE],
      ].map(([name, target]) => [
        name,
        reframeClip(input({ target: target as typeof SQUARE, footage })).path.map((k) => [
          k.at / flicksPerFrame(R30),
          ...cropInsets(k.rect),
        ]),
      ]),
    );
    expect(paths).toMatchSnapshot();
  });
});

describe('deriveVariant reframes clips', () => {
  function project() {
    const p = Project.parse(sampleProject());
    p.timelines[0]!.resolution = HD;
    return p;
  }
  const master = (p: Project) => p.timelines[0]!;

  it('crops clips for a vertical version, following the analysis, and a hand-set point wins', () => {
    const p = project();
    const clip = master(p).tracks[0]!.items.find((i) => i.kind === 'clip')!;
    expect(clip.kind).toBe('clip');
    const assetId = (clip as { assetId: string }).assetId;
    const sources = new Map([
      [
        assetId,
        {
          duration: 60 * F,
          footage: {
            rate: R30,
            frameCount: 1800,
            duration: 60 * F,
            scenes: [],
            black: [],
            flashes: [],
            frozen: [],
            motion: [],
            focus: crossing(1800),
          },
        },
      ],
    ]);
    const d = deriveVariant({
      project: p,
      variantId: 'var_tt',
      masterTimelineId: master(p).id,
      sources,
    });
    const out = d.timeline.tracks[0]!.items.find((i) => i.id === clip.id)!;
    expect(out.kind === 'clip' && out.transform?.crop).toBeTruthy();
    expect((out.extensions.core as { reframe: { mode: string } }).reframe.mode).toBe('crop');
    const rep = d.slots.find((s) => s.slotId === clip.slotId);
    expect(rep?.reframe?.mode).toBe(rep?.fate === 'dropped' ? undefined : 'crop');

    p.storyboard!.variants[0]!.overrides[clip.slotId!] = { cropCenter: { x: 0.2, y: 0.5 } };
    const manual = deriveVariant({
      project: p,
      variantId: 'var_tt',
      masterTimelineId: master(p).id,
      sources,
    });
    const m = manual.timeline.tracks[0]!.items.find((i) => i.id === clip.id)!;
    expect(m.kind === 'clip' && m.transform?.crop).toEqual(
      cropInsets(placeCrop({ x: 0.2, y: 0.5 }, cropSize(HD, VERTICAL))),
    );

    p.storyboard!.variants[0]!.reframe = { mode: 'fill' };
    const filled = deriveVariant({
      project: p,
      variantId: 'var_tt',
      masterTimelineId: master(p).id,
      sources,
    });
    const f = filled.timeline.tracks[0]!.items.find((i) => i.id === clip.id)!;
    expect(f.extensions.core).toMatchObject({ reframe: { mode: 'fill', background: 'blur' } });
  });
});
