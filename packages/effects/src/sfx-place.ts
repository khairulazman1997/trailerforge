import {
  FLICKS_PER_SECOND,
  itemEnd,
  snapToFrame,
  type ClipItem,
  type Storyboard,
  type Timeline,
  type Track,
} from '@trailerforge/schema';
import { SFX_KINDS, SFX_PEAK, SFX_SPECS, type SfxKind } from './sfx-synth.js';

/**
 * Where sound effects go and how loud they are. Pure and deterministic; browser-safe.
 *
 * Cues in the storyboard (a kind on a slot, before, at the start or at the end) and the cuts
 * where a whip, flash or zoom punch sits each become a placement. The sound's loudest moment is
 * lined up with the cut or the music's hit point, on the frame grid. Levels: every kind has a
 * base gain, and where sounds overlap the music is ducked just enough, and the sounds eased
 * if need be, that music plus sounds stay under the mix ceiling.
 */

const F = FLICKS_PER_SECOND;

/** What a sound is: a generated one or a file from the user's SFX folder. */
export interface SfxOption {
  /** `generated:<kind>` or `user:<file name>`. */
  id: string;
  source: 'generated' | 'user';
  kind: SfxKind | 'custom';
  /** Length, flicks. */
  duration: number;
  /** Where its loudest moment is, share of the length. */
  peakOffset: number;
  /** Peak level of the file, dBFS. */
  peakDb: number;
}

const toDb = (lin: number) => 20 * Math.log10(lin);
const toLin = (db: number) => 10 ** (db / 20);

/** The generated sounds, as catalog entries. */
export function generatedCatalog(): SfxOption[] {
  return SFX_KINDS.map((kind) => ({
    id: `generated:${kind}`,
    source: 'generated',
    kind,
    duration: Math.round(SFX_SPECS[kind].seconds * F),
    peakOffset: SFX_SPECS[kind].peakOffset,
    peakDb: toDb(SFX_PEAK),
  }));
}

/** Transitions that carry a sound, and which. */
export const TRANSITION_SFX: Readonly<Record<string, SfxKind>> = {
  'core/whip': 'whoosh',
  'core/flash': 'impact',
  'core/zoom-punch': 'impact',
};

