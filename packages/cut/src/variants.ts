import {
  Timeline,
  Transform,
  flicksPerFrame,
  framesToFlicks,
  itemEnd,
  type Animatable,
  type FormatTarget,
  type Project,
  type Slot,
  type StoryboardVariant,
  type TimelineItem,
} from '@trailerforge/schema';
import { cropInsets, reframeClip, type ReframeResult } from './reframe.js';
import { stableHash, type TakeSource } from './rough-cut.js';

/**
 * A variant (aspect ratio, length) derived from the master cut on demand. Pure and
 * deterministic; the result is never stored in the project, only the variant's rules and sparse
 * per-slot overrides are. Browser-safe.
 *
 * The master's picture is cut into segments, one per storyboard slot (the span of its items on
 * video tracks, and on graphics tracks for cards). A cutdown first drops "nice to have" slots,
 * but only while shortening alone cannot reach the target, then other droppable slots if even
 * every slot at its minimum runs over; the hook, the title and the call to action are never
 * dropped automatically. The remaining difference is shared out in whole frames, in proportion
 * to how far each slot can shrink (or grow). Slots shorten from their tail so each keeps its
 * opening action. Captions and other overlays follow their slot; the music plays on unchanged
 * and ends with the cut.
 */

/** Bumped whenever the derivation changes its output for the same inputs. */
export const VARIANT_DERIVATION_VERSION = 3;

export interface VariantInput {
  project: Pick<Project, 'storyboard' | 'formatTargets' | 'timelines'>;
  variantId: string;
  /** The master cut; default `tl_rough`, else the first timeline that is not a variant. */
  masterTimelineId?: string;
  /**
   * Recording lengths per asset id, so a clip can grow into footage the master left unused (and
   * a swapped take is cut to its length), and with footage analysis the crop follows the
   * subject. Without it a clip never grows past its master length and crops are centred.
   */
  sources?: ReadonlyMap<string, TakeSource>;
  /**
   * Beat times in flicks (the resolved music grid). After a slot is shortened, lengthened or
   * dropped, later cuts move to the nearest beat (`leadFrames` early, as in the rough cut).
   * Without it the master's bar markers are used.
   */
  beats?: readonly number[];
  /** Frames a cut lands ahead of its beat; default 1. */
  leadFrames?: number;
}

export type SlotFate = 'kept' | 'shortened' | 'lengthened' | 'dropped';

export interface VariantSlotReport {
  slotId: string;
  fate: SlotFate;
  /** Lengths in flicks; 0 for a slot the master does not show, or that was dropped. */
  masterDuration: number;
  duration: number;
  reason: string;
  /** How the slot's first clip fits the version's shape. */
  reframe?: { mode: ReframeResult['mode']; reason: string };
}

export interface DerivedVariant {
  timeline: Timeline;
  /** Target and actual length, flicks. */
  target: number;
  duration: number;
  /** Why the target was missed by more than a frame; absent when it was met. */
  shortfall?: string;
  /** Every storyboard slot, in master order (slots the master does not show last). */
  slots: VariantSlotReport[];
  warnings: string[];
  /** Hash of everything the derivation reads: the same hash gives the same result. */
  inputHash: string;
}

export class VariantError extends Error {
  constructor(
    readonly code: 'no-storyboard' | 'unknown-variant' | 'unknown-format' | 'no-master',
    message: string,
  ) {
    super(message);
    this.name = 'VariantError';
  }
}

/** Section roles and card kinds a cutdown never drops on its own. */
const PROTECTED_ROLES = new Set(['hook']);
const PROTECTED_CARDS = new Set(['title', 'cta']);

interface Segment {
  key: string;
  slot: Slot;
  /** Items placed relative to the segment start, in frames. */
  items: { item: TimelineItem; trackId: string; rel: number; len: number }[];
  /** Master position and length, frames at the variant rate. */
  masterStart: number;
  masterLen: number;
  /** Gap before it in the master (hand deletions), frames. */
  gap: number;
  start: number;
  min: number;
  max: number;
  /** Can the cutdown drop it: 0 never, 1 a "must" slot, 2 "nice to have". */
  droppable: 0 | 1 | 2;
  keptByHand: boolean;
  dropped?: string;
  len: number;
  notes: string[];
}

