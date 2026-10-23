import type { KnowledgeEntity, KnowledgeEntityKind } from '@trailerforge/schema';
import { makeId } from './ids.js';

export const KINDS = [
  'title',
  'level',
  'character',
  'enemy',
  'boss',
  'ability',
  'item',
  'mechanic',
  'quest',
  'cutscene',
  'achievement',
  'music',
  'art',
  'other',
] as const satisfies readonly KnowledgeEntityKind[];

// Compile-time check: adding a kind to the schema without listing it here is an error.
type Missing = Exclude<KnowledgeEntityKind, (typeof KINDS)[number]>;
export const _allKindsListed: Missing extends never ? true : never = true;

export type EntityView = 'all' | 'shared' | 'excluded' | 'yours' | 'scanned' | 'stale' | 'deep';

export interface EntityFilter {
  kind: KnowledgeEntityKind | 'all';
  view: EntityView;
  query: string;
}

export const isDeep = (e: KnowledgeEntity) => e.tags.includes('deep-scan');
export const isStale = (e: KnowledgeEntity) => e.tags.includes('stale');

const VIEWS: Record<EntityView, (e: KnowledgeEntity) => boolean> = {
  all: () => true,
  shared: (e) => !e.excludedFromLlm,
  excluded: (e) => e.excludedFromLlm,
  yours: (e) => e.origin === 'user',
  scanned: (e) => e.origin === 'extracted' && !isDeep(e),
  stale: isStale,
  deep: isDeep,
};

/** Entries to show: filtered, then ordered by kind (the schema's order) and name. */
export function filterEntities(
  entities: readonly KnowledgeEntity[],
  f: EntityFilter,
): KnowledgeEntity[] {
  const q = f.query.trim().toLowerCase();
  const kindRank = new Map<string, number>(KINDS.map((k, i) => [k, i]));
  return entities
    .filter((e) => (f.kind === 'all' || e.kind === f.kind) && VIEWS[f.view](e))
    .filter(
      (e) =>
        !q || `${e.name} ${e.description} ${e.sourcePaths.join(' ')}`.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        (kindRank.get(a.kind) ?? 99) - (kindRank.get(b.kind) ?? 99) || a.name.localeCompare(b.name),
    );
}

/** What the privacy banner says: how much of the knowledge base an LLM may see. */
export function privacySummary(entities: readonly KnowledgeEntity[]) {
  const excluded = entities.filter((e) => e.excludedFromLlm).length;
  return { total: entities.length, shared: entities.length - excluded, excluded };
}

export interface Badge {
  label: string;
  tone: 'neutral' | 'info' | 'warn' | 'ok';
  title: string;
}

/** Small labels explaining where an entry came from and how it is treated. */
export function entityBadges(e: KnowledgeEntity): Badge[] {
  const out: Badge[] = [];
  out.push(
    e.origin === 'user'
      ? { label: 'Yours', tone: 'ok', title: 'You added or edited this; scans never change it.' }
      : isDeep(e)
        ? {
            label: 'Deep scan',
            tone: 'info',
            title: 'Found by Claude Code reading the repo; less certain.',
          }
        : {
            label: 'Scanned',
            tone: 'neutral',
            title: 'Found by scanning the repo; a re-scan may update it.',
          },
  );
  if (isStale(e)) {
    out.push({
      label: 'Not found now',
      tone: 'warn',
      title:
        'The last scan no longer found this, but it is still used or excluded, so it was kept.',
    });
  }
  if (e.excludedFromLlm) {
    out.push({ label: 'Excluded from AI', tone: 'warn', title: 'Never sent to an AI provider.' });
  }
  return out;
}

export const makeEntityId = (name: string, rand?: () => string): string =>
  makeId('ent', name, rand);
