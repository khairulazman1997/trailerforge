import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { HookKind, MAX_HOOKS, type Project, type Short } from '@trailerforge/schema';
import { z } from 'zod';
import { CAPTURE_TIPS_PROMPTS_DIR, excludedTerms, redactor } from './capture-tips.js';
import { tiktokFormat } from './tiktok-formats.js';

/**
 * Alternative openings for a short (route `tiktok.hooks`): the model writes up to three hooks
 * (a caption, a kind, a reason) from the concept, the brief and the game facts it may see; it
 * never sees the recordings. Anything that mentions knowledge excluded from AI use, repeats the
 * opening's own words, or repeats another hook is dropped, with the reason.
 */

export const HOOKS_TASK = 'tiktok.hooks';
const MAX_CAPTION_WORDS = 10;
const KNOWLEDGE_CAP = 120;

export const GeneratedHooks = z.strictObject({
  hooks: z.array(
    z.strictObject({
      name: z.string(),
      kind: HookKind.optional(),
      caption: z.string().optional(),
      why: z.string().optional(),
    }),
  ),
});

/** What the model proposed and passed the checks; the command gives each its id. */
export interface HookProposal {
  name: string;
  kind: z.infer<typeof HookKind>;
  caption: string;
  why?: string;
}

export interface HooksResult {
  hooks: HookProposal[];
  rejected: { index: number; name: string; reasons: string[] }[];
  provider: string;
  model: string | undefined;
  fellBack: boolean;
}

const clean = (t: string) => t.trim().replace(/\s+/g, ' ');
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim(); // prettier-ignore

export async function generateHooks(
  deps: { llm: LlmClient },
  project: Project,
  short: Short,
  opts: { count?: number; signal?: AbortSignal } = {},
): Promise<HooksResult> {
  const sb = short.storyboard;
  if (!sb) throw new Error('this TikTok has no template yet');
  const count = Math.max(1, Math.min(MAX_HOOKS, opts.count ?? MAX_HOOKS));
  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  const lower = terms.map((t) => t.toLowerCase());
  const mentionsExcluded = (t: string) => lower.some((x) => t.toLowerCase().includes(x));

  const section = sb.sections.find((s) => s.role === 'hook') ?? sb.sections[0];
  const slot = section?.slots.find((x) => x.kind === 'shot');
  const opening =
    slot && slot.kind === 'shot'
      ? {
          shows: redact(slot.title),
          instruction: redact(slot.captureInstruction),
          seconds: slot.duration.ideal,
          captionNow: redact(slot.overlays[0]?.text ?? ''),
        }
      : { shows: '', instruction: '', seconds: 2, captionNow: '' };
  const c = short.concept;
  const { assumptions: _a, ...brief } = project.brief;
  const knowledge = project.knowledge
    .filter((e) => !e.excludedFromLlm)
    .slice(0, KNOWLEDGE_CAP)
    .map((e) => `- ${e.id}: ${e.kind}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');
  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const prompt = await loadPrompt(
    HOOKS_TASK,
    {
      count: String(count),
      format: tiktokFormat(c.formatId)?.name ?? 'TikTok',
      concept: redact(JSON.stringify({ title: c.title, hook: c.hook, pitch: c.pitch, seconds: c.targetSeconds }, null, 2)), // prettier-ignore
      opening: JSON.stringify(opening, null, 2),
      voiceover: sb.voLines.length ? sb.voLines.map((v) => `- ${redact(v.text)}`).join('\n') : '(none)', // prettier-ignore
      brief: redact(JSON.stringify(brief, null, 2)),
      knowledge: knowledge || '(none)',
    },
    [CAPTURE_TIPS_PROMPTS_DIR],
  );
  opts.signal?.throwIfAborted();
  const r = await deps.llm.generate(HOOKS_TASK, { system, prompt, schema: GeneratedHooks }, opts.signal); // prettier-ignore
  opts.signal?.throwIfAborted();

  const hooks: HookProposal[] = [];
  const rejected: HooksResult['rejected'] = [];
  const seen = new Set<string>([norm(slot?.kind === 'shot' ? (slot.overlays[0]?.text ?? '') : '')]);
  r.value.hooks.forEach((h, index) => {
    const reasons: string[] = [];
    const name = clean(h.name);
    const caption = clean(h.caption ?? '');
    if (!name || name.length > 60) reasons.push('the name is empty or too long');
    if (caption.split(' ').filter(Boolean).length > MAX_CAPTION_WORDS || caption.length > 120)
      reasons.push(`the caption is over ${MAX_CAPTION_WORDS} words`);
    if (mentionsExcluded(`${name} ${caption} ${h.why ?? ''}`))
      reasons.push('mentions knowledge excluded from AI use');
    const key = norm(caption);
    if (seen.has(key))
      reasons.push(key ? 'repeats another opening' : 'a second opening with no text');
    if (reasons.length === 0 && hooks.length >= count) reasons.push(`only ${count} wanted`);
    if (reasons.length > 0)
      return void rejected.push({ index, name: name || `#${index + 1}`, reasons });
    seen.add(key);
    hooks.push({
      name,
      kind: h.kind ?? (caption ? 'text' : 'cold-open'),
      caption,
      ...(h.why ? { why: clean(h.why).slice(0, 300) } : {}),
    });
  });
  return { hooks, rejected, provider: r.provider, model: r.model, fellBack: r.fellBack }; // prettier-ignore
}