const secs = (frames: number, fps: number) => Math.round((frames / fps) * 100) / 100;

function pickMaster(timelines: readonly Timeline[], id: string | undefined): Timeline | undefined {
  if (id) return timelines.find((t) => t.id === id);
  return timelines.find((t) => t.id === 'tl_rough') ?? timelines.find((t) => !t.variantId);
}

/** Hash of the inputs `deriveVariant` reads; cheap next to the derivation itself. */
export function variantInputHash(input: VariantInput): string {
  const { project, variantId } = input;
  const sb = project.storyboard;
  const variant = sb?.variants.find((v) => v.id === variantId);
  const format = project.formatTargets.find((f) => f.id === variant?.formatTargetId);
  const master = pickMaster(project.timelines, input.masterTimelineId);
  const assets = new Set<string>();
  for (const s of sb?.sections ?? [])
    for (const slot of s.slots)
      if (slot.kind === 'shot') for (const t of slot.takes) assets.add(t.assetId);
  for (const tr of master?.tracks ?? [])
    for (const it of tr.items) if ('assetId' in it) assets.add(it.assetId);
  const sources = [...assets].sort().map((id) => {
    // Analysis is deterministic per recording and analyzer version: its shape stands for it.
    const src = input.sources?.get(id);
    const f = src?.footage;
    return [id, src?.duration ?? null, f ? [f.frameCount, f.focus?.length ?? 0] : null] as const;
  });
  return stableHash(
    JSON.stringify({
      v: VARIANT_DERIVATION_VERSION,
      variant,
      format,
      master,
      sections: sb?.sections,
      sources,
      beats: input.beats ? [input.beats.length, stableHash(input.beats.join(','))] : null,
      lead: input.leadFrames ?? 1,
    }),
  );
}

export function deriveVariant(input: VariantInput): DerivedVariant {
  const { project, variantId } = input;
  const sb = project.storyboard;
  if (!sb) throw new VariantError('no-storyboard', 'the project has no storyboard');
  const variant = sb.variants.find((v) => v.id === variantId);
  if (!variant) throw new VariantError('unknown-variant', `no variant "${variantId}"`);
  const format = project.formatTargets.find((f) => f.id === variant.formatTargetId);
  if (!format)
    throw new VariantError('unknown-format', `no format target "${variant.formatTargetId}"`);
  const master = pickMaster(project.timelines, input.masterTimelineId);
  if (!master) throw new VariantError('no-master', 'build the rough cut first');
  return derive(input, variant, format, master);
}

