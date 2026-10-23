import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const SECRET = 'STEAM-KEY-DO-NOT-LEAK';

const REPO: Record<string, string> = {
  'README.md': '# Ember Knight\n\nA soulslike about parrying fire.\n',
  'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.30f1\n',
  'ProjectSettings/ProjectSettings.asset':
    'PlayerSettings:\n  companyName: Ember Studio\n  productName: Ember Knight\n',
  'ProjectSettings/EditorBuildSettings.asset':
    'EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/CinderForest.unity\n    guid: b\n',
  'Assets/Data/Bosses/AshWarden.asset':
    '%YAML 1.1\n--- !u!114 &11400000\nMonoBehaviour:\n  m_Name: AshWarden\n  displayName: The Ash Warden\n  description: Second-act boss with two phases\n',
  '.env': `STEAM_API_KEY=${SECRET}`,
  'config/steam_api_key.txt': SECRET,
};

const storyboardReply = {
  rationale: 'Opens on the Warden, ends on the title.',
  sections: [
    {
      name: 'Hook',
      role: 'hook',
      slots: [
        {
          kind: 'shot',
          title: 'Warden parry',
          seconds: 4,
          captureInstruction: 'Parry the Warden.',
          entityIds: ['ent_the_ash_warden'],
        },
        { kind: 'shot', title: 'Forest run', seconds: 4, entityIds: ['ent_cinder_forest'] },
      ],
    },
    {
      name: 'End slate',
      role: 'end-slate',
      slots: [
        { kind: 'card', cardKind: 'title', title: 'Title', text: 'Ember Knight', seconds: 2 },
      ],
    },
  ],
  music: { direction: 'Hybrid orchestral' },
};

let root: string;
let home: string;
let repo: string;
let project: string;
const mock = createMockProvider({ 'storyboard.generate': storyboardReply });
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

async function run(args: string[], ext: Parameters<typeof main>[3] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...args, '--home', home],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    process.env,
    { engine: { llm }, ...ext },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

interface SavedProject {
  knowledge: {
    id: string;
    name: string;
    description: string;
    origin: string;
    kind: string;
    tags: string[];
    confidence: number;
  }[];
  sources: { digestHash: string | null }[];
  brief: { assumptions: unknown[] };
  storyboard: {
    meta: Record<string, unknown>;
    sections: { slots: { entityIds: string[] }[] }[];
  } | null;
}

const readProject = async () =>
  JSON.parse(await readFile(join(project, 'project.json'), 'utf8')) as SavedProject;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-m2-'));
  home = join(root, 'home');
  repo = join(root, 'game');
  project = join(root, 'Ember.tforge');
  for (const [p, c] of Object.entries(REPO)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), c);
  }
});

