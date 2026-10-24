import {
  DecisionRecord,
  FLICKS_PER_SECOND,
  Timeline,
  flicksPerFrame,
  type CardSlot,
  type Rate,
  type Resolution,
  type ShotSlot,
  type Storyboard,
  type TimelineItem,
} from '@trailerforge/schema';
import type { MusicGrid } from './grid.js';
import { layoutOnGrid } from './layout.js';

/**
 * The first rough cut: the storyboard laid on the music's beat grid, each shot filled from its
 * best take at its best moment, cut a frame ahead of the beat, the music underneath fading out on
 * the last bar, and a reason for every item. Pure and deterministic: the same inputs give the
 * same timeline (decision times come from `now` and are not part of it). Browser-safe.
 */

/** What the cut needs from a footage analysis (`FootageAnalysis` in `@trailerforge/analysis`). */
export interface FootageFacts {
  rate: Rate;
  frameCount: number;
  duration: number;
  scenes: readonly number[];
  black: readonly { start: number; end: number }[];
  flashes: readonly number[];
  frozen: readonly { start: number; end: number }[];
  motion: readonly number[];
}

export interface TakeSource {
  /** Length of the recording, flicks. */
  duration: number;
  /** Footage analysis, when it has run. */
  footage?: FootageFacts;
}

export interface RoughCutInput {
  storyboard: Pick<Storyboard, 'sections' | 'music'>;
  grid: MusicGrid;
  /** Per library asset id. Takes whose asset is missing here cannot be used yet. */
  sources: ReadonlyMap<string, TakeSource>;
  timeline: { id: string; name?: string; frameRate: Rate; resolution: Resolution };
  /** For decision timestamps only. */
  now: Date;
  options?: RoughCutOptions;
}

export interface RoughCutOptions {
  /** Cut this many frames ahead of the beat (1 or 2; default 1). */
  leadFrames?: number;
  /** Keep this much of each take unused at both ends (default 0.5 s). */
  handleSeconds?: number;
  /** Fade the music out over this many bars at the end (default 1). */
  fadeBars?: number;
  omitSlotIds?: ReadonlySet<string>;
}

export interface RoughCut {
  timeline: Timeline;
  decisions: DecisionRecord[];
  warnings: string[];
}

export const ROUGH_CUT_STEP = 'core/rough-cut';
/** Shorter than this is a flash frame in the edit, not a shot. */
const MIN_ITEM_SECONDS = 0.25;
const SEARCH_STEP_SECONDS = 0.1;
const EDGE_FRAMES = 3;
/**
 * Motion that counts as fully busy: a mean luma change of 10 levels per frame (the analysis
 * series is x10). An absolute scale, so takes compare with each other.
 */
const BUSY_MOTION = 100;

/** 53-bit hash, hex: deterministic ids without Node's crypto. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const secs = (f: number) => Math.round((f / FLICKS_PER_SECOND) * 100) / 100;

interface Window {
  sourceIn: number;
  /** 0 clean; 1 crosses a shot change or has a flash at its edges; 2 includes black or frozen picture. */
  level: number;
  score: number;
  why: string[];
}

