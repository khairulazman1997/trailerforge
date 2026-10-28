import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

const regenReply = {
  rationale: 'Forest first.',
  section: {
    name: 'Escalation v2',
    slots: [
      { kind: 'shot', title: 'Forest run', seconds: 2 },
      { kind: 'shot', title: 'Warden lands', seconds: 2 },
    ],
  },
};
const genReply = {
  rationale: 'Opens on the parry.',
  sections: [
    { name: 'Hook', role: 'hook', slots: [{ kind: 'shot', title: 'Parry', seconds: 3 }] },
    {
      name: 'End slate',
      role: 'end-slate',
      slots: [
        { kind: 'card', cardKind: 'title', title: 'Title', text: 'Ember Knight', seconds: 2 },
      ],
    },
  ],
};
const mock = createMockProvider({
  'storyboard.generate': genReply,
  'storyboard.regenerate-section': regenReply,
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let sample: string;
let sparse: string;
let repo: string;
let client: Client;
let allowRepo: Client;

async function connect(opts: Parameters<typeof createMcpServer>[0]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(opts).connect(b);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(a);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  // Tool results are arbitrary JSON; the tests assert on the parts they care about.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: r.isError === true, data: JSON.parse(r.content[0]!.text) as any };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-mcp-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
  sample = join(root, 'Sample.tforge');
  sparse = join(root, 'Sparse.tforge');
  await engine.createProject(sample, sampleProject() as never);
  await engine.createProject(sparse, {
    name: 'Sparse',
    brief: { videoTypeId: 'game-trailer/release-trailer' },
  });
  repo = join(root, 'game');
  for (const [p, c] of Object.entries({
    'README.md': '# Ember Knight\n\n## Bosses\n- The Ash Warden: two phases\n',
    '.env': 'KEY=secret',
  })) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), c);
  }
  client = await connect({ engine, defaultProject: sample });
  allowRepo = await connect({ engine, defaultProject: sparse, repoRoots: [root] });
});

afterAll(async () => {
  await engine.close();
});

describe('tool surface', () => {
  it('lists read, action and command tools with object schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'project_summary',
        'brief_get',
        'knowledge_list',
        'storyboard_get',
        'decision_log',
        'undo',
        'redo',
        'knowledge_scan',
        'storyboard_generate',
        'storyboard_regenerate_section',
        'core_storyboard_update-slot',
        'core_brief_set-field',
        'game-trailer_recording_set-overrides',
        'capture_plan',
        'footage_status',
        'footage_analyze',
        'match_suggest',
        'match_accept',
        'take_ranking',
        'cut_generate',
        'core_timeline_trim',
        'core_takes_choose',
        'capture_status',
        'capture_settings',
        'capture_tips',
        'capture_export',
        'game-trailer_capture_set-status',
        'variants_status',
        'variants_create_defaults',
        'brand_status',
        'effects_list',
        'template_preview',
        'core_variants_override',
        'core_brand_set-colors',
        'core_timeline_set-effects',
        'core_storyboard_add-sfx-cue',
        'render_status',
        'qc_report',
        'draft_start',
        'export_start',
        'handoff_start',
        'render_cancel',
        'core_review_comment',
        'core_export_set',
        'core_timeline_set-clip-audio',
      ]),
    );
    // Bulk-result commands are reachable only through the action tools.
    expect(names).not.toContain('footage_import'); // choosing files is the user's, not an AI client's
    expect(names).not.toContain('core_storyboard_set');
    expect(names).not.toContain('core_storyboard_replace-section');
    expect(names).not.toContain('core_knowledge_apply-scan');
    // Which logo and font files a project uses is the user's choice, like importing footage.
    expect(names).not.toContain('core_brand_set-logo');
    expect(names).not.toContain('core_brand_set-font');
    // Approving is the user's sign-off, and overriding a gate finding is theirs too.
    expect(names).not.toContain('core_review_approve');
    expect(JSON.stringify(tools.find((t) => t.name === 'export_start')!.inputSchema)).not.toContain(
      'override',
    );
    // Every registered command is exposed except those, and each schema is an object.
    expect(engine.commands.types().length - 6).toBe(
      names.filter((n) => n.startsWith('core_') || n.startsWith('game-trailer_')).length,
    );
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toHaveProperty('project');
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.description?.length).toBeGreaterThan(10);
    }
    // The human-only deep scan is not offered, and the scan tool cannot request it.
    expect(names.some((n) => n.includes('deep'))).toBe(false);
    expect(
      Object.keys(tools.find((t) => t.name === 'knowledge_scan')!.inputSchema.properties!),
    ).not.toContain('deep');
  });

  it('reads project state', async () => {
    const summary = await call(client, 'project_summary');
    expect(summary.data).toMatchObject({
      name: 'Ember Knight — Release Trailer',
      videoType: 'game-trailer/release-trailer',
      canUndo: false,
    });
    const sb = await call(client, 'storyboard_get');
    expect(sb.data.sections.map((s: { id: string }) => s.id)).toEqual([
      'sec_hook',
      'sec_escalation',
      'sec_end',
    ]);
    expect(sb.data.sections[2]).toMatchObject({ locked: true });
    expect(sb.data.timing).toMatchObject({ target: 60 });
    expect((await call(client, 'storyboard_get', { detail: 'full' })).data.storyboard.id).toBe(
      'sb_main',
    );
    expect(
      (await call(client, 'knowledge_list', { kind: 'boss' })).data.entities.map(
        (e: { name: string }) => e.name,
      ),
    ).toEqual(['The Ash Warden']);
    expect((await call(client, 'brief_get')).data.status).toMatchObject({
      videoTypeId: 'game-trailer/release-trailer',
    });
  });

  it('errors clearly when no project is named', async () => {
    const bare = await connect({ engine });
    const r = await call(bare, 'project_summary');
    expect(r.isError).toBe(true);
    // With several projects open in this engine, the message also lists them.
    expect(r.data.error).toMatch(/pass "project"/);
    expect((await call(client, 'no_such_tool')).isError).toBe(true);
  });
});