function derive(
  input: VariantInput,
  variant: StoryboardVariant,
  format: FormatTarget,
  master: Timeline,
): DerivedVariant {
  const sb = input.project.storyboard!;
  const rate = format.frameRate;
  const fps = rate.num / rate.den;
  const fpf = flicksPerFrame(rate);
  const F = (flicks: number) => Math.round(flicks / fpf);
  const T = (frames: number) => framesToFlicks(frames, rate);
  const warnings: string[] = [];

  const slots = new Map<string, { slot: Slot; role: string | undefined }>();
  for (const s of sb.sections)
    for (const slot of s.slots) slots.set(slot.id, { slot, role: s.role });

  // Picture segments: one per slot, from its items on video tracks (and graphics tracks for
  // cards). Unlinked picture items ride along like overlays.
  const isSpine = (kind: string, item: TimelineItem) => {
    const slot = item.slotId ? slots.get(item.slotId)?.slot : undefined;
    return !!slot && (kind === 'video' || (kind === 'graphics' && slot.kind === 'card'));
  };
  const raw = new Map<string, { slot: Slot; items: { item: TimelineItem; trackId: string }[] }>();
  for (const tr of master.tracks) {
    for (const item of tr.items) {
      if (!isSpine(tr.kind, item)) continue;
      const seg = raw.get(item.slotId!) ?? { slot: slots.get(item.slotId!)!.slot, items: [] };
      seg.items.push({ item, trackId: tr.id });
      raw.set(item.slotId!, seg);
    }
  }
  const segs: Segment[] = [...raw.entries()]
    .map(([key, r]) => {
      const start = F(Math.min(...r.items.map((x) => x.item.start)));
      const end = F(Math.max(...r.items.map((x) => itemEnd(x.item))));
      return { key, r, start, end };
    })
    .sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : 1))
    .map(({ key, r, start, end }, i, all) => {
      const prevEnd = i === 0 ? 0 : all[i - 1]!.end;
      const masterLen = end - start;
      const seg: Segment = {
        key,
        slot: r.slot,
        items: r.items
          .map(({ item, trackId }) => ({
            item,
            trackId,
            rel: F(item.start) - start,
            len: F(itemEnd(item)) - F(item.start),
          }))
          .filter((x) => x.len > 0),
        masterStart: start,
        masterLen,
        gap: Math.max(0, start - prevEnd),
        start: masterLen,
        min: masterLen,
        max: masterLen,
        droppable: 0,
        keptByHand: false,
        len: masterLen,
        notes: [],
      };
      shapeSlot(seg, r.slot, slots.get(r.slot.id)!.role);
      return seg;
    });

  function growRoom(x: Segment['items'][number]): number {
    const it = x.item;
    if (it.kind !== 'clip') return Infinity;
    const src = input.sources?.get(it.assetId);
    if (!src) return 0;
    return Math.max(0, Math.floor((src.duration - it.sourceIn) / it.speed / fpf) - x.len);
  }

  function shapeSlot(seg: Segment, slot: Slot, role: string | undefined) {
    const ov = variant.overrides[slot.id];
    if (ov?.takeId !== undefined && slot.kind === 'shot') swapTake(seg, slot, ov.takeId);
    const range = ov?.duration ?? slot.duration;
    const L = seg.masterLen;
    // Items ending with the segment are the ones that can grow.
    const tails = seg.items.filter((x) => x.rel + x.len === L);
    const room = tails.length ? Math.min(...tails.map(growRoom)) : 0;
    const cap = L + room;
    seg.min = Math.max(1, Math.min(L, Math.round(range.min * fps)));
    seg.max = Math.min(cap, Math.max(L, Math.round(range.max * fps)));
    seg.start = L;
    if (ov?.duration) {
      const ideal = Math.max(1, Math.round(range.ideal * fps));
      seg.min = Math.max(1, Math.min(ideal, Math.round(range.min * fps)));
      seg.max = Math.max(seg.min, Math.min(cap, Math.round(range.max * fps)));
      seg.start = Math.min(Math.max(ideal, seg.min), seg.max);
      if (ideal > cap)
        seg.notes.push(`the take runs out after ${secs(cap, fps)} s, short of the new length`);
    }
    seg.min = Math.min(seg.min, seg.start);
    seg.max = Math.max(seg.max, seg.start);
    const isProtected =
      (role !== undefined && PROTECTED_ROLES.has(role)) ||
      (slot.kind === 'card' && PROTECTED_CARDS.has(slot.cardKind));
    seg.droppable = isProtected ? 0 : slot.priority === 'nice' ? 2 : 1;
    if (ov?.excluded === true) seg.dropped = 'dropped by hand in this version';
    seg.keptByHand = ov?.excluded === false;
  }

  function swapTake(seg: Segment, slot: Extract<Slot, { kind: 'shot' }>, takeId: string) {
    const take = slot.takes.find((t) => t.id === takeId);
    if (!take || take.rejected) {
      warnings.push(
        `"${slot.title || slot.id}": the take chosen for this version is ${take ? 'rejected' : 'gone'}; using the master's`,
      );
      return;
    }
    const video = seg.items.filter(
      (x) => master.tracks.find((t) => t.id === x.trackId)?.kind === 'video',
    );
    const first = video[0];
    if (!first) return;
    const sourceIn = take.sourceIn ?? 0;
    const base =
      first.item.kind === 'clip'
        ? { transform: first.item.transform, effects: first.item.effects }
        : { effects: [] };
    const clip: TimelineItem = {
      id: first.item.id,
      kind: 'clip',
      start: first.item.start,
      duration: first.item.duration,
      slotId: slot.id,
      label: first.item.label,
      extensions: {},
      assetId: take.assetId,
      sourceIn,
      speed: 1,
      gainDb: 0,
      muted: false,
      ...base,
    } as TimelineItem;
    const src = input.sources?.get(take.assetId);
    let len = seg.masterLen;
    const avail = src ? Math.floor((src.duration - sourceIn) / fpf) : undefined;
    if (avail !== undefined && avail < len) {
      len = Math.max(1, avail);
      seg.notes.push(`the chosen take is only ${secs(len, fps)} s long`);
    }
    seg.items = [
      ...seg.items.filter((x) => !video.includes(x)),
      { item: clip, trackId: first.trackId, rel: 0, len },
    ];
    seg.masterLen = Math.max(len, ...seg.items.map((x) => x.rel + x.len));
    seg.notes.push(`uses take "${take.id}"`);
  }

  // Target: the variant's length, or the master's.
  const masterEnd = segs.length ? Math.max(...segs.map((s) => s.masterStart + s.masterLen)) : 0;
  const target =
    variant.targetDuration !== undefined ? Math.round(variant.targetDuration * fps) : masterEnd;
  const live = () => segs.filter((s) => !s.dropped);
  const sum = (pick: (s: Segment) => number) => live().reduce((n, s) => n + s.gap + pick(s), 0);

  // Drop "nice to have" slots while the kept ones at their lengths still run over, keeping
  // enough room to grow back to the target; then droppable "must" slots while even every slot
  // at its minimum runs over.
  const drop = (cls: 1 | 2, over: () => number, ok: (s: Segment) => boolean, why: string) => {
    for (;;) {
      const excess = over();
      if (excess <= 0) return;
      const cands = live()
        .filter((s) => s.droppable === cls && !s.keptByHand && ok(s))
        .map((s) => ({ s, w: s.gap + (cls === 2 ? s.start : s.min) }));
      if (!cands.length) return;
      // The smallest that clears the excess on its own, else the largest; later ones first.
      const later = (a: Segment, b: Segment) => b.masterStart - a.masterStart;
      const enough = cands
        .filter((c) => c.w >= excess)
        .sort((a, b) => a.w - b.w || later(a.s, b.s));
      const pick = enough[0] ?? cands.sort((a, b) => b.w - a.w || later(a.s, b.s))[0]!;
      pick.s.dropped = why;
    }
  };
  const goal = `${secs(target, fps)} s`;
  drop(
    2,
    () => sum((s) => s.start) - target,
    (s) => sum((x) => x.max) - s.gap - s.max >= target,
    `nice to have: dropped to fit ${goal}`,
  );
  drop(
    1,
    () => sum((s) => s.min) - target,
    () => true,
    `dropped to fit ${goal}: every other shot at its shortest still ran over`,
  );

  // Share the rest out in whole frames.
  const kept = live();
  for (const s of kept) s.len = s.start;
  let delta = target - sum((s) => s.len);
  const slack = kept.map((s) => (delta < 0 ? s.len - s.min : s.max - s.len));
  const moved = share(Math.abs(delta), slack);
  kept.forEach((s, i) => (s.len += Math.sign(delta) * moved[i]!));
  const total = sum((s) => s.len);
  delta = target - total;
  let shortfall: string | undefined;
  if (Math.abs(delta) > 1) {
    shortfall =
      delta < 0
        ? `runs ${secs(-delta, fps)} s over ${goal}: the slots that cannot be dropped are already at their shortest`
        : `runs ${secs(delta, fps)} s under ${goal}: every slot is at its longest (the recordings or the storyboard's maximum lengths)`;
  }

  // Back on the beat: from the first slot this version changed, each cut moves to the nearest
  // cut point (a beat, `leadFrames` early) that the slot's min/max and the room the later slots
  // need still allow; the last slot ends on the target as before.
  const lead = Math.max(0, Math.min(2, input.leadFrames ?? 1));
  const beatFrames = (
    input.beats ?? master.markers.filter((m) => m.kind === 'downbeat').map((m) => m.at)
  ).map((b) => F(b) - lead);
  const points = [...new Set(beatFrames)].filter((p) => p > 0).sort((a, b) => a - b);
  const offBeat: Segment[] = [];

  if (points.length && kept.length > 1) {
    const ends: number[] = [];
    let pos = 0;
    let first = -1;
    kept.forEach((s, i) => {
      pos += s.gap;
      if (first < 0 && (pos !== s.masterStart || s.len !== s.masterLen)) first = i;
      pos += s.len;
      ends.push(pos);
    });
    const finish = pos;
    if (first >= 0) {
      pos = ends[first]! - kept[first]!.len;
      for (let i = first; i < kept.length - 1; i++) {
        const s = kept[i]!;
        let restMin = 0;
        let restMax = 0;
        for (const r of kept.slice(i + 1)) {
          restMin += r.gap + r.min;
          restMax += r.gap + r.max;
        }
        const lo = Math.max(pos + s.min, finish - restMax);
        const hi = Math.min(pos + s.max, finish - restMin);
        const cur = pos + s.len;
        let best: number | undefined;
        for (const p of points) {
          if (p < lo || p > hi) continue;
          if (best === undefined || Math.abs(p - cur) < Math.abs(best - cur)) best = p;
        }
        if (best === undefined) offBeat.push(s);
        const next = best ?? Math.min(Math.max(cur, lo), Math.max(lo, hi));
        s.len = next - pos;
        pos = next + kept[i + 1]!.gap;
      }
      kept.at(-1)!.len = finish - pos;
    }
  }

  // Place the picture.
  const out = new Map<string, TimelineItem[]>(master.tracks.map((t) => [t.id, []]));
  const placed = new Map<string, { start: number; len: number }>();
  let cursor = 0;
  for (const s of kept) {
    cursor += s.gap;
    placed.set(s.key, { start: cursor, len: s.len });
    for (const x of s.items) {
      if (x.rel >= s.len) continue;
      const end =
        x.rel + x.len === s.masterLen && s.len > s.masterLen
          ? s.len
          : Math.min(x.rel + x.len, s.len);
      out.get(x.trackId)!.push(at(x.item, cursor + x.rel, cursor + end));
    }
    cursor += s.len;
  }
  const end = cursor;

  function at(item: TimelineItem, from: number, to: number): TimelineItem {
    return { ...item, start: T(from), duration: T(to) - T(from) };
  }

  // Overlays follow the segment they sit on; music and other unlinked audio keep their time.
  const anchor = (item: TimelineItem): Segment | undefined => {
    if (item.slotId) {
      const s = segs.find((x) => x.slot.id === item.slotId);
      if (s) return s;
    }
    const f = F(item.start);
    return segs.find((x) => f >= x.masterStart && f < x.masterStart + x.masterLen);
  };
  for (const tr of master.tracks) {
    for (const item of tr.items) {
      if (isSpine(tr.kind, item)) continue;
      const s0 = F(item.start);
      const len = F(itemEnd(item)) - s0;
      if (len <= 0) continue;
      if (tr.kind === 'audio' && !item.slotId) {
        if (s0 >= end) continue;
        const to = Math.min(s0 + len, end);
        out.get(tr.id)!.push(retimeFade(at(item, s0, to), T(to) - T(s0) - item.duration));
        continue;
      }
      const seg = anchor(item);
      const p = seg && placed.get(seg.key);
      if (!seg || !p) continue;
      const rel = s0 - seg.masterStart;
      if (rel >= p.len) continue;
      const stop = item.slotId ? p.start + p.len : end;
      out.get(tr.id)!.push(at(item, p.start + rel, Math.min(p.start + rel + len, stop)));
    }
  }

  const tracks = master.tracks.map((tr) => {
    // Unlinked overlays can meet after a cutdown: the earlier one gives way.
    const items = out.get(tr.id)!.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    const fitted: TimelineItem[] = [];
    items.forEach((it, i) => {
      const next = items[i + 1];
      const stop = next ? Math.min(itemEnd(it), next.start) : itemEnd(it);
      if (stop - it.start > 0) fitted.push({ ...it, duration: stop - it.start });
    });
    const byId = new Map(fitted.map((it) => [it.id, it]));
    return {
      ...tr,
      items: fitted,
      transitions: tr.transitions.filter((t) => {
        const a = byId.get(t.fromItemId);
        const b = byId.get(t.toItemId);
        return !!a && !!b && itemEnd(a) === b.start;
      }),
    };
  });

  // Fit every clip to the version's shape.
  const reframes = new Map<string, ReframeResult>();
  for (const tr of tracks) {
    if (tr.kind !== 'video') continue;
    tr.items = tr.items.map((it) => (it.kind === 'clip' ? reframeItem(it) : it));
  }
  function reframeItem(it: Extract<TimelineItem, { kind: 'clip' }>): TimelineItem {
    const footage = input.sources?.get(it.assetId)?.footage;
    const manual = it.slotId ? variant.overrides[it.slotId]?.cropCenter : undefined;
    const r = reframeClip({
      source: master.resolution,
      target: format.resolution,
      rate,
      sourceIn: it.sourceIn,
      duration: it.duration,
      speed: it.speed,
      mode: variant.reframe.mode,
      ...(footage ? { footage } : {}),
      ...(manual ? { manual } : {}),
    });
    if (it.slotId && !reframes.has(it.slotId)) reframes.set(it.slotId, r);
    if (r.mode === 'none') return it;
    const crop =
      r.mode === 'fill'
        ? undefined
        : r.path.length === 1
          ? cropInsets(r.path[0]!.rect)
          : {
              keyframes: r.path.map((k) => ({
                at: k.at,
                value: cropInsets(k.rect),
                easing: 'linear' as const,
              })),
            };
    const core = (it.extensions.core ?? {}) as Record<string, unknown>;
    return {
      ...it,
      transform: Transform.parse({ ...(it.transform ?? {}), ...(crop ? { crop } : {}) }),
      extensions: {
        ...it.extensions,
        core: {
          ...core,
          reframe: {
            mode: r.mode,
            reason: r.reason,
            ...(r.mode === 'fill' ? { background: 'blur' } : {}),
          },
        },
      } as TimelineItem['extensions'],
    };
  }

  const markers = master.markers
    .flatMap((m) => {
      const f = F(m.at);
      if (m.kind === 'beat' || m.kind === 'downbeat') return f < end ? [{ ...m, at: T(f) }] : [];
      const seg =
        segs.find((x) => !x.dropped && f >= x.masterStart && f < x.masterStart + x.masterLen) ??
        segs.find((x) => !x.dropped && f === x.masterStart + x.masterLen);
      const p = seg && placed.get(seg.key);
      if (!seg || !p) return [];
      const g = p.start + Math.min(f - seg.masterStart, p.len);
      return g <= end ? [{ ...m, at: T(g) }] : [];
    })
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  const timeline = Timeline.parse({
    id: `tl_${variant.id}`.slice(0, 64),
    name: variant.name || format.name,
    variantId: variant.id,
    formatTargetId: format.id,
    frameRate: rate,
    resolution: format.resolution,
    sampleRate: master.sampleRate,
    tracks,
    markers,
    extensions: {
      core: { variant: { from: master.id, version: VARIANT_DERIVATION_VERSION } },
    },
  });

  const reports: VariantSlotReport[] = segs.map((s) => {
    const notes = s.notes.length ? `; ${s.notes.join('; ')}` : '';
    if (s.dropped) return report(s, 'dropped', 0, s.dropped + notes);
    const fate: SlotFate =
      s.len < s.masterLen ? 'shortened' : s.len > s.masterLen ? 'lengthened' : 'kept';
    const what =
      fate === 'kept'
        ? 'as in the master'
        : `${fate} from ${secs(s.masterLen, fps)} s to ${secs(s.len, fps)} s${variant.overrides[s.slot.id]?.duration ? ' (retimed by hand)' : ` to fit ${goal}`}`;
    return report(s, fate, T(s.len), what + notes);
  });
  for (const { slot } of slots.values())
    if (!raw.has(slot.id))
      reports.push({
        slotId: slot.id,
        fate: 'dropped',
        masterDuration: 0,
        duration: 0,
        reason: 'not in the master cut',
      });
  function report(s: Segment, fate: SlotFate, duration: number, reason: string): VariantSlotReport {
    const r = reframes.get(s.slot.id);
    return {
      slotId: s.slot.id,
      fate,
      masterDuration: T(s.masterLen),
      duration,
      reason,
      ...(r && fate !== 'dropped' ? { reframe: { mode: r.mode, reason: r.reason } } : {}),
    };
  }

  const changed = segs.some((s) => s.dropped || s.len !== s.masterLen);
  if (changed && master.tracks.some((t) => t.kind === 'audio')) {
    if (!points.length)
      warnings.push(
        'the music plays on unchanged and no beats are known, so cuts after a shortened or dropped slot may fall off the beat',
      );
    for (const s of offBeat)
      warnings.push(
        `"${s.slot.title || s.slot.id}": no beat fits its length range, so the cut after it is off the beat`,
      );
  }

  return {
    timeline,
    target: T(target),
    duration: T(end),
    ...(shortfall ? { shortfall } : {}),
    slots: reports,
    warnings,
    inputHash: variantInputHash(input),
  };
}

