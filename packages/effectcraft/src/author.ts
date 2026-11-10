import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { EffectCraftError } from './cli.js';
import {
  AuthoredEffect,
  EFFECT_COMP,
  EFFECT_MAX_COMMANDS,
  effectCommands,
  effectProblems,
  scrubCliError,
} from './effect-spec.js';
import { effectExamplesText } from './effect-examples.js';
import type { AuthoredProject, EffectCraftRenderer } from './renderer.js';

export const EFFECT_AUTHOR_TASK = 'effectcraft.author';

/** What the maker asked for. Only text and numbers: no paths, ids, frames or footage. */
export interface EffectRequest {
  words: string;
  seconds: number;
  /** Seconds from the effect's start where its main hit lands (a beat or hit point). */
  landAt?: number;
  size: { width: number; height: number };
  frameRate: number;
  brand?: { colors: Record<string, string>; fonts: string[] } | null;
  /** An imported example (Lottie or an earlier effect) to edit; see `importExample`. */
  example?: Record<string, unknown>;
  /** Facts measured on a reference clip (numbers only). */
  reference?: Record<string, unknown>;
}

/** The authored effect could not be made usable, even after the repair round. */
export class EffectRefusedError extends Error {
  constructor(readonly problems: string[]) {
    super(`the effect could not be built: ${problems.slice(0, 5).join('; ')}`);
    this.name = 'EffectRefusedError';
  }
}

export interface AuthorEffectResult {
  effect: AuthoredEffect;
  project: AuthoredProject;
  /** 1, or 2 after a repair round. */
  attempts: number;
  /** What went wrong with the first attempt, when it was repaired. */
  repaired: string[];
  /** The request exactly as it was sent (excluded names redacted). */
  sent: Record<string, unknown>;
  provider?: string;
  model?: string;
}

const REDACTED = '[redacted]';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The request as the model sees it: the maker's words with excluded names redacted. */
export function effectWire(req: EffectRequest, terms: readonly string[]): Record<string, unknown> {
  const redact = terms.length
    ? (t: string) => t.replace(new RegExp(terms.map(escapeRe).join('|'), 'gi'), REDACTED)
    : (t: string) => t;
  return {
    words: redact(req.words.trim()).slice(0, 2000),
    seconds: Math.round(req.seconds * 1000) / 1000,
    ...(req.landAt !== undefined ? { landAt: Math.round(req.landAt * 1000) / 1000 } : {}),
    size: req.size,
    frameRate: Math.round(req.frameRate * 1000) / 1000,
    ...(req.brand
      ? { brand: { colors: req.brand.colors, fonts: req.brand.fonts.map(redact) } }
      : {}),
    ...(req.example ? { example: redactDeep(req.example, redact) } : {}),
    ...(req.reference ? { reference: req.reference } : {}),
  };
}

/**
 * Write a custom effect (plan M10 decision 4) and build it as an EffectCraft project at `dest`.
 * With `given` (Claude Code authored it through MCP) no model is asked and a failure comes back
 * to the caller as it is. Otherwise the configured model writes it from the request; if the
 * commands break the rules or EffectCraft refuses them, the model gets one repair round with the
 * problems, then the effect is refused. Nothing is stored anywhere but `dest`, and only once
 * EffectCraft has built and reopened the project.
 */