describe('editing through tools', () => {
  it('edits are validated, saved to disk, flagged, and undoable', async () => {
    const edit = await call(client, 'core_storyboard_update-slot', {
      slotId: 'shot_parry',
      patch: { captureInstruction: 'Parry twice, no HUD.', hud: 'off' },
    });
    expect(edit.isError).toBe(false);
    expect(edit.data).toMatchObject({ ok: true, canUndo: true });

    const slot = (await call(client, 'storyboard_get')).data.sections[0].slots[0];
    expect(slot).toMatchObject({
      id: 'shot_parry',
      captureInstruction: 'Parry twice, no HUD.',
      handEdited: true,
    });
    // Saved before the call returned: read it back from disk.
    const onDisk = JSON.parse(await readFile(join(sample, 'project.json'), 'utf8'));
    expect(onDisk.storyboard.sections[0].slots[0].captureInstruction).toBe('Parry twice, no HUD.');

    expect((await call(client, 'undo')).data).toMatchObject({ done: true });
    expect((await call(client, 'storyboard_get')).data.sections[0].slots[0].handEdited).toBe(false);
    expect((await call(client, 'redo')).data).toMatchObject({ done: true });
    expect((await call(client, 'storyboard_get')).data.sections[0].slots[0].handEdited).toBe(true);
    await call(client, 'undo');
  });

  it('turns bad input and locked sections into tool errors that change nothing', async () => {
    const before = (await call(client, 'storyboard_get', { detail: 'full' })).data.storyboard;
    const bad = await call(client, 'core_storyboard_update-slot', {
      slotId: 'shot_parry',
      patch: { duration: { min: 5, ideal: 2, max: 3 } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/invalid payload/);
    expect(bad.data.details.length).toBeGreaterThan(0);

    const locked = await call(client, 'core_storyboard_update-slot', {
      slotId: 'card_end',
      patch: { text: 'x' },
    });
    expect(locked.isError).toBe(true);
    expect(locked.data.error).toMatch(/locked/);

    const unknown = await call(client, 'core_storyboard_update-slot', {
      slotId: 'shot_parry',
      patch: { entityIds: ['ent_made_up'] },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error).toMatch(/broken references/);

    expect((await call(client, 'storyboard_get', { detail: 'full' })).data.storyboard).toEqual(
      before,
    );
  });
});

describe('actions', () => {
  it('will not register a new repo unless it is under an allowed folder', async () => {
    const denied = await call(client, 'knowledge_scan', { project: sparse, repo });
    expect(denied.isError).toBe(true);
    expect(denied.data.error).toMatch(/not under an allowed folder/);
    expect((await call(client, 'project_summary', { project: sparse })).data.sources).toEqual([]);

    const ok = await call(allowRepo, 'knowledge_scan', { repo });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ files: 1, skipped: { secret: 1 }, added: 2 });
    expect(JSON.stringify(ok.data)).not.toContain('KEY=secret');

    // Once it is a source, rescanning needs no allowance (and nothing changed).
    const again = await call(client, 'knowledge_scan', { project: sparse });
    expect(again.data).toMatchObject({ unchanged: true });
  });

  it('refuses to generate from an incomplete brief unless told to assume', async () => {
    const refused = await call(allowRepo, 'storyboard_generate', { duration: 30 });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toMatch(/missing required details/);
    expect(refused.data.details.map((m: { label: string }) => m.label)).toContain('Platforms');

    const done = await call(allowRepo, 'storyboard_generate', { duration: 30, assume: true });
    expect(done.isError).toBe(false);
    expect(done.data).toMatchObject({ provider: 'core/mock', slots: 2, seconds: 30 });
    expect(done.data.assumptionsAdded).toBeGreaterThan(0);
    expect(mock.calls.at(-1)!.prompt).toMatch(/The Ash Warden/);

    const log = await call(allowRepo, 'decision_log');
    expect(log.data.at(-1)).toMatchObject({
      step: 'core/storyboard-generate',
      summary: 'Opens on the parry.',
    });
  });

  it('regenerates a section but keeps hand-edited slots, and refuses locked ones', async () => {
    await call(client, 'core_storyboard_add-slot', {
      sectionId: 'sec_escalation',
      slot: {
        id: 'shot_mine',
        kind: 'shot',
        title: 'My shot',
        duration: { min: 1, ideal: 2, max: 3 },
      },
    });
    const r = await call(client, 'storyboard_regenerate_section', {
      sectionId: 'sec_escalation',
      instruction: 'more forest',
    });
    expect(r.isError).toBe(false);
    expect(r.data.keptSlotIds).toEqual(['shot_mine']);
    expect(r.data.section.slots).toContain('My shot');
    expect(
      (await call(client, 'storyboard_regenerate_section', { sectionId: 'sec_end' })).data.error,
    ).toMatch(/locked/);
    expect((await call(client, 'storyboard_regenerate_section', {})).isError).toBe(true);
  });
});

describe('stdio transport', () => {
  it('reads the capture checklist, marks a shot through its command tool, and exports the pack', async () => {
    // Earlier tests edit the shared sample project, so work from what the plan says now.
    const plan = (await call(client, 'capture_plan')).data;
    const { total, done } = plan.plan;
    expect(total).toBeGreaterThan(0);
    expect(plan.recording.settings.fps).toBe(60);
    const todo = plan.plan.groups
      .flatMap((g: { items: { slotId: string; todo: boolean }[] }) => g.items)
      .find((i: { todo: boolean }) => i.todo);
    const marked = await call(client, 'game-trailer_capture_set-status', {
      slotId: todo.slotId,
      status: 'recorded',
    });
    expect(marked.isError).toBe(false);
    expect((await call(client, 'capture_status')).data).toMatchObject({ total, done: done + 1 });
    expect((await call(client, 'capture_plan', { include: 'todo' })).data.plan.total).toBe(
      total - done - 1,
    );
    expect((await call(client, 'capture_settings')).data.settings.codec).toBeTruthy();

    const exported = await call(client, 'capture_export', { formats: ['json'] });
    expect(exported.data).toEqual({
      files: ['exports/capture/capture-pack.json'],
      shots: total,
      done: done + 1,
    });
    expect((await call(client, 'capture_export', { omitExcluded: true })).isError).toBe(false);

    // A project with no storyboard explains what to do instead of failing obscurely.
    const bare = join(root, 'NoStoryboard.tforge');
    await engine.createProject(bare, { name: 'No storyboard' });
    const none = await call(client, 'capture_plan', { project: bare });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.data)).toContain('no storyboard');
    expect((await call(client, 'capture_tips', { project: bare })).isError).toBe(true);
  });

  it('speaks line-delimited JSON-RPC and answers tools/list', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer({ engine, defaultProject: sample });
    await server.connect(new StdioServerTransport(stdin, stdout));
    const lines: string[] = [];
    stdout.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const send = (m: object) => stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise((r) => setTimeout(r, 300));
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('trailerforge');
    expect(msgs.find((m) => m.id === 2).result.tools.length).toBeGreaterThan(30);
    await server.close();
  });
});

