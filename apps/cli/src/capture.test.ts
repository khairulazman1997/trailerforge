import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const mock = createMockProvider({
  'capture.tips': (req: { prompt: string }) => ({
    groups: [...req.prompt.matchAll(/"key": "([^"]*)"/g)].map((m) => ({
      key: m[1]!,
      tips: ['Start at the checkpoint.'],
      risks: ['A popup.'],
    })),
  }),
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let home: string;
let project: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tforge-clicap-'));
  home = join(root, 'home');
  project = join(root, 'Ember.tforge');
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
  await engine.createProject(project, sampleProject() as never);
  await engine.createProject(join(root, 'Bare.tforge'), { name: 'Bare' });
  await engine.close();
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...args, '--home', home],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    process.env,
    { engine: { llm } },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('tforge capture', () => {
  it('shows the checklist and progress', async () => {
    const plan = await run(['capture', 'plan', project]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('0 of 2 shots recorded');
    expect(plan.out).toContain('[ ] shot_parry');
    expect(plan.out).toContain('Forest');
    const status = await run(['capture', 'status', project, '--json']);
    expect(JSON.parse(status.out)).toMatchObject({ total: 2, done: 0, byStatus: { empty: 2 } });
  });

  it('marks shots and keeps the change', async () => {
    const r = await run([
      'capture',
      'mark',
      project,
      'shot_parry',
      '--status',
      'recorded',
      '--takes',
      '2',
      '--note',
      'good one',
    ]);
    expect(r).toMatchObject({ code: 0, out: 'shot_parry: updated status, notes, takes' });
    expect((await run(['capture', 'plan', project])).out).toContain('[x] shot_parry');
    expect((await run(['capture', 'plan', project, '--todo'])).out).not.toContain('shot_parry');
    const onDisk = await readFile(join(project, 'project.json'), 'utf8');
    expect(onDisk).toContain('good one');
    expect((await run(['capture', 'mark', project, 'shot_boss', '--skip'])).code).toBe(0);
    expect((await run(['capture', 'status', project])).out).toContain('skipped 1');
    expect((await run(['capture', 'mark', project, 'shot_boss', '--unskip'])).code).toBe(0);
  });

  it('shows, changes, clears and resets recording settings', async () => {
    const set = await run([
      'capture',
      'settings',
      project,
      '--set',
      'fps=30',
      '--set',
      'resolution=2560x1440',
      '--set',
      'hdr=false',
    ]);
    expect(set.code).toBe(0);
    expect(set.out).toContain('2560x1440 (override), 30 fps (override)');
    expect(set.out).toContain('Saved.');
    const json = JSON.parse((await run(['capture', 'settings', project, '--json'])).out);
    expect(json.settings).toMatchObject({ fps: 30, resolution: { width: 2560, height: 1440 } });
    expect((await run(['capture', 'settings', project, '--unset', 'fps'])).out).toContain(
      '60 fps,',
    );
    const reset = await run(['capture', 'settings', project, '--reset', '--json']);
    expect(JSON.parse(reset.out).overrides).toEqual({});
  });

  it('writes tips once, and again only when asked', async () => {
    const first = await run(['capture', 'tips', project]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('Tips written for 1 group');
    expect(first.err).toBe(''); // no disclosure: the mock stays on this machine
    expect((await run(['capture', 'tips', project])).out).toContain('Tips written for 0 groups');
    expect((await run(['capture', 'tips', project, '--force'])).out).toContain(
      'Tips written for 1 group',
    );
    expect(JSON.parse((await run(['capture', 'status', project, '--json'])).out).tips.fresh).toBe(
      1,
    );
  });

  it('exports the pack under the project folder', async () => {
    const r = await run(['capture', 'export', project, '--format', 'md,json', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { files: string[]; shots: number };
    expect(out.files).toEqual([
      'exports/capture/capture-pack.json',
      'exports/capture/capture-pack.md',
    ]);
    const md = await readFile(join(project, out.files[1]!), 'utf8');
    expect(md).toContain('[x] **Perfect parry**');
    expect(md).toContain('Start at the checkpoint.');
    const all = await run(['capture', 'export', project, '--omit-excluded']);
    expect(all.out).toContain('exports/capture/capture-pack.html');
  });

  it('rejects bad input with usage errors, and explains a missing storyboard', async () => {
    expect((await run(['capture', project])).code).toBe(2);
    expect((await run(['capture', 'plan'])).code).toBe(2);
    expect((await run(['capture', 'mark', project, '--status', 'recorded'])).code).toBe(2);
    expect((await run(['capture', 'mark', project, 'shot_parry'])).err).toContain(
      'nothing to change',
    );
    expect((await run(['capture', 'mark', project, 'shot_parry', '--status', 'done'])).code).toBe(
      2,
    );
    expect((await run(['capture', 'mark', project, 'nope', '--status', 'recorded'])).code).toBe(1);
    expect((await run(['capture', 'settings', project, '--set', 'fps=fast'])).code).toBe(2);
    expect((await run(['capture', 'settings', project, '--set', 'speed=3'])).code).toBe(2);
    expect((await run(['capture', 'settings', project, '--set', 'resolution=big'])).code).toBe(2);
    expect((await run(['capture', 'export', project, '--format', 'pdf'])).code).toBe(2);
    const bare = project.replace('Ember.tforge', 'Bare.tforge');
    const r = await run(['capture', 'plan', bare]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no storyboard');
  });
});