/** A tiny stable hash for deterministic choices. */
function pickIndex(key: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

/**
 * The sound for a kind: the user's own files first (they are licensed or chosen on purpose),
 * else the generated one. Several user files of a kind are shared out by `key`, so the same cue
 * always gets the same file.
 */
export function pickSfx(
  kind: SfxKind,
  catalog: readonly SfxOption[],
  key: string,
): SfxOption | undefined {
  const user = catalog
    .filter((o) => o.source === 'user' && o.kind === kind)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (user.length) return user[pickIndex(key, user.length)];
  return catalog.find((o) => o.source === 'generated' && o.kind === kind);
}

export interface SfxPlacement {
  /** Stable: `sfx_<cue or transition id>`. */
  id: string;
  cueId?: string;
  transitionId?: string;
  option: SfxOption;
  kind: SfxKind;
  /** On the timeline, flicks (frame grid). */
  start: number;
  duration: number;
  /** Start inside the sound's file (a sound that would begin before the cut starts later). */
  sourceIn: number;
  /** Where its loudest moment lands, flicks: the hit point, cut or slot edge asked for. */
  target: number;
  gainDb: number;
  reason: string;
}

export interface MusicDuck {
  start: number;
  duration: number;
  /** Music reduction, dB (positive). */
  db: number;
}

export interface SfxPlan {
  placements: SfxPlacement[];
  ducks: MusicDuck[];
  warnings: string[];
}

export interface SfxInput {
  storyboard: Pick<Storyboard, 'music'>;
  timeline: Timeline;
  catalog: readonly SfxOption[];
  /** Peak level of the music on the cut, dBFS (default -1: normalised to the mix ceiling). */
  musicPeakDb?: number;
  /** Mix ceiling, dBFS (default -1, the platforms' true-peak limit). */
  ceilingDb?: number;
  /** Most the music is lowered under sounds, dB (default 9). */
  maxDuckDb?: number;
}

interface Edges {
  start: number;
  end: number;
}

/** Slot → its picture span on the cut (video, plus graphics for cards). */
function slotEdges(tl: Timeline): Map<string, Edges> {
  const out = new Map<string, Edges>();
  for (const tr of tl.tracks) {
    if (tr.kind !== 'video' && tr.kind !== 'graphics') continue;
    for (const it of tr.items) {
      if (!it.slotId) continue;
      const e = out.get(it.slotId);
      out.set(it.slotId, {
        start: Math.min(e?.start ?? Infinity, it.start),
        end: Math.max(e?.end ?? 0, itemEnd(it)),
      });
    }
  }
  return out;
}

export function planSfx(input: SfxInput): SfxPlan {
  const { timeline: tl, storyboard: sb } = input;
  const rate = tl.frameRate;
  const warnings: string[] = [];
  const edges = slotEdges(tl);
  const markers = new Map(tl.markers.map((m) => [m.id, m.at]));
  const placements: SfxPlacement[] = [];

  const place = (p: {
    id: string;
    cueId?: string;
    transitionId?: string;
    kind: SfxKind;
    target: number;
    reason: string;
  }) => {
    const option = pickSfx(p.kind, input.catalog, p.id);
    if (!option) {
      warnings.push(`no ${p.kind} sound is available for ${p.id}`);
      return;
    }
    const target = snapToFrame(p.target, rate);
    const peakAt = Math.round(option.peakOffset * option.duration);
    let start = snapToFrame(target - peakAt, rate);
    let duration = option.duration;
    let sourceIn = 0;
    if (start < 0) {
      // Would begin before the cut starts: begin later in the file; the loudest moment stays put.
      sourceIn = -start;
      duration -= sourceIn;
      start = 0;
      if (duration <= 0) {
        warnings.push(`${p.id}: the sound would end before the cut starts; left out`);
        return;
      }
    }
    placements.push({
      id: `sfx_${p.id}`,
      ...(p.cueId ? { cueId: p.cueId } : {}),
      ...(p.transitionId ? { transitionId: p.transitionId } : {}),
      option,
      kind: p.kind,
      start,
      duration,
      sourceIn,
      target,
      gainDb: SFX_SPECS[p.kind].gainDb,
      reason: p.reason,
    });
  };

  // Cues from the storyboard.
  const hitFor = (slotId: string) => sb.music.hitPoints.find((h) => h.slotId === slotId);
  for (const cue of sb.music.sfxCues) {
    if (cue.kind === 'custom') continue; // a custom cue names its own asset; applied by the cut
    const e = edges.get(cue.slotId);
    if (!e) continue; // the slot is not in this cut (a shorter version)
    const hit = hitFor(cue.slotId);
    const hitAt =
      hit && (hit.kind === 'impact' || hit.kind === 'drop')
        ? markers.get(`mk_hit_${hit.id}`)
        : undefined;
    const atEnd = cue.position === 'end';
    const onHit =
      hitAt !== undefined && !atEnd && (cue.kind === 'impact' || cue.kind === 'sub-drop');
    place({
      id: cue.id,
      cueId: cue.id,
      kind: cue.kind,
      target: onHit ? hitAt : atEnd ? e.end : e.start,
      reason: onHit
        ? `${cue.kind} on the music's hit point at the start of "${cue.slotId}"`
        : `${cue.kind} ${cue.position === 'before' ? 'leading into' : atEnd ? 'at the end of' : 'at the start of'} "${cue.slotId}"`,
    });
  }

  // Cuts with a whip, flash or zoom punch.
  for (const tr of tl.tracks) {
    for (const t of tr.transitions) {
      const kind = TRANSITION_SFX[t.transitionId];
      const to = tr.items.find((i) => i.id === t.toItemId);
      if (!kind || !to) continue;
      const near = placements.some(
        (p) => p.kind === kind && Math.abs(p.target - to.start) < 0.25 * F,
      );
      if (near) continue; // a cue already puts this sound on this cut
      place({
        id: t.id,
        transitionId: t.id,
        kind,
        target: to.start,
        reason: `${kind} on the ${t.transitionId.replace('core/', '')} transition`,
      });
    }
  }
  placements.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));

  const { ducks } = applyMixRules(placements, input);
  return { placements, ducks, warnings };
}

