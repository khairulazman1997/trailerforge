import dns from 'node:dns';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTemplateFiles, EffectCraftCli } from '@trailerforge/effectcraft';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { effectcraftStatusOp, effectRequestPreviewOp } from './effectcraft-ops.js';
import { Engine, type EngineOptions } from './engine.js';
import { healthOp } from './health-ops.js';

/** M10 10.5: the EffectCraft status, its Setup row, and the request disclosure; nothing touches the network. */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const stub = (mode: string) => ({ bin: process.execPath, prefixArgs: [STUB, mode] });
const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};
const mock = createMockProvider({}, 'core/mock', { vision: true });
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let templates: string;
const engines: Engine[] = [];
const start = async (name: string, o: EngineOptions) => {
  const e = await Engine.start({ home: join(root, name), autosaveMs: 0, loadUserPlugins: false, llm, ...o }); // prettier-ignore
  engines.push(e);
  return e;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecstatus-'));
  templates = join(root, 'templates');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'cwd'), { recursive: true });
  await buildTemplateFiles(new EffectCraftCli(stub('ok')), templates, join(root, 'cwd'));
}, 60_000);
afterAll(async () => {
  await Promise.all(engines.map((e) => e.close()));
  await rm(root, { recursive: true, force: true });
});

describe('EffectCraft status', { timeout: 60_000 }, () => {
  it('says ready, untested, not installed, missing, incompatible or broken, with the Setup row to match', async () => {
    const row = async (e: Engine) =>
      (await healthOp(e)).checks.find((c) => c.id === 'effectcraft')!;

    const ready = await start('ready', {
      effectcraft: stub('ok'),
      effectcraftTemplates: templates,
    });
    expect(await effectcraftStatusOp(ready)).toMatchObject({
      state: 'ready',
      version: '0.22.0',
      tested: '0.22.0',
      templates: { available: expect.arrayContaining(['effectcraft/title-reveal']), problems: [] },
    });
    expect(await row(ready)).toMatchObject({ status: 'ok', detail: expect.stringMatching(/0\.22\.0 is ready.*3 of 3/) }); // prettier-ignore

    const noTemplates = await start('notpl', { effectcraft: stub('ok'), effectcraftTemplates: join(root, 'none') }); // prettier-ignore
    expect(await effectcraftStatusOp(noTemplates)).toMatchObject({ state: 'ready', templates: { available: [], problems: [expect.stringMatching(/no EffectCraft templates/)] } }); // prettier-ignore
    expect(await row(noTemplates)).toMatchObject({ status: 'info', detail: expect.stringMatching(/0 of 3/) }); // prettier-ignore

    const none = await start('none', { effectcraft: null });
    expect(await effectcraftStatusOp(none)).toMatchObject({ state: 'not-installed' });
    expect(await row(none)).toMatchObject({
      status: 'info',
      fix: expect.stringMatching(/built-in.*install EffectCraft/),
    });

    const gone = await start('gone', { effectcraft: { bin: join(root, 'nope') } });
    expect(await effectcraftStatusOp(gone)).toMatchObject({ state: 'missing' });
    expect(await row(gone)).toMatchObject({
      status: 'warn',
      fix: expect.stringMatching(/TFORGE_EFFECTCRAFT/),
    });

    const old = await start('old', { effectcraft: stub('old') });
    expect(await effectcraftStatusOp(old)).toMatchObject({ state: 'incompatible', version: '0.8.0', reason: expect.stringMatching(/older than 0\.9\.2/) }); // prettier-ignore
    expect(await row(old)).toMatchObject({
      status: 'warn',
      fix: expect.stringMatching(/Update EffectCraft \(this app was tested with 0\.22\.0\)/),
    });

    const lacking = await start('lacking', { effectcraft: stub('lacking') });
    expect(await effectcraftStatusOp(lacking)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/lacks commands this app uses: keys\.toggleHold/) }); // prettier-ignore

    // A newer build that passes the check is used, with a note on Setup.
    const newer = await start('newer', { effectcraft: stub('newer'), effectcraftTemplates: templates }); // prettier-ignore
    expect(await effectcraftStatusOp(newer)).toMatchObject({ state: 'ready', version: '0.30.0', note: expect.stringMatching(/tested with 0\.22\.0/), templates: { available: expect.arrayContaining(['effectcraft/title-reveal']) } }); // prettier-ignore
    expect(await row(newer)).toMatchObject({ status: 'info', fix: expect.stringMatching(/passed the compatibility check/) }); // prettier-ignore

    const broken = await start('broken', { effectcraft: { bin: process.execPath, prefixArgs: ['-e', 'process.exit(3)'] } }); // prettier-ignore
    expect(await effectcraftStatusOp(broken)).toMatchObject({ state: 'broken' });
    expect((await healthOp(broken)).ready).toBe(true); // optional: never blocks the app
  });

  it('shows exactly what "Describe an effect" would send, and whether stills could go', async () => {
    const e = await start('prev', { effectcraft: stub('ok') });
    const s = await e.createProject(join(root, 'P.tforge'), { ...sampleProject(), id: 'proj_prev' } as never); // prettier-ignore
    s.dispatch('core/knowledge.add-entity', { id: 'ent_s', kind: 'character', name: 'Ash Warden' });
    s.dispatch('core/knowledge.set-excluded', { id: 'ent_s', excluded: true });
    const p = await effectRequestPreviewOp(e, s, { words: 'Ash Warden slams in', seconds: 2, landAt: 1 }); // prettier-ignore
    expect(p.wire).toMatchObject({ words: '[redacted] slams in', seconds: 2, landAt: 1 });
    expect(p).toMatchObject({ excluded: 1, provider: { id: 'core/mock', vision: true }, stills: { possible: true } }); // prettier-ignore
    expect(JSON.stringify(p)).not.toMatch(/Ash Warden/);
  });

  it('touched no network', () => {
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
