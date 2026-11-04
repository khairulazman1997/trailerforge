import {
  DecisionRecord,
  FLICKS_PER_SECOND,
  Timeline,
  flicksPerFrame,
  type Animatable,
  type CardSlot,
  type Rate,
  type Resolution,
  type ShotSlot,
  type Storyboard,
  type Take,
  type TimelineItem,
  type VoLine,
} from '@trailerforge/schema';
import { applyAccents, type Decide, type SoundSetup } from './accents.js';
import { placeCaptions } from './captions.js';
import type { MusicGrid } from './grid.js';
import {
  buildRoughCut,
  slotFiller,
  stableHash,
  type RoughCut,
  type TakeSource,
} from './rough-cut.js';
import { pickStillMotions, stillMotion } from './stills.js';

/**
 * The cut of a short (TikTok). With recorded voiceover the edit follows the voice: each slot
 * lasts as long as the lines spoken over it, cuts fall where a line ends, a long slot is shown
 * as several shots (no shot longer than `maxShotSeconds`), the hook is quick, and the music dips
 * under every line. Without voiceover it follows the music's beat grid like the trailer's rough
 * cut, or, with no analysed music, the storyboard's own lengths. Images get a slow move each
 * (never the same move twice in a row). Pure and deterministic, like `buildRoughCut`.
 */

export const SHORT_CUT_STEP = 'core/short-cut';

export interface ShortCutOptions {
  /** Beat-led: cut this many frames ahead of the beat (default 1). */
  leadFrames?: number;
  /** Keep this much of each take unused at both ends (default 0.5 s). */
  handleSeconds?: number;
  /** Longest a shot stays on screen before the picture changes (default 2.5 s). */
  maxShotSeconds?: number;
  /** Voice-led: the opening slot without voice lasts at most this long (default 1.5 s). */
  hookMaxSeconds?: number;
  /** Silence between voiceover lines (default 0.15 s). */
  lineGapSeconds?: number;
  /** How far the music dips under the voice, dB (default 12). */
  duckDb?: number;
  /** How much an image grows or travels (see `stillMotion`; default 0.18). */
  stillStrength?: number;
  sound?: SoundSetup;
}

export interface ShortCutInput {
  storyboard: Pick<Storyboard, 'sections' | 'music' | 'voLines'>;
  /** Recordings, images, voiceover and music files, per library asset id. */
  sources: ReadonlyMap<string, TakeSource>;
  /** The analysed music's grid, when there is music and it was analysed. */
  grid?: MusicGrid | null;
  timeline: { id: string; name?: string; frameRate: Rate; resolution: Resolution };
  now: Date;
  options?: ShortCutOptions;
}

export interface ShortCut extends RoughCut {
  /** What set the timing. */
  mode: 'voice' | 'beat' | 'plain';
}

const S = FLICKS_PER_SECOND;
const secs = (f: number) => Math.round((f / S) * 100) / 100;
const WORDS_PER_SECOND = 2.6;

const chosenTake = (v: VoLine): Take | undefined =>
  v.takes.find((t) => t.id === v.chosenTakeId) ?? v.takes.filter((t) => !t.rejected).at(-1);

interface VoicePart {
  line: VoLine;
  take: Take;
  sourceIn: number;
  length: number;
}

/** The recorded part of each line that can be used, or null (not recorded, file not ready). */
function voiceOf(line: VoLine, sources: ReadonlyMap<string, TakeSource>): VoicePart | null {
  const take = chosenTake(line);
  const src = take ? sources.get(take.assetId) : undefined;
  if (!take || !src || src.still) return null;
  const sourceIn = Math.max(0, take.sourceIn ?? 0);
  const out = Math.min(src.duration, take.sourceOut ?? src.duration);
  return out > sourceIn ? { line, take, sourceIn, length: out - sourceIn } : null;
}

