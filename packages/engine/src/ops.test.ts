import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import {
  answerBriefOp,
  assumeMissingOp,
  briefForm,
  llmPreviewOp,
  OpError,
  suggestBriefAnswerOp,
} from './ops.js';

const mock = createMockProvider({
  'brief.suggest': (req: LlmRequest<unknown>) => ({
    value: req.prompt.includes('Game name') ? 'Ember Knight' : ['a', 'b', 'c'],
    reason: 'because the game facts say so',
  }),
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ops-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
});
afterAll(async () => {
  await engine.close();
});

const fresh = (
  videoTypeId: string | null = 'game-trailer/release-trailer',
): Promise<ProjectStore> =>
  engine.createProject(join(root, `P${++n}.tforge`), {
    name: 'Ember Knight',
    ...(videoTypeId ? { brief: { videoTypeId } } : {}),
  });
const field = (store: ProjectStore, id: string) =>
  briefForm(engine, store).fields.find((f) => f.id === id)!;

describe('briefForm', () => {
  it('lists every requirement in the video type order with its state and prompt', async () => {
    const store = await fresh();
    const form = briefForm(engine, store);
    expect(form).toMatchObject({
      videoTypeId: 'game-trailer/release-trailer',
      score: 0,
      complete: false,
      canProceed: false,
    });
    expect(form.fields.map((f) => f.label).slice(0, 4)).toEqual([
      'Game name',
      'Release date',
      'Platforms',
      'Genre',
    ]);
    expect(form.fields.every((f) => f.state === 'missing')).toBe(true);
    expect(field(store, 'brief.title')).toMatchObject({
      required: true,
      input: 'text',
      value: null,
      why: 'Needed for this video type',
    });
    expect(field(store, 'brief.keySellingPoints')).toMatchObject({ input: 'list', minItems: 3 });
    expect(field(store, 'formatTargets').choices?.length).toBeGreaterThan(2);
    expect(form.fields.find((f) => f.label === 'Age rating')).toMatchObject({ required: false });
  });

  it('refuses a project with no video type', async () => {
    const store = await fresh(null);
    expect(() => briefForm(engine, store)).toThrow(OpError);
  });
});

describe('answering', () => {
  it('saves text, lists and choices, and the form follows', async () => {
    const store = await fresh();
    answerBriefOp(engine, store, { questionId: 'brief.title', value: '  Ember Knight  ' });
    expect(field(store, 'brief.title')).toMatchObject({
      state: 'answered',
      value: 'Ember Knight',
      why: '',
    });
    answerBriefOp(engine, store, {
      questionId: 'brief.keySellingPoints',
      value: ['Parry', 'Bosses', 'Fire'],
    });
    expect(field(store, 'brief.keySellingPoints')).toMatchObject({
      state: 'answered',
      value: ['Parry', 'Bosses', 'Fire'],
    });
    answerBriefOp(engine, store, {
      questionId: 'brief.extensions.game-trailer.genre',
      value: 'Soulslike',
    });
    expect(briefForm(engine, store).score).toBeGreaterThan(0.2);
  });

  it('rejects wrong shapes and unknown fields without changing anything', async () => {
    const store = await fresh();
    const before = store.state;
    expect(() =>
      answerBriefOp(engine, store, { questionId: 'brief.keySellingPoints', value: ['only one'] }),
    ).toThrow(/at least 3|Too small/i);
    expect(() => answerBriefOp(engine, store, { questionId: 'brief.title', value: 5 })).toThrow(
      OpError,
    );
    expect(() =>
      answerBriefOp(engine, store, { questionId: 'brief.nonsense', value: 'x' }),
    ).toThrow(/no brief field/);
    expect(store.state).toBe(before);
  });

  it('puts an exact release date in the date field and a loose one in the release window', async () => {
    const store = await fresh();
    answerBriefOp(engine, store, {
      questionId: 'brief.keyDates[label=Release].date',
      value: '2027-02-14',
    });
    expect(field(store, 'brief.keyDates[label=Release].date')).toMatchObject({
      state: 'answered',
      value: '2027-02-14',
    });

    const other = await fresh();
    answerBriefOp(engine, other, {
      questionId: 'brief.keyDates[label=Release].date',
      value: 'Q2 2027',
    });
    expect(field(other, 'brief.keyDates[label=Release].date')).toMatchObject({
      state: 'answered',
      value: 'Q2 2027',
    });
    expect(other.state.brief.keyDates).toEqual([]); // nothing invalid written to the date field

    // A video type without a window alternative asks for a real date.
    expect(() =>
      answerBriefOp(engine, other, { questionId: 'brief.keyDates[label=Release].date', value: '' }),
    ).toThrow(OpError);
  });

  it('adds chosen output formats once, even if the same preset is sent again', async () => {
    const store = await fresh();
    const choices = field(store, 'formatTargets').choices!;
    expect(
      answerBriefOp(engine, store, { questionId: 'formatTargets', value: [choices[0]] }).commands,
    ).toBe(1);
    expect(
      answerBriefOp(engine, store, { questionId: 'formatTargets', value: [choices[0], choices[1]] })
        .commands,
    ).toBe(1);
    expect(store.state.formatTargets).toHaveLength(2);
    expect(briefForm(engine, store).formats.map((f) => f.name)).toEqual([choices[0], choices[1]]);
    expect(field(store, 'formatTargets')).toMatchObject({
      state: 'answered',
      value: [choices[0], choices[1]],
    });
  });
});

