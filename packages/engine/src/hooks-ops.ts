import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import { generateHooks, HOOKS_TASK } from '@trailerforge/pack-game-trailer';
import { LlmConsentError } from '@trailerforge/llm';
import { DecisionRecord, MAX_HOOKS, hookVersionId } from '@trailerforge/schema';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { findShort } from './shorts-ops.js';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export interface HooksOutcome {
  /** Hook versions added (their version ids), after the checks. */
  added: { id: string; versionId: string; name: string; caption: string }[];
  rejected: { index: number; name: string; reasons: string[] }[];
  /** Hooks that could not be added because the TikTok already has the most it can have. */
  full: boolean;
}

/**
 * Ask the app's AI for alternative openings and add the ones that pass the checks to the free
 * places (hook versions you made are kept). One undo step. Needs a template; the model never sees
 * the recordings.
 */
export async function generateHooksOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: { count?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<HooksOutcome> {
  const short = findShort(store, shortId);
  if (!short.storyboard) throw new OpError('usage', `"${short.name}" has no template yet: build it first`); // prettier-ignore
  const room = MAX_HOOKS - short.hooks.length;
  if (room <= 0) return { added: [], rejected: [], full: true };
  let r;
  try {
    r = await generateHooks({ llm: engine.llmFor(store) }, store.state, short, {
      count: Math.min(room, opts.count ?? room),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof LlmConsentError) throw new OpError('usage', 'you chose not to send the request'); // prettier-ignore
    throw err;
  }
  opts.signal?.throwIfAborted();
  if (r.hooks.length === 0) return { added: [], rejected: r.rejected, full: false };

  const before = new Set(short.hooks.map((h) => h.id));
  store.dispatch('core/shorts.set-hooks', {
    shortId,
    hooks: [
      ...short.hooks.map((h) => ({ ...h })),
      ...r.hooks.map((h) => ({ name: h.name, kind: h.kind, caption: h.caption, ...(h.why ? { why: h.why } : {}) })), // prettier-ignore
    ],
  });
  const added = findShort(store, shortId).hooks.filter((h) => !before.has(h.id));
  const at = new Date().toISOString();
  await appendDecisions(
    store.paths.decisions,
    added.map((h) =>
      DecisionRecord.parse({
        id: `dec_${sha256(`tiktok-hook|${at}|${shortId}|${h.id}`).slice(0, 24)}`,
        at,
        step: 'game-trailer/tiktok-hook',
        subject: { kind: 'short', id: shortId },
        choice: { hookId: h.id, kind: h.kind, caption: h.caption },
        reasons: { task: HOOKS_TASK, provider: r.provider, fellBack: r.fellBack },
        summary: `Hook version "${h.name}" for "${short.name}": ${h.caption || 'no text, straight into the action'}`.slice(0, 400), // prettier-ignore
      }),
    ),
  );
  return {
    added: added.map((h) => ({ id: h.id, versionId: hookVersionId(shortId, h.id), name: h.name, caption: h.caption })), // prettier-ignore
    rejected: r.rejected,
    full: false,
  };
}
