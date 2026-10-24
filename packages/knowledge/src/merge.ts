import type { ExtractedEntity } from '@trailerforge/plugin-api';
import { mintId, type KnowledgeEntity } from '@trailerforge/schema';
import { dedupe, unionTags } from './generic.js';

/** Tag on entities found by the opt-in deep scan, so a normal re-scan doesn't delete them. */
export const DEEP_SCAN_TAG = 'deep-scan';
/** Tag on extracted entities a re-scan no longer finds but that are still referenced or excluded. */
export const STALE_TAG = 'stale';

export type ScanScope = 'standard' | 'deep';

export interface MergeResult {
  knowledge: KnowledgeEntity[];
  added: string[];
  updated: string[];
  /** Deleted: extracted, unreferenced, no longer found. */
  removed: string[];
  /** Kept but tagged `stale` because the storyboard references them or the user excluded them. */
  stale: string[];
}

const keyOf = (e: { kind: string; name: string }) => `${e.kind}\0${e.name.trim().toLowerCase()}`;
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fold a scan's entities into the project's knowledge without losing the user's work:
 *
 * - `origin: 'user'` entities (added by hand, or extracted ones the user edited) are never
 *   changed; a scan that finds the same kind+name leaves them alone.
 * - Extracted entities of this source are refreshed (description, paths, confidence) but keep
 *   their id, `excludedFromLlm`, tags and extensions.
 * - Extracted entities the scan no longer finds are deleted, unless the storyboard references
 *   them (deleting would break the project) or the user excluded them (deleting would forget the
 *   exclusion, and the entity would come back un-excluded); those stay, tagged `stale`.
 * - Entities from other sources are not touched, and are not duplicated.
 * - A `deep` scan only manages entities carrying the deep-scan tag, so the two scopes don't
 *   delete each other's results.
 */
export function mergeKnowledge(
  existing: readonly KnowledgeEntity[],
  sourceId: string,
  incoming: readonly ExtractedEntity[],
  opts: { scope?: ScanScope; taken: Set<string>; referenced: ReadonlySet<string> },
): MergeResult {
  const scope = opts.scope ?? 'standard';
  const byKey = new Map<string, KnowledgeEntity>();
  // User entities win a key clash so a hand-added entity is the one that matches.
  for (const e of [...existing].sort(
    (a, b) => Number(a.origin === 'user') - Number(b.origin === 'user'),
  )) {
    byKey.set(keyOf(e), e);
  }

  const seen = new Set<string>();
  const replaced = new Map<string, KnowledgeEntity>();
  const added: KnowledgeEntity[] = [];
  const result: Omit<MergeResult, 'knowledge'> = { added: [], updated: [], removed: [], stale: [] };

  for (const inc of dedupe([...incoming])) {
    const match = byKey.get(keyOf(inc));
    if (match) {
      seen.add(match.id);
      if (match.origin === 'user' || (match.sourceId !== undefined && match.sourceId !== sourceId))
        continue;
      const description = inc.description?.trim() ? inc.description : match.description;
      // Extractor tags are added, never removed: a tag the user set on an extracted entity stays.
      const tags = unionTags(
        match.tags.filter((t) => t !== STALE_TAG),
        inc.tags ?? [],
      );
      const next: KnowledgeEntity = {
        ...match,
        description,
        sourcePaths: inc.sourcePaths,
        confidence: inc.confidence,
        tags,
      };
      const changed =
        description !== match.description ||
        inc.confidence !== match.confidence ||
        !sameList(inc.sourcePaths, match.sourcePaths) ||
        !sameList(tags, match.tags);
      if (changed) {
        replaced.set(match.id, next);
        result.updated.push(match.id);
      }
      continue;
    }
    const entity: KnowledgeEntity = {
      id: mintId('ent', inc.name, opts.taken),
      kind: inc.kind,
      name: inc.name.trim(),
      description: inc.description ?? '',
      sourceId,
      sourcePaths: inc.sourcePaths,
      confidence: inc.confidence,
      origin: 'extracted',
      excludedFromLlm: false,
      tags: unionTags(inc.tags ?? [], scope === 'deep' ? [DEEP_SCAN_TAG] : []),
      extensions: {},
    };
    added.push(entity);
    byKey.set(keyOf(entity), entity);
    result.added.push(entity.id);
  }

  const managed = (e: KnowledgeEntity) =>
    e.origin === 'extracted' &&
    e.sourceId === sourceId &&
    e.tags.includes(DEEP_SCAN_TAG) === (scope === 'deep');

  const kept: KnowledgeEntity[] = [];
  for (const e of existing) {
    if (!managed(e) || seen.has(e.id)) {
      kept.push(replaced.get(e.id) ?? e);
    } else if (opts.referenced.has(e.id) || e.excludedFromLlm) {
      kept.push(e.tags.includes(STALE_TAG) ? e : { ...e, tags: [...e.tags, STALE_TAG] });
      result.stale.push(e.id);
    } else {
      result.removed.push(e.id);
    }
  }
  return { knowledge: [...kept, ...added], ...result };
}
