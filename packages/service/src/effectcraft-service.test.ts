import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceClient } from './client.js';
import { startService, type RunningService } from './service.js';

/** M10 10.5: EffectCraft over the service: status, the Setup row, write → look → accept or reject. */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const good = {
  name: 'Ember burst',
  summary: 'The title snaps in.',
  commands: [{ command: 'layer.newText', params: { name: 'T', text: 'EMBER' } }],
};
const mock = createMockProvider({ 'effectcraft.author': good }, 'core/mock', { vision: true });
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let svc: RunningService;
let client: ServiceClient;
const ID = 'proj_ecsvc';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecsvc-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  const store = await engine.createProject(join(root, 'S.tforge'), { ...sampleProject(), id: ID } as never); // prettier-ignore
  store.dispatch('core/timeline.set', {
    timeline: { id: 'tl_rough', name: 'Rough cut', frameRate: { num: 30, den: 1 }, resolution: { width: 160, height: 90 }, tracks: [{ id: 'trk_v', kind: 'video', items: [] }] }, // prettier-ignore
  });
  svc = await startService({ engine });
  client = new ServiceClient({ baseUrl: svc.url, token: svc.token });
}, 60_000);
afterAll(async () => {
  await svc.close();
  await engine.close();
  await rm(root, { recursive: true, force: true });
});

describe('EffectCraft over the service', { timeout: 120_000 }, () => {
  it('reports status and a Setup row', async () => {
    expect(await client.effectcraft()).toMatchObject({ state: 'ready', version: '0.9.2' });
    const h = await client.health();
    expect(h.checks.find((c) => c.id === 'effectcraft')).toMatchObject({ title: expect.stringMatching(/EffectCraft/) }); // prettier-ignore
  });

  it('shows what would be sent before anything is sent', async () => {
    const p = await client.effectRequestPreview(ID, { words: 'a title', seconds: 2 });
    expect(p).toMatchObject({
      provider: { id: 'core/mock' },
      wire: { words: 'a title', seconds: 2 },
    });
  });

  it('writes an effect as a task, shows a preview frame, and accepts it (undoable) or rejects it', async () => {
    const t = await client.startTask(ID, { kind: 'effectcraft-author', options: { words: 'a title', seconds: 1 } }); // prettier-ignore
    const done = await client.waitForTask(t.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { name: 'Ember burst', attempts: 1 },
    });
    const list = await client.effectProposals(ID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Ember burst', frames: 30 });
    expect(JSON.stringify(list)).not.toContain(root);
    const png = Buffer.from(await (await client.effectFrame(ID, list[0]!.id, 10)).arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    await expect(client.effectFrame(ID, list[0]!.id, 999)).rejects.toMatchObject({ status: 404 });
    await expect(client.effectFrame(ID, 'fx_000000000000', 0)).rejects.toMatchObject({
      status: 404,
    });

    const r = await client.acceptEffect(ID, list[0]!.id, 2);
    expect(r.project).toMatch(/^media\/[0-9a-f]{64}\.ecproj$/);
    expect(await client.effectProposals(ID)).toEqual([]);
    const undone = await client.undo(ID);
    expect(undone.done).toBe(true);

    const t2 = await client.startTask(ID, { kind: 'effectcraft-author', options: { words: 'again', seconds: 1 } }); // prettier-ignore
    await client.waitForTask(t2.id);
    const [p2] = await client.effectProposals(ID);
    await client.rejectEffect(ID, p2!.id);
    expect(await client.effectProposals(ID)).toEqual([]);
    await expect(client.rejectEffect(ID, p2!.id)).rejects.toMatchObject({ status: 404 });
  });

  it('makes reference stills for the user to look at, and refuses a mismatch', async () => {
    const clip = join(root, 'ref.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=2', '-pix_fmt', 'yuv420p', clip]); // prettier-ignore
    const { stills } = await client.referenceStills(ID, clip);
    expect(stills).toHaveLength(8);
    expect(JSON.stringify(stills)).not.toContain(root);
    const still = Buffer.from(await (await client.referenceStill(ID, clip, 0)).arrayBuffer());
    expect(still.subarray(1, 4).toString()).toBe('PNG');
    const t = await client.startTask(ID, {
      kind: 'effectcraft-author',
      options: {
        words: 'x',
        seconds: 1,
        reference: { file: clip, stills: { consent: true, sha256: ['bad'] } },
      },
    });
    expect(JSON.stringify((await client.waitForTask(t.id)).error)).toMatch(
      /changed since you saw them/,
    );
    await expect(client.startTask(ID, { kind: 'effectcraft-author', options: { words: 'x', seconds: 1, reference: { file: clip, stills: { consent: false, sha256: [] } } } } as never)).rejects.toMatchObject({ status: 400 }); // prettier-ignore
  });

  it('opens an accepted effect for hand polish and takes the edited copy back (one undo step)', async () => {
    const t = await client.startTask(ID, { kind: 'effectcraft-author', options: { words: 'polish me', seconds: 1 } }); // prettier-ignore
    await client.waitForTask(t.id);
    const [p] = await client.effectProposals(ID);
    const accepted = await client.acceptEffect(ID, p!.id, 0);
    const items = await client.effectItems(ID);
    expect(items.find((i) => i.itemId === accepted.itemId)).toMatchObject({
      start: 0,
      duration: 1,
    });

    const out = await client.exportEffect(ID, accepted.itemId);
    expect(out.fileName).toMatch(/\.ecproj$/);
    expect(out.path).toContain('exports');
    const text = readFileSync(out.path, 'utf8');
    const edited = join(root, 'edited.ecproj');
    writeFileSync(
      edited,
      text.replace('"tf-effect"', '"tf-effect"').replace(/\}$/, ', "polished": true}'),
    );
    const r = await client.reimportEffect(ID, accepted.itemId, edited);
    expect(r.project).toMatch(/^media\/[0-9a-f]{64}\.ecproj$/);
    expect(r.project).not.toBe(accepted.project);
    const after = await client.getProject(ID);
    void after;
    await client.undo(ID);
    const items2 = await client.effectItems(ID);
    expect(items2.some((i) => i.itemId === accepted.itemId)).toBe(true); // still there, old project

    writeFileSync(join(root, 'bad.ecproj'), '{"schema":2}');
    await expect(client.reimportEffect(ID, accepted.itemId, join(root, 'bad.ecproj'))).rejects.toMatchObject({ status: 400 }); // prettier-ignore
    await expect(client.reimportEffect(ID, 'it_nope', edited)).rejects.toMatchObject({
      status: 404,
    });
  });
});
