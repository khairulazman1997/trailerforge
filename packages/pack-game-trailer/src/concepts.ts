import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { Concept, type ConceptSource, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { CAPTURE_TIPS_PROMPTS_DIR, excludedTerms, redactor, textLeaves } from './capture-tips.js';
import { TIKTOK_FORMAT_IDS, TIKTOK_FORMATS } from './tiktok-formats.js';

/**
 * TikTok concepts (route `tiktok.concepts`): short-form ideas built from the brief, the game
 * knowledge and the developer's own ideas. They come from two places and go through the same
 * checks: the app's LLM (`generateConcepts`) and Claude Code over MCP (`vetConcepts` on what it
 * proposes). Nothing here changes the project; the engine adds the vetted concepts to the waiting
 * list, and the user picks one. Knowledge excluded from LLM use never goes out, and a concept
 * that mentions it is dropped, so it cannot reach a later prompt through the concept list.
 */

export const CONCEPTS_TASK = 'tiktok.concepts';
export const DEFAULT_CONCEPT_COUNT = 5;
export const MAX_CONCEPT_COUNT = 10;
const KNOWLEDGE_CAP = 120;
const MAX_IDEAS = 10;
const MAX_IDEA_CHARS = 500;

/** A concept as a model or Claude Code writes it: no id, source or time. */
export const RawConcept = z.strictObject({
  title: z.string(),
  hook: z.string(),
  formatId: z.string(),
  pitch: z.string().default(''),
  shotList: z.array(z.string()).default([]),
  voiceover: z.array(z.string()).default([]),
  targetSeconds: z.number(),
  entityIds: z.array(z.string()).default([]),
});
export type RawConcept = z.infer<typeof RawConcept>;
export type RawConceptInput = z.input<typeof RawConcept>;

/** What the app's LLM is asked for; the format is one of the built-in ones. */
export const GeneratedConcepts = z.strictObject({
  concepts: z.array(RawConcept.extend({ formatId: z.enum(TIKTOK_FORMAT_IDS) })).max(12),
});

/** A concept ready for `core/concepts.add` (the command mints the id and the time). */
export type VettedConcept = Omit<z.input<typeof Concept>, 'id' | 'createdAt'>;

export interface RejectedConcept {
  /** Position in what was proposed, from 0. */
  index: number;
  title: string;
  reasons: string[];
}

export interface VetResult {
  concepts: VettedConcept[];
  rejected: RejectedConcept[];
  warnings: string[];
}

export interface VetOptions {
  source: ConceptSource;
  /**
   * Unknown fact ids reject the concept (Claude Code is told which ids exist and can retry);
   * otherwise they are dropped with a warning (the app's model sometimes slips).
   */
  strictEntities: boolean;
}

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const clean = (lines: readonly string[]) => lines.map((l) => l.trim()).filter(Boolean);

/** Titles of the concepts already waiting and of the concepts the project's shorts came from. */
export function existingConceptTitles(project: Project): string[] {
  return [...project.concepts.map((c) => c.title), ...project.shorts.map((s) => s.concept.title)];
}

/**
 * Check proposed concepts against the schema, the built-in formats, the project's knowledge and
 * the exclusions. Accepted concepts are trimmed and ready to add; each rejected one says why, in
 * words the proposer can act on.
 */
export function vetConcepts(
  project: Project,
  proposed: readonly unknown[],
  opts: VetOptions,
): VetResult {
  const result: VetResult = { concepts: [], rejected: [], warnings: [] };
  const visible = new Set(project.knowledge.filter((e) => !e.excludedFromLlm).map((e) => e.id));
  const terms = excludedTerms(project.knowledge).map((t) => t.toLowerCase());
  const seen = new Set(existingConceptTitles(project).map(normTitle));

  proposed.forEach((item, index) => {
    const parsed = RawConcept.safeParse(item);
    const title = parsed.success
      ? parsed.data.title.trim()
      : typeof (item as { title?: unknown } | null)?.title === 'string'
        ? (item as { title: string }).title
        : `(concept ${index + 1})`;
    const reject = (...reasons: string[]) => result.rejected.push({ index, title, reasons });
    if (!parsed.success) {
      reject(...parsed.error.issues.map((i) => `${i.path.join('.') || 'concept'}: ${i.message}`));
      return;
    }
    const raw = parsed.data;
    const reasons: string[] = [];
    if (!TIKTOK_FORMAT_IDS.includes(raw.formatId)) {
      reasons.push(`unknown format "${raw.formatId}"; use one of ${TIKTOK_FORMAT_IDS.join(', ')}`);
    }
    const ids = [...new Set(raw.entityIds.map((e) => e.trim()).filter(Boolean))];
    const unknown = ids.filter((id) => !visible.has(id));
    const entityIds = ids.filter((id) => visible.has(id));
    if (unknown.length > 0) {
      if (opts.strictEntities) {
        reasons.push(
          `entityIds not in the game knowledge: ${unknown.join(', ')}; use ids from knowledge_list`,
        );
      } else result.warnings.push(`"${title}": dropped unknown facts ${unknown.join(', ')}`);
    }
    const candidate = {
      id: 'con_check',
      source: opts.source,
      title: raw.title.trim(),
      hook: raw.hook.trim(),
      formatId: raw.formatId,
      pitch: raw.pitch.trim(),
      shotList: clean(raw.shotList),
      voiceover: clean(raw.voiceover),
      targetSeconds: raw.targetSeconds,
      entityIds,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const checked = Concept.safeParse(candidate);
    if (!checked.success) {
      reasons.push(...checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    }
    if (terms.length > 0) {
      const text = textLeaves(candidate, ['id', 'source', 'formatId', 'entityIds', 'createdAt'])
        .join('\n')
        .toLowerCase();
      if (terms.some((t) => text.includes(t))) {
        reasons.push('mentions something excluded from AI use in the game knowledge');
      }
    }
    const key = normTitle(candidate.title);
    if (reasons.length === 0 && seen.has(key))
      reasons.push('a concept with this title already exists');
    if (reasons.length > 0) {
      reject(...reasons);
      return;
    }
    seen.add(key);
    const { id: _id, createdAt: _at, ...concept } = candidate;
    result.concepts.push(concept);
  });
  return result;
}

export interface GenerateConceptsDeps {
  llm: LlmClient;
}

export interface GenerateConceptsOptions {
  /** The developer's own ideas, one per entry. */
  ideas?: readonly string[];
  /** How many to ask for (1 to 10, default 5). */
  count?: number;
  signal?: AbortSignal;
}

export interface GenerateConceptsResult extends VetResult {
  provider: string;
  model: string | undefined;
  fellBack: boolean;
}

/** The formats as the prompt lists them. */
function formatLines(): string {
  return TIKTOK_FORMATS.map((f) => `- ${f.id}: ${f.name}. ${f.description}`).join('\n');
}

/**
 * Ask the model for concepts. The client's disclosure gate runs before anything leaves the
 * machine. Works with any provider, including Mock, Ollama and Chat Handoff.
 */
export async function generateConcepts(
  deps: GenerateConceptsDeps,
  project: Project,
  opts: GenerateConceptsOptions = {},
): Promise<GenerateConceptsResult> {
  const count = Math.min(
    MAX_CONCEPT_COUNT,
    Math.max(1, Math.round(opts.count ?? DEFAULT_CONCEPT_COUNT)),
  );
  const redact = redactor(excludedTerms(project.knowledge));
  const ideas = (opts.ideas ?? [])
    .map((i) => i.trim().slice(0, MAX_IDEA_CHARS))
    .filter(Boolean)
    .slice(0, MAX_IDEAS);
  const { assumptions: _a, ...brief } = project.brief;
  const knowledge = project.knowledge
    .filter((e) => !e.excludedFromLlm)
    .slice(0, KNOWLEDGE_CAP)
    .map((e) => `- ${e.id}: ${e.kind}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');
  const existing = existingConceptTitles(project);

  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const prompt = await loadPrompt(
    CONCEPTS_TASK,
    {
      count: String(count),
      formats: formatLines(),
      ideas: ideas.length
        ? ideas.map((i) => `- ${redact(i)}`).join('\n')
        : '(none; choose the strongest angles)',
      existing: existing.length ? existing.map((t) => `- ${redact(t)}`).join('\n') : '(none)',
      brief: redact(JSON.stringify(brief, null, 2)),
      knowledge: knowledge || '(none)',
    },
    [CAPTURE_TIPS_PROMPTS_DIR],
  );
  opts.signal?.throwIfAborted();
  const r = await deps.llm.generate(
    CONCEPTS_TASK,
    { system, prompt, schema: GeneratedConcepts },
    opts.signal,
  );
  opts.signal?.throwIfAborted();
  const vetted = vetConcepts(project, r.value.concepts, { source: 'app', strictEntities: false });
  return { ...vetted, provider: r.provider, model: r.model, fellBack: r.fellBack };
}