/** `base` plus a piecewise-linear curve that is 0 outside its points (both dB). */
export function addGain(
  base: Animatable,
  pts: readonly { at: number; value: number }[],
): Animatable {
  if (pts.length === 0) return base;
  const keys =
    typeof base === 'object' && !Array.isArray(base)
      ? base.keyframes.map((k) => ({ at: k.at, value: Number(k.value) }))
      : [];
  const constant = typeof base === 'number' ? base : Array.isArray(base) ? (base[0] ?? 0) : 0;
  const curve = (xs: { at: number; value: number }[], t: number, outside: number | 'hold') => {
    if (xs.length === 0) return outside === 'hold' ? constant : outside;
    if (t <= xs[0]!.at) return outside === 'hold' ? xs[0]!.value : t === xs[0]!.at ? xs[0]!.value : outside; // prettier-ignore
    if (t >= xs.at(-1)!.at) return outside === 'hold' ? xs.at(-1)!.value : t === xs.at(-1)!.at ? xs.at(-1)!.value : outside; // prettier-ignore
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = xs[i]!;
      const b = xs[i + 1]!;
      if (t >= a.at && t <= b.at)
        return b.at === a.at
          ? b.value
          : a.value + ((t - a.at) * (b.value - a.value)) / (b.at - a.at);
    }
    return xs.at(-1)!.value;
  };
  const times = [...new Set([...keys.map((k) => k.at), ...pts.map((p) => p.at)])].sort((a, b) => a - b); // prettier-ignore
  return {
    keyframes: times.map((at) => ({
      at,
      value: Math.round((curve(keys, at, 'hold') + curve([...pts], at, 0)) * 100) / 100,
      easing: 'linear' as const,
    })),
  };
}

