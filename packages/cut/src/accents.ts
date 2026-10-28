import {
  FlashRiskError,
  assertFlashSafe,
  builtinFilters,
  flashEvents,
  planSfx,
  sfxTracks,
  type FilterRegistry,
  type FlashEvent,
  type SfxOption,
} from '@trailerforge/effects';
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  itemEnd,
  snapToFrame,
  type Animatable,
  type Slot,
  type Storyboard,
  type Timeline,
  type TimelineItem,
  type Transition,
} from '@trailerforge/schema';

/**
 * The storyboard's accents on a cut: a slot's effects on its items, its transition in from the
 * item before it, and the sound cues with the music ducked under them. Pure and deterministic;
 * every accent gets a decision record. Applied after the rough cut is built, and again after a
 * rebuild merges hand edits, so the storyboard stays the source of the picks.
 */

const F = FLICKS_PER_SECOND;
const secs = (f: number) => Math.round((f / F) * 100) / 100;

export interface SoundSetup {
  catalog: readonly SfxOption[];
  /** Sound option id (`generated:impact`, `user:boom.wav`) → library asset id. */
  assetIds: ReadonlyMap<string, string>;
  /** Peak level of the music track, dBFS (default -1). */
  musicPeakDb?: number;
}

export type Decide = (
  subjectId: string,
  slotId: string,
  choice: unknown,
  reasons: Record<string, unknown>,
  summary: string,
) => string;

/** A slot's effects as effect instances on one of its items. */
export function slotEffects(slot: Slot, itemId: string, decide: Decide) {
  return slot.effects.map((e, i) => {
    const id = `${itemId}_fx${i + 1}`.slice(0, 64);
    decide(
      id,
      slot.id,
      { effectId: e.effectId, params: e.params },
      { from: 'storyboard' },
      `Effect ${e.effectId.replace(/^core\//, '')} on "${slot.title || slot.id}", as the storyboard asks`,
    );
    return { id, effectId: e.effectId, enabled: true, params: e.params as Record<string, never> };
  });
}

export function applyAccents(
  timeline: Timeline,
  sb: Pick<Storyboard, 'sections' | 'music'>,
  decide: Decide,
  opts: { filters?: FilterRegistry; sound?: SoundSetup } = {},
): { timeline: Timeline; warnings: string[] } {
  const filters = opts.filters ?? builtinFilters();
  const warnings: string[] = [];
  const rate = timeline.frameRate;
  const fpf = flicksPerFrame(rate);
  const tracks = timeline.tracks.map((t) => ({
    ...t,
    transitions: [...t.transitions],
    items: [...t.items],
  }));
  const slots = sb.sections.flatMap((s) => s.slots);
  const flashes: FlashEvent[] = [];
  const ctx = (duration: number) => ({
    width: timeline.resolution.width,
    height: timeline.resolution.height,
    rate,
    duration: duration / F,
  });

  // A slot's transition in, from the item before it; and its transition out, into whatever
  // follows it (unless that slot asks for its own way in). In time order, so the flash guard
  // keeps the earlier ones.
  const pictureTracks = tracks.filter((t) => t.kind === 'video' || t.kind === 'graphics');
  const ins = new Set(slots.filter((s) => s.transitionIn).map((s) => s.id));
  interface Want {
    slot: Slot;
    ref: NonNullable<Slot['transitionIn']>;
    track: (typeof tracks)[number];
    to: TimelineItem;
    from?: TimelineItem;
  }
  const wanted: Want[] = [];
  for (const slot of slots) {
    for (const t of pictureTracks) {
      const own = t.items.filter((i) => i.slotId === slot.id).sort((a, b) => a.start - b.start);
      if (!own.length) continue;
      if (slot.transitionIn) wanted.push({ slot, ref: slot.transitionIn, track: t, to: own[0]! });
      if (slot.transitionOut) {
        const last = own.at(-1)!;
        const next = t.items.find((i) => i.start === itemEnd(last) && i.slotId !== slot.id);
        if (next && !(next.slotId && ins.has(next.slotId)))
          wanted.push({ slot, ref: slot.transitionOut, track: t, to: next, from: last });
      }
      break;
    }
  }
  wanted.sort((a, b) => a.to.start - b.to.start);
  for (const { slot, ref, track, to, from: known } of wanted) {
    const name = slot.title || slot.id;
    const out = known !== undefined;
    const def = filters.get(ref.transitionId);
    if (def?.kind !== 'transition') {
      warnings.push(
        `"${name}": transition ${ref.transitionId} is not installed; a hard cut instead`,
      );
      continue;
    }
    if (track.transitions.some((x) => x.toItemId === to.id)) continue;
    const from = known ?? track.items.find((i) => itemEnd(i) === to.start && i.id !== to.id);
    if (!from) {
      warnings.push(
        `"${name}": the ${ref.transitionId.replace(/^core\//, '')} transition needs the item before it on the same track (a card next to a shot is not supported yet); a hard cut instead`,
      );
      continue;
    }
    const want = snapToFrame(Math.round(ref.duration * F), rate);
    const duration = Math.max(
      fpf,
      Math.min(want, snapToFrame(Math.min(from.duration, to.duration), rate)),
    );
    const at = (to.start - duration / 2) / F;
    const events = flashEvents(def, ref.params, ctx(duration), at);
    try {
      assertFlashSafe([...flashes, ...events]);
    } catch (err) {
      if (!(err instanceof FlashRiskError)) throw err;
      warnings.push(
        `"${name}": the ${def.name.toLowerCase()} was left out: with it the cut would flash more than three times in a second, unsafe for viewers with photosensitive epilepsy`,
      );
      continue;
    }
    flashes.push(...events);
    const id = `tr_${slot.id}${out ? '_out' : ''}`.slice(0, 64);
    const decisionId = decide(
      id,
      slot.id,
      { transitionId: ref.transitionId, duration, params: ref.params },
      { from: 'storyboard', seconds: secs(duration) },
      `${def.name} ${out ? 'out of' : 'into'} "${name}" over ${secs(duration)} s, as the storyboard asks`,
    );
    const tr: Transition = {
      id,
      transitionId: ref.transitionId,
      fromItemId: from.id,
      toItemId: to.id,
      duration,
      params: ref.params,
      decisionId,
    };
    track.transitions.push(tr);
  }

  // Sound cues.
  const cues = sb.music.sfxCues.filter((c) => c.kind !== 'custom').length;
  let next: Timeline = { ...timeline, tracks };
  if (opts.sound) {
    const plan = planSfx({
      storyboard: sb,
      timeline: next,
      catalog: opts.sound.catalog,
      ...(opts.sound.musicPeakDb !== undefined ? { musicPeakDb: opts.sound.musicPeakDb } : {}),
    });
    warnings.push(...plan.warnings);
    const { tracks: sfx, missing } = sfxTracks(plan, opts.sound.assetIds);
    for (const m of missing) warnings.push(`sound ${m} is not in the library yet; left out`);
    for (const p of plan.placements)
      if (sfx.some((t) => t.items.some((i) => i.id === p.id)))
        decide(
          p.id,
          p.cueId ? (sb.music.sfxCues.find((c) => c.id === p.cueId)?.slotId ?? '') : '',
          { option: p.option.id, start: p.start, gainDb: p.gainDb },
          { target: p.target, source: p.option.source },
          `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)} sound: ${p.reason}, at ${p.gainDb} dB`,
        );
    const ducked = duckMusic(tracks, plan.ducks, fpf);
    next = { ...next, tracks: [...ducked, ...sfx] };
  } else if (cues > 0) {
    warnings.push(
      `${cues} sound cue${cues === 1 ? ' is' : 's are'} not placed: no sound effects are set up yet`,
    );
  }
  return { timeline: next, warnings };
}

