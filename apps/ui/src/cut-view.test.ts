import { Timeline } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  rebuildSummary,
  F,
  applySourceEdit,
  canTrim,
  captionAt,
  cutPointFor,
  deltaToBeat,
  fadeOutOf,
  fitSourceIn,
  heldPastEnd,
  itemAt,
  musicLengthPlan,
  pictureAt,
  planLength,
  planSourceEdit,
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

describe('planSourceEdit', () => {
  const clip = { duration: 30 * FPF, sourceIn: 10 * FPF, speed: 1 };
  const len = 100 * FPF;

  it('slips on the frame grid and stays inside the recording', () => {
    expect(planSourceEdit(clip, 'slip', 5.4 * FPF, len, RATE)).toEqual({
      sourceDelta: 5 * FPF,
      timelineDelta: 0,
    });
    expect(planSourceEdit(clip, 'slip', -50 * FPF, len, RATE).sourceDelta).toBe(-10 * FPF);
    expect(planSourceEdit(clip, 'slip', 500 * FPF, len, RATE).sourceDelta).toBe(60 * FPF);
  });

  it('trims the start no earlier than the recording and leaves a frame', () => {
    expect(planSourceEdit(clip, 'in', -20 * FPF, len, RATE).timelineDelta).toBe(-10 * FPF);
    expect(planSourceEdit(clip, 'in', 40 * FPF, len, RATE).timelineDelta).toBe(29 * FPF);
  });

  it('trims the end no later than the recording', () => {
    expect(planSourceEdit(clip, 'out', 200 * FPF, len, RATE).timelineDelta).toBe(60 * FPF);
    expect(planSourceEdit(clip, 'out', 200 * FPF, null, RATE).timelineDelta).toBe(200 * FPF);
    expect(planSourceEdit(clip, 'out', -40 * FPF, len, RATE).timelineDelta).toBe(-29 * FPF);
  });

  it('turns source time into timeline time by the clip speed', () => {
    const fast = { ...clip, speed: 2 };
    expect(planSourceEdit(fast, 'out', 10 * FPF, len, RATE)).toEqual({
      sourceDelta: 10 * FPF,
      timelineDelta: 5 * FPF,
    });
  });
});

describe('applySourceEdit', () => {
  const clip = { duration: 30 * FPF, sourceIn: 10 * FPF, speed: 1 };
  it('moves the start, the end or the whole window inside the recording', () => {
    expect(applySourceEdit(clip, 'in', 4 * FPF, 100 * FPF, RATE)).toEqual({
      duration: 26 * FPF,
      sourceIn: 14 * FPF,
      speed: 1,
    });
    expect(applySourceEdit(clip, 'out', 100 * FPF, 100 * FPF, RATE).duration).toBe(90 * FPF);
    expect(applySourceEdit(clip, 'slip', -3 * FPF, 100 * FPF, RATE)).toMatchObject({
      sourceIn: 7 * FPF,
      duration: 30 * FPF,
    });
  });
});

describe('planLength', () => {
  const edit = Timeline.parse({
    ...tl,
    tracks: [
      {
        id: 'v',
        kind: 'video',
        items: [
          { id: 'a', kind: 'clip', start: 0, duration: 2 * F, assetId: 'x', sourceIn: 0 },
          { id: 'b', kind: 'clip', start: 2 * F, duration: 2 * F, assetId: 'y', sourceIn: F },
          { id: 'c', kind: 'clip', start: 5 * F, duration: F, assetId: 'z', sourceIn: 0 },
        ],
      },
    ],
  });

  it('takes the time from the shot right after it, on the frame grid', () => {
    expect(planLength(edit, 'a', 2.5 * F + 1, 'roll')).toEqual({
      ok: true,
      type: 'core/timeline.roll',
      payload: { timelineId: 'tl', itemId: 'a', delta: F / 2 },
    });
    expect(planLength(edit, 'a', 2 * F, 'roll')).toBeNull();
  });

  it('says why when the next shot would vanish or has no earlier footage', () => {
    expect(planLength(edit, 'a', 4 * F, 'roll')).toMatchObject({ ok: false });
    expect(planLength(edit, 'a', 3.5 * F, 'roll')).toMatchObject({ ok: true });
    // Shorter: the next shot starts earlier and needs footage from before its start.
    expect(planLength(edit, 'a', 0.5 * F, 'roll')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no earlier footage'),
    });
  });

  it('grows into a gap, refuses to run into the next item, and ripples on request', () => {
    expect(planLength(edit, 'b', 2.5 * F, 'roll')).toMatchObject({
      ok: true,
      type: 'core/timeline.trim',
      payload: { edge: 'out', delta: F / 2, ripple: false },
    });
    expect(planLength(edit, 'b', 4 * F, 'roll')).toMatchObject({ ok: false });
    expect(planLength(edit, 'b', 4 * F, 'ripple')).toMatchObject({
      ok: true,
      payload: { delta: 2 * F, ripple: true },
    });
    expect(planLength(edit, 'a', 0, 'roll')).toMatchObject({ ok: false });
  });

  it('measures how long a clip outruns its recording', () => {
    const a = edit.tracks[0]!.items[0]!;
    expect(heldPastEnd(a, 1.5 * F)).toBe(F / 2);
    expect(heldPastEnd(a, 10 * F)).toBe(0);
    expect(heldPastEnd(a, null)).toBe(0);
  });
});

describe('music length', () => {
  const music = {
    id: 'rc_music',
    kind: 'clip' as const,
    start: 0,
    duration: 8 * F,
    assetId: 'song',
    sourceIn: 0,
    speed: 1,
    effects: [],
    muted: false,
    extensions: {},
    gainDb: {
      keyframes: [
        { at: 6 * F, value: 0, easing: 'linear' as const },
        { at: 8 * F, value: -60, easing: 'linear' as const },
      ],
    },
  };
  const bars = [0, 2 * F, 4 * F, 6 * F, 8 * F, 10 * F, 12 * F];

  it('reads the fade-out length', () => {
    expect(fadeOutOf(music)).toBe(2 * F);
    expect(fadeOutOf({ ...music, gainDb: 0 })).toBe(0);
  });

  it('steps a bar either way, stops at the end of the song, and knows where the picture ends', () => {
    expect(musicLengthPlan(tl, music, bars, 11 * F)).toEqual({
      shorter: 6 * F,
      longer: 10 * F,
      toSongEnd: 11 * F,
      pictureEnd: 8 * F,
    });
    expect(musicLengthPlan(tl, { ...music, duration: 10 * F }, bars, 11 * F).longer).toBe(11 * F);
    expect(musicLengthPlan(tl, { ...music, duration: 11 * F }, bars, 11 * F).longer).toBeNull();
    expect(musicLengthPlan(tl, music, bars, null).toSongEnd).toBeNull();
  });
});

describe('rebuildSummary', () => {
  it('says what a rebuild kept and what the storyboard replaced', () => {
    expect(rebuildSummary(0, [])).toBeNull();
    expect(rebuildSummary(1, [])).toMatch(/^Kept 1 clip you edited by hand as you left it;/);
    expect(rebuildSummary(2, [{ title: 'Parry' }])).toMatch(
      /Kept 2 clips .* them; .* Made "Parry" again from the storyboard/,
    );
  });
});
