import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import { createClaudeCodeProvider } from '@trailerforge/llm';
import { scanSource, withScanSandbox } from '@trailerforge/knowledge';
import {
  CONCEPTS_TASK,
  GeneratedConcepts,
  conceptsPrompt,
  generateConcepts,
  vetConcepts,
  type RejectedConcept,
  type VetResult,
  type VettedConcept,
} from '@trailerforge/pack-game-trailer';
import { DecisionRecord, type Series } from '@trailerforge/schema';
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
  /** Write episodes of this series (they link to it and use its format). */
  series?: Pick<Series, 'id' | 'name' | 'premise' | 'formatId'> | undefined;
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
    ...(opts.series ? { series: opts.series } : {}),
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

// ---- "Ask Claude Code": concepts from reading the game itself ----------------------------------

export const CLAUDE_CODE_CONCEPTS_WARNING =
  'Asking Claude Code sends the text files of your game project (the ones the scan accepts: ' +
  'nothing ignored, no secrets, no huge files) and your brief to Anthropic through Claude Code, ' +
  'so it can read the game and suggest TikTok concepts. It works in a throwaway copy with ' +
  'read-only tools and changes nothing. Confirm explicitly to run it.';

export interface ClaudeCodeConceptsOptions extends ConceptsOptions {
  /** The user's explicit yes to `CLAUDE_CODE_CONCEPTS_WARNING`. */
  allow?: boolean | undefined;
  claudeBin?: string | undefined;
  onNotice?: ((message: string) => void) | undefined;
  /** Which repo, when the project has several. */
  repo?: string | undefined;
}

function sourceOf(store: ProjectStore, repo?: string) {
  const sources = store.state.sources;
  const s = repo ? sources.find((x) => x.path === repo) : sources[0];
  if (!s)
    throw new OpError(
      'usage',
      'this project has no game repo yet: scan one first (knowledge scan)',
    );
  if (!repo && sources.length > 1)
    throw new OpError('usage', 'this project has several sources; say which repo to use');
  return s;
}

async function scanOf(engine: Engine, source: ReturnType<typeof sourceOf>, signal?: AbortSignal) {
  try {
    return (
      await scanSource(source, (id) => engine.plugins.registries.knowledgeExtractors.get(id), {
        skipIfDigest: null,
        ...(signal ? { signal } : {}),
      })
    ).scan;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OpError('not-found', `the game repo ${source.path} was not found on this computer`);
    throw err;
  }
}

/** What "Ask Claude Code" would send, before anything is: the request text and the files. */
export async function claudeCodeConceptsPreviewOp(
  engine: Engine,
  store: ProjectStore,
  opts: ConceptsOptions & { repo?: string | undefined } = {},
) {
  requireBrief(store);
  const source = sourceOf(store, opts.repo);
  const scan = { scan: await scanOf(engine, source) };
  const prompt = await conceptsPrompt(
    store.state,
    {
      ...(opts.ideas ? { ideas: opts.ideas } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
    },
    'claude-code',
  );
  return {
    warning: CLAUDE_CODE_CONCEPTS_WARNING,
    repo: source.path,
    files: scan.scan.files.length,
    truncated: scan.scan.truncated,
    prompt,
  };
}

/**
 * Let Claude Code read the game (a read-only sandbox copy) and propose concepts. The answer goes
 * through the same checks as any proposal, as source `claude-code`; the user still picks one.
 */
export async function claudeCodeConceptsOp(
  engine: Engine,
  store: ProjectStore,
  opts: ClaudeCodeConceptsOptions = {},
): Promise<ConceptsOutcome & { filesShared: number }> {
  if (opts.allow !== true) throw new OpError('usage', CLAUDE_CODE_CONCEPTS_WARNING);
  requireBrief(store);
  const source = sourceOf(store, opts.repo);
  const scan = await scanOf(engine, source, opts.signal);
  const prompt = await conceptsPrompt(
    store.state,
    {
      ...(opts.ideas ? { ideas: opts.ideas } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
    },
    'claude-code',
  );
  opts.onNotice?.(`Claude Code will read ${scan.files.length} text files from a temporary copy.`);
  // Claude Code reaches the network itself: the hand-off is logged by Egress, under a purpose.
  const found = await engine.egress.scope(
    { purpose: 'TikTok concepts from the game (Claude Code)' },
    () =>
      withScanSandbox(scan, opts.signal, async ({ dir, shared }) => {
        const provider = createClaudeCodeProvider({
          ...(opts.claudeBin ? { bin: opts.claudeBin } : {}),
          tools: ['Read', 'Grep', 'Glob'],
          cwd: dir,
          handOff: (text) => engine.egress.handOff({ provider: 'core/claude-code', tool: 'claude-code', text }), // prettier-ignore
        });
        const r = await provider.generate(
          {
            task: CONCEPTS_TASK,
            system:
              'You are a careful creative strategist. You only read files; you never modify anything.',
            prompt,
            schema: GeneratedConcepts,
            effort: 'medium',
          },
          opts.signal ?? new AbortController().signal,
        );
        return { concepts: r.value.concepts, shared: shared.length, model: r.model };
      }),
  );
  opts.signal?.throwIfAborted();
  const vetted = vetConcepts(store.state, found.concepts, {
    source: 'claude-code',
    strictEntities: false,
  });
  const out = await addVetted(store, vetted, {
    task: 'claude-code-read',
    provider: 'core/claude-code',
  });
  return { ...out, filesShared: found.shared };
}
