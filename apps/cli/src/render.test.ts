import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let root: string;
let home: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-clirender-'));
  home = join(root, 'home');
  project = join(root, 'Ember.tforge');
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
  await engine.createProject(project, sampleProject() as never);
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

describe('tforge presets, qc, review, draft, export and handoff', { timeout: 120_000 }, () => {
  it('lists the presets', async () => {
    const r = await run(['presets']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/core\/steam\s+Steam \(\.mp4\)/);
  });

  it('qc exits 1 and says why when the gate blocks; --json has the verdict', async () => {
    const r = await run(['qc', project, '--version', 'var_tt']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/var_tt as Vertical social: blocked/);
    expect(r.out).toMatch(/X .*placeholder/);
    const j = JSON.parse((await run(['qc', project, '--version', 'master', '--json'])).out) as {
      verdict: { allowed: boolean };
    };
    expect(j.verdict.allowed).toBe(false);
  });

  it('overrides need a reason, and only override-tier checks can use one', async () => {
    const noReason = await run(['qc', project, '--override', 'loudness']);
    expect(noReason.code).toBe(2);
    expect(noReason.err).toMatch(/needs a reason/);
    const exp = await run(['export', project, '--version', 'var_tt']);
    expect(exp.code).toBe(1);
    expect(exp.err).toMatch(/Quality Gate stopped the export before rendering/);
  });

  it('comments, resolves, approves, withdraws; the list shows each step', async () => {
    const c = await run([
      'review',
      'comment',
      project,
      '--version',
      'var_tt',
      '--at',
      '1.5',
      '--text',
      'Hook is slow',
    ]);
    expect(c.code).toBe(0);
    const id = /Comment (\S+) on/.exec(c.out)![1]!;
    expect((await run(['review', 'list', project])).out).toMatch(
      new RegExp(`\\[ \\] ${id}\\s+var_tt @ 1.5 s: Hook is slow`),
    );
    expect((await run(['review', 'resolve', project, id])).code).toBe(0);
    expect(
      (await run(['review', 'approve', project, '--version', 'var_tt', '--note', 'ship it'])).out,
    ).toMatch(/Approved var_tt/);
    const list = await run(['review', 'list', project]);
    expect(list.out).toMatch(/var_tt\s+approved\s+/);
    expect(list.out).toMatch(new RegExp(`\\[x\\] ${id}`));
    expect((await run(['review', 'revoke', project, '--version', 'var_tt'])).out).toMatch(
      /Withdrew/,
    );
    expect((await run(['review', 'comment', project, '--version', 'var_tt'])).code).toBe(2);
    const saved = JSON.parse(await readFile(join(project, 'project.json'), 'utf8')) as {
      review: { comments: unknown[]; approvals: unknown[] };
    };
    expect(saved.review.comments).toHaveLength(1);
    expect(saved.review.approvals).toHaveLength(0);
  });

  it('draft and handoff run on the sample (missing media shows as slates and warnings)', async () => {
    const d = await run(['draft', project, '--version', 'var_tt']);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/Draft of var_tt: .*drafts/);
    const h = await run(['handoff', project, '--version', 'var_tt', '--format', 'edl,otio']);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/edl: .*\.edl/);
    expect(h.out).toMatch(/! "?.*placeholder|cannot be found/);
    expect((await run(['handoff', project, '--format', 'zip'])).code).toBe(2);
  });
});
