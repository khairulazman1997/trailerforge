import type { ProjectStore } from '@trailerforge/core';
import { BUILTIN_PROMPTS_DIR, loadPrompt } from '@trailerforge/llm';
import { redactor, textLeaves } from '@trailerforge/pack-game-trailer';
import { FLICKS_PER_SECOND, type Timeline } from '@trailerforge/schema';
import { z } from 'zod';
import { buildCritiqueFacts } from './critique.js';
import type { Engine } from './engine.js';
import { effectItemsOp, masterTimeline } from './effectcraft-ops.js';
import { OpError } from './ops.js';

/**
 * "Suggest an effect" (route `effectcraft.suggest`): the AI reads a TEXT description of the cut
 * (the brief, each shot's words as opaque `shot-N` keys, the effects already on it, the brand
 * colours and fonts) and proposes up to three custom effects, each as the words the maker would
 * type into "Describe an effect", a length, an optional hit point and the shot it belongs on.
 * Nothing is stored and nothing is written: the user picks one, which opens "Describe an effect"
 * filled in, and only that sends a request to write it.
 */
export const EFFECT_SUGGEST_TASK = 'effectcraft.suggest';
export const MAX_IDEAS = 3;

export const GeneratedEffectIdeas = z.strictObject({
  ideas: z
    .array(
      z.strictObject({
        about: z.string().min(1).max(40),
        words: z.string().min(1).max(600),
        seconds: z.number().min(0.5).max(10),
        landAt: z.number().min(0).max(10).optional(),
        why: z.string().max(400).default(''),
      }),
    )
    .max(10),
});
export type GeneratedEffectIdeas = z.infer<typeof GeneratedEffectIdeas>;

export interface EffectIdea {
  /** What to type into "Describe an effect". */
  words: string;
  seconds: number;
  /** Seconds from the effect's start where its hit lands. */
  landAt?: number;
  /** The shot it belongs on (its slot), when it names one. */
  slotId?: string;
  /** The shot's title, for the list. */
  slotLabel?: string;
  /** Where its shot starts in the cut, seconds (where "Add it to the cut" will put it). */
  atSeconds?: number;
  why: string;
}

