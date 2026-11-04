import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import {
  CONCEPTS_TASK,
  generateConcepts,
  vetConcepts,
  type RejectedConcept,
  type VetResult,
  type VettedConcept,
} from '@trailerforge/pack-game-trailer';
import { DecisionRecord } from '@trailerforge/schema';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/**
 * TikTok concepts: ideas for short videos, kept in `project.concepts` until the user picks one
 * (`core/shorts.add`). They come from the app's LLM (`conceptsOp`) or from Claude Code, which
 * proposes them over MCP (`proposeConceptsOp`); both go through the same checks, and only the
 * ones that pass are added, as one undo step.
 */

/** The waiting list stops growing here; the user clears some before asking for more. */
export const MAX_WAITING_CONCEPTS = 60;

export interface ConceptsOutcome {
  added: { id: string; title: string; formatId: string; source: string }[];
  /** Proposed concepts that failed a check, with the reasons. */
  rejected: RejectedConcept[];
  warnings: string[];
}

export interface ConceptsOptions {
  ideas?: readonly string[] | undefined;
  count?: number | undefined;
  signal?: AbortSignal | undefined;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function requireBrief(store: ProjectStore): void {
  if (!store.state.brief.title?.trim() && !store.state.brief.freeText?.trim()) {
    throw new OpError('usage', 'describe the game in the brief first (at least its name)');
  }
}

async function addVetted(
  store: ProjectStore,
  vetted: VetResult,
  via: Record<string, string | boolean | undefined>,
): Promise<ConceptsOutcome> {
  const room = MAX_WAITING_CONCEPTS - store.state.concepts.length;
  if (vetted.concepts.length > room) {
    throw new OpError(
      'usage',
      `there are ${store.state.concepts.length} concepts waiting; remove some before adding ${vetted.concepts.length} more`,
    );
  }
  const out: ConceptsOutcome = { added: [], rejected: vetted.rejected, warnings: vetted.warnings };
  if (vetted.concepts.length === 0) return out;
  const before = store.state.concepts.length;
  store.dispatch('core/concepts.add', { concepts: vetted.concepts as VettedConcept[] });
  const made = store.state.concepts.slice(before);
  out.added = made.map((c) => ({
    id: c.id,
    title: c.title,
    formatId: c.formatId,
    source: c.source,
  }));
  const at = new Date().toISOString();
  await appendDecisions(
    store.paths.decisions,
    made.map((c) =>
      DecisionRecord.parse({
        id: `dec_${sha256(`tiktok-concept|${at}|${c.id}`).slice(0, 24)}`,
        at,
        step: 'game-trailer/tiktok-concept',
        subject: { kind: 'concept', id: c.id },
        choice: { title: c.title, formatId: c.formatId },
        reasons: { source: c.source, ...via },
        summary: `Concept "${c.title}" (${c.formatId.replace('game-trailer/tiktok-', '')}) from ${
          c.source === 'claude-code' ? 'Claude Code' : 'the app’s AI'
        }: ${c.hook}`.slice(0, 400),
      }),
    ),
  );
  return out;
}

/** Ask the app's LLM for concepts and add the ones that pass the checks. */
export async function conceptsOp(
  engine: Engine,
  store: ProjectStore,
  opts: ConceptsOptions = {},
): Promise<ConceptsOutcome> {
  requireBrief(store);
  const r = await generateConcepts({ llm: engine.llmFor(store) }, store.state, {
    ...(opts.ideas ? { ideas: opts.ideas } : {}),
    ...(opts.count !== undefined ? { count: opts.count } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  return addVetted(store, r, {
    task: CONCEPTS_TASK,
    provider: r.provider,
    ...(r.model ? { model: r.model } : {}),
    fellBack: r.fellBack,
  });
}

/**
 * Add concepts that Claude Code (or another tool) proposes. Stricter than the app's own: a fact
 * id that is not in the game knowledge rejects the concept, so the proposer can correct it.
 */
export async function proposeConceptsOp(
  _engine: Engine,
  store: ProjectStore,
  proposals: readonly unknown[],
): Promise<ConceptsOutcome> {
  if (proposals.length === 0) throw new OpError('usage', 'propose at least one concept');
  if (proposals.length > 20) throw new OpError('usage', 'propose at most 20 concepts at a time');
  const vetted = vetConcepts(store.state, proposals, {
    source: 'claude-code',
    strictEntities: true,
  });
  return addVetted(store, vetted, { task: 'claude-code' });
}