describe('M2a end to end: scan repo → brief check → generate storyboard', () => {
  it('creates a project and reports the brief gaps', async () => {
    expect(
      (
        await run([
          'new',
          project,
          '--name',
          'Ember Knight',
          '--type',
          'game-trailer/release-trailer',
        ])
      ).code,
    ).toBe(0);
    const check = await run(['brief', 'check', project]);
    expect(check.code).toBe(1);
    expect(check.out).toMatch(/Release trailer: brief \d+% complete, \d+ required fields? missing/);
    expect(check.out).toMatch(
      /\* Release date \(brief\.keyDates\[label=Release\]\.date\): missing/,
    );
    const json = JSON.parse((await run(['brief', 'check', project, '--json'])).out);
    expect(json).toMatchObject({
      videoTypeId: 'game-trailer/release-trailer',
      complete: false,
      canProceed: false,
    });
    expect(json.missing.some((m: { label: string }) => m.label === 'Game name')).toBe(true);
  });

  it('refuses to generate from an incomplete brief without --assume', async () => {
    const r = await run(['storyboard', 'generate', project]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/missing required details/);
    expect(r.err).toMatch(/--assume/);
    expect(mock.calls).toHaveLength(0);
    expect((await readProject()).storyboard).toBeNull();
  });

  it('scans the repo into the knowledge base without touching secrets', async () => {
    const r = await run(['knowledge', 'scan', project, '--repo', repo, '--json']);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.extractors).toEqual(['core/generic', 'game-trailer/unity']);
    expect(s.skipped).toMatchObject({ secret: 2 });
    expect(s.added).toBeGreaterThanOrEqual(3);

    const p = await readProject();
    expect(p.knowledge.map((e) => e.name).sort()).toEqual(
      expect.arrayContaining(['Cinder Forest', 'Ember Knight', 'The Ash Warden']),
    );
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0]!.digestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it('skips unchanged repos, and keeps user edits across a forced rescan', async () => {
    const again = await run(['knowledge', 'scan', project, '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ unchanged: true, files: 5 });
    expect(again.out).not.toContain('"added": 1');

    // The user rewrites a description; a forced rescan must not overwrite it.
    const p = await readProject();
    const warden = p.knowledge.find((e) => e.name === 'The Ash Warden')!;
    p.knowledge = p.knowledge.map((e) =>
      e.id === warden.id ? { ...e, description: 'My notes', origin: 'user' } : e,
    );
    await writeFile(join(project, 'project.json'), JSON.stringify(p));
    const forced = await run(['knowledge', 'scan', project, '--force', '--json']);
    expect(forced.code).toBe(0);
    const after = (await readProject()).knowledge.find((e) => e.id === warden.id);
    expect(after).toMatchObject({ description: 'My notes', origin: 'user' });
  });

  it('will not deep-scan without the explicit confirmation flag', async () => {
    const fakeBin = join(root, 'must-not-run');
    const r = await run(['knowledge', 'scan', project, '--deep'], { claudeBin: fakeBin });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/sends the contents of your project files/);
    expect(r.err).toMatch(/--allow-deep-scan/);
  });

  it('generates the storyboard from the brief and knowledge, logs the decision', async () => {
    const r = await run(['storyboard', 'generate', project, '--assume', '--duration', '30']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Storyboard written with core\/mock: 2 sections, 3 slots, 30 s/);

    // The scanned facts reached the prompt, and nothing secret did.
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toMatch(/The Ash Warden/);
    expect(prompt).not.toContain(SECRET);

    const p = await readProject();
    const slots = p.storyboard!.sections.flatMap((s) => s.slots);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.entityIds).toEqual(['ent_the_ash_warden']);
    expect(p.brief.assumptions.length).toBeGreaterThan(0); // proceeding was logged, not silent
    expect(p.storyboard!.meta).toMatchObject({
      templateId: 'game-trailer/tpl-release',
      targetDuration: 30,
    });

    const log = (await readFile(join(project, 'logs', 'decisions.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({
      step: 'core/storyboard-generate',
      summary: storyboardReply.rationale,
    });

    const info = JSON.parse((await run(['info', project, '--json'])).out);
    expect(info.storyboardSlots).toBe(3);
    // Assumptions make generation possible but the brief is still not complete.
    const check = JSON.parse((await run(['brief', 'check', project, '--json'])).out);
    expect(check).toMatchObject({ complete: false, canProceed: true });
  });

  it('rejects bad input with usage errors', async () => {
    expect((await run(['storyboard', 'generate', project, '--duration', 'soon'])).code).toBe(2);
    expect((await run(['brief', 'check'])).code).toBe(2);
    expect((await run(['knowledge', 'scan', join(root, 'new2.tforge')])).code).toBe(1); // no such project
  });

  it.skipIf(process.platform === 'win32')(
    'deep scan adds Claude Code findings, tagged, when confirmed',
    async () => {
      const bin = join(root, 'claude');
      await writeFile(
        bin,
        `#!/usr/bin/env node
process.stdin.resume().on('data', () => {}).on('end', () => {
  process.stdout.write(JSON.stringify({ result: '', structured_output: { entities: [{ kind: 'mechanic', name: 'Perfect Parry', description: 'Timed deflect', paths: ['README.md'] }] }, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
      );
      await chmod(bin, 0o755);
      const r = await run(['knowledge', 'scan', project, '--deep', '--allow-deep-scan', '--json'], {
        claudeBin: bin,
      });
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/Claude Code will read 5 text files/);
      expect(JSON.parse(r.out).deep).toMatchObject({ entities: 1, filesShared: 5 });
      const parry = (await readProject()).knowledge.find(
        (e: { name: string }) => e.name === 'Perfect Parry',
      );
      expect(parry).toMatchObject({
        kind: 'mechanic',
        tags: ['deep-scan'],
        confidence: 0.6,
        origin: 'extracted',
      });

      // A normal forced rescan leaves deep-scan results alone.
      await run(['knowledge', 'scan', project, '--force']);
      expect((await readProject()).knowledge.some((e) => e.name === 'Perfect Parry')).toBe(true);
    },
  );
});