export interface EffectSuggestFacts {
  /** The data exactly as it is sent. */
  wire: Record<string, unknown>;
  /** What each `shot-N` key stands for. */
  keys: Map<string, { slotId: string; start: number; label: string }>;
  terms: string[];
  /** What is sent, in words, for the disclosure. */
  summary: string[];
  excluded: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** What a suggestion request would send for this cut. Pure. */
export function buildEffectSuggestFacts(
  store: ProjectStore,
  timeline: Timeline,
): EffectSuggestFacts {
  const project = store.state;
  // Effects already on the cut are listed on their own, not as shots.
  const picture: Timeline = {
    ...timeline,
    tracks: timeline.tracks.filter((t) => !t.id.startsWith('trk_user_')),
  };
  const f = buildCritiqueFacts({ project, timeline: picture, beats: null, bars: null, findings: [] }); // prettier-ignore
  const redact = redactor(f.terms);
  const effects = effectItemsOp(store)
    .filter((e) => e.timelineId === timeline.id)
    .map((e) => ({
      startSeconds: round1(e.start),
      seconds: round1(e.duration),
      name: redact(e.label),
    }));
  const brand = project.brand;
  const { videoType, brief, shots, voiceOver } = f.wire as Record<string, unknown>;
  const wire: Record<string, unknown> = {
    videoType,
    brief,
    shots,
    ...(voiceOver ? { voiceOver } : {}),
    effectsAlready: effects,
    ...(brand ? { brand: { colors: brand.colors, fonts: brand.fonts.map((x) => x.family) } } : {}),
  };
  const keys: EffectSuggestFacts['keys'] = new Map();
  for (const [key, k] of f.keys)
    keys.set(key, {
      slotId: k.slotId,
      start: k.start,
      label: k.slot.title || k.slot.purpose || key,
    });
  const n = Array.isArray(shots) ? shots.length : 0;
  const summary = [
    f.summary[0]!,
    `${n} shots in order: section, title, purpose, length, priority, on-screen text`,
    `${effects.length} custom effect${effects.length === 1 ? '' : 's'} already on the cut (time, length, name)`,
    ...(brand ? ['Your brand colours and font names'] : []),
    'Never sent: footage, frames, sound, file names or paths, ids, or game facts you excluded',
  ];
  return {
    wire,
    keys,
    terms: f.terms,
    summary,
    excluded: project.knowledge.filter((e) => e.excludedFromLlm).length,
  };
}

/** Effects need EffectCraft and a cut to suggest for. */
async function factsFor(engine: Engine, store: ProjectStore): Promise<EffectSuggestFacts> {
  const r = engine.plugins.registries.motionRenderers.get('effectcraft/cli');
  const a = r ? await r.available() : null;
  if (!a?.ok)
    throw new OpError('usage', `custom effects need EffectCraft${a && !a.ok ? `: ${a.reason}` : ''}`); // prettier-ignore
  if (!store.state.storyboard) throw new OpError('not-found', 'make a storyboard first');
  return buildEffectSuggestFacts(store, masterTimeline(store));
}

export interface EffectSuggestFactsView {
  summary: string[];
  wire: Record<string, unknown>;
  excluded: number;
}

/** What "Suggest an effect" would send. Sends nothing. */
export async function effectSuggestFactsOp(
  engine: Engine,
  store: ProjectStore,
): Promise<EffectSuggestFactsView> {
  const f = await factsFor(engine, store);
  return { summary: f.summary, wire: f.wire, excluded: f.excluded };
}

export interface EffectSuggestions {
  provider: string;
  model: string;
  ideas: EffectIdea[];
  /** Ideas left out, with why (a shot key that does not exist, or too many). */
  skipped: { about: string; reason: 'unknown-shot' | 'too-many' }[];
}

/** Ask for effect ideas. Stores nothing; a cancelled run changes nothing. */
export async function suggestEffectsOp(
  engine: Engine,
  store: ProjectStore,
  opts: { signal?: AbortSignal } = {},
): Promise<EffectSuggestions> {
  const facts = await factsFor(engine, store);
  // The user's text that goes out (keys and enums are not): nothing excluded may be in it.
  const sent = textLeaves(facts.wire, ['key', 'kind', 'role', 'priority', 'videoType'])
    .join('\n')
    .toLowerCase();
  if (facts.terms.some((t) => sent.includes(t.toLowerCase())))
    throw new Error('refusing to send: the request still contains knowledge excluded from LLM use');

  const system = await loadPrompt('system.trailer-craft', { projectName: '' }, [BUILTIN_PROMPTS_DIR]); // prettier-ignore
  const prompt = await loadPrompt(
    EFFECT_SUGGEST_TASK,
    {
      videoType: String(facts.wire.videoType ?? 'trailer'),
      facts: JSON.stringify(facts.wire, null, 2),
      maxIdeas: String(MAX_IDEAS),
    },
    [BUILTIN_PROMPTS_DIR],
  );
  const r = await engine
    .llmFor(store)
    .generate(EFFECT_SUGGEST_TASK, { system, prompt, schema: GeneratedEffectIdeas }, opts.signal);
  opts.signal?.throwIfAborted();

  const out: EffectSuggestions = { provider: r.provider, model: r.model, ideas: [], skipped: [] };
  for (const idea of r.value.ideas) {
    if (out.ideas.length >= MAX_IDEAS) {
      out.skipped.push({ about: idea.about, reason: 'too-many' });
      continue;
    }
    const about = idea.about.trim();
    const shot = about === 'overall' ? undefined : facts.keys.get(about);
    if (about !== 'overall' && !shot) {
      out.skipped.push({ about, reason: 'unknown-shot' });
      continue;
    }
    const seconds = round1(idea.seconds);
    out.ideas.push({
      words: idea.words.trim(),
      seconds,
      ...(idea.landAt !== undefined && idea.landAt <= seconds ? { landAt: round1(idea.landAt) } : {}), // prettier-ignore
      ...(shot
        ? { slotId: shot.slotId, slotLabel: shot.label, atSeconds: round1(shot.start / FLICKS_PER_SECOND) } // prettier-ignore
        : {}),
      why: idea.why.trim(),
    });
  }
  return out;
}