describe('review, quality and render tools', () => {
  it('reports versions and the gate, comments through the command tools, and renders in the background', async () => {
    const status = await call(client, 'render_status');
    expect(status.data.versions.map((v: { variantId: string | null }) => v.variantId)).toEqual([
      null,
      'var_tt',
    ]);
    expect(status.data.render).toBeNull();

    const qc = await call(client, 'qc_report', { version: 'var_tt' });
    expect(qc.data.verdict.allowed).toBe(false);
    expect(qc.data.verdict.blocking.length).toBeGreaterThan(0);
    expect((await call(client, 'qc_report', { version: 'var_gone' })).isError).toBe(true);

    const c = await call(client, 'core_review_comment', {
      variantId: 'var_tt',
      at: 705600000,
      text: 'Slow start',
    });
    expect(c.isError).toBe(false);
    expect((await call(client, 'render_status')).data.comments).toHaveLength(1);

    const started = await call(client, 'draft_start', { version: 'var_tt' });
    expect(started.data).toMatchObject({ started: 'draft', version: 'var_tt' });
    expect((await call(client, 'draft_start', { version: 'var_tt' })).isError).toBe(true); // one at a time
    let done;
    for (let i = 0; i < 200; i++) {
      done = (await call(client, 'render_status')).data.render;
      if (done.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.status).toBe('succeeded');
    expect(done.result.file).toMatch(/drafts/);

    // An export the gate blocks reports why, and there is no way to override it from here.
    await call(client, 'export_start', { version: 'var_tt' });
    for (let i = 0; i < 100; i++) {
      done = (await call(client, 'render_status')).data.render;
      if (done.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.status).toBe('failed');
    expect(done.error.message).toMatch(/Quality Gate stopped the export/);
    expect((await call(client, 'render_cancel')).data).toEqual({ cancelled: false });
  }, 60_000);
});