/** The best stretch of `length` flicks in a take. */
function bestWindow(
  src: TakeSource,
  length: number,
  handle: number,
  hint?: { in?: number; out?: number },
): Window | null {
  if (src.duration < length) return null;
  let lo = Math.max(0, hint?.in ?? 0);
  let hi = Math.min(src.duration, hint?.out ?? src.duration);
  if (hi - lo < length) {
    lo = 0;
    hi = src.duration;
  }
  const h = Math.min(handle, Math.floor((hi - lo - length) / 2));
  lo += h;
  hi -= h;
  const f = src.footage;
  if (!f || f.frameCount === 0) {
    return {
      sourceIn: Math.round(lo + (hi - lo - length) / 2),
      level: 0,
      score: 0,
      why: ['no footage analysis yet: the middle of the take'],
    };
  }
  const sp = flicksPerFrame(f.rate);
  const toFrame = (t: number) => Math.round(t / sp);
  const len = Math.ceil(length / sp);
  const first = Math.ceil(lo / sp);
  const last = Math.floor((hi - length) / sp);
  if (last < first)
    return {
      sourceIn: Math.round(lo),
      level: 0,
      score: 0,
      why: ['the take only just covers the shot'],
    };
  const prefix = [0];
  for (const m of f.motion) prefix.push(prefix.at(-1)! + m);
  const mean = (a: number, b: number) => {
    const x = Math.max(0, Math.min(a, f.motion.length));
    const y = Math.max(x, Math.min(b, f.motion.length));
    return y > x ? (prefix[y]! - prefix[x]!) / (y - x) : 0;
  };
  const bad = [...f.black, ...f.frozen].map((r) => [toFrame(r.start), toFrame(r.end)] as const);
  const scenes = f.scenes.map(toFrame);
  const flashes = f.flashes.map(toFrame);
  const step = Math.max(1, Math.round((SEARCH_STEP_SECONDS * FLICKS_PER_SECOND) / sp));
  const tail = Math.max(1, Math.round((0.3 * FLICKS_PER_SECOND) / sp));

  let best: (Window & { at: number }) | null = null;
  for (let s = first; s <= last; s += step) {
    const e = s + len;
    const why: string[] = [];
    let level = 0;
    if (bad.some(([a, b]) => s < b && e > a)) {
      level = 2;
      why.push('includes black or frozen picture');
    } else {
      if (scenes.some((c) => c > s && c < e)) {
        level = 1;
        why.push('crosses a shot change in the recording');
      }
      if (flashes.some((x) => (x >= s && x < s + EDGE_FRAMES) || (x >= e - EDGE_FRAMES && x < e))) {
        level = 1;
        why.push('a flash frame at a cut');
      }
    }
    const inside = flashes.filter((x) => x >= s && x < e).length;
    const score =
      Math.min(1, (0.7 * mean(s, e) + 0.3 * mean(e - tail, e)) / BUSY_MOTION) - 0.05 * inside;
    if (!best || level < best.level || (level === best.level && score > best.score + 1e-9)) {
      best = {
        sourceIn: Math.min(Math.round(s * sp), src.duration - length),
        level,
        score,
        why,
        at: s,
      };
    }
  }
  if (!best) return null;
  const { at: _at, ...w } = best;
  if (w.level === 0)
    w.why.push(
      'clean: no shot change, black, frozen or flash frames at the cuts',
      `motion ${Math.round(w.score * 100)}% of busy`,
    );
  return w;
}