/** Shift a trimmed clip's gain keyframes so a fade-out still ends with it. */
function retimeFade(item: TimelineItem, shift: number): TimelineItem {
  if (item.kind !== 'clip' || shift === 0) return item;
  const g: Animatable = item.gainDb;
  if (typeof g !== 'object' || Array.isArray(g)) return item;
  const keyframes: typeof g.keyframes = [];
  for (const k of g.keyframes) {
    const kf = { ...k, at: Math.max(0, k.at + shift) };
    if (keyframes.length && keyframes.at(-1)!.at >= kf.at) keyframes[keyframes.length - 1] = kf;
    else keyframes.push(kf);
  }
  return { ...item, gainDb: { keyframes } };
}

/**
 * Share `amount` whole units out in proportion to `caps`, never giving one more than its cap.
 * Largest remainders take the leftovers; ties go to the earlier one.
 */
export function share(amount: number, caps: readonly number[]): number[] {
  const total = caps.reduce((a, b) => a + b, 0);
  if (amount >= total) return [...caps];
  const base = caps.map((c) => Math.floor((amount * c) / total));
  let left = amount - base.reduce((a, b) => a + b, 0);
  const order = caps
    .map((c, i) => ({ i, r: (amount * c) % total }))
    .filter(({ i }) => base[i]! < caps[i]!)
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]!++;
    left--;
  }
  return base;
}

/** Derived variants by input hash; treat results as read-only. */
export class VariantCache {
  private readonly entries = new Map<string, DerivedVariant>();
  constructor(private readonly max = 16) {}

  get(input: VariantInput): DerivedVariant {
    const key = `${input.variantId}|${variantInputHash(input)}`;
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const derived = deriveVariant(input);
    this.entries.set(key, derived);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return derived;
  }
}

/**
 * The variants a project gets by default: one per format target that has none yet, at the
 * master's length. Returns `core/variants.add` payloads.
 */
export function defaultVariants(
  project: Pick<Project, 'storyboard' | 'formatTargets'>,
): { formatTargetId: string; name: string }[] {
  const have = new Set(project.storyboard?.variants.map((v) => v.formatTargetId) ?? []);
  return project.formatTargets
    .filter((f) => !have.has(f.id))
    .map((f) => ({ formatTargetId: f.id, name: f.name }));
}
