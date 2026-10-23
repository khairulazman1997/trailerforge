import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { announcementTrailer, releaseTrailer } from '@trailerforge/pack-game-trailer';
import { VideoTypeDef } from '@trailerforge/plugin-api';
import { Project, type ProjectInput } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { briefCommands } from './commands.js';
import { buildQuestionnaire, checkCompleteness } from './completeness.js';
import { getAt, parsePath, setAt } from './path.js';
import { answerCommands, assumptionsFor, suggestAnswer } from './suggest.js';

const release = VideoTypeDef.parse(releaseTrailer);
const announcement = VideoTypeDef.parse(announcementTrailer);

/** A release-trailer project with only a title and one selling point. */
function sparse(): ProjectInput {
  const p = sampleProject();
  return {
    ...p,
    formatTargets: [],
    storyboard: null,
    timelines: [],
    brief: {
      videoTypeId: 'game-trailer/release-trailer',
      title: 'Ember Knight',
      keySellingPoints: ['Parry combat'],
      tone: ['TBD'],
    },
  };
}

describe('path', () => {
  it('parses selectors and dashed keys', () => {
    expect(parsePath('brief.keyDates[label=Release].date')).toEqual([
      { key: 'brief' },
      { key: 'keyDates', filter: { field: 'label', value: 'Release' } },
      { key: 'date' },
    ]);
    expect(parsePath('brief.extensions.game-trailer.genre').map((s) => s.key)).toEqual([
      'brief',
      'extensions',
      'game-trailer',
      'genre',
    ]);
    expect(() => parsePath('brief..x')).toThrow();
  });

  it('gets and upserts through selectors', () => {
    const o: Record<string, unknown> = {
      brief: { keyDates: [{ label: 'Beta', date: '2026-12-01' }] },
    };
    expect(getAt(o, 'brief.keyDates[label=Release].date')).toBeUndefined();
    setAt(o, 'brief.keyDates[label=Release].date', '2027-02-14');
    setAt(o, 'brief.extensions.game-trailer.genre', 'Soulslike');
    expect(getAt(o, 'brief.keyDates[label=Release].date')).toBe('2027-02-14');
    expect((o.brief as { keyDates: unknown[] }).keyDates).toHaveLength(2);
    setAt(o, 'brief.keyDates[label=Release].date', '2027-03-01');
    expect((o.brief as { keyDates: unknown[] }).keyDates).toHaveLength(2);
    expect(getAt(o, 'brief.extensions.game-trailer.genre')).toBe('Soulslike');
  });
});

describe('checkCompleteness', () => {
  it('passes the fully specified sample project', () => {
    const r = checkCompleteness(Project.parse(sampleProject()), release);
    expect(r.missing.filter((m) => m.requirement.required)).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.canProceed).toBe(true);
  });

  it('reports missing, too-few and placeholder values without guessing', () => {
    const r = checkCompleteness(Project.parse(sparse()), release);
    const byLabel = Object.fromEntries(r.missing.map((m) => [m.requirement.label, m]));
    expect(r.complete).toBe(false);
    expect(byLabel['Key selling points']).toMatchObject({ reason: 'too-few', have: 1 });
    expect(byLabel['Tone']?.reason).toBe('placeholder');
    expect(byLabel['Release date']?.reason).toBe('missing');
    expect(byLabel['Output formats and length']?.reason).toBe('missing');
    expect(r.satisfied.map((s) => s.label)).toEqual(['Game name']);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(0.2);
  });

  it('accepts a release window instead of an exact date', () => {
    const p = sparse();
    p.brief.extensions = { 'game-trailer': { releaseWindow: 'Q2 2027' } };
    const r = checkCompleteness(Project.parse(p), release);
    expect(r.satisfied.map((s) => s.label)).toContain('Release date');
  });

  it('treats optional fields as non-blocking', () => {
    const p = Project.parse(sampleProject());
    const r = checkCompleteness({ ...p, brief: { ...p.brief, pressQuotes: [] } }, release);
    expect(r.missing.some((m) => m.requirement.label === 'Press quotes or accolades')).toBe(true);
    expect(r.complete).toBe(true);
  });

  it('lets logged assumptions unblock generation, but not count as complete', () => {
    const p = Project.parse(sparse());
    const report = checkCompleteness(p, release);
    const assumptions = assumptionsFor(
      report,
      new Map([['brief.tone', { value: ['Intense'], reason: 'typical for soulslikes' }]]),
      new Date('2026-10-23T14:00:00Z'),
    );
    expect(assumptions.find((a) => a.field === 'brief.tone')).toMatchObject({
      value: ['Intense'],
      source: 'ai',
    });
    expect(assumptions.find((a) => a.field === 'formatTargets')).toMatchObject({
      value: null,
      source: 'user',
    });
    const after = checkCompleteness({ ...p, brief: { ...p.brief, assumptions } }, release);
    expect(after).toMatchObject({ complete: false, canProceed: true });
    expect(after.assumed).toHaveLength(assumptions.length);
  });
});