export function buildRoughCut(input: RoughCutInput): RoughCut {
  const { storyboard: sb, grid, sources } = input;
  const o = input.options ?? {};
  const fpf = flicksPerFrame(input.timeline.frameRate);
  const toFrameGrid = (t: number) => Math.round(Math.round(t / fpf) * fpf);
  const lead = Math.max(0, Math.min(2, o.leadFrames ?? 1));
  const handle = Math.round((o.handleSeconds ?? 0.5) * FLICKS_PER_SECOND);
  const minItem = Math.max(fpf * 6, MIN_ITEM_SECONDS * FLICKS_PER_SECOND);
  const warnings: string[] = [];

  const layout = layoutOnGrid(sb, grid, o.omitSlotIds ? { omitSlotIds: o.omitSlotIds } : {});
  warnings.push(...layout.warnings);
  const slotById = new Map(sb.sections.flatMap((s) => s.slots).map((s) => [s.id, s]));
  const beatSet = new Set(grid.beats);

  // Cut points: a frame or two ahead of the beat, on the timeline's frame grid; the first starts
  // at zero and the last stays on its bar for the music fade.
  const ends = layout.slots.map((x, i) =>
    i === layout.slots.length - 1
      ? toFrameGrid(x.end)
      : toFrameGrid(beatSet.has(x.end) ? x.end - lead * fpf : x.end),
  );
  const starts = ends.map((_, i) => (i === 0 ? 0 : ends[i - 1]!));

  const picture: TimelineItem[] = [];
  const cards: TimelineItem[] = [];
  const decisions: DecisionRecord[] = [];
  const decide = (
    itemId: string,
    slotId: string,
    choice: unknown,
    reasons: Record<string, unknown>,
    summary: string,
  ) => {
    const inputsHash = hash(JSON.stringify({ itemId, slotId, choice, reasons }));
    const rec = DecisionRecord.parse({
      id: `dec_${hash(`${ROUGH_CUT_STEP}|${itemId}|${inputsHash}`)}`,
      at: input.now.toISOString(),
      step: ROUGH_CUT_STEP,
      subject: { kind: 'item', id: itemId },
      choice: choice as never,
      reasons: reasons as never,
      summary,
    });
    decisions.push(rec);
    return rec.id;
  };

  layout.slots.forEach((ls, i) => {
    const start = starts[i]!;
    const duration = ends[i]! - start;
    const slot = slotById.get(ls.slotId)!;
    const id = `rc_${ls.slotId}`;
    const timing = {
      beatAligned: beatSet.has(ls.end),
      leadFrames: i < layout.slots.length - 1 && beatSet.has(ls.end) ? lead : 0,
      seconds: secs(duration),
    };
    if (duration <= 0) return;
    if (duration < minItem)
      warnings.push(`"${slot.title || slot.id}" is only ${secs(duration)} s long in the cut`);

    if (slot.kind === 'card') {
      const card = slot as CardSlot;
      const decisionId = decide(
        id,
        slot.id,
        { templateId: card.templateId },
        timing,
        `Card "${card.title || card.cardKind}" for ${secs(duration)} s`,
      );
      cards.push({
        id,
        kind: 'graphic',
        start,
        duration,
        slotId: slot.id,
        decisionId,
        label: card.title || card.cardKind,
        templateId: card.templateId,
        params: { ...card.params, text: card.text },
        effects: [],
        extensions: {},
      });
      return;
    }

    const shot = slot as ShotSlot;
    const takes = shot.takes.filter((t) => !t.rejected);
    const chosen = shot.chosenTakeId ? takes.find((t) => t.id === shot.chosenTakeId) : undefined;
    const candidates = (chosen ? [chosen] : takes)
      .map((t, order) => {
        const src = sources.get(t.assetId);
        const hint = {
          ...(t.sourceIn !== undefined ? { in: t.sourceIn } : {}),
          ...(t.sourceOut !== undefined ? { out: t.sourceOut } : {}),
        };
        return { t, src, order, w: src ? bestWindow(src, duration, handle, hint) : null };
      })
      .filter((c) => c.src !== undefined);
    const usable = candidates
      .filter((c) => c.w)
      .sort((a, b) => a.w!.level - b.w!.level || b.w!.score - a.w!.score || a.order - b.order);
    const pick = usable[0];

    if (!pick) {
      // Footage missing, or every take is shorter than the shot: keep the slot visible.
      const short = candidates.sort((a, b) => b.src!.duration - a.src!.duration)[0];
      if (short && short.src!.duration >= minItem) {
        const clipLen = Math.min(duration, toFrameGrid(short.src!.duration) || short.src!.duration);
        const decisionId = decide(
          id,
          shot.id,
          { takeId: short.t.id, sourceIn: 0 },
          { ...timing, take: 'longest take, shorter than the shot' },
          `"${shot.title || shot.id}": the takes are shorter than ${secs(duration)} s; used all ${secs(clipLen)} s of ${short.t.id}`,
        );
        picture.push({
          id,
          kind: 'clip',
          start,
          duration: clipLen,
          slotId: shot.id,
          decisionId,
          label: shot.title || undefined,
          assetId: short.t.assetId,
          sourceIn: 0,
          speed: 1,
          effects: [],
          gainDb: 0,
          muted: false,
          extensions: {},
        });
        if (duration - clipLen > 0) {
          picture.push({
            id: `${id}_rest`,
            kind: 'placeholder',
            start: start + clipLen,
            duration: duration - clipLen,
            slotId: shot.id,
            decisionId,
            reason: 'missing-footage',
            note: 'the take is shorter than the shot',
            extensions: {},
          });
        }
        return;
      }
      const note =
        takes.length === 0
          ? 'not recorded yet'
          : 'recording not ready (not imported or not probed yet)';
      const decisionId = decide(
        id,
        shot.id,
        { placeholder: true },
        { ...timing, takes: takes.length },
        `"${shot.title || shot.id}": ${note}`,
      );
      picture.push({
        id,
        kind: 'placeholder',
        start,
        duration,
        slotId: shot.id,
        decisionId,
        label: shot.title || undefined,
        reason: 'missing-footage',
        note,
        extensions: {},
      });
      return;
    }

    const w = pick.w!;
    const takeWhy = chosen
      ? 'the take you chose'
      : takes.length === 1
        ? 'the only take'
        : `best of ${usable.length} takes`;
    const decisionId = decide(
      id,
      shot.id,
      { takeId: pick.t.id, assetId: pick.t.assetId, sourceIn: w.sourceIn, duration },
      {
        ...timing,
        take: takeWhy,
        window: w.why,
        level: w.level,
        score: Math.round(w.score * 1000) / 1000,
        alternatives: usable.slice(1).map((c) => c.t.id),
      },
      `"${shot.title || shot.id}": ${takeWhy}, from ${secs(w.sourceIn)} s for ${secs(duration)} s${timing.leadFrames ? `, cut ${timing.leadFrames} frame ahead of the beat` : ''}`,
    );
    if (w.level > 0)
      warnings.push(
        `"${shot.title || shot.id}": no clean stretch in the take (${w.why.join('; ')})`,
      );
    picture.push({
      id,
      kind: 'clip',
      start,
      duration,
      slotId: shot.id,
      decisionId,
      label: shot.title || undefined,
      assetId: pick.t.assetId,
      sourceIn: w.sourceIn,
      speed: 1,
      effects: [],
      gainDb: 0,
      muted: false,
      extensions: {},
    });
  });

  const end = ends.at(-1) ?? 0;
  const tracks: Timeline['tracks'] = [
    {
      id: 'trk_picture',
      kind: 'video',
      name: 'Picture',
      muted: false,
      locked: false,
      items: picture,
      transitions: [],
    },
  ];
  if (cards.length)
    tracks.push({
      id: 'trk_cards',
      kind: 'graphics',
      name: 'Cards',
      muted: false,
      locked: false,
      items: cards,
      transitions: [],
    });

  const musicId = sb.music.trackAssetId;
  if (musicId && end > 0) {
    const musicEnd = Math.min(end, grid.duration);
    const barLen =
      grid.bars.length > 1
        ? (grid.bars.at(-1)! - grid.bars[0]!) / (grid.bars.length - 1)
        : FLICKS_PER_SECOND;
    const fade = Math.min(musicEnd, Math.round(barLen * (o.fadeBars ?? 1)));
    const decisionId = decide(
      'rc_music',
      '',
      { assetId: musicId, duration: musicEnd },
      { fadeSeconds: secs(fade), tempo: grid.tempo },
      `Music under the whole cut, fading out over the last ${secs(fade)} s`,
    );
    tracks.push({
      id: 'trk_music',
      kind: 'audio',
      name: 'Music',
      muted: false,
      locked: false,
      transitions: [],
      items: [
        {
          id: 'rc_music',
          kind: 'clip',
          start: 0,
          duration: musicEnd,
          decisionId,
          label: 'Music',
          assetId: musicId,
          sourceIn: 0,
          speed: 1,
          effects: [],
          muted: false,
          extensions: {},
          gainDb:
            fade > 0 && fade < musicEnd
              ? {
                  keyframes: [
                    { at: musicEnd - fade, value: 0, easing: 'linear' },
                    { at: musicEnd, value: -60, easing: 'linear' },
                  ],
                }
              : 0,
        },
      ],
    });
  } else
    warnings.push(
      'no music track: the cut follows the storyboard lengths without a beat to land on',
    );

  const markers: Timeline['markers'] = [
    ...grid.bars
      .filter((b) => b < end)
      .map((at, n) => ({ id: `mk_bar_${n}`, at, kind: 'downbeat' as const, label: '' })),
    ...layout.sections
      .filter((s) => s.end > s.start && s.start < end)
      .map((s) => ({
        id: `mk_sec_${s.sectionId}`,
        at: s.start,
        kind: 'section' as const,
        label: sb.sections.find((x) => x.id === s.sectionId)?.name ?? '',
      })),
    ...layout.hits
      .filter((h) => h.at <= end)
      .map((h) => ({
        id: `mk_hit_${h.id}`,
        at: Math.min(h.at, end),
        kind: 'hit' as const,
        label: h.kind,
      })),
  ].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  const timeline = Timeline.parse({
    id: input.timeline.id,
    name: input.timeline.name ?? 'Rough cut',
    frameRate: input.timeline.frameRate,
    resolution: input.timeline.resolution,
    tracks,
    markers,
    extensions: { core: { roughCut: { generator: ROUGH_CUT_STEP, version: 1 } } },
  });
  return { timeline, decisions, warnings };
}

/** Stable hash of a timeline, for checking that the same inputs give the same cut. */
export const timelineHash = (t: Timeline) => hash(JSON.stringify(t));
