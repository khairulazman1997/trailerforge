import type { StoryboardTemplate } from '@trailerforge/plugin-api';
import {
  Storyboard,
  type Concept,
  type Section,
  type Short,
  type SlotInput,
  type VoLine,
} from '@trailerforge/schema';
import type { z } from 'zod';
import { TIKTOK_FORMATS } from './tiktok-formats.js';

/**
 * The six short-form (TikTok) storyboard templates. Unlike a trailer, a short's structure is
 * fixed by its format: which sections and slots there are, how long each runs, and what may fill
 * it (gameplay, an image, any video). A concept only seeds the words: shot titles and capture
 * instructions from its shot list, the hook as on-screen text, its voiceover lines. The build is
 * pure and deterministic, so the same concept always gives the same template and ids; the
 * optional AI pass (`short-wording.ts`) improves wording but never touches the structure.
 */

type StoryboardInput = z.input<typeof Storyboard>;

interface SlotSpec {
  /** Short key (at most 8 characters): the slot id is `<short id>_<key>`. */
  key: string;
  kind: 'shot' | 'card';
  title: string;
  purpose: string;
  /** Relative share of the running time. */
  weight: number;
  /** Longest ideal length, seconds (hooks must be quick). */
  cap?: number;
  /** Only in cuts at least this long; such slots are `nice`. */
  from?: number;
  accepts?: SlotInput[];
  hud?: 'on' | 'off' | 'any';
  /** Shows the concept's hook as on-screen text, or an item number. */
  caption?: 'hook' | string;
  card?: { cardKind: 'title' | 'logo' | 'cta' | 'custom'; templateId: string };
  capture?: string;
}

