import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureExportOp,
  captureMarkOp,
  captureSettingsOp,
  captureStatusOp,
  captureTipsOp,
  captureViewOp,
  setCaptureSettingsOp,
} from './capture-ops.js';
import { Engine } from './engine.js';
import { llmPreviewOp, type OpError } from './ops.js';

const mock = createMockProvider({
  'capture.tips': (req: { prompt: string }) => ({
    groups: [...req.prompt.matchAll(/"key": "([^"]*)"/g)].map((m) => ({
      key: m[1]!,
      tips: ['Start at the checkpoint.'],
      risks: [],
    })),
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
  root = await mkdtemp(join(tmpdir(), 'tforge-capops-'));
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

const sample = () =>
  engine.createProject(join(root, `P${++n}.tforge`), {
    ...sampleProject(),
    id: `proj_${n}`,
  } as never);
const usage = (code: OpError['code']) => expect.objectContaining({ name: 'OpError', code });

describe('capture ops', () => {
  it('reads the checklist, progress and settings; no storyboard is not-found', async () => {
    const store = await sample();
    const v = captureViewOp(engine, store);
    expect(v.plan).toMatchObject({ total: 2, done: 0 });
    expect(v.hints).toHaveLength(v.plan.groups.length);
    expect(captureStatusOp(engine, store)).toMatchObject({
      total: 2,
      byStatus: { empty: 2, recorded: 0, approved: 0, rejected: 0 },
      skipped: 0,
      tips: { none: 2 },
    });
    expect(captureSettingsOp(engine, store).settings.fps).toBe(60);

    const bare = await engine.createProject(join(root, 'Bare.tforge'), { name: 'Bare' });
    expect(() => captureViewOp(engine, bare)).toThrow(usage('not-found'));
    expect(() => captureStatusOp(engine, bare)).toThrow(usage('not-found'));
  });

  it('marks shots through commands, validates, and undoes', async () => {
    const store = await sample();
    expect(
      captureMarkOp(engine, store, {
        slotId: 'shot_parry',
        status: 'recorded',
        takes: 2,
        notes: 'ok',
      }),
    ).toEqual({ slotId: 'shot_parry', changed: ['status', 'notes', 'takes'] });
    expect(captureStatusOp(engine, store)).toMatchObject({ done: 1, byStatus: { recorded: 1 } });
    captureMarkOp(engine, store, { slotId: 'shot_boss', skipped: true });
    expect(captureStatusOp(engine, store)).toMatchObject({ total: 1, skipped: 1 });
    for (let i = 0; i < 4; i++) store.undo();
    expect(captureStatusOp(engine, store)).toMatchObject({ total: 2, done: 0, skipped: 0 });

    expect(() => captureMarkOp(engine, store, { slotId: 'nope', status: 'recorded' })).toThrow(
      usage('not-found'),
    );
    expect(() => captureMarkOp(engine, store, { slotId: 'card_end', status: 'recorded' })).toThrow(
      usage('usage'),
    );
    expect(() =>
      captureMarkOp(engine, store, { slotId: 'shot_boss', status: 'done' as never }),
    ).toThrow(usage('usage'));
    expect(() => captureMarkOp(engine, store, { slotId: 'shot_boss', takes: -1 })).toThrow(
      usage('usage'),
    );
    expect(() => captureMarkOp(engine, store, { slotId: 'shot_boss' })).toThrow(usage('usage'));
  });

  it('changes recording settings, clears one, resets all, and rejects bad values', async () => {
    const store = await sample();
    const r = setCaptureSettingsOp(engine, store, { patch: { fps: 30, codec: 'av1' } });
    expect(r.settings).toMatchObject({ fps: 30, codec: 'av1' });
    expect(r.sources).toMatchObject({ fps: 'override', codec: 'override', hud: 'derived' });
    expect(setCaptureSettingsOp(engine, store, { patch: { fps: null } }).settings.fps).toBe(60);
    setCaptureSettingsOp(engine, store, { reset: true });
    expect(captureSettingsOp(engine, store).overrides).toEqual({});
    expect(() => setCaptureSettingsOp(engine, store, { patch: { fps: 0 } })).toThrow(
      usage('usage'),
    );
    expect(() => setCaptureSettingsOp(engine, store, { patch: { bogus: 1 } })).toThrow(
      usage('usage'),
    );
  });

  it('writes tips, skips fresh groups, and a cancelled run stores nothing', async () => {
    const store = await sample();
    const first = await captureTipsOp(engine, store);
    expect(first.written).toHaveLength(2);
    expect(captureStatusOp(engine, store).tips).toMatchObject({ fresh: 2 });
    expect((await captureTipsOp(engine, store)).written).toEqual([]);

    const ctl = new AbortController();
    ctl.abort();
    const version = JSON.stringify(store.state);
    await expect(
      captureTipsOp(engine, store, { force: true, signal: ctl.signal }),
    ).rejects.toThrow();
    expect(JSON.stringify(store.state)).toBe(version);
  });

  it('previews what tips will send, without the brief and without excluded entities', async () => {
    const store = await sample();
    store.dispatch('core/knowledge.set-excluded', { id: 'ent_forest', excluded: true });
    const p = await llmPreviewOp(engine, store, 'capture.tips');
    expect(p).toMatchObject({ available: true, willSend: { brief: [], assumptions: 0 } });
    expect(p.willSend.capture).toEqual({ groups: 2, shots: 2 });
    expect(p.willSend.knowledge.map((k) => k.id)).not.toContain('ent_forest');
    expect(p.willSend.knowledge.map((k) => k.id)).toContain('ent_warden');
  });

  it('exports the pack under the project folder with relative paths', async () => {
    const store = await sample();
    const r = await captureExportOp(engine, store, { formats: ['html', 'md'] });
    expect(r).toEqual({
      files: ['exports/capture/capture-pack.html', 'exports/capture/capture-pack.md'],
      shots: 2,
      done: 0,
    });
    expect(await readFile(join(store.paths.dir, r.files[0]!), 'utf8')).toContain('<!doctype html>');
    expect((await captureExportOp(engine, store)).files).toHaveLength(3);
    await expect(
      captureExportOp(engine, store, { formats: ['pdf' as never] }),
    ).rejects.toMatchObject({
      code: 'usage',
    });
    const bare = await engine.createProject(join(root, 'Bare2.tforge'), { name: 'Bare' });
    await expect(captureExportOp(engine, bare)).rejects.toMatchObject({ code: 'not-found' });
  });
});
