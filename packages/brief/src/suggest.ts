import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import type { Assumption, Project } from '@trailerforge/schema';
import { z } from 'zod';
import type { CompletenessReport, Question } from './completeness.js';
import { FORMAT_PRESETS } from './formats.js';

export const BRIEF_PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** The shape an answer must have, derived from the question. */
export function answerSchema(q: Question): z.ZodType {
  switch (q.input) {
    case 'list':
    case 'multi-choice':
      return z.array(z.string().min(1)).min(q.minItems ?? 1);
    case 'date':
      return q.id.endsWith('].date') || q.id.endsWith('Date')
        ? z.union([z.iso.date(), z.string().min(1)])
        : z.string().min(1);
    default:
      return z.string().min(1);
  }
}

/**
 * "Suggest for me": ask the LLM for one field, grounded in the brief and the knowledge entities
 * the user hasn't excluded. The result is a suggestion for the user to accept or edit.
 */
export async function suggestAnswer(
  llm: LlmClient,
  project: Project,
  q: Question,
  signal?: AbortSignal,
): Promise<{ value: unknown; reason: string; provider: string }> {
  const { assumptions: _a, ...brief } = project.brief;
  const knowledge = project.knowledge
    .filter((e) => !e.excludedFromLlm)
    .slice(0, 80)
    .map((e) => `- ${e.kind}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');
  const constraints = [
    q.choices ? `Prefer one of: ${q.choices.join(' | ')}` : '',
    q.minItems ? `Give at least ${q.minItems} entries.` : '',
    q.help ? `Hint: ${q.help}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const prompt = await loadPrompt(
    'brief.suggest',
    {
      videoType: brief.videoTypeId ?? 'unspecified',
      label: q.label,
      field: q.id,
      input: q.input,
      constraints,
      brief: JSON.stringify(brief, null, 2),
      knowledge: knowledge || '(none)',
    },
    [BRIEF_PROMPTS_DIR],
  );
  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const schema = z.strictObject({ value: answerSchema(q), reason: z.string() });
  const r = await llm.generate('brief.suggest', { system, prompt, schema }, signal);
  const out = r.value as { value: unknown; reason: string };
  return { value: out.value, reason: out.reason, provider: r.provider };
}

/** Commands that apply an answer: format presets become format targets, everything else a field. */
export function answerCommands(q: Question, value: unknown): { type: string; payload: unknown }[] {
  if (q.id === 'formatTargets') {
    const names = Array.isArray(value) ? value : [value];
    return FORMAT_PRESETS.filter((f) => names.includes(f.name)).map((f) => ({
      type: 'core/project.add-format-target',
      payload: f,
    }));
  }
  return [{ type: 'core/brief.set-field', payload: { path: q.id, value } }];
}

/**
 * "Proceed with assumptions": one visible assumption per missing required field, using the
 * suggestion when one exists.
 */
export function assumptionsFor(
  report: CompletenessReport,
  suggestions: ReadonlyMap<string, { value: unknown; reason: string }>,
  now: Date,
): Assumption[] {
  return report.missing
    .filter((m) => m.requirement.required)
    .map((m) => {
      const s = suggestions.get(m.requirement.field);
      return {
        field: m.requirement.field,
        value: (s?.value ?? null) as Assumption['value'],
        reason: s
          ? `Not provided; assumed: ${s.reason}`
          : 'Not provided; left open for the generator to fill sensibly',
        source: s ? 'ai' : 'user',
        createdAt: now.toISOString(),
      };
    });
}
