import { request } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
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
const mock = createMockProvider({
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
