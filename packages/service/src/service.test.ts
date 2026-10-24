import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceClient, ServiceError, type ServiceEventMessage } from './client.js';
import { EventLog } from './events.js';
import { startService, type RunningService } from './service.js';

const genReply = {
  rationale: 'Opens on the parry.',
  sections: [
    { name: 'Hook', role: 'hook', slots: [{ kind: 'shot', title: 'Parry', seconds: 3 }] },
    { name: 'Middle', role: 'escalation', slots: [{ kind: 'shot', title: 'Run', seconds: 3 }] },
  ],
};
/** While set, generation waits on it: lets a test cancel or edit mid-flight. */
let gate: Promise<void> | null = null;
/** While set, capture tips wait on it. */
let tipsGate: Promise<void> | null = null;
const tipsReply = async (req: { prompt: string }) => {
  if (tipsGate) await tipsGate;
  const keys = [...req.prompt.matchAll(/"key": "([^"]*)"/g)].map((m) => m[1]!);
  return {
    groups: keys.map((key) => ({ key, tips: ['Use the checkpoint.'], risks: ['A popup.'] })),
  };
};
const mock = createMockProvider({
  'capture.tips': tipsReply,
  'brief.suggest': { value: 'Ember Knight', reason: 'from the game facts' },
  'storyboard.generate': async () => {
    if (gate) await gate;
    return genReply;
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let svc: RunningService;
let client: ServiceClient;
let sampleDir: string;
const UI_ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-svc-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
  sampleDir = join(root, 'Sample.tforge');
  await engine.createProject(sampleDir, sampleProject() as never);
  svc = await startService({ engine, allowedOrigins: [UI_ORIGIN], maxBodyBytes: 64 * 1024 });
  client = new ServiceClient({ baseUrl: svc.url, token: svc.token });
});

afterAll(async () => {
  await svc.close();
  await engine.close();
});

/** Raw request, so tests can send headers fetch would normalise (Host, Origin). */
function raw(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: svc.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', fail);
    req.end(opts.body);
  });
}
const auth = () => ({ authorization: `Bearer ${svc.token}` });
const errCode = (r: { body: string }) =>
  (JSON.parse(r.body) as { error: { code: string } }).error.code;

async function nextEvents(
  it: AsyncGenerator<ServiceEventMessage>,
  n: number,
  filter = (_: ServiceEventMessage) => true,
) {
  const out: ServiceEventMessage[] = [];
  while (out.length < n) {
    const { value, done } = await it.next();
    if (done) break;
    if (filter(value)) out.push(value);
  }
  return out;
}

