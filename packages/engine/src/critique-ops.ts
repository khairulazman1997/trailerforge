import { CommandError, appendDecisions, type ProjectStore } from '@trailerforge/core';
import { flicksPerFrame, type CritiqueFix, type Timeline } from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { buildCritiqueFacts, critique, type CritiqueFacts } from './critique.js';
import { applyCritiqueFix } from './critique-commands.js';
import { ROUGH_CUT_TIMELINE_ID, buildCutTimeline, cutGridOp } from './footage-ops.js';
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

export interface ApplyFixOutcome {
  /** Whether the rough cut was rebuilt with the fix (false: no cut yet, so nothing to rebuild). */
  rebuilt: boolean;
  warnings: string[];
}

/**
 * Apply a critique note's fix and rebuild the rough cut from the changed storyboard, in one undo
 * step, so the next draft or export shows it (renders read the cut, not the storyboard). Hand
 * edits elsewhere are kept as on a rebuild; a shot whose length the fix sets loses its own hand
 * trims, since the fix is about exactly that.
 */
export async function applyCritiqueFixOp(
  engine: Engine,
  store: ProjectStore,
  commentId: string,
): Promise<ApplyFixOutcome> {
  const type = 'core/critique.apply-fix';
  const fix = store.state.review.comments.find((c) => c.id === commentId)?.fix;
  const previous = store.state.timelines.find((t) => t.id === ROUGH_CUT_TIMELINE_ID);
  if (!previous || !fix) {
    store.dispatch(type, { commentId });
    return { rebuilt: false, warnings: [] };
  }
  // The storyboard as the fix leaves it (the command's own checks refuse a stale note here).
  const next = structuredClone(store.state) as Parameters<typeof applyCritiqueFix.apply>[0];
  try {
    applyCritiqueFix.apply(next, { commentId });
  } catch (e) {
    if (e instanceof CommandError) throw new OpError('usage', e.message);
    throw e;
  }
  const base = fix.type === 'slot-duration' ? withoutHandEdits(previous, fix.slotId) : previous;
  let built;
  try {
    built = await buildCutTimeline(engine, store, {
      storyboard: next.storyboard ?? undefined,
      previous: base,
    });
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    store.dispatch(type, { commentId });
    return { rebuilt: false, warnings: [`The cut was not rebuilt: ${e.message}.`] };
  }
  store.dispatch(type, { commentId, timeline: built.timeline });
  await appendDecisions(store.paths.decisions, built.decisions);
  return { rebuilt: true, warnings: built.warnings };
}

/** The cut with the hand-edit marks of one shot's items cleared, so a rebuild re-times them. */
function withoutHandEdits(tl: Timeline, slotId: string): Timeline {
  const copy = structuredClone(tl);
  for (const item of copy.tracks.flatMap((t) => t.items)) {
    const core = item.extensions.core as Record<string, unknown> | undefined;
    if (item.slotId === slotId && core) delete core.userEdited;
  }
  return copy;
}