describe('suggestions', () => {
  it('asks the LLM for one field, grounded in the project, without changing it', async () => {
    const store = await fresh();
    const before = store.state;
    const s = await suggestBriefAnswerOp(engine, store, { questionId: 'brief.title' });
    expect(s).toEqual({
      questionId: 'brief.title',
      value: 'Ember Knight',
      reason: 'because the game facts say so',
      provider: 'core/mock',
    });
    expect(mock.calls.at(-1)!.prompt).toMatch(/Game name/);
    expect(store.state).toBe(before);
    await expect(suggestBriefAnswerOp(engine, store, { questionId: 'nope' })).rejects.toThrow(
      /no brief field/,
    );
  });
});

describe('proceeding with assumptions', () => {
  it('logs one assumption per missing required field, once, and answers replace them', async () => {
    const store = await fresh();
    answerBriefOp(engine, store, { questionId: 'brief.title', value: 'Ember Knight' });
    const { added } = assumeMissingOp(engine, store);
    expect(added).toBe(briefForm(engine, store).fields.filter((f) => f.required).length - 1);
    const form = briefForm(engine, store);
    expect(form).toMatchObject({ canProceed: true, complete: false });
    expect(form.fields.find((f) => f.id === 'brief.extensions.game-trailer.genre')).toMatchObject({
      state: 'assumed',
      assumption: { source: 'user' },
    });
    expect(assumeMissingOp(engine, store).added).toBe(0);

    answerBriefOp(engine, store, {
      questionId: 'brief.extensions.game-trailer.genre',
      value: 'Soulslike',
    });
    expect(field(store, 'brief.extensions.game-trailer.genre')).toMatchObject({
      state: 'answered',
    });
    expect(
      store.state.brief.assumptions.some((a) => a.field === 'brief.extensions.game-trailer.genre'),
    ).toBe(false);
  });
});

describe('llmPreviewOp', () => {
  it('names the provider and lists exactly what would be sent, honouring exclusions', async () => {
    const store = await fresh();
    answerBriefOp(engine, store, { questionId: 'brief.title', value: 'Ember Knight' });
    store.dispatch('core/knowledge.add-entity', { id: 'ent_a', kind: 'boss', name: 'Ash Warden' });
    store.dispatch('core/knowledge.add-entity', {
      id: 'ent_b',
      kind: 'level',
      name: 'Hidden Level',
    });
    store.dispatch('core/knowledge.set-excluded', { id: 'ent_b', excluded: true });
    assumeMissingOp(engine, store);

    const p = await llmPreviewOp(engine, store, 'storyboard.generate');
    expect(p).toMatchObject({
      task: 'storyboard.generate',
      available: true,
      provider: { id: 'core/mock', kind: 'mock', sendsDataOffDevice: false },
      fellBack: false,
    });
    expect(p.willSend.brief).toContain('title');
    expect(p.willSend.brief).not.toContain('videoTypeId');
    expect(p.willSend.assumptions).toBeGreaterThan(0);
    expect(p.willSend.knowledge).toEqual([{ id: 'ent_a', kind: 'boss', name: 'Ash Warden' }]);
    expect(p.willSend.knowledgeExcluded).toBe(1);
    expect(mock.calls.some((c) => c.task === 'storyboard.generate')).toBe(false); // nothing was sent
  });

  it('says so when no provider can run the task', async () => {
    const lonely = new LlmClient({
      providers: () => undefined,
      routes: RoutesConfig.parse({ default: { provider: 'x/none' }, fallbacks: [] }),
    });
    const e2 = await Engine.start({
      home: join(root, 'home-none'),
      autosaveMs: 0,
      loadUserPlugins: false,
      llm: lonely,
    });
    try {
      const store = await e2.createProject(join(root, 'None.tforge'), { name: 'N' });
      expect(await llmPreviewOp(e2, store, 'storyboard.generate')).toMatchObject({
        available: false,
        reason: expect.stringMatching(/no LLM provider available/),
        willSend: { knowledge: [], knowledgeExcluded: 0 },
      });
    } finally {
      await e2.close();
    }
  });
});
