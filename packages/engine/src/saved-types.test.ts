import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { briefForm, generateStoryboardOp, OpError } from './ops.js';
import {
  loadSavedTypes,
  removeSavedTypeOp,
  savedTypesViewOp,
  saveVideoTypeOp,
  updateSavedTypeOp,
} from './saved-types-ops.js';

const prompts: string[] = [];
const reply = {
  rationale: 'A short teaser that asks for backing.',
  sections: [
    {
      name: 'Ember Knight wakes',
      role: 'hook',
      slots: [{ kind: 'shot', title: 'Eyes open', seconds: 3, captureInstruction: 'Start a run.' }],
    },
    {
      name: 'Why back us',
      role: 'pitch',
      slots: [
        { kind: 'shot', title: 'Forge', seconds: 6 },
        { kind: 'shot', title: 'Boss', seconds: 6 },
      ],
    },
    {
      name: 'Ask',
      role: 'end-slate',
      slots: [{ kind: 'card', cardKind: 'cta', title: 'Back it', text: 'Back us', seconds: 5 }],
    },
  ],
  music: { direction: 'Driving synths, Ember Knight motif' },
};
const mock = createMockProvider({
  'storyboard.generate': (req: LlmRequest<unknown>) => {
    prompts.push(req.prompt);
    return reply;
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-types-'));
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

const project = (videoTypeId: string) =>
  engine.createProject(join(root, `P${++n}.tforge`), {
    name: 'Ember Knight',
    brief: {
      videoTypeId,
      title: 'Ember Knight',
      extensions: { 'game-trailer': { customType: 'A 20 s Kickstarter teaser' } },
    },
  });

describe('open-ended and saved video types', () => {
  it('"Something else" asks for a description and sends it with a loose structure', async () => {
    const store = await project('game-trailer/custom');
    const form = briefForm(engine, store);
    expect(
      form.fields.find((f) => f.id === 'brief.extensions.game-trailer.customType'),
    ).toMatchObject({
      required: true,
      state: 'answered',
      value: 'A 20 s Kickstarter teaser',
    });
    await generateStoryboardOp(engine, store, { duration: 20, assume: true });
    expect(prompts.at(-1)).toContain('video described as: "A 20 s Kickstarter teaser"');
    expect(prompts.at(-1)).toContain('only a loose starting point');
  });

  it('saves the structure without the game words, and reuses it in a new project', async () => {
    const source = await project('game-trailer/custom');
    await generateStoryboardOp(engine, source, { duration: 20, assume: true });
    const saved = await saveVideoTypeOp(engine, source, { name: 'Kickstarter teaser' });
    expect(saved).toMatchObject({
      id: 'user/kickstarter-teaser',
      description: 'A 20 s Kickstarter teaser',
      basedOn: 'game-trailer/custom',
      duration: 20,
      sections: [
        { name: 'Hook', role: 'hook', slots: 1 },
        { name: 'Why back us', role: 'pitch', slots: 2 },
        { name: 'Ask', role: 'end-slate', slots: 1 },
      ],
    });
    const file = await readFile(join(engine.savedTypes.dir, 'kickstarter-teaser.json'), 'utf8');
    expect(file).not.toMatch(/ember|forge|eyes open|boss/i);
    // A second save with the same name gets its own id.
    expect((await saveVideoTypeOp(engine, source, { name: 'Kickstarter teaser' })).id).toBe(
      'user/kickstarter-teaser-2',
    );

    const reuse = await project('user/kickstarter-teaser');
    expect(reuse.state.extensions.core).toMatchObject({ savedVideoType: { id: saved.id } });
    // The description question is gone: the saved description takes its place.
    expect(briefForm(engine, reuse).fields.map((f) => f.id)).not.toContain(
      'brief.extensions.game-trailer.customType',
    );
    await generateStoryboardOp(engine, reuse, { assume: true });
    expect(prompts.at(-1)).toContain(
      'Write a storyboard for a Kickstarter teaser lasting 20 seconds',
    );
    expect(prompts.at(-1)).toContain('Why back us (pitch');
    expect(prompts.at(-1)).toContain('Keep its order and roles');

    // Renaming or deleting the file never changes a project that uses it.
    await updateSavedTypeOp(engine, saved.id, {
      name: 'KS teaser',
      description: 'Ask for backing',
    });
    expect(savedTypesViewOp(engine).types.find((t) => t.id === saved.id)).toMatchObject({
      name: 'KS teaser',
    });
    await removeSavedTypeOp(engine, saved.id);
    expect(engine.plugins.registries.videoTypes.get(saved.id)).toBeUndefined();
    expect(briefForm(engine, reuse).videoTypeName).toBe('Kickstarter teaser');
    await generateStoryboardOp(engine, reuse, { assume: true });
  });

  it('switching to a saved type through the command keeps a copy; switching away drops it', async () => {
    const source = await project('game-trailer/custom');
    await generateStoryboardOp(engine, source, { duration: 20, assume: true });
    const { id } = await saveVideoTypeOp(engine, source, { name: 'Devlog intro' });
    const store = await project('game-trailer/release-trailer');
    const copy = engine.savedTypes.types.find((t) => t.id === id)!;
    store.dispatch('core/brief.set-video-type', { videoTypeId: id, saved: copy });
    expect(briefForm(engine, store).videoTypeName).toBe('Devlog intro');
    store.dispatch('core/brief.set-video-type', { videoTypeId: 'game-trailer/release-trailer' });
    expect(store.state.extensions.core).toBeUndefined();
    expect(() =>
      store.dispatch('core/brief.set-video-type', { videoTypeId: 'user/other', saved: copy }),
    ).toThrow();
  });

  it('refuses to save without a storyboard or a name', async () => {
    const store = await project('game-trailer/custom');
    await expect(saveVideoTypeOp(engine, store, { name: 'x' })).rejects.toBeInstanceOf(OpError);
    await expect(saveVideoTypeOp(engine, store, { name: '  ' })).rejects.toThrow(/name/);
  });

  it('reports files that do not load and keeps the rest', async () => {
    const dir = engine.savedTypes.dir;
    await writeFile(join(dir, 'broken.json'), '{ nope');
    const good = (await readdir(dir)).find((f) => f.startsWith('devlog'))!;
    await writeFile(join(dir, 'renamed.json'), await readFile(join(dir, good), 'utf8'));
    const state = await loadSavedTypes(engine);
    expect(state.problems.map((p) => p.file).sort()).toEqual(['broken.json', 'renamed.json']);
    expect(state.problems.find((p) => p.file === 'renamed.json')?.message).toMatch(/file name/);
    expect(state.types.some((t) => t.name === 'Devlog intro')).toBe(true);
  });
});
