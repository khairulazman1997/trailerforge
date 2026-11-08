import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDecisions, type ProjectStore } from '@trailerforge/core';
import { effectProblems, scrubCliError } from '@trailerforge/effectcraft';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptEffectOp, authorEffectOp, rejectEffectOp } from './effectcraft-ops.js';
import { Engine } from './engine.js';
import { OpError } from './ops.js';

/** M10 10.4b: custom effects by words, with a mock model and the stand-in EffectCraft CLI. */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);

let replies: unknown[] = [];
let onAsk: ((req: LlmRequest<unknown>) => void) | undefined;
const prompts: string[] = [];
const mock = createMockProvider({
  'effectcraft.author': (req: LlmRequest<unknown>) => {
    prompts.push(`${req.system}\n${req.prompt}`);
    onAsk?.(req);
    return replies.shift();
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

const good = {
  name: 'Ember burst',
  summary: 'The title snaps in on the hit with an orange glow.',
  commands: [
    { command: 'layer.newText', params: { name: 'Title', text: 'EMBER', size: 120, fill: '#ff7a1a' } },
    { command: 'prop.addKey', params: { layer: 'Title', path: 'transform/scale', time: 0, value: [60, 60] } },
    { command: 'prop.addKey', params: { layer: 'Title', path: 'transform/scale', time: 1, value: [100, 100] } },
    { command: 'keys.select', params: { keys: [{ layer: 'Title', path: 'transform/scale', time: 1 }] } },
    { command: 'keys.easyEase', params: { which: 'in' } },
  ],
}; // prettier-ignore

let root: string;
let engine: Engine;
let store: ProjectStore;
const proposals = () => {
  const d = join(store.paths.cache, 'effectcraft', 'proposals');
  return existsSync(d) ? readdirSync(d) : [];
};
const effects = () =>
  store.state.timelines
    .find((t) => t.id === 'tl_rough')!
    .tracks.find((t) => t.id === 'trk_user_effects')?.items ?? [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecauthor-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  store = await engine.createProject(join(root, 'Fx.tforge'), {
    ...sampleProject(),
    id: 'proj_fx',
  } as never);
  store.dispatch('core/knowledge.add-entity', { id: 'ent_secret', kind: 'character', name: 'Ash Warden' }); // prettier-ignore
  store.dispatch('core/knowledge.set-excluded', { id: 'ent_secret', excluded: true });
  store.dispatch('core/timeline.set', {
    timeline: {
      id: 'tl_rough',
      name: 'Rough cut',
      frameRate: { num: 30, den: 1 },
      resolution: { width: 320, height: 180 },
      tracks: [{ id: 'trk_v', kind: 'video', items: [] }],
    },
  });
}, 60_000);
afterAll(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  replies = [];
  onAsk = undefined;
  prompts.length = 0;
});

describe('custom effects by words', { timeout: 120_000 }, () => {
  it('writes, builds and previews an effect without touching the project; accept is one undo step', async () => {
    replies = [good];
    const before = store.state;
    const p = await authorEffectOp(engine, store, {
      words: 'The title EMBER slams in with a glow when the Ash Warden appears',
      seconds: 2,
      landAt: 1,
    });
    expect(store.state).toBe(before);
    expect(p).toMatchObject({ name: 'Ember burst', attempts: 1, repaired: [], seconds: 2 });
    expect(p.preview).toMatchObject({ frames: 60, still: 30, pattern: 'frame_%06d.png' });
    expect(existsSync(join(p.preview.dir, 'frame_000030.png'))).toBe(true);
    expect(proposals()).toEqual([p.id]);

    // What was sent: text and numbers only; the excluded name is redacted, no paths.
    const sent = prompts.join('\n');
    expect(sent).not.toMatch(/Ash Warden/i);
    expect(sent).toContain('[redacted]');
    for (const path of [root, store.paths.dir, engine.home, tmpdir()])
      expect(sent).not.toContain(path);
    expect(p.sent).toMatchObject({ seconds: 2, landAt: 1, size: { width: 320, height: 180 } });

    const r = await acceptEffectOp(engine, store, { proposalId: p.id, at: 3.01 });
    expect(r).toMatchObject({ start: 3 * FLICKS_PER_SECOND, duration: 2 * FLICKS_PER_SECOND });
    expect(r.project).toMatch(/^media\/[0-9a-f]{64}\.ecproj$/);
    expect(existsSync(join(store.paths.dir, r.project))).toBe(true);
    expect(effects()).toMatchObject([
      {
        id: r.itemId,
        templateId: 'effectcraft/project',
        label: 'Ember burst',
        params: { project: r.project, comp: 'tf-effect' },
        decisionId: `dec_${p.id}`,
      },
    ]);
    const log = await readDecisions(store.paths.decisions);
    expect(log.find((d) => d.id === `dec_${p.id}`)).toMatchObject({ step: 'effectcraft/author' });
    expect(proposals()).toEqual([]);

    store.undo();
    expect(effects()).toEqual([]);
    store.redo();
    expect(effects()).toHaveLength(1);
    store.undo();
  });

  it('repairs a reply that breaks the rules, telling the model what was wrong', async () => {
    replies = [
      { ...good, commands: [{ command: 'file.open', params: { path: 'C:\\x\\y.ecproj' } }, ...good.commands] },
      good,
    ]; // prettier-ignore
    const p = await authorEffectOp(engine, store, { words: 'a title', seconds: 1 });
    expect(p).toMatchObject({ attempts: 2 });
    expect(p.repaired.join()).toMatch(/command 1 \(file\.open\): not allowed/);
    expect(prompts[1]).toMatch(/could not be used/);
    expect(prompts[1]).toMatch(/file\.open/);
    await rejectEffectOp(store, { proposalId: p.id });
    expect(proposals()).toEqual([]);
  });

  it('repairs what EffectCraft itself refuses, without leaking paths', async () => {
    replies = [{ ...good, commands: [{ command: 'layer.newText', params: { name: 'T' } }] }, good];
    const p = await authorEffectOp(engine, store, { words: 'a title', seconds: 1 });
    expect(p.repaired).toEqual(['effectcraft-cli run: layer.newText: text']);
    for (const path of [root, store.paths.dir]) expect(prompts[1]).not.toContain(path);
    await rejectEffectOp(store, { proposalId: p.id });
  });

  it('refuses after one failed repair and stores nothing', async () => {
    const bad = { ...good, commands: [{ command: 'prop.set', params: { layer: 'T', path: 'transform/opacity', expression: 'time*10' } }] }; // prettier-ignore
    replies = [bad, bad];
    const before = store.state;
    const err = await authorEffectOp(engine, store, { words: 'a title', seconds: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpError);
    expect(err).toMatchObject({ code: 'effect-refused', details: { problems: [expect.stringMatching(/expression: not allowed/)] } }); // prettier-ignore
    expect(store.state).toBe(before);
    expect(proposals()).toEqual([]);
  });

  it('cancel stores nothing', async () => {
    const ctl = new AbortController();
    replies = [good];
    onAsk = () => ctl.abort();
    const before = store.state;
    await expect(authorEffectOp(engine, store, { words: 'a title', seconds: 1 }, { signal: ctl.signal })).rejects.toThrow(); // prettier-ignore
    expect(store.state).toBe(before);
    expect(proposals()).toEqual([]);
  });

  it('takes commands written by the caller (Claude Code through MCP) without asking a model', async () => {
    const p = await authorEffectOp(engine, store, { words: '', seconds: 1, effect: good });
    expect(prompts).toEqual([]);
    expect(p).toMatchObject({ sent: null, attempts: 1 });
    await expect(
      authorEffectOp(engine, store, { words: '', seconds: 1, effect: { ...good, commands: [{ command: 'comp.new', params: {} }] } }),
    ).rejects.toMatchObject({ code: 'effect-refused' }); // prettier-ignore
    await rejectEffectOp(store, { proposalId: p.id });
    await expect(rejectEffectOp(store, { proposalId: p.id })).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(rejectEffectOp(store, { proposalId: '../../x' })).rejects.toMatchObject({
      code: 'usage',
    });
  });

  it('checks every parameter for files, URLs, code and other compositions', () => {
    expect(effectProblems(good.commands)).toEqual([]);
    const probs = effectProblems([
      { command: 'layer.newText', params: { name: 'A', text: '/etc/passwd' } },
      { command: 'layer.newText', params: { name: 'B', text: 'https://x.test/a' } },
      { command: 'prop.set', params: { layer: 'A', path: '../../x', value: 1 } },
      {
        command: 'prop.set',
        params: { layer: 'A', path: 'transform/opacity', value: 1, comp: 'Other' },
      },
      { command: 'effect.apply', params: { layer: 'A', effect: 'Glow', file: 'x' } },
      { command: 'renderQueue.add', params: {} },
      { command: 'layer.newText', params: { name: 'C', text: 'READY? GO!' } },
    ]);
    expect(probs).toHaveLength(6);
    expect(scrubCliError('cannot open /tmp/a/b/effect.ecproj: missing')).toBe(
      'cannot open <file>: missing',
    );
  });
});