/**
 * Level rules under the music. Sounds that overlap form a cluster. Within a cluster the sounds'
 * peaks add up in the worst case; the music is lowered (by at most `maxDuckDb`) so that music and
 * sounds together stay under the ceiling, and if that is not enough the sounds are eased down.
 * Changes `gainDb` in place; returns the ducks.
 */
export function applyMixRules(
  placements: SfxPlacement[],
  opts: { musicPeakDb?: number; ceilingDb?: number; maxDuckDb?: number } = {},
): { ducks: MusicDuck[] } {
  const musicLin = toLin(opts.musicPeakDb ?? -1);
  const ceilingLin = toLin(opts.ceilingDb ?? -1);
  const maxDuck = opts.maxDuckDb ?? 9;
  const ducks: MusicDuck[] = [];
  const sorted = [...placements].sort((a, b) => a.start - b.start);
  const clusters: SfxPlacement[][] = [];
  let end = -Infinity;
  for (const p of sorted) {
    if (clusters.length && p.start < end) clusters.at(-1)!.push(p);
    else clusters.push([p]);
    end = Math.max(end, p.start + p.duration);
  }
  const peak = (p: SfxPlacement) => toLin(p.option.peakDb + p.gainDb);
  for (const cluster of clusters) {
    const from = Math.min(...cluster.map((p) => p.start));
    const to = Math.max(...cluster.map((p) => p.start + p.duration));
    const sfx = cluster.reduce((a, p) => a + peak(p), 0);
    const allowed = ceilingLin - musicLin * toLin(-maxDuck);
    // A little under the limit, so rounding the duck up to 0.1 dB cannot pass `maxDuckDb`.
    if (sfx > allowed * 0.98) for (const p of cluster) p.gainDb += toDb((allowed * 0.98) / sfx);
    const sfxNow = cluster.reduce((a, p) => a + peak(p), 0);
    const room = ceilingLin - sfxNow;
    const duck =
      musicLin > room ? Math.min(maxDuck, Math.ceil(toDb(musicLin / room) * 10) / 10) : 0;
    if (duck > 0) ducks.push({ start: from, duration: to - from, db: duck });
  }
  for (const p of placements) p.gainDb = Math.round(p.gainDb * 100) / 100;
  return { ducks };
}

/**
 * Audio tracks for the placements: sounds that overlap go on lanes of their own (`trk_sfx`,
 * `trk_sfx_2`…), because a track holds one thing at a time and an impact with a sub-drop under
 * it is the usual case. `assetIds` maps an option id (`generated:whoosh`, `user:boom.wav`) to its
 * library asset id; placements without one are left out and reported in `missing`.
 */
export function sfxTracks(
  plan: SfxPlan,
  assetIds: ReadonlyMap<string, string>,
): { tracks: Track[]; missing: string[] } {
  const missing: string[] = [];
  const lanes: { end: number; items: ClipItem[] }[] = [];
  for (const p of plan.placements) {
    const assetId = assetIds.get(p.option.id);
    if (!assetId) {
      if (!missing.includes(p.option.id)) missing.push(p.option.id);
      continue;
    }
    const item: ClipItem = {
      id: p.id,
      kind: 'clip',
      start: p.start,
      duration: p.duration,
      label: `${p.kind} sound`,
      extensions: {},
      assetId,
      sourceIn: p.sourceIn,
      speed: 1,
      effects: [],
      gainDb: p.gainDb,
      muted: false,
    };
    const lane =
      lanes.find((l) => l.end <= item.start) ?? lanes[lanes.push({ end: 0, items: [] }) - 1]!;
    lane.items.push(item);
    lane.end = itemEnd(item);
  }
  return {
    tracks: lanes.map((l, i) => ({
      id: i === 0 ? 'trk_sfx' : `trk_sfx_${i + 1}`,
      kind: 'audio' as const,
      name: i === 0 ? 'Sound effects' : `Sound effects ${i + 1}`,
      muted: false,
      locked: false,
      items: l.items,
      transitions: [],
    })),
    missing,
  };
}