interface SectionSpec {
  key: string;
  name: string;
  role: string;
  purpose: string;
  /** Voiceover lines are spread over this section's picture slots. */
  voice?: boolean;
  slots: SlotSpec[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const ANY: SlotInput[] = ['gameplay', 'video', 'image'];
const PLAY: SlotInput[] = ['gameplay', 'video'];

const shot = (
  key: string,
  title: string,
  purpose: string,
  o: Partial<SlotSpec> = {},
): SlotSpec => ({
  key,
  kind: 'shot',
  title,
  purpose,
  weight: 2,
  accepts: PLAY,
  ...o,
});

const hookShot = (accepts: SlotInput[] = PLAY): SlotSpec =>
  shot('hook', 'Hook', 'The first second: stop the scroll with the strongest moment', {
    weight: 1,
    cap: 2.5,
    accepts,
    hud: 'off',
    caption: 'hook',
    capture: 'The most striking, instantly readable moment you can film in a few seconds.',
  });

const cta = (): SlotSpec => ({
  key: 'cta',
  kind: 'card',
  title: 'Call to action',
  purpose: 'Tell them what to do next',
  weight: 1.2,
  cap: 3,
  card: { cardKind: 'cta', templateId: 'core/cta-card' },
});

const endSection = (slots: SlotSpec[] = [cta()]): SectionSpec => ({
  key: 'end',
  name: 'Call to action',
  role: 'end-slate',
  purpose: 'Name the game and ask for the wishlist',
  slots,
});

const SPECS: Record<string, { music: string; sections: SectionSpec[] }> = {
  'game-trailer/tiktok-montage': {
    music:
      'A punchy track, or leave the music out and add a trending sound in TikTok; cut on the beat.',
    sections: [
      {
        key: 'hook',
        name: 'Hook',
        role: 'hook',
        purpose: 'Win the first second',
        slots: [hookShot()],
      },
      {
        key: 'montage',
        name: 'Montage',
        role: 'escalation',
        purpose: 'Fast cuts, each one a reason to care',
        slots: [
          shot('m1', 'Moment 1', 'Show the core of the game', { weight: 1.5 }),
          shot('m2', 'Moment 2', 'Raise the stakes', { weight: 1.5 }),
          shot('m3', 'Moment 3', 'Something different', { weight: 1.5 }),
          shot('m4', 'Moment 4', 'Keep the pace up', { weight: 1.5, from: 22 }),
          shot('m5', 'Moment 5', 'One more crowd-pleaser', { weight: 1.5, from: 32 }),
        ],
      },
      endSection(),
    ],
  },
  'game-trailer/tiktok-voiceover': {
    music: 'Quiet and low under the voice, or none; the voice carries it.',
    sections: [
      {
        key: 'hook',
        name: 'Hook',
        role: 'hook',
        purpose: 'Open on the point of the video',
        slots: [hookShot(ANY)],
      },
      {
        key: 'story',
        name: 'The story',
        role: 'story',
        purpose: 'Say it over what you show',
        voice: true,
        slots: [
          shot('b1', 'Beat 1', 'First point', { accepts: ANY }),
          shot('b2', 'Beat 2', 'Second point', { accepts: ANY }),
          shot('b3', 'Beat 3', 'Third point', { accepts: ANY }),
          shot('b4', 'Beat 4', 'One more thing', { accepts: ANY, from: 30 }),
        ],
      },
      endSection(),
    ],
  },
  'game-trailer/tiktok-list': {
    music: 'A light rhythmic track under the numbers, or none.',
    sections: [
      {
        key: 'hook',
        name: 'Title',
        role: 'hook',
        purpose: 'Promise the list',
        slots: [
          {
            key: 'hook',
            kind: 'card',
            title: 'The promise',
            purpose: 'Say what the list is about',
            weight: 1,
            cap: 2.5,
            card: { cardKind: 'custom', templateId: 'core/custom-card' },
          },
        ],
      },
      {
        key: 'items',
        name: 'The list',
        role: 'escalation',
        purpose: 'One short clip per point',
        slots: [
          shot('item1', 'Point 1', 'The first fact', { weight: 2.5, accepts: ANY, caption: '1' }),
          shot('item2', 'Point 2', 'The second fact', { weight: 2.5, accepts: ANY, caption: '2' }),
          shot('item3', 'Point 3', 'The best one, last', {
            weight: 2.5,
            accepts: ANY,
            caption: '3',
          }),
        ],
      },
      endSection(),
    ],
  },
  'game-trailer/tiktok-progress': {
    music: 'A track that lifts at the change; cut the reveal on the beat.',
    sections: [
      { key: 'hook', name: 'Hook', role: 'hook', purpose: 'Tease the change', slots: [hookShot()] },
      {
        key: 'change',
        name: 'Before and after',
        role: 'escalation',
        purpose: 'Show how far it has come',
        slots: [
          shot('before', 'Before', 'How it looked or played first', {
            weight: 2.5,
            accepts: ['video', 'image', 'gameplay'],
            capture: 'An old build, an early sketch or a first prototype clip.',
          }),
          shot('after', 'After', 'How it looks or plays now', {
            weight: 2.5,
            capture: 'The same thing as it is now, framed like the before.',
          }),
        ],
      },
      endSection(),
    ],
  },
  'game-trailer/tiktok-pov': {
    music: 'Tense under the setup, a hit on the payoff.',
    sections: [
      {
        key: 'hook',
        name: 'Hook',
        role: 'hook',
        purpose: 'Put the viewer in the seat',
        slots: [hookShot(['gameplay'])],
      },
      {
        key: 'challenge',
        name: 'The challenge',
        role: 'escalation',
        purpose: 'Set it up, try it, pay it off',
        slots: [
          shot('setup', 'The setup', 'What the player faces', {
            weight: 1.5,
            accepts: ['gameplay'],
          }),
          shot('try', 'The attempt', 'The tricky moment', { accepts: ['gameplay'] }),
          shot('payoff', 'The payoff', 'It works, or it very much does not', {
            accepts: ['gameplay'],
          }),
        ],
      },
      endSection(),
    ],
  },
  'game-trailer/tiktok-wishlist': {
    music: 'A slow build that stops, then lands on the reveal.',
    sections: [
      {
        key: 'tease',
        name: 'The tease',
        role: 'hook',
        purpose: 'Hold something back',
        slots: [
          { ...hookShot(), key: 'tease1', weight: 1.5, title: 'Tease 1' },
          shot('tease2', 'Tease 2', 'A little more, still not all of it', { weight: 1.5 }),
        ],
      },
      {
        key: 'reveal',
        name: 'The reveal',
        role: 'climax',
        purpose: 'Show the thing',
        slots: [shot('reveal', 'The reveal', 'The moment the tease was about', { weight: 2.5 })],
      },
      endSection([
        {
          key: 'logo',
          kind: 'card',
          title: 'Game name',
          purpose: 'Name the game',
          weight: 1,
          cap: 2,
          card: { cardKind: 'logo', templateId: 'core/logo-card' },
        },
        cta(),
      ]),
    ],
  },
};

/** Spread `total` seconds over the specs by weight, respecting each cap; whole tenths. */
function allocate(specs: readonly SlotSpec[], total: number): number[] {
  const out = specs.map(() => 0);
  let free = specs.map((_, i) => i);
  let left = total;
  for (let guard = 0; guard < specs.length && free.length > 0; guard++) {
    const w = free.reduce((a, i) => a + specs[i]!.weight, 0);
    const over = free.filter((i) => (specs[i]!.cap ?? Infinity) < (left * specs[i]!.weight) / w);
    if (over.length === 0) break;
    for (const i of over) {
      out[i] = specs[i]!.cap!;
      left -= specs[i]!.cap!;
    }
    free = free.filter((i) => !over.includes(i));
  }
  const w = free.reduce((a, i) => a + specs[i]!.weight, 0);
  for (const i of free) out[i] = (left * specs[i]!.weight) / w;
  const rounded = out.map(round1);
  const drift = round1(total - rounded.reduce((a, b) => a + b, 0));
  const sink = free.length > 0 ? free[free.length - 1]! : rounded.length - 1;
  rounded[sink] = round1(rounded[sink]! + drift);
  return rounded;
}

export interface BuildShortOptions {
  formatId: string;
  /** Ids are `<idPrefix>_…`; use the short's id (at most 52 characters). */
  idPrefix: string;
  targetSeconds: number;
  concept?: Pick<Concept, 'hook' | 'shotList' | 'voiceover'> | undefined;
  callToAction?: string | undefined;
  tone?: readonly string[] | undefined;
}

/** First words of a line, as a slot title. */
function titleOf(line: string): string {
  const one = line.trim().replace(/\s+/g, ' ');
  if (one.length <= 60) return one;
  const cut = one.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 30))}…`;
}

/** Build a short's storyboard from its format, seeded with the concept. Pure and deterministic. */
export function buildShortStoryboard(o: BuildShortOptions): StoryboardInput {
  const spec = SPECS[o.formatId];
  if (!spec) throw new RangeError(`unknown TikTok format "${o.formatId}"`);
  if (!(o.targetSeconds > 0)) throw new RangeError('targetSeconds must be positive');
  if (o.idPrefix.length > 52) throw new RangeError('idPrefix is at most 52 characters');
  const id = (k: string) => `${o.idPrefix}_${k}`;
  const sections = spec.sections
    .map((s) => ({
      ...s,
      slots: s.slots.filter((x) => x.from === undefined || o.targetSeconds >= x.from),
    }))
    .filter((s) => s.slots.length > 0);
  const flat = sections.flatMap((s) => s.slots);
  const ideals = allocate(flat, o.targetSeconds);
  const lines = o.concept?.shotList ?? [];
  // The hook is written from the concept's hook line; the shot list fills the other pictures.
  const pictureSlots = flat.filter((x) => x.kind === 'shot' && x.caption !== 'hook');
  const ctaText = o.callToAction?.trim() || 'Wishlist now';

  let n = 0;
  const built: z.input<typeof Section>[] = sections.map((s) => ({
    id: id(`s_${s.key}`),
    name: s.name,
    role: s.role,
    purpose: s.purpose,
    slots: s.slots.map((x) => {
      const ideal = ideals[n++]!;
      const duration = {
        min: round1(Math.min(ideal, Math.max(0.8, ideal * 0.7))),
        ideal,
        max: round1(Math.max(ideal, ideal * 1.4)),
      };
      const priority = x.from === undefined ? ('must' as const) : ('nice' as const);
      const base = { id: id(x.key), title: x.title, purpose: x.purpose, duration, priority };
      if (x.kind === 'card') {
        const text =
          x.card!.cardKind === 'cta'
            ? ctaText
            : x.card!.cardKind === 'custom'
              ? (o.concept?.hook ?? '')
              : '';
        return { ...base, kind: 'card' as const, ...x.card!, text };
      }
      const k = pictureSlots.indexOf(x);
      const line = k >= 0 ? lines[k] : undefined;
      const last = k === pictureSlots.length - 1;
      const extra = last ? lines.slice(pictureSlots.length) : [];
      const caption =
        x.caption === 'hook' ? o.concept?.hook : x.caption !== undefined ? x.caption : undefined;
      return {
        ...base,
        kind: 'shot' as const,
        ...(line ? { title: titleOf(line), captureInstruction: line.trim() } : {}),
        ...(!line && x.capture ? { captureInstruction: x.capture } : {}),
        ...(extra.length > 0 ? { alternates: extra.map((e) => e.trim()) } : {}),
        accepts: x.accepts ?? PLAY,
        ...(x.hud ? { hud: x.hud } : {}),
        ...(caption?.trim()
          ? {
              overlays: [
                {
                  id: id(`${x.key}_t`),
                  templateId: 'core/caption',
                  text: caption.trim(),
                  offset: 0,
                  duration: round1(Math.min(ideal, 2.5)),
                },
              ],
            }
          : {}),
      };
    }),
  }));

  // Voiceover lines are spread, in order, over the voice section's picture slots (or all of them).
  const voiceSlots = (sections.find((s) => s.voice) ? sections.filter((s) => s.voice) : sections)
    .flatMap((s) => s.slots)
    .filter((x) => x.kind === 'shot');
  const spoken = (o.concept?.voiceover ?? []).map((t) => t.trim()).filter(Boolean);
  const voLines: z.input<typeof VoLine>[] = spoken.map((text, i) => ({
    id: id(`vo${i + 1}`),
    speaker: 'Dev',
    text,
    linkedSlotIds:
      voiceSlots.length > 0
        ? [
            id(
              voiceSlots[
                Math.min(voiceSlots.length - 1, Math.floor((i * voiceSlots.length) / spoken.length))
              ]!.key,
            ),
          ]
        : [],
  }));

  return {
    id: id('sb'),
    meta: {
      videoTypeId: 'game-trailer/tiktok',
      templateId: o.formatId,
      tone: [...(o.tone ?? [])],
      targetDuration: o.targetSeconds,
      masterResolution: { width: 1080, height: 1920 },
    },
    sections: built,
    voLines,
    music: { direction: spec.music, structure: [], hitPoints: [], sfxCues: [] },
  };
}

/** The templates as the registry lists them (a skeleton without a concept). */
export const shortTemplates: StoryboardTemplate[] = TIKTOK_FORMATS.map((f) => ({
  id: f.id,
  videoTypeId: 'game-trailer/tiktok',
  name: f.name,
  description: f.description,
  build: ({ targetDuration }) =>
    buildShortStoryboard({ formatId: f.id, idPrefix: 'tpl', targetSeconds: targetDuration }),
}));

const hasEdits = (slot: { extensions: Record<string, unknown> }): boolean => {
  const core = slot.extensions.core as { userEdited?: unknown } | undefined;
  return Array.isArray(core?.userEdited) && core.userEdited.length > 0;
};

/** A slot the rebuild must not replace: it has files, or the user changed it. */
export function isFilledOrEdited(slot: Storyboard['sections'][number]['slots'][number]): boolean {
  if (hasEdits(slot)) return true;
  return slot.kind === 'shot' && (slot.takes.length > 0 || slot.status !== 'empty');
}

export interface RebuildShortOptions {
  short: Pick<Short, 'id' | 'concept' | 'storyboard'>;
  callToAction?: string | undefined;
  tone?: readonly string[] | undefined;
  /** Rebuild only these sections; the others stay as they are. */
  sectionIds?: readonly string[] | undefined;
}

export interface RebuildShortResult {
  storyboard: Storyboard;
  /** Slots written fresh from the template and the concept. */
  rebuilt: string[];
  /** Slots left as they were: they have files or hand edits, or sit in a locked section. */
  kept: string[];
}

/**
 * (Re)build a short's storyboard from its format and concept. Locked sections, slots with
 * recordings or hand edits, and voiceover lines with recordings are kept; everything else is
 * written again, so editing the concept and rebuilding refreshes only what the user has not
 * touched. Slots and sections the user added by hand stay too.
 */
export function rebuildShortStoryboard(o: RebuildShortOptions): RebuildShortResult {
  const { short } = o;
  const fresh = Storyboard.parse(
    buildShortStoryboard({
      formatId: short.concept.formatId,
      idPrefix: short.id,
      targetSeconds: short.concept.targetSeconds,
      concept: short.concept,
      callToAction: o.callToAction,
      tone: o.tone,
    }),
  );
  const old = short.storyboard;
  const ids = (sb: Storyboard) => sb.sections.flatMap((s) => s.slots.map((x) => x.id));
  if (!old) return { storyboard: fresh, rebuilt: ids(fresh), kept: [] };

  const only = o.sectionIds ? new Set(o.sectionIds) : undefined;
  const rebuilt: string[] = [];
  const kept: string[] = [];
  const merge = (f: Section, prior: Section | undefined): Section => {
    if (!prior) {
      rebuilt.push(...f.slots.map((x) => x.id));
      return f;
    }
    if (prior.locked || (only && !only.has(f.id))) {
      kept.push(...prior.slots.map((x) => x.id));
      return prior;
    }
    const oldSlots = new Map(prior.slots.map((x) => [x.id, x]));
    const slots = f.slots.map((x) => {
      const p = oldSlots.get(x.id);
      if (p && isFilledOrEdited(p)) {
        kept.push(p.id);
        return p;
      }
      rebuilt.push(x.id);
      return x;
    });
    const freshIds = new Set(f.slots.map((x) => x.id));
    for (const p of prior.slots) {
      if (freshIds.has(p.id)) continue;
      kept.push(p.id);
      slots.push(p);
    }
    return { ...f, locked: false, slots };
  };
  const oldById = new Map(old.sections.map((s) => [s.id, s]));
  const sections = fresh.sections.map((f) => merge(f, oldById.get(f.id)));
  const freshSections = new Set(fresh.sections.map((s) => s.id));
  for (const s of old.sections)
    if (!freshSections.has(s.id)) {
      kept.push(...s.slots.map((x) => x.id));
      sections.push(s);
    }

  const slotIds = new Set(sections.flatMap((s) => s.slots.map((x) => x.id)));
  let voLines: VoLine[];
  if (only) {
    voLines = old.voLines.map((v) => ({
      ...v,
      linkedSlotIds: v.linkedSlotIds.filter((id) => slotIds.has(id)),
    }));
  } else {
    const withTakes = new Map(old.voLines.filter((v) => v.takes.length > 0).map((v) => [v.id, v]));
    voLines = fresh.voLines.map((v) => withTakes.get(v.id) ?? v);
    const freshVo = new Set(fresh.voLines.map((v) => v.id));
    for (const v of withTakes.values()) if (!freshVo.has(v.id)) voLines.push(v);
    voLines = voLines.map((v) => ({
      ...v,
      linkedSlotIds: v.linkedSlotIds.filter((id) => slotIds.has(id)),
    }));
  }

  const storyboard = Storyboard.parse({
    ...old,
    revision: old.revision + 1,
    meta: { ...old.meta, ...fresh.meta },
    sections,
    voLines,
    music: {
      ...old.music,
      hitPoints: old.music.hitPoints.filter((h) => slotIds.has(h.slotId)),
      sfxCues: old.music.sfxCues.filter((c) => slotIds.has(c.slotId)),
    },
  });
  return { storyboard, rebuilt, kept };
}
