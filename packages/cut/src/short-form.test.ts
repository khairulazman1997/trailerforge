import { secondsToFlicks as s, Timeline } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { GATE_POLICY, checkShortForm } from './quality.js';
import type { TakeSource } from './rough-cut.js';

const base = { speed: 1, gainDb: 0, muted: false, effects: [], extensions: {} };
const clip = (id: string, a: string, start: number, d: number, extra: object = {}) => ({
  id, kind: 'clip', assetId: a, start: s(start), duration: s(d), sourceIn: 0, ...base, ...extra,
}); // prettier-ignore
const card = (id: string, slotId: string, start: number, d: number) => ({
  id, kind: 'graphic', templateId: 'core/cta-card', params: {}, slotId, start: s(start), duration: s(d),
  effects: [], extensions: {},
}); // prettier-ignore
const tl = (tracks: object[]) =>
  Timeline.parse({
    id: 'tl_short_x',
    name: 'x',
    frameRate: { num: 30, den: 1 },
    resolution: { width: 1080, height: 1920 },
    tracks: tracks.map((t, i) => ({
      name: `t${i}`,
      muted: false,
      locked: false,
      transitions: [],
      ...t,
    })),
  });
const picture = (items: object[]) => ({ id: 'trk_picture', kind: 'video', items });
const footage = (motion: number[]): TakeSource => ({
  duration: s(10),
  footage: { rate: { num: 30, den: 1 }, frameCount: 300, duration: s(10), scenes: [], black: [], flashes: [], frozen: [], motion, } as never, // prettier-ignore
});
const ids = (f: { checkId: string }[]) => f.map((x) => x.checkId);

describe('short-form checks', () => {
  it('are all warnings', () => {
    for (const id of ['first-frame', 'first-cut', 'dead-air', 'loop-end', 'cta-end'])
      expect(GATE_POLICY[`short/${id}`]).toBe('warning');
  });

  it('first frame: footage that is still warns; moving footage, words, or a moving image pass', () => {
    const t = tl([picture([clip('a', 'a1', 0, 1.5), clip('b', 'a2', 1.5, 1)])]);
    const still = checkShortForm({
      timeline: t,
      sources: new Map([['a1', footage(Array(300).fill(0))]]),
    });
    expect(ids(still)).toEqual(['short/first-frame']);
    expect(still[0]).toMatchObject({ severity: 'warning', itemId: 'a' });
    const moving = checkShortForm({
      timeline: t,
      sources: new Map([['a1', footage(Array(300).fill(20))]]),
    });
    expect(moving).toEqual([]);
    // Unknown footage: no opinion.
    expect(checkShortForm({ timeline: t })).toEqual([]);
    // Words over the first frame pass whatever is behind them.
    const words = tl([picture([clip('a', 'a1', 0, 1.5), clip('b', 'a2', 1.5, 1)]), { id: 'trk_captions', kind: 'caption', items: [{ id: 'c', kind: 'caption', start: 0, duration: s(1.5), label: 'Hi', text: 'Hi', extensions: {} }] }]); // prettier-ignore
    expect(
      checkShortForm({ timeline: words, sources: new Map([['a1', footage(Array(300).fill(0))]]) }),
    ).toEqual([]);
    // A still image: static warns, a push-in passes.
    const img = new Map<string, TakeSource>([['a1', { duration: s(3600), still: true }]]);
    expect(ids(checkShortForm({ timeline: t, sources: img }))).toEqual(['short/first-frame']);
    const move = tl([picture([clip('a', 'a1', 0, 1.5, { transform: { scale: { keyframes: [{ at: 0, value: 1, easing: 'linear' }, { at: s(1.5), value: 1.2, easing: 'linear' }] } } }), clip('b', 'a2', 1.5, 1)])]); // prettier-ignore
    expect(checkShortForm({ timeline: move, sources: img })).toEqual([]);
  });

  it('first cut: later than two seconds warns, a single shot does not', () => {
    const late = tl([picture([clip('a', 'a1', 0, 2.6), clip('b', 'a2', 2.6, 1)])]);
    expect(checkShortForm({ timeline: late })).toMatchObject([
      { checkId: 'short/first-cut', at: { start: 2.6 } },
    ]);
    const one = tl([picture([clip('a', 'a1', 0, 6)])]);
    expect(ids(checkShortForm({ timeline: one }))).toEqual(['short/dead-air']);
  });

  it('dead air: a long shot with no voice warns; the voice over it clears it', () => {
    const quiet = tl([picture([clip('a', 'a1', 0, 1.5), clip('b', 'a2', 1.5, 4)])]);
    expect(checkShortForm({ timeline: quiet })).toMatchObject([
      { checkId: 'short/dead-air', itemId: 'b' },
    ]);
    const spoken = tl([picture([clip('a', 'a1', 0, 1.5), clip('b', 'a2', 1.5, 4)]), { id: 'trk_voice', kind: 'audio', items: [clip('v', 'v1', 1.5, 3.5)] }]); // prettier-ignore
    expect(checkShortForm({ timeline: spoken })).toEqual([]);
  });

  it('loop end: a music fade-out warns, unless the video ends on its call to action', () => {
    const fade = {
      gainDb: {
        keyframes: [
          { at: s(2), value: 0, easing: 'linear' },
          { at: s(3), value: -60, easing: 'linear' },
        ],
      },
    };
    const mk = (extraPic: object[]) =>
      tl([picture([clip('a', 'a1', 0, 1.5), clip('b', 'a2', 1.5, 1.5), ...extraPic]), { id: 'trk_music', kind: 'audio', items: [clip('m', 'mu', 0, 3, fade)] }]); // prettier-ignore
    expect(checkShortForm({ timeline: mk([]) })).toMatchObject([
      { checkId: 'short/loop-end', at: { start: 2, end: 3 } },
    ]);
    const withCta = mk([]);
    withCta.tracks[0]!.items[1] = {
      ...(withCta.tracks[0]!.items[1] as object),
      slotId: 'cta1',
    } as never;
    expect(checkShortForm({ timeline: withCta, ctaSlotIds: ['cta1'] })).toEqual([]);
  });

  it('call to action: must be on screen in the last three seconds when the format has one', () => {
    const at = (cta: number) => tl([picture([clip('a', 'a1', 0, 2), clip('b', 'a2', 2, 4)]), { id: 'trk_cards', kind: 'graphics', items: [card('c', 'cta1', cta, 1.5)] }]); // prettier-ignore
    const early = checkShortForm({ timeline: at(1), ctaSlotIds: ['cta1'] });
    expect(early.map((f) => f.checkId)).toContain('short/cta-end');
    expect(ids(checkShortForm({ timeline: at(4.5), ctaSlotIds: ['cta1'] }))).not.toContain(
      'short/cta-end',
    );
    expect(ids(checkShortForm({ timeline: at(1) }))).not.toContain('short/cta-end'); // no call to action in this format
  });
});

describe('plannedDark', () => {
  it('covers the fade-in and fade-out of full-frame cards only', async () => {
    const { plannedDark } = await import('./quality.js');
    const t = tl([
      picture([clip('a', 'a1', 0, 2)]),
      { id: 'trk_cards', kind: 'graphics', items: [card('c', 'cta1', 2, 2)] },
    ]);
    expect(plannedDark(t, (i) => i.kind === 'graphic')).toEqual([
      { start: 2, end: 2.5 },
      { start: 3.6, end: 4 },
    ]);
    expect(plannedDark(t, () => false)).toEqual([]);
  });
});