describe('security', () => {
  it('refuses to listen on anything but loopback, and refuses short tokens', async () => {
    await expect(startService({ engine, host: '0.0.0.0' })).rejects.toThrow(/loopback-only/);
    await expect(startService({ engine, token: 'short' })).rejects.toThrow(/at least 32/);
  });

  it('requires the token on every request, including the event stream', async () => {
    expect((await raw({ path: '/v1/info' })).status).toBe(401);
    const wrong = 'x'.repeat(svc.token.length);
    expect(
      (await raw({ path: '/v1/info', headers: { authorization: `Bearer ${wrong}` } })).status,
    ).toBe(401);
    expect((await raw({ path: '/v1/events' })).status).toBe(401);
    expect(svc.token.length).toBeGreaterThanOrEqual(43);
    await expect(
      new ServiceClient({ baseUrl: svc.url, token: wrong }).info(),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('rejects foreign Host headers (DNS rebinding), even with the token', async () => {
    const r = await raw({
      path: '/v1/info',
      headers: { ...auth(), host: `evil.example:${svc.port}` },
    });
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe('bad-host');
    expect(
      (await raw({ path: '/v1/info', headers: { ...auth(), host: `localhost:${svc.port}` } }))
        .status,
    ).toBe(200);
  });

  it('allows only listed browser origins, and never "null"', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:9999']) {
      const r = await raw({ path: '/v1/info', headers: { ...auth(), origin } });
      expect(r.status).toBe(403);
      expect(errCode(r)).toBe('bad-origin');
    }
    const ok = await raw({ path: '/v1/info', headers: { ...auth(), origin: UI_ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(UI_ORIGIN);
    // The service's own origin is always allowed.
    expect(
      (
        await raw({
          path: '/v1/info',
          headers: { ...auth(), origin: `http://127.0.0.1:${svc.port}` },
        })
      ).status,
    ).toBe(200);
  });

  it('answers CORS preflight for allowed origins only, without needing the token', async () => {
    const pre = await raw({
      method: 'OPTIONS',
      path: '/v1/projects',
      headers: { origin: UI_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toMatch(/authorization/);
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined(); // no cookies, ever
    expect(
      (
        await raw({
          method: 'OPTIONS',
          path: '/v1/projects',
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('accepts JSON bodies only, within the size cap', async () => {
    const form = await raw({
      method: 'POST',
      path: '/v1/projects/open',
      headers: { ...auth(), 'content-type': 'text/plain' },
      body: '{"dir":"x"}',
    });
    expect(form.status).toBe(415);
    const big = await raw({
      method: 'POST',
      path: '/v1/projects/open',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ dir: 'x'.repeat(70 * 1024) }),
    });
    expect(big.status).toBe(413);
    const bad = await raw({
      method: 'POST',
      path: '/v1/projects/open',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(errCode(bad)).toBe('bad-json');
  });

  it('sends defensive headers and clean 404/405s', async () => {
    const r = await raw({ path: '/v1/info', headers: auth() });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw({ path: '/v1/nope', headers: auth() })).status).toBe(404);
    expect((await raw({ method: 'DELETE', path: '/v1/info', headers: auth() })).status).toBe(405);
  });
});

describe('projects, commands and events', () => {
  it('creates and opens projects, and lists what the UI needs', async () => {
    const info = await client.info();
    expect(info.videoTypes.map((v) => v.id)).toContain('game-trailer/release-trailer');
    expect(info.commands).toContain('core/storyboard.update-slot');

    const created = await client.createProject({
      dir: join(root, 'New.tforge'),
      name: 'New',
      videoTypeId: 'game-trailer/gameplay-trailer',
    });
    expect(created).toMatchObject({
      version: 0,
      canUndo: false,
      busy: null,
      project: { name: 'New' },
    });
    await expect(
      client.createProject({ dir: join(root, 'New.tforge'), name: 'Again' }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect((await client.listProjects()).map((p) => p.name)).toEqual(
      expect.arrayContaining(['New']),
    );
    await expect(client.getProject('proj_nope')).rejects.toMatchObject({
      status: 404,
      code: 'not-open',
    });
  });

  it('streams changes in order with versions and patches, and replays after a reconnect', async () => {
    const { id } = await client.getProject('proj_sample');
    const ac = new AbortController();
    const stream = client.events({ after: (await client.info()).lastSeq, signal: ac.signal });
    const first = client.command(id, 'core/project.rename', { name: 'One' });
    const changes = nextEvents(stream, 2, (e) => e.type === 'project.changed');
    await first;
    const second = await client.command(id, 'core/project.rename', { name: 'Two' });
    const [a, b] = await changes;
    ac.abort();
    expect(b!.seq).toBeGreaterThan(a!.seq);
    expect([
      (a!.data as { version: number }).version,
      (b!.data as { version: number }).version,
    ]).toEqual([second.version - 1, second.version]);
    expect((b!.data as { patches: { path: string[]; value: unknown }[] }).patches).toContainEqual(
      expect.objectContaining({ path: ['name'], value: 'Two' }),
    );

    // Reconnect from just after `a`: we get `b` again, nothing before it.
    const ac2 = new AbortController();
    const replay = await nextEvents(client.events({ after: a!.seq, signal: ac2.signal }), 1);
    ac2.abort();
    expect(replay[0]!.seq).toBe(a!.seq + 1);

    const undone = await client.undo(id);
    expect(undone).toMatchObject({ done: true, version: second.version + 1 });
    // Two quick renames are one undo step (rename merges within 1 s), so undo restores the original.
    expect((await client.getProject(id)).project.name).toBe('Ember Knight — Release Trailer');
  });

  it('turns command problems into clear errors that change nothing', async () => {
    const before = await client.getProject('proj_sample');
    await expect(
      client.command('proj_sample', 'core/storyboard.update-slot', {
        slotId: 'shot_parry',
        patch: { duration: { min: 5, ideal: 1, max: 2 } },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid' });
    await expect(client.command('proj_sample', 'core/nope', {})).rejects.toMatchObject({
      status: 400,
      code: 'unknown-command',
    });
    await expect(
      client.command('proj_sample', 'core/storyboard.update-slot', {
        slotId: 'card_end',
        patch: { text: 'x' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'locked' });
    await expect(
      client.command('proj_sample', 'core/knowledge.remove-entity', { id: 'ent_nope' }),
    ).rejects.toMatchObject({ status: 422, code: 'rejected' });
    expect((await client.getProject('proj_sample')).version).toBe(before.version);
  });

  it('reports a project another instance holds as locked, and releases it on close', async () => {
    const engine2 = await Engine.start({
      home: join(root, 'home2'),
      autosaveMs: 0,
      loadUserPlugins: false,
      llm,
    });
    const svc2 = await startService({ engine: engine2 });
    const client2 = new ServiceClient({ baseUrl: svc2.url, token: svc2.token });
    try {
      const dir = join(root, 'New.tforge');
      await expect(client2.openProject(dir)).rejects.toMatchObject({
        status: 423,
        code: 'project-locked',
      });
      const { id } = (await client.listProjects()).find((p) => p.name === 'New')!;
      await client.closeProject(id);
      expect((await client2.openProject(dir)).project.name).toBe('New');
    } finally {
      await svc2.close();
      await engine2.close();
    }
  });
});

describe('tasks', () => {
  it('runs generation as a task, blocks edits meanwhile, and saves the result', async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const t = await client.startTask('proj_sample', {
      kind: 'generate',
      options: { duration: 30, assume: true },
    });
    expect(t.status).toBe('running');
    await expect(
      client.command('proj_sample', 'core/project.rename', { name: 'X' }),
    ).rejects.toMatchObject({ status: 409, code: 'busy' });
    await expect(client.startTask('proj_sample', { kind: 'generate' })).rejects.toMatchObject({
      code: 'busy',
    });
    expect((await client.getProject('proj_sample')).busy?.id).toBe(t.id);
    gate = null;
    release();
    const done = await client.waitForTask(t.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { provider: 'core/mock', seconds: 30 },
    });
    const onDisk = JSON.parse(await readFile(join(sampleDir, 'project.json'), 'utf8')) as {
      storyboard: { meta: { targetDuration: number } };
    };
    expect(onDisk.storyboard.meta.targetDuration).toBe(30);
    expect((await client.decisions('proj_sample')).length).toBeGreaterThan(0);
  });

  it('cancelling a task means its result never lands', async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const before = await client.getProject('proj_sample');
    const t = await client.startTask('proj_sample', {
      kind: 'generate',
      options: { duration: 45, assume: true },
    });
    expect((await client.cancelTask(t.id)).id).toBe(t.id);
    gate = null;
    release();
    expect((await client.waitForTask(t.id)).status).toBe('cancelled');
    const after = await client.getProject('proj_sample');
    expect(after.project.storyboard?.meta.targetDuration).toBe(
      before.project.storyboard?.meta.targetDuration,
    );
    expect(after.version).toBe(before.version);
    // The project is usable again straight away.
    await client.command('proj_sample', 'core/project.rename', { name: 'After cancel' });
  });

  it('reports task failures with codes, and validates task requests', async () => {
    const lockedId = (await client.getProject('proj_sample')).project.storyboard!.sections.find(
      (s) => s.locked,
    )?.id;
    if (lockedId) {
      const t = await client.startTask('proj_sample', {
        kind: 'regenerate-section',
        options: { sectionId: lockedId },
      });
      expect(await client.waitForTask(t.id)).toMatchObject({
        status: 'failed',
        error: { code: 'locked' },
      });
    }
    const deep = await client.startTask('proj_sample', { kind: 'scan', options: { deep: true } });
    expect(await client.waitForTask(deep.id)).toMatchObject({
      status: 'failed',
      error: { code: 'usage' },
    });
    await expect(
      client.startTask('proj_sample', { kind: 'frobnicate' } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.getTask('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('footage settings, vision and previews', () => {
  it('saves watched folders and refuses paths that are not existing folders', async () => {
    const obs = join(root, 'svc-obs');
    await mkdir(obs);
    await expect(client.setWatchedFolders(['relative'])).rejects.toMatchObject({ status: 400 });
    await expect(client.setWatchedFolders([join(root, 'nope')])).rejects.toMatchObject({
      status: 404,
    });
    expect(await client.setWatchedFolders([obs])).toMatchObject({
      folders: [obs],
      watching: true,
    });
    expect((await client.watchedFolders()).folders).toEqual([obs]);
    expect(await client.setWatchedFolders([])).toMatchObject({ folders: [], watching: false });
  });

  it('shows the vision disclosure, and downloads only with an explicit yes', async () => {
    const view = await client.vision();
    expect(view.status).not.toBe('ready');
    expect(view.disclosure?.sends).toMatch(/Nothing about you/);
    for (const body of [{}, { consent: false }, { consent: 'yes' }]) {
      const r = await fetch(`${svc.url}/v1/vision/download`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }

    // A second engine with a test model and a fake network, so the task runs end to end.
    const file = Buffer.from('m'.repeat(500));
    const { createHash } = await import('node:crypto');
    const fetched: string[] = [];
    const e2 = await Engine.start({
      home: join(root, 'vision-home'),
      autosaveMs: 0,
      loadUserPlugins: false,
      visionModel: {
        id: 'svc-clip',
        title: 'Test',
        license: 'MIT',
        source: 'example/test@1',
        files: [
          {
            name: 'model.onnx',
            url: 'https://models.example.org/model.onnx',
            bytes: file.length,
            sha256: createHash('sha256').update(file).digest('hex'),
          },
        ],
      },
      egressFetch: (async (url: string) => {
        fetched.push(url);
        return new Response(new Uint8Array(file));
      }) as unknown as typeof fetch,
    });
    const s2 = await startService({ engine: e2 });
    try {
      const c2 = new ServiceClient({ baseUrl: s2.url, token: s2.token });
      expect((await c2.vision()).status).toBe('absent');
      const task = await c2.downloadVision();
      expect(task.kind).toBe('vision-download');
      expect(await c2.waitForTask(task.id)).toMatchObject({
        status: 'succeeded',
        result: { status: 'ready' },
      });
      expect(fetched).toEqual(['https://models.example.org/model.onnx']);
    } finally {
      await s2.close();
      await e2.close();
    }
  });

  it('serves previews only for library assets', async () => {
    for (const what of ['thumbnail', 'filmstrip']) {
      const r = await fetch(`${svc.url}/v1/library/assets/asset_missing/${what}`, {
        headers: auth(),
      });
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
        /no library asset/,
      );
    }
    const other = await fetch(`${svc.url}/v1/library/assets/asset_missing/..%2Fsecrets.json`, {
      headers: auth(),
    });
    expect(other.status).toBe(404);
  });
});

describe('Claude Code connection', () => {
  /** A stand-in `claude` that keeps its MCP registrations in a JSON file. */
  async function fakeClaude() {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-fake-cc-'));
    const state = join(dir, 'servers.json');
    const script = join(dir, 'claude.js');
    await writeFile(
      script,
      `const fs = require('fs'); const f = ${JSON.stringify(state)};
const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const [, , a, b, ...rest] = process.argv;
if (a === 'mcp' && b === 'get') process.exit(db[rest[0]] ? 0 : 1);
if (a === 'mcp' && b === 'add') {
  const i = rest.indexOf('--'); const name = rest[i - 1];
  db[name] = { scope: rest[rest.indexOf('--scope') + 1], cmd: rest.slice(i + 1) };
  fs.writeFileSync(f, JSON.stringify(db)); process.exit(0);
}
if (a === 'mcp' && b === 'remove') { delete db[rest[rest.length - 1]]; fs.writeFileSync(f, JSON.stringify(db)); process.exit(0); }
process.exit(2);`,
    );
    return {
      script,
      servers: async () => JSON.parse(await readFile(state, 'utf8').catch(() => '{}')),
    };
  }

  it('registers, re-registers and removes the MCP server, and says when it cannot', async () => {
    const fake = await fakeClaude();
    const cli = join(root, 'cli', 'bin.js');
    const s2 = await startService({
      engine,
      claudeBin: process.execPath,
      claudeBinArgs: [fake.script],
      cliPath: cli,
    });
    try {
      const c2 = new ServiceClient({ baseUrl: s2.url, token: s2.token });
      const before = await c2.claudeCode();
      expect(before).toMatchObject({ installed: true, connected: false, canConnect: true });
      expect(before.command).toContain('claude mcp add --scope user trailerforge --');
      expect(before.command).toContain(engine.home);

      expect(await c2.connectClaudeCode()).toMatchObject({ connected: true });
      expect((await fake.servers()).trailerforge).toMatchObject({
        scope: 'user',
        cmd: ['node', cli, 'mcp', '--home', engine.home],
      });
      expect(await c2.connectClaudeCode()).toMatchObject({ connected: true }); // reconnect
      expect(await c2.disconnectClaudeCode()).toMatchObject({ connected: false });
      expect(await fake.servers()).toEqual({});
    } finally {
      await s2.close();
    }

    const noConfig = join(root, 'no-such-claude.json');
    const noCli = await startService({
      engine,
      claudeBin: process.execPath,
      claudeBinArgs: [fake.script],
    });
    const missing = await startService({
      engine,
      claudeBin: join(root, 'no-such-claude'),
      claudeConfigPath: noConfig,
      cliPath: cli,
    });
    try {
      const a = new ServiceClient({ baseUrl: noCli.url, token: noCli.token });
      expect(await a.claudeCode()).toMatchObject({ canConnect: false, command: null });
      await expect(a.connectClaudeCode()).rejects.toMatchObject({ status: 400 });
      const b = new ServiceClient({ baseUrl: missing.url, token: missing.token });
      expect(await b.claudeCode()).toMatchObject({ installed: false, connected: false });
      await expect(b.connectClaudeCode()).rejects.toMatchObject({ status: 404 });
    } finally {
      await noCli.close();
      await missing.close();
    }
  });
});

describe('Claude Code connection without a claude command', () => {
  it('edits only its own entry in the settings file, keeps a backup, and refuses a broken file', async () => {
    const file = join(root, 'claude-settings.json');
    const original = {
      userID: 'u1',
      projects: { a: { x: 1 } },
      mcpServers: { other: { type: 'stdio', command: 'x' } },
    };
    await writeFile(file, JSON.stringify(original));
    const cli = join(root, 'cli', 'bin.js');
    const s2 = await startService({
      engine,
      claudeBin: join(root, 'no-such-claude'),
      claudeConfigPath: file,
      cliPath: cli,
    });
    try {
      const c = new ServiceClient({ baseUrl: s2.url, token: s2.token });
      expect(await c.claudeCode()).toMatchObject({ installed: true, connected: false });
      expect(await c.connectClaudeCode()).toMatchObject({ installed: true, connected: true });
      const after = JSON.parse(await readFile(file, 'utf8'));
      expect(after.userID).toBe('u1');
      expect(after.projects).toEqual(original.projects);
      expect(after.mcpServers.other).toEqual(original.mcpServers.other);
      expect(after.mcpServers.trailerforge).toEqual({
        type: 'stdio',
        command: 'node',
        args: [cli, 'mcp', '--home', engine.home],
        env: {},
      });
      expect(JSON.parse(await readFile(`${file}.tforge-backup`, 'utf8'))).toEqual(original);

      expect(await c.disconnectClaudeCode()).toMatchObject({ connected: false });
      const gone = JSON.parse(await readFile(file, 'utf8'));
      expect(gone.mcpServers).toEqual(original.mcpServers);

      await writeFile(file, '{ not json');
      await expect(c.connectClaudeCode()).rejects.toMatchObject({ status: 502 });
      expect(await readFile(file, 'utf8')).toBe('{ not json'); // untouched
    } finally {
      await s2.close();
    }
  });
});

describe('EventLog', () => {
  it('tells a client that fell too far behind to refetch', async () => {
    const log = new EventLog(3);
    for (let i = 0; i < 6; i++) log.emit('x', i);
    const written: string[] = [];
    const res = {
      writeHead() {},
      write: (s: string) => written.push(s),
      on() {},
    } as never;
    log.attach(res, 1);
    expect(written.join('')).toMatch(/event: reset/);
    written.length = 0;
    log.attach(res, 4);
    expect(written.join('').match(/event: x/g)).toHaveLength(2);
  });
});

describe('serving a built UI', () => {
  let ui: RunningService;
  let dir: string;
  beforeAll(async () => {
    dir = join(root, 'ui-dist');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><title>UI</title><div id="root"></div>',
    );
    await writeFile(join(dir, 'assets', 'app-AbCdEf12.js'), 'console.log(1)');
    await writeFile(join(root, 'secret.txt'), 'TOP SECRET');
    await symlink(join(root, 'secret.txt'), join(dir, 'leak.txt')).catch(() => undefined);
    ui = await startService({ engine, staticDir: dir });
  });
  afterAll(async () => {
    await ui.close();
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((done, fail) => {
      request({ host: '127.0.0.1', port: ui.port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
        .on('error', fail)
        .end();
    });

  it('serves the UI without a token, with a strict CSP, but the API still needs one', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<div id="root">/);
    expect(page.headers['content-security-policy']).toMatch(
      /default-src 'self'.*frame-ancestors 'none'/,
    );
    expect(page.headers['content-security-policy']).not.toMatch(
      /unsafe-eval|script-src[^;]*unsafe-inline/,
    );
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await get('/v1/info')).status).toBe(401);
    const asset = await get('/assets/app-AbCdEf12.js');
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toMatch(/immutable/);
  });

  it('falls back to index.html for client routes but 404s for missing files', async () => {
    expect((await get('/p/proj_1/storyboard')).body).toMatch(/<title>UI<\/title>/);
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('cannot be tricked into reading outside the UI folder', async () => {
    for (const p of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/../../secret.txt',
      '/%00',
      '/leak.txt',
      '/%',
    ]) {
      const r = await get(p);
      expect(r.body).not.toContain('TOP SECRET');
      expect([400, 404]).toContain(
        r.status === 200 && r.body.includes('<title>UI</title>') ? 404 : r.status,
      );
    }
  });

  it('still rejects foreign Hosts and POSTs to static paths', async () => {
    expect((await get('/', { host: 'evil.example' })).status).toBe(403);
    const post = await new Promise<number>((done) =>
      request({ host: '127.0.0.1', port: ui.port, path: '/', method: 'POST' }, (res) =>
        done(res.statusCode ?? 0),
      ).end(),
    );
    expect(post).toBe(405);
  });

  it('refuses a UI folder without index.html', async () => {
    await expect(startService({ engine, staticDir: join(root, 'home') })).rejects.toThrow();
  });
});

describe('brief routes', () => {
  let id: string;
  beforeAll(async () => {
    id = (
      await client.createProject({
        dir: join(root, 'Brief.tforge'),
        name: 'Brief',
        videoTypeId: 'game-trailer/release-trailer',
      })
    ).id;
  });

  it('returns the form, saves answers, and rejects bad ones with a reason', async () => {
    const form = await client.briefForm(id);
    expect(form.fields[0]).toMatchObject({ id: 'brief.title', state: 'missing', required: true });
    const edit = await client.answerBrief(id, 'brief.title', 'Ember Knight');
    expect(edit.version).toBe(1);
    expect((await client.briefForm(id)).fields[0]).toMatchObject({
      state: 'answered',
      value: 'Ember Knight',
    });
    await expect(client.answerBrief(id, 'brief.keySellingPoints', ['one'])).rejects.toMatchObject({
      status: 400,
      code: 'usage',
    });
    await expect(client.answerBrief(id, 'brief.nope', 'x')).rejects.toMatchObject({
      status: 404,
      code: 'not-found',
    });
    await expect(client.answerBrief(id, 'brief.title', 5)).rejects.toMatchObject({ status: 400 });
  });

  it('suggests without changing the project, and proceeds with assumptions', async () => {
    const before = (await client.getProject(id)).version;
    expect(await client.suggestBrief(id, 'brief.title')).toMatchObject({
      value: 'Ember Knight',
      provider: 'core/mock',
    });
    expect((await client.getProject(id)).version).toBe(before);
    const r = await client.assumeMissing(id);
    expect(r.added).toBeGreaterThan(3);
    expect(r.version).toBeGreaterThan(before);
    expect(await client.briefForm(id)).toMatchObject({ canProceed: true, complete: false });
    expect((await client.assumeMissing(id)).added).toBe(0);
  });

  it('refuses answers while a task is running on the project', async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const t = await client.startTask(id, { kind: 'generate', options: { assume: true } });
    await expect(client.answerBrief(id, 'brief.title', 'Other')).rejects.toMatchObject({
      status: 409,
      code: 'busy',
    });
    await expect(client.assumeMissing(id)).rejects.toMatchObject({ code: 'busy' });
    expect((await client.briefForm(id)).fields[0]).toMatchObject({ value: 'Ember Knight' }); // reads are fine
    gate = null;
    release();
    await client.waitForTask(t.id);
  });
});

describe('llm preview route', () => {
  it('discloses the provider and request contents without sending anything', async () => {
    const id = (
      await client.createProject({
        dir: join(root, 'Preview.tforge'),
        name: 'Preview',
        videoTypeId: 'game-trailer/release-trailer',
      })
    ).id;
    await client.command(id, 'core/knowledge.add-entity', {
      id: 'ent_x',
      kind: 'boss',
      name: 'Ash Warden',
    });
    const calls = mock.calls.length;
    const p = await client.llmPreview(id, 'storyboard.generate');
    expect(p).toMatchObject({
      available: true,
      provider: { id: 'core/mock', sendsDataOffDevice: false },
      willSend: { knowledge: [{ name: 'Ash Warden' }], knowledgeExcluded: 0 },
    });
    expect(mock.calls.length).toBe(calls);
    await expect(client.llmPreview(id, 'vo.script' as never)).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.llmPreview('proj_nope', 'storyboard.generate')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('settings routes', () => {
  let e2: Engine;
  let svc2: RunningService;
  let c2: ServiceClient;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    savedEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // The real provider set (no injected mock), so keys, routes and handoff behave as they do live.
    e2 = await Engine.start({
      home: join(root, 'home-settings'),
      autosaveMs: 0,
      loadUserPlugins: false,
    });
    svc2 = await startService({ engine: e2 });
    c2 = new ServiceClient({ baseUrl: svc2.url, token: svc2.token });
  });
  afterAll(async () => {
    await svc2.close();
    await e2.close();
    if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
  });

  it('stores an API key without ever sending it back, and the provider becomes available', async () => {
    const anthropic = async () => (await c2.llmProviders()).find((p) => p.id === 'core/anthropic')!;
    expect((await anthropic()).available).toMatchObject({ ok: false });
    expect(await c2.secrets()).toMatchObject({ anthropicApiKey: { set: false, source: null } });

    const view = await c2.setApiKey('sk-ant-super-secret-key');
    expect(view.anthropicApiKey).toEqual({ set: true, source: 'stored' });
    expect((await anthropic()).available).toEqual({ ok: true });

    // Nothing the service sends for settings contains the key.
    const everything = JSON.stringify([
      view,
      await c2.secrets(),
      await c2.llmProviders(),
      await c2.llmRoutes(),
    ]);
    expect(everything).not.toContain('super-secret');
    expect(await readFile(join(root, 'home-settings', 'secrets.json'), 'utf8')).toContain(
      'super-secret',
    );

    await expect(c2.setApiKey('two words')).rejects.toMatchObject({ status: 400, code: 'usage' });
    await expect(c2.setApiKey('')).rejects.toMatchObject({ status: 400 });
    expect((await c2.clearApiKey()).anthropicApiKey.set).toBe(false);
    expect((await anthropic()).available).toMatchObject({ ok: false });
  });

  it('edits and resets the routes, and announces the change on the event stream', async () => {
    const ac = new AbortController();
    const stream = c2.events({ after: (await c2.info()).lastSeq, signal: ac.signal });
    const seen = nextEvents(stream, 1, (e) => e.type === 'settings.changed');
    const before = await c2.llmRoutes();
    expect(before).toMatchObject({
      custom: false,
      config: { default: { provider: 'core/anthropic' } },
    });

    const saved = await c2.saveRoutes({ default: { provider: 'core/claude-code' }, fallbacks: [] });
    expect(saved).toMatchObject({
      custom: true,
      config: { default: { provider: 'core/claude-code' } },
    });
    expect((await seen)[0]!.data).toEqual({ what: 'routes' });
    ac.abort();

    await expect(c2.saveRoutes({ default: { provider: 'nope/x' } })).rejects.toMatchObject({
      status: 400,
      code: 'usage',
    });
    await expect(
      c2.saveRoutes({ default: { provider: 'core/anthropic', effort: 'extreme' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await c2.resetRoutes()).custom).toBe(false);
    expect((await c2.llmRoutes()).config.default?.provider).toBe('core/anthropic');
  });

  it('settings need the token like everything else', async () => {
    const anon = new ServiceClient({ baseUrl: svc2.url, token: 'x'.repeat(43) });
    for (const call of [
      () => anon.secrets(),
      () => anon.setApiKey('sk-x'),
      () => anon.saveRoutes({}),
      () => anon.handoffs(),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 401 });
    }
  });

  it('relays Chat Handoff to the UI: prompt out, reply in, and a fix-it follow-up when it does not validate', async () => {
    await c2.saveRoutes({ default: { provider: 'core/chat-handoff' }, fallbacks: [] });
    expect((await c2.llmProviders()).find((p) => p.id === 'core/chat-handoff')!.available).toEqual({
      ok: true,
    });

    const id = (
      await c2.createProject({
        dir: join(root, 'Handoff.tforge'),
        name: 'Handoff',
        videoTypeId: 'game-trailer/release-trailer',
      })
    ).id;
    const ac = new AbortController();
    const stream = c2.events({ after: (await c2.info()).lastSeq, signal: ac.signal });
    const requested = nextEvents(stream, 2, (e) => e.type === 'handoff.requested');

    // "Suggest for me" now waits for a person to paste a reply.
    const suggestion = c2.suggestBrief(id, 'brief.title');
    const waitFor = async (round: number) => {
      for (let i = 0; i < 200; i++) {
        const p = (await c2.handoffs()).find((h) => h.round === round);
        if (p) return p;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no handoff for round ${round}`);
    };
    const first = await waitFor(0);
    expect(first.prompt).toContain('Game name');
    await c2.replyHandoff(first.id, '{"value": 42, "reason": "wrong type"}');
    const second = await waitFor(1);
    expect(second.prompt).toMatch(/did not validate/);
    await c2.replyHandoff(
      second.id,
      '```json\n{"value": "Ember Knight", "reason": "pasted from my chat"}\n```',
    );

    expect(await suggestion).toMatchObject({
      value: 'Ember Knight',
      reason: 'pasted from my chat',
      provider: 'core/chat-handoff',
    });
    const events = await requested;
    expect(events.map((e) => (e.data as { round: number }).round)).toEqual([0, 1]);
    expect(await c2.handoffs()).toEqual([]);
    ac.abort();

    await expect(c2.replyHandoff(first.id, 'late')).rejects.toMatchObject({ status: 404 });
  });

  it('cancelling a handoff fails the waiting request cleanly', async () => {
    const id = (await c2.listProjects()).find((p) => p.name === 'Handoff')!.id;
    const waiting = c2.suggestBrief(id, 'brief.title');
    let pending;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = (await c2.handoffs())[0];
      if (!pending) await new Promise((r) => setTimeout(r, 10));
    }
    await c2.cancelHandoff(pending!.id);
    await expect(waiting).rejects.toMatchObject({ status: 409, code: 'cancelled' });
  });

  it('shutting the service down withdraws Chat Handoff and releases anything waiting', async () => {
    const e3 = await Engine.start({
      home: join(root, 'home-shutdown'),
      autosaveMs: 0,
      loadUserPlugins: false,
    });
    const s3 = await startService({ engine: e3 });
    expect(e3.handoff.available).toBe(true);
    const waiting = e3.handoff.request(
      { task: 't', prompt: 'p', round: 0 },
      new AbortController().signal,
    );
    const settled = waiting.then(
      () => 'answered',
      () => 'cancelled',
    );
    await s3.close();
    expect(e3.handoff.available).toBe(false);
    expect(await settled).toBe('cancelled');
    await e3.close();
  });
});

describe('capture', () => {
  const ID = 'proj_capture';
  let dir: string;
  beforeAll(async () => {
    dir = join(root, 'Capture.tforge');
    await engine.createProject(dir, { ...sampleProject(), id: ID } as never);
  });

  it('needs the token like everything else', async () => {
    for (const path of ['', '/status']) {
      expect((await raw({ path: `/v1/projects/${ID}/capture${path}` })).status).toBe(401);
    }
    expect(
      (await raw({ path: `/v1/projects/${ID}/capture/export`, method: 'POST', body: '{}' })).status,
    ).toBe(401);
  });

  it('serves the checklist and progress, and edits go through commands', async () => {
    const view = await client.capture(ID);
    expect(view.plan).toMatchObject({ total: 2, done: 0 });
    expect(view.plan.groups).toHaveLength(2);
    expect(view.hints).toHaveLength(2);
    expect(view.recording.settings.resolution.width).toBeGreaterThan(0);

    await client.command(ID, 'game-trailer/capture.set-status', {
      slotId: 'shot_parry',
      status: 'recorded',
    });
    await client.command(ID, 'game-trailer/recording.set-overrides', { fps: 30 });
    expect(await client.captureStatus(ID)).toMatchObject({
      total: 2,
      done: 1,
      byStatus: { recorded: 1, empty: 1 },
    });
    expect((await client.capture(ID, 'todo')).plan.total).toBe(1);
    expect((await client.capture(ID)).recording.settings.fps).toBe(30);
    await expect(client.capture('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('shows what tips will send, then runs them as a task and saves the result', async () => {
    const preview = await client.llmPreview(ID, 'capture.tips');
    expect(preview).toMatchObject({
      available: true,
      willSend: { brief: [], capture: { shots: 1 } },
    });

    const t = await client.startTask(ID, { kind: 'capture-tips' });
    const done = await client.waitForTask(t.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { written: [{ tips: 1, risks: 1 }] },
    });
    const onDisk = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as {
      extensions: { 'game-trailer': { captureTips: Record<string, unknown> } };
    };
    expect(Object.keys(onDisk.extensions['game-trailer'].captureTips)).toHaveLength(1);
    expect((await client.captureStatus(ID)).tips.fresh).toBe(1);

    const again = await client.waitForTask(
      (await client.startTask(ID, { kind: 'capture-tips' })).id,
    );
    expect(again).toMatchObject({ status: 'succeeded', result: { written: [] } });
  });

  it('cancelling tips means nothing is stored', async () => {
    await client.command(ID, 'game-trailer/capture.clear-tips', {});
    let release!: () => void;
    tipsGate = new Promise((r) => (release = r));
    const before = await client.getProject(ID);
    const t = await client.startTask(ID, { kind: 'capture-tips', options: { force: true } });
    await client.cancelTask(t.id);
    tipsGate = null;
    release();
    expect((await client.waitForTask(t.id)).status).toBe('cancelled');
    const after = await client.getProject(ID);
    expect(after.version).toBe(before.version);
    expect((await client.captureStatus(ID)).tips.fresh).toBe(0);
  });

  it('renders the pack for download and validates the request', async () => {
    const r = await client.renderCapture(ID, { format: 'html' });
    expect(r).toMatchObject({ filename: 'capture-pack.html', mime: 'text/html; charset=utf-8' });
    expect(r.content.startsWith('<!doctype html>')).toBe(true);
    expect(r.content).not.toContain(dir);
    await expect(client.renderCapture(ID, { format: 'pdf' as never })).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (await raw({ path: `/v1/projects/${ID}/capture/render`, method: 'POST', body: '{}' })).status,
    ).toBe(401);
  });

  it('exports the pack under the project folder, and validates the request', async () => {
    const r = await client.exportCapture(ID, { formats: ['md', 'json'] });
    expect(r).toMatchObject({
      files: ['exports/capture/capture-pack.json', 'exports/capture/capture-pack.md'],
      shots: 2,
      done: 1,
    });
    const md = await readFile(join(dir, 'exports', 'capture', 'capture-pack.md'), 'utf8');
    expect(md).toContain('capture pack');
    expect(md).not.toContain(dir);
    await expect(client.exportCapture(ID, { formats: ['pdf' as never] })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('footage', () => {
  const ID = 'proj_footage';
  const sh = (args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  let dir: string;
  let recDir: string;
  beforeAll(async () => {
    dir = join(root, 'Footage.tforge');
    await engine.createProject(dir, { ...sampleProject(), id: ID } as never);
    recDir = join(root, 'footage-rec');
    mkdirSync(recDir);
    sh([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(recDir, 'one.mp4'),
    ]);
  });

  it('needs the token like everything else', async () => {
    for (const path of ['/footage', '/footage/matches']) {
      expect((await raw({ path: `/v1/projects/${ID}${path}` })).status).toBe(401);
    }
    for (const path of ['/footage/import', '/footage/analyze', '/footage/matches/accept', '/cut']) {
      expect(
        (await raw({ path: `/v1/projects/${ID}${path}`, method: 'POST', body: '{}' })).status,
      ).toBe(401);
    }
  });

  it('imports, reports progress, suggests matches, and says what the cut still needs', async () => {
    const r = await client.importFootage(ID, [recDir]);
    expect(r.jobs).toHaveLength(1);
    for (
      let i = 0;
      i < 400 && engine.jobs.list().some((j) => ['queued', 'running'].includes(j.status));
      i++
    ) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const f = await client.footage(ID);
    expect(f.footage).toHaveLength(1);
    expect(f.footage[0]).toMatchObject({ name: 'one.mp4', file: 'ok', slotIds: [] });
    const m = await client.footageMatches(ID);
    expect(m.matches).toHaveLength(1);
    expect(m.matches[0]!.kind).toBe('suggested');
    const acc = await client.acceptMatches(ID);
    expect(acc.attached.map((a) => a.assetId)).toEqual([m.matches[0]!.assetId]);
    expect(acc.attached[0]!.matchedBy).toBe('suggestion');
    // the player's media: the editing copy, never an arbitrary file
    const proxy = await client.media(f.footage[0]!.assetId, 'proxy');
    expect(proxy.type).toBe('video/mp4');
    expect(proxy.size).toBeGreaterThan(1000);
    await expect(client.media(f.footage[0]!.assetId, 'audio')).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.media('asset_nope', 'proxy')).rejects.toMatchObject({ status: 404 });
    for (const evil of ['../../etc/passwd', '..\\..\\secrets.json', '%2e%2e%2fsecrets.json']) {
      await expect(client.media(evil, 'audio')).rejects.toMatchObject({ status: 404 }); // ids are looked up, never used as paths
    }
    expect((await raw({ path: `/v1/library/assets/${f.footage[0]!.assetId}/proxy` })).status).toBe(
      401,
    );
    expect(await client.cutGrid(ID)).toBeNull(); // the music is not analysed yet
    await expect(client.generateCut(ID)).rejects.toMatchObject({ status: 404 }); // the music is not in the library
    await expect(client.importFootage(ID, [])).rejects.toMatchObject({ status: 400 });
  }, 60_000);
});