describe('buildQuestionnaire', () => {
  it('asks only for what is missing, required first, with choices and reasons', () => {
    const qs = buildQuestionnaire(checkCompleteness(Project.parse(sparse()), release));
    expect(qs.map((q) => q.label).slice(0, 7)).toEqual([
      'Release date',
      'Platforms',
      'Genre',
      'Key selling points',
      'Tone',
      'Call to action',
      'Output formats and length',
    ]);
    expect(qs.every((q) => q.canSuggest)).toBe(true);
    expect(qs.find((q) => q.label === 'Key selling points')?.why).toBe(
      'Add at least 3 (you have 1)',
    );
    expect(qs.find((q) => q.label === 'Tone')?.why).toMatch(/placeholder/);
    expect(qs.find((q) => q.id === 'formatTargets')?.choices).toContain(
      'TikTok / Reels / Shorts 9:16 · 30 s',
    );
    expect(qs.filter((q) => !q.required).map((q) => q.label)).toContain('Target audience');
    expect(qs.some((q) => q.label === 'Game name')).toBe(false);
  });

  it('differs by video type', () => {
    const qs = buildQuestionnaire(checkCompleteness(Project.parse(sparse()), announcement));
    expect(qs.find((q) => q.label === 'Release date or window')?.required).toBe(false);
  });
});

describe('answering through the project store', () => {
  it('applies answers, adds formats and clears assumptions, until the brief is complete', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-brief-')), 'P.tforge');
    const registry = coreCommands();
    for (const c of briefCommands) registry.register(c);
    const store = await ProjectStore.create(dir, sparse(), { commands: registry, autosaveMs: 0 });
    try {
      const assume = assumptionsFor(checkCompleteness(store.state, release), new Map(), new Date());
      for (const a of assume) store.dispatch('core/brief.add-assumption', a);
      expect(checkCompleteness(store.state, release).canProceed).toBe(true);

      const answers: Record<string, unknown> = {
        'brief.keyDates[label=Release].date': '2027-02-14',
        'brief.extensions.game-trailer.gamePlatforms': ['PC (Steam)', 'PlayStation 5'],
        'brief.extensions.game-trailer.genre': 'Soulslike',
        'brief.keySellingPoints': ['Parry combat', 'Hand-drawn bosses', 'Co-op'],
        'brief.tone': ['Intense'],
        'brief.callToAction': 'Wishlist on Steam',
        formatTargets: ['YouTube 16:9 · 60 s', 'TikTok / Reels / Shorts 9:16 · 30 s'],
      };
      for (const q of buildQuestionnaire(checkCompleteness(store.state, release), {
        includeAssumed: true,
      })) {
        if (q.required) expect(q.assumption).toBeDefined();
        if (!(q.id in answers)) continue;
        for (const c of answerCommands(q, answers[q.id])) store.dispatch(c.type, c.payload);
      }
      const done = checkCompleteness(store.state, release);
      expect(done.complete).toBe(true);
      expect(store.state.brief.assumptions).toEqual([]);
      expect(store.state.formatTargets.map((f) => f.aspect)).toEqual(['16:9', '9:16']);
      expect(store.state.brief.keyDates).toEqual([{ label: 'Release', date: '2027-02-14' }]);

      // Every answer is undoable.
      store.undo();
      expect(store.state.formatTargets).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('rejects writes outside the brief and type-invalid answers', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-brief-')), 'P.tforge');
    const registry = coreCommands();
    for (const c of briefCommands) registry.register(c);
    const store = await ProjectStore.create(dir, sparse(), { commands: registry, autosaveMs: 0 });
    try {
      expect(() => store.dispatch('core/brief.set-field', { path: 'name', value: 'x' })).toThrow(
        /invalid payload/,
      );
      expect(() =>
        store.dispatch('core/brief.set-field', { path: 'brief.assumptions', value: [] }),
      ).toThrow(/invalid payload/);
      expect(() =>
        store.dispatch('core/brief.set-field', { path: 'brief.tone', value: 'not-a-list' }),
      ).toThrow(/failed validation/);
    } finally {
      await store.close();
    }
  });
});

describe('suggestAnswer', () => {
  it('asks the routed provider with brief and non-excluded knowledge, and validates the shape', async () => {
    const mock = createMockProvider({
      'brief.suggest': [
        '{"value": "Intense"}',
        { value: ['Intense', 'Dark'], reason: 'boss-heavy soulslike' },
      ],
    });
    const llm = new LlmClient({
      providers: (id) => (id === 'core/mock' ? mock : undefined),
      routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
    });
    const p = Project.parse(sparse());
    p.knowledge = [
      {
        id: 'e1',
        kind: 'boss',
        name: 'The Ash Warden',
        description: '',
        sourcePaths: [],
        confidence: 1,
        origin: 'user',
        excludedFromLlm: false,
        tags: [],
        extensions: {},
      },
      {
        id: 'e2',
        kind: 'boss',
        name: 'Secret Final Boss',
        description: '',
        sourcePaths: [],
        confidence: 1,
        origin: 'user',
        excludedFromLlm: true,
        tags: [],
        extensions: {},
      },
    ];
    const tone = buildQuestionnaire(checkCompleteness(p, release)).find((q) => q.label === 'Tone')!;
    const s = await suggestAnswer(llm, p, tone);
    expect(s).toEqual({
      value: ['Intense', 'Dark'],
      reason: 'boss-heavy soulslike',
      provider: 'core/mock',
    });
    expect(mock.calls[0]?.prompt).toMatch(/The Ash Warden/);
    expect(mock.calls[0]?.prompt).not.toMatch(/Secret Final Boss/);
    expect(mock.calls[1]?.prompt).toMatch(/did not validate/); // first reply had the wrong shape
  });
});
