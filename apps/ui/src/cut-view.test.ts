import { Timeline } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  F,
  canTrim,
  captionAt,
  cutPointFor,
  deltaToBeat,
  fitSourceIn,
  itemAt,
  pictureAt,
  timecode,
  transformStyle,
} from './cut-view.js';

const RATE = { num: 30, den: 1 };
const FPF = F / 30;
const tl = Timeline.parse({
  id: 'tl',
  name: 't',
  frameRate: RATE,
  resolution: { width: 1920, height: 1080 },
  tracks: [
    {
      id: 'g',
      kind: 'graphics',
      items: [
        {
          id: 'card',
          kind: 'graphic',
          start: 6 * F,
          duration: 2 * F,
          templateId: 'core/end-slate',
        },
      ],
    },
    {
      id: 'v',
      kind: 'video',
      items: [
        { id: 'a', kind: 'clip', start: 0, duration: 3 * F, assetId: 'x', sourceIn: F },
        { id: 'b', kind: 'placeholder', start: 3 * F, duration: 3 * F, reason: 'missing-footage' },
      ],
    },
    {
      id: 'm',
      kind: 'audio',
      items: [{ id: 'mu', kind: 'clip', start: 0, duration: 8 * F, assetId: 'song', sourceIn: 0 }],
    },
  ],
});

describe('cut view helpers', () => {
  it('formats timecode in frames', () => {
    expect(timecode(0, RATE)).toBe('0:00.00');
    expect(timecode(61.5 * F, RATE)).toBe('1:01.15');
    expect(timecode(F / 30, RATE)).toBe('0:00.01');
  });

  it('finds the picture at a time, skipping audio, with end exclusive', () => {
    expect(pictureAt(tl, 0)?.id).toBe('a');
    expect(pictureAt(tl, 3 * F)?.id).toBe('b');
    expect(pictureAt(tl, 6.5 * F)?.id).toBe('card');
    expect(pictureAt(tl, 9 * F)).toBeUndefined();
    expect(itemAt(tl.tracks[2]!.items, 7 * F)?.id).toBe('mu');
  });

  it('finds the on-screen text at a time, and none on a muted caption track', () => {
    const withCaps = Timeline.parse({
      ...tl,
      tracks: [
        ...tl.tracks,
        {
          id: 'c',
          kind: 'caption',
          items: [
            { id: 'c1', kind: 'caption', start: F, duration: F, text: 'Parry!' },
            {
              id: 'c2',
              kind: 'caption',
              start: 3 * F,
              duration: F,
              text: 'The Ash Warden',
              styleId: 'core/lower-third',
            },
          ],
        },
      ],
    });
    expect(captionAt(withCaps, 0)).toBeUndefined();
    expect(captionAt(withCaps, 1.5 * F)).toEqual({ text: 'Parry!', styleId: undefined });
    expect(captionAt(withCaps, 3 * F)?.styleId).toBe('core/lower-third');
    const muted = { tracks: withCaps.tracks.map((t) => ({ ...t, muted: t.kind === 'caption' })) };
    expect(captionAt(muted, 1.5 * F)).toBeUndefined();
  });

  it('moves an edge to the next or previous beat, one frame ahead of it', () => {
    const beats = [0, 0.5, 1, 1.5, 2].map((s) => Math.round(s * F));
    expect(cutPointFor(F, RATE)).toBe(F - FPF);
    expect(deltaToBeat(F - FPF, beats, 'next', RATE)).toBe(0.5 * F);
    expect(deltaToBeat(F - FPF, beats, 'previous', RATE)).toBe(-0.5 * F);
    expect(deltaToBeat(2 * F, beats, 'next', RATE)).toBeNull();
    expect(deltaToBeat(-F, beats, 'previous', RATE)).toBeNull();
  });

  it('knows which trims leave a valid clip', () => {
    const a = tl.tracks[1]!.items[0]!;
    expect(canTrim(a, 'out', -FPF, RATE)).toBe(true);
    expect(canTrim(a, 'out', -3 * F, RATE)).toBe(false); // nothing left
    expect(canTrim(a, 'in', -FPF, RATE)).toBe(false); // before the start
    expect(canTrim(a, 'in', 2 * F, RATE)).toBe(true);
    expect(canTrim(a, 'in', -2 * F, RATE)).toBe(false);
  });

  it('keeps a replacement take inside its length', () => {
    expect(fitSourceIn(5 * F, 2 * F, 6 * F)).toBe(4 * F);
    expect(fitSourceIn(F, 2 * F, 6 * F)).toBe(F);
    expect(fitSourceIn(F, 2 * F, null)).toBe(0);
    expect(fitSourceIn(F, 9 * F, 6 * F)).toBe(0);
  });
});

describe('transformStyle', () => {
  const clip = (transform?: object) =>
    Timeline.parse({
      id: 'tl',
      name: 'T',
      frameRate: RATE,
      resolution: { width: 1920, height: 1080 },
      tracks: [{ id: 'v', kind: 'video', items: [{ id: 'c', kind: 'clip', start: F, duration: 2 * F, assetId: 'a', sourceIn: 0, ...(transform ? { transform } : {}) }] }],
    }).tracks[0]!.items[0]!; // prettier-ignore

  it('shows nothing for no transform or the identity', () => {
    expect(transformStyle(clip(), F)).toBeUndefined();
    expect(transformStyle(clip({}), F)).toBeUndefined();
  });

  it('scales about the anchor and moves it onto the position, in clip time', () => {
    expect(transformStyle(clip({ position: [0.25, 0.25], scale: 0.5 }), F)).toEqual({
      transform: 'translate(-25%, -25%) scale(0.5)',
      transformOrigin: '50% 50%',
      opacity: 1,
    });
    const fade = clip({
      opacity: {
        keyframes: [
          { at: 0, value: 0 },
          { at: F, value: 1 },
        ],
      },
    });
    expect(transformStyle(fade, 1.5 * F)?.opacity).toBeCloseTo(0.5);
    expect(transformStyle(fade, 2.5 * F)).toBeUndefined();
  });
});
