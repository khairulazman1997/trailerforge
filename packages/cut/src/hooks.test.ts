import { secondsToFlicks as s, Timeline, type Storyboard } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { deriveHook, hookSlotOf } from './hooks.js';

const take = (id: string, assetId: string, extra = {}) => ({
  id,
  assetId,
  matchedBy: 'manual',
  rejected: false,
  note: '',
  attachedAt: '2026-11-05T00:00:00.000Z',
  ...extra,
});
const slot = (id: string, extra = {}) => ({
  kind: 'shot',
  id,
  title: id,
  purpose: '',
  duration: { min: 1, ideal: 2, max: 3 },
  priority: 'must',
  effects: [],
  audioNotes: '',
  status: 'recorded',
  takes: [],
  overlays: [],
  tags: [],
  entityIds: [],
  alternates: [],
  ...extra,
});
const sb = {
  sections: [
    {
      id: 'sec_hook',
      name: 'Hook',
      role: 'hook',
      locked: false,
      slots: [
        slot('hook', {
          takes: [take('t1', 'a1'), take('t2', 'a2', { sourceIn: s(1) })],
          overlays: [{ id: 'ov', templateId: 'core/caption', text: 'Original', offset: 0, duration: 2, params: {} }], // prettier-ignore
        }),
      ],
    },
    { id: 'sec_body', name: 'Body', role: 'body', locked: false, slots: [slot('b1')] },
  ],
} as unknown as Pick<Storyboard, 'sections'>;
const clip = (id: string, slotId: string, start: number, d: number, assetId: string) => ({
  id,
  kind: 'clip',
  start: s(start),
  duration: s(d),
  assetId,
  slotId,
  sourceIn: 0,
  speed: 1,
  gainDb: 0,
  muted: false,
  effects: [],
  extensions: {}, // prettier-ignore
});
const timeline = Timeline.parse({
  id: 'tl_short_x',
  name: 'x',
  frameRate: { num: 30, den: 1 },
  resolution: { width: 1080, height: 1920 },
  tracks: [
    { id: 'trk_picture', kind: 'video', name: 'Picture', muted: false, locked: false, transitions: [],
      items: [clip('rc_hook', 'hook', 0, 2, 'a1'), clip('rc_b1', 'b1', 2, 3, 'a3')] }, // prettier-ignore
  ],
});
const src = (d: number) => ({ duration: s(d) });

describe('hook versions', () => {
  it('finds the opening shot', () => {
    expect(hookSlotOf(sb)?.id).toBe('hook');
    expect(hookSlotOf({ sections: [] })).toBeUndefined();
  });

  it('swaps the take and the text of the opening only; the length and the body stay', () => {
    const r = deriveHook({
      timeline,
      storyboard: sb,
      hook: { id: 'b', name: 'Question', caption: 'Can you parry this?', takeId: 't2' },
      sources: new Map([['a2', src(10)], ['a3', src(10)]]), // prettier-ignore
    });
    const items = r.timeline.tracks.find((t) => t.id === 'trk_picture')!.items as { id: string; assetId: string; sourceIn: number; start: number; duration: number }[]; // prettier-ignore
    expect(items[0]).toMatchObject({ id: 'rc_hook', assetId: 'a2', sourceIn: s(1), start: 0, duration: s(2) }); // prettier-ignore
    expect(items[1]).toEqual(timeline.tracks[0]!.items[1]);
    const caps = r.timeline.tracks.find((t) => t.id === 'trk_captions')!.items as { text: string; start: number; duration: number }[]; // prettier-ignore
    expect(caps.map((c) => c.text)).toEqual(['Can you parry this?']);
    expect(caps[0]).toMatchObject({ start: 0, duration: s(2) });
    expect(r.warnings).toEqual([]);
  });

  it('no caption means no text; a take that is gone or too short is said so; derivation is pure', () => {
    const none = deriveHook({ timeline, storyboard: sb, hook: { id: 'a', name: 'Cold open', caption: '' } }); // prettier-ignore
    expect(none.timeline.tracks.some((t) => t.id === 'trk_captions')).toBe(false);
    expect(none.timeline.tracks[0]).toEqual(timeline.tracks[0]);
    const gone = deriveHook({ timeline, storyboard: sb, hook: { id: 'a', name: 'X', caption: 'Hi', takeId: 'zz' } }); // prettier-ignore
    expect(gone.warnings.join(' ')).toMatch(/no longer on the opening shot/);
    const short = deriveHook({ timeline, storyboard: sb, hook: { id: 'a', name: 'X', caption: 'Hi', takeId: 't2' }, sources: new Map([['a2', src(1.5)]]) }); // prettier-ignore
    expect(short.warnings.join(' ')).toMatch(/shorter than the opening/);
    expect(sb.sections[0]!.slots[0]).toMatchObject({ overlays: [{ text: 'Original' }] });
  });
});
