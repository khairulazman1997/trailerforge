import { evaluateNumber, evaluateVector } from '@trailerforge/graphics';
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  itemEnd,
  type Rate,
  type Timeline,
  type TimelineItem,
} from '@trailerforge/schema';

export const F = FLICKS_PER_SECOND;

/**
 * CSS for a clip's position, scale and opacity at `t` (timeline flicks), the way the renderer
 * applies them: scaled about the anchor, which lands on the position (shares of the frame), then
 * faded. Undefined when the clip has no transform to show. Rotation is not rendered, so not shown.
 */
export function transformStyle(
  item: TimelineItem | undefined,
  t: number,
): { transform: string; transformOrigin: string; opacity: number } | undefined {
  if (item?.kind !== 'clip' || !item.transform) return undefined;
  const at = Math.round(t - item.start);
  const tr = item.transform;
  const [px, py] = evaluateVector(tr.position, at, 2) as [number, number];
  const [ax, ay] = evaluateVector(tr.anchor, at, 2) as [number, number];
  const s = evaluateNumber(tr.scale, at);
  const opacity = Math.min(1, Math.max(0, evaluateNumber(tr.opacity, at)));
  if (px === 0.5 && py === 0.5 && ax === 0.5 && ay === 0.5 && s === 1 && opacity === 1)
    return undefined;
  const pct = (v: number) => `${+(v * 100).toFixed(4)}%`;
  return {
    transform: `translate(${pct(px - ax)}, ${pct(py - ay)}) scale(${+s.toFixed(6)})`,
    transformOrigin: `${pct(ax)} ${pct(ay)}`,
    opacity,
  };
}