/** Lower the music under the sounds (two-frame ramps), keeping its fade-out at the end. */
function duckMusic(
  tracks: Timeline['tracks'],
  ducks: { start: number; duration: number; db: number }[],
  fpf: number,
) {
  if (!ducks.length) return tracks;
  return tracks.map((t) => {
    if (t.kind !== 'audio') return t;
    return {
      ...t,
      items: t.items.map((it) => {
        if (it.kind !== 'clip' || it.slotId || it.id !== 'rc_music') return it;
        return { ...it, gainDb: withDucks(it.gainDb, ducks, it.start, it.duration, 2 * fpf) };
      }),
    };
  });
}

/** Gain keyframes with dips for the ducks; a duck that would reach into the fade-out is left out. */
export function withDucks(
  gain: Animatable,
  ducks: { start: number; duration: number; db: number }[],
  itemStart: number,
  itemDuration: number,
  ramp: number,
): Animatable {
  const fade = typeof gain === 'object' && !Array.isArray(gain) ? gain.keyframes : [];
  const fadeStart = fade.length ? fade[0]!.at : itemDuration;
  const pts: { at: number; value: number }[] = [];
  for (const d of [...ducks].sort((a, b) => a.start - b.start)) {
    const s = d.start - itemStart;
    const e = s + d.duration;
    if (e + ramp > fadeStart) continue;
    const cand = [
      { at: Math.max(0, s - ramp), value: 0 },
      { at: Math.max(1, s), value: -d.db },
      { at: e, value: -d.db },
      { at: e + ramp, value: 0 },
    ];
    for (const p of cand) if (!pts.length || p.at > pts.at(-1)!.at) pts.push(p);
  }
  if (!pts.length) return gain;
  const all = [
    ...pts,
    ...fade
      .map((k) => ({ at: k.at, value: k.value as number }))
      .filter((k) => k.at > pts.at(-1)!.at),
  ];
  return { keyframes: all.map((p) => ({ at: p.at, value: p.value, easing: 'linear' as const })) };
}

/** Items of a slot, for tests and the inspector. */
export const itemsOf = (tl: Timeline, slotId: string): TimelineItem[] =>
  tl.tracks.flatMap((t) => t.items.filter((i) => i.slotId === slotId));
