import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conceptsOp, MAX_WAITING_CONCEPTS, proposeConceptsOp } from './concepts-ops.js';
import { Engine } from './engine.js';
import { OpError } from './ops.js';

const concept = (title: string, extra: object = {}) => ({
  title,
  hook: 'A boss swing stops dead.',
  formatId: 'game-trailer/tiktok-montage',
  pitch: 'Fits the game.',
  shotList: ['A parry'],
  voiceover: [],
  targetSeconds: 20,
  entityIds: ['ent_warden'],
  ...extra,
});
let nextReply: unknown = { concepts: [concept('One'), concept('Two')] };
const mock = createMockProvider({ 'tiktok.concepts': () => nextReply });
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let engine: Engine;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-concepts-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
});
afterAll(async () => {
  await engine.close();
});
const open = async (name: string, init = sampleProject()) =>
  engine.createProject(join(root, name), { ...init, name });

describe('concept ops', () => {
  it('adds the app’s concepts as one undo step and logs a decision for each', async () => {
    const store = await open('a');
    nextReply = { concepts: [concept('One'), concept('Two')] };
    const r = await conceptsOp(engine, store, { ideas: ['boss in 3 s'], count: 2 });
    expect(r.added.map((c) => [c.id, c.source])).toEqual([
      ['con_one', 'app'],
      ['con_two', 'app'],
    ]);
    expect(store.state.concepts.map((c) => c.title)).toEqual(['One', 'Two']);
    const log = (await readFile(store.paths.decisions, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)); // prettier-ignore
    expect(log.filter((d) => d.step === 'game-trailer/tiktok-concept')).toHaveLength(2);
    expect(log[0]).toMatchObject({ subject: { kind: 'concept', id: 'con_one' } });
    store.undo();
    expect(store.state.concepts).toEqual([]);
    await store.close();
  });

  it('reports what failed the checks and still adds the rest; a second run skips repeats', async () => {
    const store = await open('b');
    nextReply = { concepts: [concept('Good'), concept('Leaky', { pitch: 'x'.repeat(2000) })] };
    const r = await conceptsOp(engine, store);
    expect(r.added.map((c) => c.title)).toEqual(['Good']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ title: 'Leaky' });
    nextReply = { concepts: [concept('Good')] };
    const again = await conceptsOp(engine, store);
    expect(again.added).toEqual([]);
    expect(again.rejected[0]!.reasons[0]).toMatch(/already exists/);
    expect(store.state.concepts).toHaveLength(1);
    await store.close();
  });

  it('needs a brief to work from', async () => {
    const init = sampleProject();
    init.brief = { videoTypeId: 'game-trailer/release-trailer' } as never;
    const store = await open('c', init);
    await expect(conceptsOp(engine, store)).rejects.toBeInstanceOf(OpError);
    await store.close();
  });

  it('Claude Code’s proposals are marked as its own, checked against the knowledge, and bounce with reasons', async () => {
    const store = await open('d');
    const r = await proposeConceptsOp(engine, store, [
      concept('From Claude Code'),
      concept('Bad facts', { entityIds: ['ent_nope'] }),
      { title: 'Half a concept' },
    ]);
    expect(r.added).toEqual([
      { id: 'con_from_claude_code', title: 'From Claude Code', formatId: 'game-trailer/tiktok-montage', source: 'claude-code' }, // prettier-ignore
    ]);
    expect(r.rejected.map((x) => x.title)).toEqual(['Bad facts', 'Half a concept']);
    expect(r.rejected[0]!.reasons[0]).toMatch(/ent_nope/);
    const log = await readFile(store.paths.decisions, 'utf8');
    expect(log).toContain('"source":"claude-code"');
    await expect(proposeConceptsOp(engine, store, [])).rejects.toBeInstanceOf(OpError);
    await store.close();
  });

  it('stops growing the waiting list at its limit', async () => {
    const store = await open('e');
    const fill = Array.from({ length: MAX_WAITING_CONCEPTS }, (_, i) => concept(`Idea ${i}`));
    for (let i = 0; i < fill.length; i += 20) await proposeConceptsOp(engine, store, fill.slice(i, i + 20)); // prettier-ignore
    expect(store.state.concepts).toHaveLength(MAX_WAITING_CONCEPTS);
    await expect(proposeConceptsOp(engine, store, [concept('One too many')])).rejects.toThrow(/remove some/); // prettier-ignore
    await store.close();
  });

  it('sends only what the preview promises: no excluded facts reach the model', async () => {
    const init = sampleProject();
    init.knowledge![0]!.excludedFromLlm = true;
    const store = await open('f', init);
    nextReply = { concepts: [] };
    const before = mock.calls.length;
    await conceptsOp(engine, store, { ideas: ['the Ash Warden'] });
    const prompt = mock.calls[before]!.prompt;
    expect(prompt).not.toMatch(/Ash Warden|ent_warden/);
    await store.close();
  });
});
