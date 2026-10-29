import { flicksPerFrame, type Timeline, type TimelineItem, type Track } from '@trailerforge/schema';

/**
 * Drag editing on the timeline, planned without touching the project: where a dragged clip or
 * edge would land (snapped to beat cut points, bars, sections, other edges or the playhead, on
 * the frame grid) and the one `core/timeline.move` or `core/timeline.trim` command that puts it
 * there, or the reason it cannot go there. Overwrite is the default: a drop that would overlap
 * another item is refused, never cut into it; `ripple` moves the items after it instead. The
 * plan mirrors what the commands do, so a planned drop always applies.
 */

export type SnapKind = 'playhead' | 'section' | 'bar' | 'beat' | 'edge';

/** On a tie in distance, the more musical target wins. */
const PRIORITY: Record<SnapKind, number> = { playhead: 0, section: 1, bar: 2, beat: 3, edge: 4 };

export interface SnapTarget {
  at: number;
  kind: SnapKind;
}

export interface SnapGrid {
  beats: readonly number[];
  bars?: readonly number[];
  sections?: readonly { start: number }[];
}

/**
 * Every place a drag can snap to, sorted by time: the cut point of each beat, bar and section
 * (`leadFrames` ahead of it on the frame grid, as the rough cut cuts), the timeline's own beat,
 * bar and section markers the same way, the edges of all other items, the start, and the playhead.
 */
export function snapTargets(
  timeline: Timeline,
  grid: SnapGrid | null,
  o: { leadFrames?: number; exclude?: string; playhead?: number } = {},
): SnapTarget[] {
  const fpf = flicksPerFrame(timeline.frameRate);
  const lead = o.leadFrames ?? 1;
  const cut = (t: number) => Math.round(t / fpf) * fpf - lead * fpf;
  const best = new Map<number, SnapKind>();
  const add = (at: number, kind: SnapKind) => {
    if (at < 0) return;
    const had = best.get(at);
    if (had === undefined || PRIORITY[kind] < PRIORITY[had]) best.set(at, kind);
  };
  for (const b of grid?.beats ?? []) add(cut(b), 'beat');
  for (const b of grid?.bars ?? []) add(cut(b), 'bar');
  for (const s of grid?.sections ?? []) add(cut(s.start), 'section');
  for (const m of timeline.markers) {
    if (m.kind === 'beat') add(cut(m.at), 'beat');
    else if (m.kind === 'downbeat') add(cut(m.at), 'bar');
    else if (m.kind === 'section') add(cut(m.at), 'section');
  }
  add(0, 'edge');
  for (const track of timeline.tracks)
    for (const it of track.items) {
      if (it.id === o.exclude) continue;
      add(it.start, 'edge');
      add(it.start + it.duration, 'edge');
    }
  if (o.playhead !== undefined) add(Math.round(o.playhead / fpf) * fpf, 'playhead');
  return [...best]
    .map(([at, kind]) => ({ at, kind }))
    .sort((a, b) => a.at - b.at || PRIORITY[a.kind] - PRIORITY[b.kind]);
}

/** The target nearest to `t` within `threshold` (ties: the more musical, then the earlier). */
export function nearestTarget(
  targets: readonly SnapTarget[],
  t: number,
  threshold: number,
): SnapTarget | undefined {
  let found: SnapTarget | undefined;
  let dist = Infinity;
  for (const c of targets) {
    if (c.at < t - threshold) continue;
    if (c.at > t + threshold) break;
    const d = Math.abs(c.at - t);
    if (d < dist || (d === dist && found && PRIORITY[c.kind] < PRIORITY[found.kind])) {
      found = c;
      dist = d;
    }
  }
  return found;
}

export type DragMode = 'move' | 'trim-in' | 'trim-out';

export interface DragInput {
  timeline: Timeline;
  itemId: string;
  mode: DragMode;
  /** How far the pointer (or keyboard) moved, in flicks; rounded to whole frames. */
  delta: number;
  /** Move onto another track (of the same kind). */
  toTrackId?: string;
  ripple?: boolean;
  snap?: { targets: readonly SnapTarget[]; threshold: number } | null;
}

