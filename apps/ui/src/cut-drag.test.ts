import { planDrag, snapTargets } from '@trailerforge/cut';
import { Timeline, flicksPerFrame } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { dragNote, planKeyMove } from './cut-drag.js';

const R = { num: 30, den: 1 };
const fr = (n: number) => n * flicksPerFrame(R);
const tl = Timeline.parse({
  id: 'tl', name: 'T', frameRate: R, resolution: { width: 1920, height: 1080 },
  tracks: [{ id: 'v1', kind: 'video', name: 'Picture', items: [
    { id: 'a', kind: 'placeholder', label: 'Parry', start: 0, duration: fr(60), reason: 'missing-footage' },
    { id: 'b', kind: 'placeholder', label: 'Boss', start: fr(60), duration: fr(60), reason: 'missing-footage' },
    { id: 'c', kind: 'placeholder', label: 'Fall', start: fr(150), duration: fr(60), reason: 'missing-footage' },
  ] }],
  markers: [{ id: 'm', at: fr(135), kind: 'downbeat' }],
}); // prettier-ignore
const item = (id: string) => tl.tracks[0]!.items.find((i) => i.id === id)!;

describe('drag notes', () => {
  it('says where it lands, what it snapped to and what moves along', () => {
    const targets = snapTargets(tl, null, { exclude: 'c' });
    const p = planDrag({ timeline: tl, itemId: 'c', mode: 'move', delta: -fr(15) - 5000, snap: { targets, threshold: fr(2) } }); // prettier-ignore
    expect(dragNote(p, item('c'), R, { mode: 'move', ripple: false })).toBe('Move "Fall": 0:04.14 to 0:06.14, on a bar.'); // prettier-ignore
    const r = planDrag({
      timeline: tl,
      itemId: 'b',
      mode: 'trim-out',
      delta: fr(10),
      ripple: true,
    });
    expect(dragNote(r, item('b'), R, { mode: 'trim-out', ripple: true })).toBe('Ripple trim the end "Boss": 0:02.00 to 0:04.10; 1 later clip moves along.'); // prettier-ignore
    const no = planDrag({ timeline: tl, itemId: 'b', mode: 'move', delta: fr(40) });
    expect(dragNote(no, item('b'), R, { mode: 'move', ripple: false })).toBe('Can\'t drop "Boss" there: it would overlap "Fall".'); // prettier-ignore
  });

  it('arrow keys move by a frame, or with Shift to the next musical target', () => {
    const targets = snapTargets(tl, null, { exclude: 'c' });
    const step = planKeyMove(tl, item('c'), 1, { toBeat: false, ripple: false, targets });
    expect(step.ok && step.start).toBe(fr(151));
    const beat = planKeyMove(tl, item('c'), -1, { toBeat: true, ripple: false, targets });
    expect(beat.ok && beat.start).toBe(fr(134));
    const ripple = planKeyMove(tl, item('b'), -1, { toBeat: false, ripple: true, targets });
    expect(ripple).toMatchObject({ ok: false }); // b cannot go left: a is in the way
  });
});
