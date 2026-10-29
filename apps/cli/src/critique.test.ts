import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const mock = createMockProvider({
  'critique.run': {
    notes: [
      { about: 'shot-1', kind: 'issue', text: 'The hook runs long.', fix: { type: 'slot-duration', shot: 'shot-1', seconds: 1.5, summary: 'Cut it to 1.5 s' } }, // prettier-ignore
      { about: 'overall', kind: 'idea', text: 'Speed up the last third.', atSeconds: 4 },
    ],
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let home: string;
let project: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-clicrit-'));
  home = join(root, 'home');
  project = join(root, 'Ember.tforge');
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
  await engine.createProject(project, sampleProject() as never);
  await engine.close();
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, '--home', home], { out: (l) => out.push(l), err: (l) => err.push(l) }, process.env, { engine: { llm } }); // prettier-ignore
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('tforge critique', { timeout: 60_000 }, () => {
  it('--show lists what would be sent and sends nothing', async () => {
    const r = await run(['critique', project, '--show']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/A critique would send:/);
    expect(r.out).toMatch(/Never sent: footage/);
    expect(mock.calls).toHaveLength(0);
  });

  it('puts the notes on the Review tab and prints them with their fixes', async () => {
    const r = await run(['critique', project]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 notes on the Review tab \(one undo step\)/);
    expect(r.out).toMatch(/! The hook runs long\.\s+\[fix: Cut it to 1\.5 s\]/);
    expect(r.out).toMatch(/\+ Speed up the last third\./);
    const list = await run(['review', 'list', project, '--json']);
    expect(list.out).toMatch(/The hook runs long/);
  });
});