export type DragCommand =
  | {
      type: 'core/timeline.move';
      payload: {
        timelineId: string;
        itemId: string;
        start: number;
        trackId?: string;
        ripple?: boolean;
      };
    }
  | {
      type: 'core/timeline.trim';
      payload: {
        timelineId: string;
        itemId: string;
        edge: 'in' | 'out';
        delta: number;
        ripple?: boolean;
      };
    };

export interface DragPreview {
  /** Where the item would be. */
  trackId: string;
  start: number;
  end: number;
  /** Items a ripple would move, with their new starts. */
  shifted: { itemId: string; trackId: string; start: number }[];
  /** The snap target the drop landed on, if any. */
  snapped?: SnapTarget;
  /** True when the drop was held back at a limit (the start, the recording's start, one frame). */
  clamped: boolean;
}

export type DragPlan =
  | (DragPreview & { ok: true; command: DragCommand | null })
  | (DragPreview & { ok: false; reason: string });

interface Span {
  id: string;
  start: number;
  end: number;
  label: string;
}

const labelOf = (it: TimelineItem) =>
  it.label || (it.kind === 'caption' ? it.text : '') || `${it.kind} ${it.id}`;

const spansOf = (track: Track): Span[] =>
  track.items.map((it) => ({
    id: it.id,
    start: it.start,
    end: it.start + it.duration,
    label: labelOf(it),
  }));

/** Shift spans starting at or after `from` (but not `except`) by `delta`. */
function shift(spans: Span[], from: number, delta: number, except: string): Span[] {
  if (delta === 0) return spans;
  return spans.map((s) =>
    s.id === except || s.start < from ? s : { ...s, start: s.start + delta, end: s.end + delta },
  );
}

/** The first overlap on a track, preferring one that involves `id`. */
function overlapOf(spans: readonly Span[], id: string): string | undefined {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  let other: string | undefined;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b.start >= a.end) continue;
    if (a.id === id) return `it would overlap "${b.label}"`;
    if (b.id === id) return `it would overlap "${a.label}"`;
    other ??= `"${a.label}" and "${b.label}" would overlap`;
  }
  return other;
}

function movedFrom(before: readonly Span[], after: readonly Span[], trackId: string, id: string) {
  const was = new Map(before.map((s) => [s.id, s.start]));
  return after
    .filter((s) => s.id !== id && was.has(s.id) && was.get(s.id) !== s.start)
    .map((s) => ({ itemId: s.id, trackId, start: s.start }));
}

