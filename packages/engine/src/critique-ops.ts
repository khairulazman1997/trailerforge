import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import { flicksPerFrame, type CritiqueFix } from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { buildCritiqueFacts, critique, type CritiqueFacts } from './critique.js';
import { cutGridOp } from './footage-ops.js';
import { OpError } from './ops.js';
import { buildVersion, planFindings } from './render-ops.js';

async function factsFor(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
): Promise<{ facts: CritiqueFacts; frameFlicks: number }> {
  if (!store.state.storyboard) throw new OpError('not-found', 'make a storyboard first');
  const b = await buildVersion(engine, store, variantId);
  const grid = await cutGridOp(engine, store);
  const facts = buildCritiqueFacts({
    project: store.state,
    timeline: b.timeline,
    beats: grid?.beats ?? null,
    bars: grid?.bars ?? null,
    findings: planFindings(b),
  });
  return { facts, frameFlicks: flicksPerFrame(b.timeline.frameRate) };
}

export interface CritiqueFactsView {
  variantId: string | null;
  /** What would be sent, in words. */
  summary: string[];
  /** The data exactly as it would be sent (names the project excluded are already removed). */
  wire: Record<string, unknown>;
  /** How many game facts are left out because you excluded them. */
  excluded: number;
}

/** What a critique of this version would send. Sends nothing. */
export async function critiqueFactsOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
): Promise<CritiqueFactsView> {
  const { facts } = await factsFor(engine, store, variantId);
  return {
    variantId,
    summary: facts.summary,
    wire: facts.wire,
    excluded: store.state.knowledge.filter((e) => e.excludedFromLlm).length,
  };
}

export interface CritiqueOutcome {
  variantId: string | null;
  provider: string;
  model: string;
  /** The notes now on the Review tab (the version's earlier open critique notes are replaced). */
  notes: { at: number; text: string; kind: 'issue' | 'idea'; slotId?: string; fix?: CritiqueFix }[];
  skipped: { about: string; reason: string }[];
  droppedFixes: { about: string; reason: string }[];
}

/**
 * Ask the AI for a critique of a version and put its notes on the Review tab as comments by the
 * critique (one undo step; the version's earlier open critique notes are replaced). Nothing is
 * stored when the run is cancelled or fails. Fixes are never applied here.
 */
export async function critiqueOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  opts: { signal?: AbortSignal | undefined; now?: () => Date } = {},
): Promise<CritiqueOutcome> {
  const { facts, frameFlicks } = await factsFor(engine, store, variantId);
  const result = await critique(
    { llm: engine.llmFor(store), ...(opts.now ? { now: opts.now } : {}) },
    facts,
    { variantId, frameFlicks, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  opts.signal?.throwIfAborted();
  store.dispatch('core/critique.add', {
    variantId,
    notes: result.notes.map((n) => ({
      at: n.at,
      ...(n.itemId ? { itemId: n.itemId } : {}),
      text: n.text,
      ...(n.fix ? { fix: n.fix } : {}),
    })),
  });
  if (result.decisions.length) await appendDecisions(store.paths.decisions, result.decisions);
  return {
    variantId,
    provider: result.provider,
    model: result.model,
    notes: result.notes.map(({ at, text, kind, slotId, fix }) => ({
      at,
      text,
      kind,
      ...(slotId ? { slotId } : {}),
      ...(fix ? { fix } : {}),
    })),
    skipped: result.skipped,
    droppedFixes: result.droppedFixes,
  };
}