export async function authorEffect(
  deps: { llm?: LlmClient; renderer: EffectCraftRenderer },
  req: EffectRequest,
  o: {
    terms: readonly string[];
    dest: string;
    given?: AuthoredEffect;
    signal?: AbortSignal;
    /** An imported example the commands edit (its compositions may be targeted). */
    base?: { project: string; comps: string[] };
    /** Stills the user agreed to send, PNG base64; with the first request only. */
    images?: { mediaType: 'image/png'; data: string }[];
    /** Font files (the brand's) EffectCraft is given while it builds the project. */
    fonts?: readonly string[];
  },
): Promise<AuthorEffectResult> {
  const signal = o.signal ?? new AbortController().signal;
  const sent = effectWire(req, o.terms);
  const leaked = leakOf(sent, o.terms);
  const commandSet = await deps.renderer.effectCommandSet();
  if (leaked !== undefined)
    throw new Error('refusing to send: the request still contains knowledge excluded from LLM use');

  const attempt = async (effect: AuthoredEffect): Promise<AuthoredProject | string[]> => {
    const problems = effectProblems(effect.commands, {
      comps: o.base?.comps ?? [EFFECT_COMP],
      listed: commandSet.listed,
    });
    if (problems.length) return problems;
    try {
      return o.base
        ? await deps.renderer.authorProject(
            effect.commands.map((c) => ({
              command: c.command,
              params: c.params as Record<string, unknown>,
            })),
            o.dest,
            signal,
            { base: o.base.project, ...(o.fonts ? { fonts: o.fonts } : {}) },
          )
        : await deps.renderer.authorProject(
            effectCommands(effect, { ...req.size, frameRate: req.frameRate, seconds: req.seconds }),
            o.dest,
            signal,
            o.fonts ? { fonts: o.fonts } : {},
          );
    } catch (e) {
      if (e instanceof EffectCraftError && (e.code === 'failed' || e.code === 'bad-project'))
        return [scrubCliError(e.message)];
      throw e;
    }
  };

  if (o.given) {
    const r = await attempt(AuthoredEffect.parse(o.given));
    if (Array.isArray(r)) throw new EffectRefusedError(r);
    return { effect: o.given, project: r, attempts: 1, repaired: [], sent };
  }

  if (!deps.llm) throw new Error('no model to write the effect');
  const request = JSON.stringify(sent, null, 2);
  const system = await loadPrompt('system.trailer-craft', { projectName: '' }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const prompt = await loadPrompt(
    'effectcraft.author',
    {
      request,
      comp: EFFECT_COMP,
      commands: commandSet.offered.join(', '),
      reported: commandSet.described.length
        ? `How this EffectCraft describes those commands (its own words win over the notes above):\n${commandSet.described.join('\n')}`
        : '',
      examples: effectExamplesText(),
      maxCommands: String(EFFECT_MAX_COMMANDS),
      context: contextText(sent, o.images?.length ?? 0, o.base?.comps ?? [EFFECT_COMP]),
    },
    [BUILTIN_PROMPTS_DIR],
  );
  const first = await deps.llm.generate(
    EFFECT_AUTHOR_TASK,
    { system, prompt, schema: AuthoredEffect, ...(o.images?.length ? { images: o.images } : {}) },
    signal,
  );
  signal.throwIfAborted();
  const r1 = await attempt(first.value);
  if (!Array.isArray(r1))
    return { effect: first.value, project: r1, attempts: 1, repaired: [], sent, provider: first.provider, model: first.model }; // prettier-ignore

  const repair = await loadPrompt(
    'effectcraft.repair',
    {
      request,
      previous: JSON.stringify(first.value, null, 2),
      problems: r1.map((p) => `- ${p}`).join('\n'),
      commands: commandSet.offered.join(', '),
    },
    [BUILTIN_PROMPTS_DIR],
  );
  const second = await deps.llm.generate(EFFECT_AUTHOR_TASK, { system, prompt: repair, schema: AuthoredEffect }, signal); // prettier-ignore
  signal.throwIfAborted();
  const r2 = await attempt(second.value);
  if (Array.isArray(r2)) throw new EffectRefusedError(r2);
  return {
    effect: second.value,
    project: r2,
    attempts: 2,
    repaired: r1,
    sent,
    provider: second.provider,
    model: second.model,
  };
}

function redactDeep(v: unknown, redact: (t: string) => string): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, redact)]));
  return v;
}

/** What the prompt says about an example, a reference and stills, when there are any. */
function contextText(
  sent: Record<string, unknown>,
  stills: number,
  comps: readonly string[],
): string {
  const parts: string[] = [];
  if (sent.example)
    parts.push(
      `Start from the example in "example": it is already in the project${comps.length > 1 ? `, as the composition "${comps[1]}" nested as a layer of that name in "${EFFECT_COMP}"` : ` in "${EFFECT_COMP}"`}. Edit it rather than starting over: change its text (prop.set path "text/sourceText" on its text layers, with "comp" set to the composition that holds them), its colours toward the brand, and time it to the length and the hit point (keyframes on the nested layer in "${EFFECT_COMP}"). You may add layers. Its logos or artwork are not to be copied into something new.`,
    );
  if (sent.reference)
    parts.push(
      'Match the style of the reference clip measured in "reference" (seconds): its length, its events (where things appear, flash, cut or fade), its main colours and which way and how fast things move. Copy the style, not its content.',
    );
  if (stills)
    parts.push(`The ${stills} images attached are stills from that reference clip, in time order; use them for the look (layout, type, colours).`); // prettier-ignore
  return parts.join('\n\n');
}

function leakOf(v: unknown, terms: readonly string[]): string | undefined {
  const text = JSON.stringify(v).toLowerCase();
  return terms.find((t) => text.includes(t.toLowerCase()));
}