/** Plan one drag of a clip or one of its edges. */
export function planDrag(input: DragInput): DragPlan {
  const { timeline, itemId, mode } = input;
  const fpf = flicksPerFrame(timeline.frameRate);
  const track = timeline.tracks.find((t) => t.items.some((i) => i.id === itemId));
  const item = track?.items.find((i) => i.id === itemId);
  if (!track || !item)
    return refuse({ trackId: '', start: 0, end: 0, shifted: [], clamped: false }, 'no such item');
  const here: DragPreview = {
    trackId: track.id,
    start: item.start,
    end: item.start + item.duration,
    shifted: [],
    clamped: false,
  };
  if (track.locked) return refuse(here, `track "${track.name || track.id}" is locked`);
  const delta = Math.round(input.delta / fpf) * fpf;
  const ripple = input.ripple === true;
  const snapTo = (t: number) =>
    input.snap ? nearestTarget(input.snap.targets, t, input.snap.threshold) : undefined;
  const ref = { timelineId: timeline.id, itemId };

  if (mode === 'move') {
    const target = input.toTrackId ? timeline.tracks.find((t) => t.id === input.toTrackId) : track;
    if (!target) return refuse(here, 'no such track');
    if (target.locked) return refuse(here, `track "${target.name || target.id}" is locked`);
    if (target.kind !== track.kind)
      return refuse(here, `it can only move to another ${track.kind} track`);
    let start = item.start + delta;
    let snapped: SnapTarget | undefined;
    const a = snapTo(start);
    const b = snapTo(start + item.duration);
    if (a && (!b || Math.abs(a.at - start) <= Math.abs(b.at - (start + item.duration)))) {
      snapped = a;
      start = a.at;
    } else if (b) {
      snapped = b;
      start = b.at - item.duration;
    }
    const clamped = start < 0;
    if (clamped) {
      start = 0;
      snapped = undefined;
    }
    const oldEnd = item.start + item.duration;
    const moved: Span = { ...spansOf(track).find((s) => s.id === itemId)!, start, end: start + item.duration }; // prettier-ignore
    const base = { trackId: target.id, start, end: moved.end, clamped, ...(snapped ? { snapped } : {}) }; // prettier-ignore
    let reason: string | undefined;
    let shifted: DragPreview['shifted'];
    if (target === track) {
      const before = spansOf(track);
      let after = before.map((s) => (s.id === itemId ? moved : s));
      if (ripple) after = shift(after, oldEnd, start - item.start, itemId);
      reason = overlapOf(after, itemId);
      shifted = movedFrom(before, after, track.id, itemId);
    } else {
      const srcBefore = spansOf(track);
      let src = srcBefore.filter((s) => s.id !== itemId);
      const dstBefore = spansOf(target);
      let dst = dstBefore;
      if (ripple) {
        src = shift(src, oldEnd, -item.duration, itemId);
        dst = shift(dst, start, item.duration, itemId);
      }
      dst = [...dst, moved];
      reason = overlapOf(dst, itemId) ?? overlapOf(src, itemId);
      shifted = [
        ...movedFrom(srcBefore, src, track.id, itemId),
        ...movedFrom(dstBefore, dst, target.id, itemId),
      ];
    }
    const preview: DragPreview = { ...base, shifted };
    if (reason) return refuse(preview, reason);
    if (target === track && start === item.start) return { ...preview, ok: true, command: null };
    return {
      ...preview,
      ok: true,
      command: {
        type: 'core/timeline.move',
        payload: {
          ...ref,
          start,
          ...(target !== track ? { trackId: target.id } : {}),
          ...(ripple ? { ripple: true } : {}),
        },
      },
    };
  }

  // Trims: the dragged edge snaps, then is held inside what the item allows.
  const isIn = mode === 'trim-in';
  const start0 = item.start;
  const end0 = item.start + item.duration;
  let edge = (isIn ? start0 : end0) + delta;
  const s = snapTo(edge);
  if (s) edge = s.at;
  let lo: number;
  let hi: number;
  if (isIn) {
    const speed = 'speed' in item ? item.speed : 1;
    // The recording's start: the edge may move back only as far as whole frames of source allow.
    const back = 'sourceIn' in item ? Math.floor(item.sourceIn / speed / fpf) * fpf : Infinity;
    lo = Math.max(start0 - back, ripple ? -Infinity : 0);
    hi = end0 - fpf;
  } else {
    lo = start0 + fpf;
    hi = Infinity;
  }
  const clamped = edge < lo || edge > hi;
  edge = Math.min(hi, Math.max(lo, edge));
  const d = edge - (isIn ? start0 : end0);
  const snapped = s && s.at === edge ? s : undefined;
  const before = spansOf(track);
  let start = start0;
  let end = end0;
  let after: Span[];
  if (isIn) {
    if (ripple) {
      end = end0 - d;
      after = shift(before, end0, -d, itemId);
    } else {
      start = start0 + d;
      after = before;
    }
  } else {
    end = end0 + d;
    after = ripple ? shift(before, end0, d, itemId) : before;
  }
  after = after.map((x) => (x.id === itemId ? { ...x, start, end } : x));
  const preview: DragPreview = {
    trackId: track.id,
    start,
    end,
    shifted: movedFrom(before, after, track.id, itemId),
    clamped,
    ...(snapped ? { snapped } : {}),
  };
  const reason = overlapOf(after, itemId);
  if (reason) return refuse(preview, reason);
  if (d === 0) return { ...preview, ok: true, command: null };
  return {
    ...preview,
    ok: true,
    command: {
      type: 'core/timeline.trim',
      payload: { ...ref, edge: isIn ? 'in' : 'out', delta: d, ...(ripple ? { ripple: true } : {}) },
    },
  };
}

function refuse(p: DragPreview, reason: string): DragPlan {
  return { ...p, ok: false, reason };
}
