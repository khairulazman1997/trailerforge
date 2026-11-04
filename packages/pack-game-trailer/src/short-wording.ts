import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { Storyboard, type Project, type Short } from '@trailerforge/schema';
import { z } from 'zod';
import { CAPTURE_TIPS_PROMPTS_DIR, excludedTerms, redactor } from './capture-tips.js';
import { tiktokFormat } from './tiktok-formats.js';

/**
 * Optional AI pass over a short's wording (route `tiktok.wording`). The template has already
 * fixed the structure; the model only rewrites the words of slots it is given: shot titles and
 * capture instructions, card text and on-screen captions. It refers to slots by opaque keys,
 * cannot add or remove anything, and anything it writes that mentions knowledge excluded from AI
 * use is ignored. The result is applied to the storyboard in memory, so the caller stores
 * structure and wording together as one step. Wording written here is not a hand edit: a later
 * rebuild may write it again.
 */

export const WORDING_TASK = 'tiktok.wording';
const MAX_TITLE = 50;
const MAX_INSTRUCTION = 220;
const MAX_CARD = 60;
const MAX_CAPTION_WORDS = 8;
const KNOWLEDGE_CAP = 120;

export const GeneratedWording = z.strictObject({
  slots: z.array(
    z.strictObject({
      key: z.string(),
      title: z.string().optional(),
      captureInstruction: z.string().optional(),
      text: z.string().optional(),
      captionText: z.string().optional(),
    }),
  ),
});
export type GeneratedWording = z.infer<typeof GeneratedWording>;

export interface WordingResult {
  /** The storyboard with the new words in (the same object when nothing changed). */
  storyboard: Storyboard;
  /** Slots whose words changed. */
  changed: string[];
  /** Fields the model wrote that were not used, with why. */
  ignored: { slotId: string; field: string; reason: string }[];
  provider: string;
  model: string | undefined;
  fellBack: boolean;
}

export interface WordingOptions {
  /** The slots to write; each must be in the short's storyboard. */
  slotIds: readonly string[];
  signal?: AbortSignal;
}

const clean = (t: string) => t.trim().replace(/\s+/g, ' ');

export async function fillShortWording(
  deps: { llm: LlmClient },
  project: Project,
  short: Short,
  opts: WordingOptions,
): Promise<WordingResult> {
  const sb = short.storyboard;
  if (!sb) throw new Error('this TikTok has no template yet');
  const want = new Set(opts.slotIds);
  const slots = sb.sections.flatMap((s) =>
    s.slots.filter((x) => want.has(x.id)).map((x) => ({ section: s, slot: x })),
  );
  const unchanged = (): WordingResult => ({
    storyboard: sb,
    changed: [],
    ignored: [],
    provider: '',
    model: undefined,
    fellBack: false,
  });
  if (slots.length === 0) return unchanged();

  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  const lower = terms.map((t) => t.toLowerCase());
  const mentionsExcluded = (t: string) => lower.some((x) => t.toLowerCase().includes(x));

  const wire = slots.map(({ section, slot }, i) => ({
    key: `slot-${i + 1}`,
    kind: slot.kind,
    section: section.name,
    purpose: redact(slot.purpose),
    seconds: slot.duration.ideal,
    ...(slot.kind === 'shot'
      ? {
          accepts: slot.accepts ?? ['gameplay'],
          title: redact(slot.title),
          captureInstruction: redact(slot.captureInstruction),
          ...(slot.overlays[0]?.text && !/^\d+$/.test(slot.overlays[0].text)
            ? { caption: redact(slot.overlays[0].text) }
            : {}),
        }
      : { text: redact(slot.text) }),
  }));
  const format = tiktokFormat(short.concept.formatId);
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
    WORDING_TASK,
    {
      format: format?.name ?? 'TikTok',
      concept: redact(
        JSON.stringify(
          { title: c.title, hook: c.hook, pitch: c.pitch, seconds: c.targetSeconds },
          null,
          2,
        ),
      ),
      voiceover: sb.voLines.length
        ? sb.voLines.map((v) => `- ${redact(v.text)}`).join('\n')
        : '(none)',
      slots: JSON.stringify(wire, null, 2),
      brief: redact(JSON.stringify(brief, null, 2)),
      knowledge: knowledge || '(none)',
    },
    [CAPTURE_TIPS_PROMPTS_DIR],
  );
  opts.signal?.throwIfAborted();
  const r = await deps.llm.generate(
    WORDING_TASK,
    { system, prompt, schema: GeneratedWording },
    opts.signal,
  );
  opts.signal?.throwIfAborted();

  const byKey = new Map(slots.map((s, i) => [`slot-${i + 1}`, s.slot.id]));
  const ignored: WordingResult['ignored'] = [];
  const patches = new Map<string, { title?: string; captureInstruction?: string; text?: string; captionText?: string }>(); // prettier-ignore
  for (const w of r.value.slots) {
    const slotId = byKey.get(w.key.trim());
    if (!slotId) continue;
    const kind = slots.find((s) => s.slot.id === slotId)!.slot.kind;
    const take = (field: 'title' | 'captureInstruction' | 'text' | 'captionText', max: number) => {
      const raw = w[field];
      if (raw === undefined) return;
      const v = clean(raw);
      const ok =
        field === 'captionText'
          ? v.split(' ').length <= MAX_CAPTION_WORDS && v.length <= 80
          : v.length <= max;
      const fits = (kind === 'shot' && field !== 'text') || (kind === 'card' && field === 'text');
      if (!fits) return ignored.push({ slotId, field, reason: `a ${kind} has no ${field}` });
      if (v.length === 0) return ignored.push({ slotId, field, reason: 'empty' });
      if (!ok) return ignored.push({ slotId, field, reason: 'too long' });
      if (mentionsExcluded(v))
        return ignored.push({ slotId, field, reason: 'mentions knowledge excluded from AI use' });
      patches.set(slotId, { ...patches.get(slotId), [field]: v });
    };
    take('title', MAX_TITLE);
    take('captureInstruction', MAX_INSTRUCTION);
    take('text', MAX_CARD);
    take('captionText', 80);
  }

  const changed: string[] = [];
  const next = structuredClone(sb);
  for (const section of next.sections)
    for (const slot of section.slots) {
      const p = patches.get(slot.id);
      if (!p) continue;
      const before = JSON.stringify(slot);
      if (slot.kind === 'shot') {
        if (p.title !== undefined) slot.title = p.title;
        if (p.captureInstruction !== undefined) slot.captureInstruction = p.captureInstruction;
        const overlay = slot.overlays[0];
        if (p.captionText !== undefined && overlay && !/^\d+$/.test(overlay.text ?? ''))
          overlay.text = p.captionText;
      } else if (p.text !== undefined) slot.text = p.text;
      if (JSON.stringify(slot) !== before) changed.push(slot.id);
    }
  if (changed.length === 0)
    return { ...unchanged(), ignored, provider: r.provider, model: r.model, fellBack: r.fellBack };
  return {
    storyboard: Storyboard.parse(next),
    changed,
    ignored,
    provider: r.provider,
    model: r.model,
    fellBack: r.fellBack,
  };
}
