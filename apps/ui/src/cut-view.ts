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
