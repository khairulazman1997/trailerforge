import type { KnowledgeEntity } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { entityBadges, filterEntities, makeEntityId, privacySummary } from './knowledge-view.js';

const e = (over: Partial<KnowledgeEntity> & { id: string; name: string }): KnowledgeEntity => ({
  kind: 'boss',
  description: '',
  sourcePaths: [],
  confidence: 1,
  origin: 'extracted',
  excludedFromLlm: false,
  tags: [],
  extensions: {},
  ...over,
});

const all = [
  e({ id: 'a', name: 'Zed', kind: 'level' }),
  e({ id: 'b', name: 'Ash Warden', description: 'Two phases', sourcePaths: ['README.md'] }),
  e({ id: 'c', name: 'Beta', excludedFromLlm: true }),
  e({ id: 'd', name: 'Mine', origin: 'user', kind: 'ability' }),
  e({ id: 'g', name: 'Gone', tags: ['stale'] }),
  e({ id: 'h', name: 'Hidden Gem', tags: ['deep-scan'], kind: 'mechanic' }),
];

describe('filterEntities', () => {
  const f = (over = {}) =>
    filterEntities(all, { kind: 'all', view: 'all', query: '', ...over }).map((x) => x.id);

  it('orders by kind then name', () => {
    // schema order: level, boss, ability, mechanic
    expect(f()).toEqual(['a', 'b', 'c', 'g', 'd', 'h']);
  });

  it('filters by kind, view and text (name, description, source path)', () => {
    expect(f({ kind: 'boss' })).toEqual(['b', 'c', 'g']);
    expect(f({ view: 'excluded' })).toEqual(['c']);
    expect(f({ view: 'shared' })).toHaveLength(5);
    expect(f({ view: 'yours' })).toEqual(['d']);
    expect(f({ view: 'scanned' })).toEqual(['a', 'b', 'c', 'g']);
    expect(f({ view: 'stale' })).toEqual(['g']);
    expect(f({ view: 'deep' })).toEqual(['h']);
    expect(f({ query: ' PHASES ' })).toEqual(['b']);
    expect(f({ query: 'readme' })).toEqual(['b']);
    expect(f({ kind: 'boss', query: 'zed' })).toEqual([]);
  });
});

describe('privacySummary and badges', () => {
  it('counts what an AI may see', () => {
    expect(privacySummary(all)).toEqual({ total: 6, shared: 5, excluded: 1 });
    expect(privacySummary([])).toEqual({ total: 0, shared: 0, excluded: 0 });
  });

  it('explains origin, staleness and exclusion', () => {
    const labels = (id: string) => entityBadges(all.find((x) => x.id === id)!).map((b) => b.label);
    expect(labels('b')).toEqual(['Scanned']);
    expect(labels('c')).toEqual(['Scanned', 'Excluded from AI']);
    expect(labels('d')).toEqual(['Yours']);
    expect(labels('g')).toEqual(['Scanned', 'Not found now']);
    expect(labels('h')).toEqual(['Deep scan']);
  });
});

describe('makeEntityId', () => {
  it('makes valid, readable ids', () => {
    const id = makeEntityId('The Ash Warden!', () => 'abc123');
    expect(id).toBe('ent_the_ash_warden_abc123');
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(makeEntityId('???', () => 'x')).toBe('ent_x_x');
    expect(makeEntityId('a'.repeat(100), () => 'z').length).toBeLessThanOrEqual(64);
  });
});