/** `m:ss.ff` for a flick position at a frame rate. */
export function timecode(flicks: number, rate: Rate): string {
  const fps = Math.round(rate.num / rate.den);
  const frames = Math.round(flicks / flicksPerFrame(rate));
  const totalSec = Math.floor(frames / fps);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}.${String(frames - totalSec * fps).padStart(2, '0')}`;
}

export const percent = (t: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, (t / total) * 100)) : 0;

/** The item of a track that covers time `t` (start inclusive, end exclusive). */
export function itemAt(items: readonly TimelineItem[], t: number): TimelineItem | undefined {
  return items.find((i) => t >= i.start && t < itemEnd(i));
}

/** The picture at `t`: the first video or graphics track that has something there. */
export function pictureAt(tl: Pick<Timeline, 'tracks'>, t: number): TimelineItem | undefined {
  for (const track of tl.tracks) {
    if (track.kind !== 'video' && track.kind !== 'graphics') continue;
    const hit = itemAt(track.items, t);
    if (hit) return hit;
  }
  return undefined;
}

/** The on-screen text at `t`, from caption tracks that are not muted. */
export function captionAt(
  tl: Pick<Timeline, 'tracks'>,
  t: number,
): { text: string; styleId?: string | undefined } | undefined {
  for (const track of tl.tracks) {
    if (track.kind !== 'caption' || track.muted) continue;
    const hit = itemAt(track.items, t);
    if (hit?.kind === 'caption') return { text: hit.text, styleId: hit.styleId };
  }
  return undefined;
}

/** Where a beat puts a cut: one frame ahead of it, on the frame grid (as the rough cut does). */
export const cutPointFor = (beat: number, rate: Rate) =>
  Math.round(beat / flicksPerFrame(rate)) * flicksPerFrame(rate) - flicksPerFrame(rate);

/**
 * How far to move an edge (in flicks) so it lands on the next or previous beat's cut point, or
 * null when there is none that way.
 */
export function deltaToBeat(
  edge: number,
  beats: readonly number[],
  direction: 'next' | 'previous',
  rate: Rate,
): number | null {
  const points = beats.map((b) => cutPointFor(b, rate));
  const target =
    direction === 'next'
      ? points.find((p) => p > edge)
      : [...points].reverse().find((p) => p < edge);
  return target === undefined ? null : target - edge;
}

/** Trim limits: can this edge move by `delta` and still leave a clip of at least one frame? */
export function canTrim(
  item: TimelineItem,
  edge: 'in' | 'out',
  delta: number,
  rate: Rate,
): boolean {
  const fpf = flicksPerFrame(rate);
  const start = edge === 'in' ? item.start + delta : item.start;
  const duration = edge === 'in' ? item.duration - delta : item.duration + delta;
  const sourceIn = 'sourceIn' in item ? item.sourceIn + (edge === 'in' ? delta : 0) : 0;
  return start >= 0 && duration >= fpf && sourceIn >= 0;
}

/** Items in time order across all picture tracks, for keyboard stepping. */
export function pictureItems(tl: Pick<Timeline, 'tracks'>): TimelineItem[] {
  return tl.tracks
    .filter((t) => t.kind === 'video' || t.kind === 'graphics')
    .flatMap((t) => t.items)
    .sort((a, b) => a.start - b.start);
}

export const kindLabel = (i: TimelineItem) =>
  i.kind === 'clip'
    ? 'clip'
    : i.kind === 'placeholder'
      ? 'placeholder'
      : i.kind === 'graphic'
        ? 'card'
        : i.kind;

/** A sourceIn for a replacement take that stays inside it. */
export function fitSourceIn(
  current: number,
  itemDuration: number,
  takeDuration: number | null,
): number {
  if (takeDuration === null) return 0;
  return Math.max(0, Math.min(current, takeDuration - itemDuration));
}

/** What dragging the source window changes: the whole window (slip) or one of its edges. */
export type SourceEdit = 'slip' | 'in' | 'out';

/**
 * A drag of the source window, kept on the frame grid and inside the recording: `sourceDelta` is
 * how far the dragged part moves in the recording, `timelineDelta` how far the clip's edge moves on
 * the timeline (0 for a slip, which keeps the clip where it is). `length` null = unknown, unlimited.
 */
export function planSourceEdit(
  item: { duration: number; sourceIn: number; speed: number },
  mode: SourceEdit,
  delta: number,
  length: number | null,
  rate: Rate,
): { sourceDelta: number; timelineDelta: number } {
  const fpf = flicksPerFrame(rate);
  const span = item.duration * item.speed;
  const max = length ?? Infinity;
  const frames = (d: number) => Math.round(d / fpf) * fpf;
  if (mode === 'slip') {
    const lo = -item.sourceIn;
    const hi = Math.max(lo, max - item.sourceIn - span);
    const d = Math.min(hi, Math.max(lo, frames(delta)));
    return { sourceDelta: d, timelineDelta: 0 };
  }
  let td = frames(delta / item.speed);
  if (mode === 'in') {
    td = Math.max(td, -Math.floor(item.sourceIn / item.speed / fpf) * fpf);
    td = Math.min(td, item.duration - fpf);
  } else {
    td = Math.max(td, fpf - item.duration);
    if (Number.isFinite(max))
      td = Math.min(td, Math.floor((max - item.sourceIn - span) / item.speed / fpf) * fpf);
  }
  return { sourceDelta: Math.round(td * item.speed), timelineDelta: td };
}

/** A clip's source range after a drag of the source window (see `planSourceEdit`). */
export function applySourceEdit<T extends { duration: number; sourceIn: number; speed: number }>(
  clip: T,
  mode: SourceEdit,
  delta: number,
  length: number | null,
  rate: Rate,
): T {
  const p = planSourceEdit(clip, mode, delta, length, rate);
  if (mode === 'slip') return { ...clip, sourceIn: clip.sourceIn + p.sourceDelta };
  if (mode === 'in')
    return {
      ...clip,
      sourceIn: clip.sourceIn + p.sourceDelta,
      duration: clip.duration - p.timelineDelta,
    };
  return { ...clip, duration: clip.duration + p.timelineDelta };
}

/** How a change of length reaches the rest of the track. */
export type LengthMode = 'roll' | 'ripple';

export type LengthPlan =
  | { ok: true; type: 'core/timeline.roll' | 'core/timeline.trim'; payload: object }
  | { ok: false; reason: string };

/**
 * The command that gives an item a new length (flicks, put on the frame grid), or why it cannot,
 * or null when nothing changes. `roll` takes the time from (or gives it to) the item right after
 * it, so later cuts stay on the beat; with nothing right after it, the end moves into the gap.
 * `ripple` moves everything after it along.
 */
export function planLength(
  tl: Pick<Timeline, 'id' | 'tracks' | 'frameRate'>,
  itemId: string,
  duration: number,
  mode: LengthMode,
): LengthPlan | null {
  const fpf = flicksPerFrame(tl.frameRate);
  const track = tl.tracks.find((t) => t.items.some((i) => i.id === itemId));
  const item = track?.items.find((i) => i.id === itemId);
  if (!track || !item) return { ok: false, reason: 'that item is gone' };
  if (track.locked) return { ok: false, reason: 'its track is locked' };
  const want = Math.round(duration / fpf) * fpf;
  if (want < fpf) return { ok: false, reason: 'it needs at least one frame' };
  const delta = want - item.duration;
  if (delta === 0) return null;
  const ref = { timelineId: tl.id, itemId };
  const trim = (ripple: boolean): LengthPlan => ({
    ok: true,
    type: 'core/timeline.trim',
    payload: { ...ref, edge: 'out', delta, ripple },
  });
  if (mode === 'ripple') return trim(true);
  const end = itemEnd(item);
  const name = (i: TimelineItem) => `"${i.label ?? kindLabel(i)}"`;
  const next = track.items.find((i) => i.id !== itemId && i.start === end);
  if (next) {
    if (next.duration - delta < fpf)
      return {
        ok: false,
        reason: `${name(next)} after it would be gone; it can be at most ${seconds(item.duration + next.duration - fpf)} long this way`,
      };
    if ('sourceIn' in next && next.sourceIn + delta * ('speed' in next ? next.speed : 1) < 0)
      return {
        ok: false,
        reason: `${name(next)} after it has no earlier footage to fill the time; move everything after it along instead`,
      };
    return { ok: true, type: 'core/timeline.roll', payload: { ...ref, delta } };
  }
  const after = track.items
    .filter((i) => i.id !== itemId && i.start >= end)
    .sort((a, b) => a.start - b.start)[0];
  if (after && end + delta > after.start)
    return {
      ok: false,
      reason: `it would run into ${name(after)}; move everything after it along instead`,
    };
  return trim(false);
}

const seconds = (flicks: number) => `${+(flicks / F).toFixed(2)} s`;

/** How long a clip runs past the end of its recording (its last frame holds), in flicks. */
export function heldPastEnd(item: TimelineItem, recordingLength: number | null): number {
  if (item.kind !== 'clip' || recordingLength === null) return 0;
  return Math.max(0, item.sourceIn + item.duration * item.speed - recordingLength);
}