export function buildShortCut(input: ShortCutInput): ShortCut {
  const { storyboard: sb, sources } = input;
  const o = input.options ?? {};
  const fpf = flicksPerFrame(input.timeline.frameRate);
  const grid = (t: number) => Math.round(Math.round(t / fpf) * fpf);
  const voices = sb.voLines.map((v) => voiceOf(v, sources));
  const voiced = voices.some(Boolean);
  const mode: ShortCut['mode'] = voiced ? 'voice' : input.grid ? 'beat' : 'plain';

  let cut: RoughCut;
  if (mode === 'beat') {
    cut = buildRoughCut({
      storyboard: sb,
      grid: input.grid!,
      sources,
      timeline: { ...input.timeline, name: input.timeline.name ?? 'TikTok' },
      now: input.now,
      options: {
        ...(o.leadFrames !== undefined ? { leadFrames: o.leadFrames } : {}),
        ...(o.handleSeconds !== undefined ? { handleSeconds: o.handleSeconds } : {}),
        ...(o.sound ? { sound: o.sound } : {}),
      },
    });
  } else cut = voiceOrPlain();

  // Images move: a slow push, pull or pan each, never the same twice in a row.
  const picture = cut.timeline.tracks.filter((t) => t.kind === 'video');
  const stills = picture.flatMap((t) =>
    t.items.filter((i) => i.kind === 'clip' && sources.get(i.assetId)?.still && !i.transform),
  );
  const moves = pickStillMotions(stills.map((i) => i.id));
  const motion = new Map(stills.map((i, k) => [i.id, moves[k]!]));
  const timeline = Timeline.parse({
    ...cut.timeline,
    tracks: cut.timeline.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) =>
        motion.has(i.id) && i.kind === 'clip'
          ? {
              ...i,
              transform: stillMotion({
                style: motion.get(i.id)!,
                duration: i.duration,
                ...(o.stillStrength !== undefined ? { strength: o.stillStrength } : {}),
              }),
            }
          : i,
      ),
    })),
    extensions: { core: { roughCut: { generator: SHORT_CUT_STEP, version: 1, mode } } },
  });
  const maxShot = (o.maxShotSeconds ?? 2.5) * S;
  const warnings = [...cut.warnings];
  for (const t of picture)
    for (const i of t.items)
      if (i.kind === 'clip' && !sources.get(i.assetId)?.still && i.duration > maxShot + fpf)
        warnings.push(`"${i.label ?? i.id}" stays on screen ${secs(i.duration)} s; short-form viewers expect a change every ${secs(maxShot)} s or so`); // prettier-ignore
  return { ...cut, timeline, warnings, mode };

  function voiceOrPlain(): RoughCut {
    const warnings: string[] = [];
    const decisions: DecisionRecord[] = [];
    const decide: Decide = (subjectId, _slotId, choice, reasons, summary) => {
      const inputsHash = stableHash(JSON.stringify({ subjectId, choice, reasons }));
      const rec = DecisionRecord.parse({
        id: `dec_${stableHash(`${SHORT_CUT_STEP}|${subjectId}|${inputsHash}`)}`,
        at: input.now.toISOString(),
        step: SHORT_CUT_STEP,
        subject: { kind: 'item', id: subjectId },
        choice: choice as never,
        reasons: reasons as never,
        summary,
      });
      decisions.push(rec);
      return rec.id;
    };
    const pictureItems: TimelineItem[] = [];
    const cards: TimelineItem[] = [];
    const fill = slotFiller({
      sources,
      fpf,
      handle: Math.round((o.handleSeconds ?? 0.5) * S),
      minItem: Math.max(fpf * 6, 0.25 * S),
      picture: pictureItems,
      cards,
      warnings,
      decide,
    });
    const gap = grid((o.lineGapSeconds ?? 0.15) * S);
    const hookMax = (o.hookMaxSeconds ?? 1.5) * S;
    const slots = sb.sections.flatMap((sec) => sec.slots.map((slot) => ({ sec, slot })));
    const slotIds = new Set(slots.map((x) => x.slot.id));

    // Each line belongs to the slot it is linked to; an unlinked line to the previous line's.
    const linesBySlot = new Map<string, number[]>();
    let previous = slots.find((x, k) => k > 0 && x.slot.kind === 'shot')?.slot.id ?? slots[0]?.slot.id; // prettier-ignore
    sb.voLines.forEach((v, k) => {
      const home = v.linkedSlotIds.find((id) => slotIds.has(id)) ?? previous;
      if (!home) return;
      previous = home;
      linesBySlot.set(home, [...(linesBySlot.get(home) ?? []), k]);
    });

    const voiceItems: TimelineItem[] = [];
    const markers: Timeline['markers'] = [];
    let t = 0;
    let seenSection = '';
    slots.forEach(({ sec, slot }, k) => {
      if (sec.id !== seenSection) {
        seenSection = sec.id;
        markers.push({ id: `mk_sec_${sec.id}`, at: t, kind: 'section', label: sec.name });
      }
      const start = t;
      const own = linesBySlot.get(slot.id) ?? [];
      let duration: number;
      if (mode === 'voice' && own.length > 0) {
        let at = start;
        for (const li of own) {
          const v = voices[li];
          const line = sb.voLines[li]!;
          if (!v) {
            const guess = grid(
              (line.targetDuration ??
                Math.max(1, line.text.split(/\s+/).length / WORDS_PER_SECOND)) * S,
            );
            warnings.push(`voiceover "${line.text}" is not recorded yet; ${secs(guess)} s of silence left for it`); // prettier-ignore
            at += guess + gap;
            continue;
          }
          const id = `rc_vo_${line.id}`;
          const len = grid(v.length) || fpf;
          const decisionId = decide(
            id,
            slot.id,
            { takeId: v.take.id, assetId: v.take.assetId, sourceIn: v.sourceIn, duration: len },
            { line: line.text, slot: slot.id },
            `Voiceover "${line.text}" over "${slot.title || slot.id}" for ${secs(len)} s`,
          );
          voiceItems.push({
            id,
            kind: 'clip',
            start: at,
            duration: len,
            slotId: slot.id,
            decisionId,
            label: line.text.slice(0, 60),
            assetId: v.take.assetId,
            sourceIn: v.sourceIn,
            speed: 1,
            effects: [],
            gainDb: 0,
            muted: false,
            extensions: {},
          });
          at += len + gap;
        }
        duration = grid(at - start);
      } else {
        duration = grid(slot.duration.ideal * S);
        if (mode === 'voice' && k === 0 && slot.kind === 'shot') duration = Math.min(duration, grid(hookMax)); // prettier-ignore
      }
      if (duration <= 0) return;
      const timing = { seconds: secs(duration), mode, lines: own.length };
      const parts =
        slot.kind === 'shot' && !isStill(slot as ShotSlot) && duration > maxShotOf()
          ? Math.ceil(duration / maxShotOf())
          : 1;
      if (parts === 1) fill(slot, `rc_${slot.id}`, start, duration, timing);
      else {
        // Several shots for one long slot, cut on the frame grid.
        for (let p = 0; p < parts; p++) {
          const a = grid(start + (duration * p) / parts);
          const b = p === parts - 1 ? start + duration : grid(start + (duration * (p + 1)) / parts);
          fill(slot, p === 0 ? `rc_${slot.id}` : `rc_${slot.id}_${p + 1}`, a, b - a, { ...timing, part: p + 1, of: parts }, { index: p, count: parts }); // prettier-ignore
        }
      }
      t = start + duration;
    });
    const end = t;

    const tracks: Timeline['tracks'] = [
      { id: 'trk_picture', kind: 'video', name: 'Picture', muted: false, locked: false, items: pictureItems, transitions: [] }, // prettier-ignore
    ];
    if (cards.length)
      tracks.push({ id: 'trk_cards', kind: 'graphics', name: 'Cards', muted: false, locked: false, items: cards, transitions: [] }); // prettier-ignore
    if (voiceItems.length)
      tracks.push({ id: 'trk_voice', kind: 'audio', name: 'Voiceover', muted: false, locked: false, items: voiceItems, transitions: [] }); // prettier-ignore

    const musicId = sb.music.trackAssetId;
    const music = musicId ? sources.get(musicId) : undefined;
    if (musicId && music && end > 0) {
      const musicEnd = Math.min(end, grid(music.duration));
      const fade = Math.min(musicEnd, grid(1 * S));
      const decisionId = decide(
        'rc_music',
        '',
        { assetId: musicId, duration: musicEnd },
        { fadeSeconds: secs(fade), duckDb: o.duckDb ?? 12 },
        `Music under the whole TikTok${voiceItems.length ? ', lower under the voice' : ''}, fading out over the last ${secs(fade)} s`,
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
                ? { keyframes: [{ at: musicEnd - fade, value: 0, easing: 'linear' }, { at: musicEnd, value: -60, easing: 'linear' }] } // prettier-ignore
                : 0,
          },
        ],
      });
    } else if (musicId) warnings.push('the music file is not ready; the TikTok has no music yet');
    if (mode === 'plain')
      warnings.push('no voiceover and no analysed music: the cut follows the storyboard lengths');

    const raw = Timeline.parse({
      id: input.timeline.id,
      name: input.timeline.name ?? 'TikTok',
      frameRate: input.timeline.frameRate,
      resolution: input.timeline.resolution,
      tracks,
      markers,
    });
    const captioned = placeCaptions(
      raw,
      sb,
      (c) =>
      decide(c.id, c.slotId ?? '', { text: c.text, start: c.start, duration: c.duration }, { from: "the shot's on-screen text" }, `Caption "${c.text}" for ${secs(c.duration)} s`), // prettier-ignore
    );
    const accented = applyAccents(
      captioned.timeline,
      sb,
      decide,
      o.sound ? { sound: o.sound } : {},
    );
    // The music dips under every line (after the sound effects added their own dips).
    const ramp = grid(0.15 * S);
    const dip = -(o.duckDb ?? 12);
    const spans: [number, number][] = [];
    for (const v of voiceItems) {
      const a = Math.max(0, v.start - ramp);
      const b = v.start + v.duration + ramp;
      const last = spans.at(-1);
      if (last && a - last[1] < 0.4 * S) last[1] = b;
      else spans.push([a, b]);
    }
    const dips = spans.flatMap(([a, b]) => [
      { at: a, value: 0 },
      { at: a + ramp, value: dip },
      { at: Math.max(a + ramp + 1, b - ramp), value: dip },
      { at: Math.max(a + ramp + 2, b), value: 0 },
    ]);
    const tl = Timeline.parse({
      ...accented.timeline,
      tracks: accented.timeline.tracks.map((tr) => ({
        ...tr,
        items: tr.items.map((i) =>
          i.id === 'rc_music' && i.kind === 'clip' && dips.length
            ? { ...i, gainDb: addGain(i.gainDb, dips.filter((d) => d.at <= i.duration).map((d) => ({ ...d, at: d.at - i.start }))) } // prettier-ignore
            : i,
        ),
      })),
    });
    return {
      timeline: tl,
      decisions,
      warnings: [...warnings, ...captioned.warnings, ...accented.warnings],
      soundOptions: accented.soundOptions,
    };
  }

  function maxShotOf(): number {
    return (o.maxShotSeconds ?? 2.5) * S;
  }

  function isStill(slot: ShotSlot | CardSlot): boolean {
    if (slot.kind !== 'shot') return false;
    const take = slot.takes.find((x) => x.id === slot.chosenTakeId) ?? slot.takes.find((x) => !x.rejected); // prettier-ignore
    return !!take && !!sources.get(take.assetId)?.still;
  }
}
