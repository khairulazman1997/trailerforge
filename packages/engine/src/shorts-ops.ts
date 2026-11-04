import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import { LlmConsentError } from '@trailerforge/llm';
import {
  fillShortWording,
  rebuildShortStoryboard,
  tiktokFormat,
  WORDING_TASK,
} from '@trailerforge/pack-game-trailer';
import { DecisionRecord, type Short } from '@trailerforge/schema';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/**
 * TikTok templates. A short is made from a concept (`core/shorts.add`, which any caller can
 * dispatch) and then built: the format fixes the structure and the concept seeds the words, so
 * the build works with no AI at all; an optional AI pass improves the wording of the slots that
 * were just written. Building again (or only some sections) refreshes what the user has not
 * touched and keeps locked sections, slots with files or hand edits, and recorded voiceover.
 */

export interface BuildShortOptions {
  /** Only these sections; default all. */
  sectionIds?: readonly string[] | undefined;
  /** Improve the wording with the AI (default true). Failing or declining never fails the build. */
  wording?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface BuildShortOutcome {
  shortId: string;
  /** Slots written from the template and the concept. */
  rebuilt: number;
  /** Slots left as they were (files, hand edits, locked sections). */
  kept: number;
  wording:
    | { status: 'off' }
    | { status: 'nothing-to-write' }
    | { status: 'skipped'; reason: string }
    | { status: 'done'; changed: number; ignored: number };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function findShort(store: ProjectStore, shortId: string): Short {
  const s = store.state.shorts.find((x) => x.id === shortId);
  if (!s) throw new OpError('not-found', `no TikTok "${shortId}"`);
  return s;
}

export async function buildShortOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: BuildShortOptions = {},
): Promise<BuildShortOutcome> {
  const short = findShort(store, shortId);
  if (!tiktokFormat(short.concept.formatId))
    throw new OpError('usage', `unknown TikTok format "${short.concept.formatId}"`);
  for (const id of opts.sectionIds ?? [])
    if (!short.storyboard?.sections.some((s) => s.id === id))
      throw new OpError('not-found', `no section "${id}" in "${short.name}"`);

  const { callToAction, tone } = store.state.brief;
  const built = rebuildShortStoryboard({
    short,
    ...(callToAction ? { callToAction } : {}),
    ...(tone ? { tone } : {}),
    ...(opts.sectionIds ? { sectionIds: opts.sectionIds } : {}),
  });
  let storyboard = built.storyboard;
  let wording: BuildShortOutcome['wording'] = { status: 'off' };
  let via: Record<string, string | boolean> = {};
  if (opts.wording !== false) {
    if (built.rebuilt.length === 0) wording = { status: 'nothing-to-write' };
    else {
      try {
        const w = await fillShortWording(
          { llm: engine.llmFor(store) },
          store.state,
          { ...short, storyboard },
          { slotIds: built.rebuilt, ...(opts.signal ? { signal: opts.signal } : {}) },
        );
        storyboard = w.storyboard;
        wording = { status: 'done', changed: w.changed.length, ignored: w.ignored.length };
        via = { task: WORDING_TASK, provider: w.provider, fellBack: w.fellBack };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        wording = {
          status: 'skipped',
          reason:
            err instanceof LlmConsentError
              ? 'you chose not to send the wording request'
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }
  }
  opts.signal?.throwIfAborted();

  store.dispatch('core/shorts.set-storyboard', { shortId, storyboard });
  const at = new Date().toISOString();
  await appendDecisions(store.paths.decisions, [
    DecisionRecord.parse({
      id: `dec_${sha256(`tiktok-template|${at}|${shortId}`).slice(0, 24)}`,
      at,
      step: 'game-trailer/tiktok-template',
      subject: { kind: 'short', id: shortId },
      choice: { formatId: short.concept.formatId, targetSeconds: short.concept.targetSeconds },
      reasons: {
        rebuilt: built.rebuilt.length,
        kept: built.kept.length,
        wording: wording.status,
        ...via,
      },
      summary: `Built the ${tiktokFormat(short.concept.formatId)!.name} template for "${short.name}": ${built.rebuilt.length} slots written, ${built.kept.length} kept.`,
    }),
  ]);
  return { shortId, rebuilt: built.rebuilt.length, kept: built.kept.length, wording };
}
