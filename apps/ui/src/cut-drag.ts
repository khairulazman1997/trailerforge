import { planDrag, type DragMode, type DragPlan, type SnapTarget } from '@trailerforge/cut';
import { flicksPerFrame, type Rate, type Timeline, type TimelineItem } from '@trailerforge/schema';
import { kindLabel, timecode } from './cut-view.js';

/** Pointer travel (px) before a press on a clip counts as a drag rather than a click. */
export const DRAG_SLOP_PX = 3;
/** How close (px) an edge has to come to a target to snap to it. */
export const SNAP_PX = 8;

const KIND_WORD: Record<SnapTarget['kind'], string> = {
  playhead: 'the playhead',
  section: 'a section',
  bar: 'a bar',
  beat: 'a beat',
  edge: 'a clip edge',
};

const nameOf = (item: TimelineItem) => item.label ?? kindLabel(item);

const verb = (mode: DragMode, ripple: boolean) =>
  `${ripple ? 'Ripple ' : ''}${mode === 'move' ? 'move' : mode === 'trim-in' ? 'trim the start' : 'trim the end'}`;

/** What a drag would do, said in words (shown while dragging and after the drop). */
export function dragNote(
  plan: DragPlan,
  item: TimelineItem,
  rate: Rate,
  o: { mode: DragMode; ripple: boolean; trackName?: string },
): string {
  if (!plan.ok) return `Can't drop "${nameOf(item)}" there: ${plan.reason}.`;
  if (!plan.command) return `"${nameOf(item)}" stays where it is.`;
  const where = `${timecode(plan.start, rate)} to ${timecode(plan.end, rate)}`;
  const on = plan.snapped ? `, on ${KIND_WORD[plan.snapped.kind]}` : '';
  const track = o.trackName ? ` on ${o.trackName}` : '';
  const moved = plan.shifted.length
    ? `; ${plan.shifted.length} later clip${plan.shifted.length === 1 ? '' : 's'} move${plan.shifted.length === 1 ? 's' : ''} along`
    : '';
  const held = plan.clamped ? ' (as far as it goes)' : '';
  const text = `${verb(o.mode, o.ripple)} "${nameOf(item)}": ${where}${track}${on}${held}${moved}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The keyboard's version of a drag: one frame left or right, or (with `toBeat`) to the previous
 * or next musical target (beat, bar or section cut point) for whichever edge reaches one first.
 */
export function planKeyMove(
  timeline: Timeline,
  item: TimelineItem,
  direction: -1 | 1,
  o: { toBeat: boolean; ripple: boolean; targets: readonly SnapTarget[] },
): DragPlan {
  const fpf = flicksPerFrame(timeline.frameRate);
  let delta = direction * fpf;
  if (o.toBeat) {
    const musical = o.targets.filter((t) => t.kind !== 'edge' && t.kind !== 'playhead');
    const end = item.start + item.duration;
    const steps = musical
      .flatMap((t) => [t.at - item.start, t.at - end])
      .filter((d) => d * direction > 0);
    if (steps.length) delta = direction > 0 ? Math.min(...steps) : Math.max(...steps);
  }
  return planDrag({ timeline, itemId: item.id, mode: 'move', delta, ripple: o.ripple });
}
