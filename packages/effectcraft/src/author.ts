import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { EffectCraftError } from './cli.js';
import {
  AuthoredEffect,
  EFFECT_COMMANDS,
  EFFECT_COMP,
  EFFECT_MAX_COMMANDS,
  effectCommands,
  effectProblems,
  scrubCliError,
} from './effect-spec.js';
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
  };
}

/**
 * Write a custom effect (plan M8 decision 4) and build it as an EffectCraft project at `dest`.
 * With `given` (Claude Code authored it through MCP) no model is asked and a failure comes back
 * to the caller as it is. Otherwise the configured model writes it from the request; if the
 * commands break the rules or EffectCraft refuses them, the model gets one repair round with the
 * problems, then the effect is refused. Nothing is stored anywhere but `dest`, and only once
 * EffectCraft has built and reopened the project.
 */
export async function authorEffect(
  deps: { llm?: LlmClient; renderer: EffectCraftRenderer },
  req: EffectRequest,
  o: { terms: readonly string[]; dest: string; given?: AuthoredEffect; signal?: AbortSignal },
): Promise<AuthorEffectResult> {
  const signal = o.signal ?? new AbortController().signal;
  const sent = effectWire(req, o.terms);
  const leaked = leakOf(sent, o.terms);
  if (leaked !== undefined)
    throw new Error('refusing to send: the request still contains knowledge excluded from LLM use');

  const attempt = async (effect: AuthoredEffect): Promise<AuthoredProject | string[]> => {
    const problems = effectProblems(effect.commands);
    if (problems.length) return problems;
    try {
      return await deps.renderer.authorProject(
        effectCommands(effect, { ...req.size, frameRate: req.frameRate, seconds: req.seconds }),
        o.dest,
        signal,
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
      commands: EFFECT_COMMANDS.join(', '),
      maxCommands: String(EFFECT_MAX_COMMANDS),
    },
    [BUILTIN_PROMPTS_DIR],
  );
  const first = await deps.llm.generate(EFFECT_AUTHOR_TASK, { system, prompt, schema: AuthoredEffect }, signal); // prettier-ignore
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

function leakOf(v: unknown, terms: readonly string[]): string | undefined {
  const text = JSON.stringify(v).toLowerCase();
  return terms.find((t) => text.includes(t.toLowerCase()));
}
