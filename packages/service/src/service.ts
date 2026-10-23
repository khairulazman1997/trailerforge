import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  CommandError,
  ProjectLockedError,
  ProjectOpenError,
  readDecisions,
  type ProjectStore,
} from '@trailerforge/core';
import {
  briefStatus,
  generateStoryboardOp,
  OpError,
  regenerateSectionOp,
  scanKnowledgeOp,
  type Engine,
} from '@trailerforge/engine';
import { SectionLockedError } from '@trailerforge/storyboard';
import { z } from 'zod';
import { EventLog } from './events.js';
import {
  bearer,
  hostAllowed,
  LOOPBACK_HOSTS,
  newToken,
  originAllowed,
  tokenMatches,
} from './security.js';
import { TaskManager } from './tasks.js';

export const API_VERSION = 'v1';

export interface ServiceOptions {
  engine: Engine;
  /** Loopback only; anything else is refused. Default 127.0.0.1. */
  host?: string;
  /** Default 0: pick a free port. */
  port?: number;
  /** Default: a fresh random token per launch. */
  token?: string;
  /**
   * Browser origins allowed besides the service's own (e.g. the Vite dev server
   * `http://localhost:5173`, or Electron's `app://trailerforge`).
   */
  allowedOrigins?: readonly string[];
  /** Request body cap. Default 5 MiB. */
  maxBodyBytes?: number;
}

export interface RunningService {
  url: string;
  port: number;
  token: string;
  events: EventLog;
  close(): Promise<void>;
}

/** A failure with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function describeError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof OpError) {
    const status = { usage: 400, 'not-found': 404, 'no-video-type': 422, 'brief-incomplete': 422 }[
      err.code
    ];
    return new HttpError(status, err.code, err.message, err.details);
  }
  if (err instanceof SectionLockedError) return new HttpError(409, 'locked', err.message);
  if (err instanceof ProjectLockedError) {
    return new HttpError(423, 'project-locked', err.message, err.holder);
  }
  if (err instanceof ProjectOpenError)
    return new HttpError(422, 'invalid-project', err.message, err.issues);
  if (err instanceof CommandError) {
    return /unknown command/.test(err.message)
      ? new HttpError(400, 'unknown-command', err.message)
      : new HttpError(422, 'invalid', err.message, err.issues.length ? err.issues : undefined);
  }
  if (err instanceof z.ZodError) {
    return new HttpError(
      400,
      'bad-request',
      'invalid request body',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST') return new HttpError(409, 'exists', (err as Error).message);
  if (code === 'ENOENT') return new HttpError(404, 'not-found', (err as Error).message);
  // Errors thrown by a command's own checks ("no slot ...", "already used", ...).
  if (err instanceof Error && err.name === 'Error')
    return new HttpError(422, 'rejected', err.message);
  return new HttpError(500, 'internal', err instanceof Error ? err.message : String(err));
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new HttpError(
      415,
      'unsupported-media-type',
      'send JSON with Content-Type: application/json',
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too-large', `request body is over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON');
  }
}

type Handler = (ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<unknown>;
  req: IncomingMessage;
  res: ServerResponse;
}) => Promise<unknown>;

const TaskRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('generate'),
    options: z
      .strictObject({
        duration: z.number().positive().optional(),
        template: z.string().optional(),
        assume: z.boolean().optional(),
      })
      .default({}),
  }),
  z.strictObject({
    kind: z.literal('regenerate-section'),
    options: z.strictObject({
      sectionId: z.string().min(1),
      instruction: z.string().optional(),
      keepEdited: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal('scan'),
    options: z
      .strictObject({
        repo: z.string().optional(),
        force: z.boolean().optional(),
        deep: z.boolean().optional(),
        allowDeep: z.boolean().optional(),
      })
      .default({}),
  }),
]);

/**
 * The engine as a local HTTP service for the UI (browser "web mode" and Electron). Security:
 * loopback bind only, a per-launch bearer token on every request (events included), Host
 * checked against DNS rebinding, browser Origins allow-listed, JSON-only bodies with a size cap.
 */
export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const { engine } = opts;
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`refusing to listen on "${host}": the engine service is loopback-only`);
  }
  const token = opts.token ?? newToken();
  if (token.length < 32) throw new Error('token must be at least 32 characters');
  const maxBody = opts.maxBodyBytes ?? 5 * 1024 * 1024;
  const events = new EventLog();
  const tasks = new TaskManager(events, (err) => {
    const e = describeError(err);
    return {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined ? { details: e.details } : {}),
    };
  });

  // Per-project version: bumps on every change, so clients can apply patches in order.
  const versions = new Map<string, number>();
  const offs = [
    engine.bus.on('core/project.changed', ({ projectId, change }) => {
      const version = (versions.get(projectId) ?? 0) + 1;
      versions.set(projectId, version);
      events.emit('project.changed', { projectId, version, ...change });
    }),
    engine.bus.on('core/project.opened', (p) => events.emit('project.opened', p)),
    engine.bus.on('core/project.closed', (p) => {
      versions.delete(p.projectId);
      events.emit('project.closed', p);
    }),
    engine.bus.on('core/project.saved', (p) => events.emit('project.saved', p)),
    engine.bus.on('core/job.updated', (p) => events.emit('job.updated', p)),
  ];

  const stores = () => [...engine.projects.values()];
  const storeById = (id: string): ProjectStore => {
    const store = stores().find((s) => s.state.id === id);
    if (!store) throw new HttpError(404, 'not-open', `project "${id}" is not open`);
    return store;
  };
  const projectView = (store: ProjectStore) => {
    const busy = tasks.busy(store.state.id);
    return {
      id: store.state.id,
      dir: store.paths.dir,
      version: versions.get(store.state.id) ?? 0,
      canUndo: store.canUndo,
      canRedo: store.canRedo,
      busy: busy ?? null,
      project: store.state,
    };
  };
  const notBusy = (store: ProjectStore) => {
    const t = tasks.busy(store.state.id);
    if (t) throw new HttpError(409, 'busy', `"${t.kind}" is running on this project`, t);
  };
  const editResult = (store: ProjectStore) => ({
    version: versions.get(store.state.id) ?? 0,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
  });
  const opened = (store: ProjectStore) => {
    const clash = stores().find((s) => s !== store && s.state.id === store.state.id);
    if (clash) {
      void engine.closeProject(store.paths.dir);
      throw new HttpError(
        409,
        'duplicate-id',
        `a different folder with project id "${store.state.id}" is already open: ${clash.paths.dir}`,
      );
    }
    if (!versions.has(store.state.id)) versions.set(store.state.id, 0);
    return projectView(store);
  };

  const Dir = z.strictObject({ dir: z.string().min(1) });
  const routes: [string, RegExp, Handler][] = [
    [
      'GET',
      /^\/v1\/info$/,
      async () => ({
        apiVersion: API_VERSION,
        lastSeq: events.lastSeq,
        plugins: engine.pluginStatus,
        videoTypes: engine.plugins.registries.videoTypes.list().map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          typicalDuration: v.typicalDuration,
          defaultTemplateId: v.defaultTemplateId,
        })),
        templates: engine.plugins.registries.templates.list().map((t) => ({
          id: t.id,
          videoTypeId: t.videoTypeId,
          name: t.name,
          description: t.description,
        })),
        commands: engine.commands.types(),
      }),
    ],
    [
      'GET',
      /^\/v1\/events$/,
      async ({ query, req, res }) => {
        const raw = query.get('after') ?? (req.headers['last-event-id'] as string | undefined);
        const after = raw === undefined || raw === null ? undefined : Number(raw);
        if (after !== undefined && !Number.isInteger(after))
          throw new HttpError(400, 'bad-request', '"after" must be an integer');
        events.attach(res, after);
        return STREAMING;
      },
    ],
    [
      'GET',
      /^\/v1\/projects$/,
      async () => stores().map((s) => ({ id: s.state.id, name: s.state.name, dir: s.paths.dir })),
    ],
    [
      'POST',
      /^\/v1\/projects\/open$/,
      async ({ body }) => {
        const { dir } = Dir.parse(await body());
        return opened(await engine.openProject(resolve(dir)));
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/create$/,
      async ({ body }) => {
        const p = z
          .strictObject({
            dir: z.string().min(1),
            name: z.string().min(1),
            videoTypeId: z.string().optional(),
          })
          .parse(await body());
        const store = await engine.createProject(resolve(p.dir), {
          name: p.name,
          ...(p.videoTypeId ? { brief: { videoTypeId: p.videoTypeId } } : {}),
        });
        return opened(store);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/close$/,
      async ({ params }) => {
        const store = storeById(params.id!);
        notBusy(store);
        await engine.closeProject(store.paths.dir);
        return { closed: true };
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)$/,
      async ({ params }) => projectView(storeById(params.id!)),
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/brief-status$/,
      async ({ params }) => briefStatus(engine, storeById(params.id!)),
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/decisions$/,
      async ({ params, query }) => {
        const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), 500);
        return (await readDecisions(storeById(params.id!).paths.decisions)).slice(-limit);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/commands$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const { type, payload } = z
          .strictObject({ type: z.string().min(1), payload: z.unknown() })
          .parse(await body());
        notBusy(store);
        store.dispatch(type, payload);
        return editResult(store);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/(?<op>undo|redo)$/,
      async ({ params }) => {
        const store = storeById(params.id!);
        notBusy(store);
        const done = params.op === 'undo' ? store.undo() : store.redo();
        return { done, ...editResult(store) };
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/tasks$/,
      async ({ params, body, res }) => {
        const store = storeById(params.id!);
        const t = TaskRequest.parse(await body());
        notBusy(store);
        const run = async (signal: AbortSignal) => {
          let out: unknown;
          if (t.kind === 'generate')
            out = await generateStoryboardOp(engine, store, { ...t.options, signal });
          else if (t.kind === 'regenerate-section')
            out = await regenerateSectionOp(engine, store, { ...t.options, signal });
          else {
            out = await scanKnowledgeOp(engine, store, {
              ...t.options,
              signal,
              onNotice: (message) =>
                events.emit('task.notice', { projectId: store.state.id, message }),
            });
          }
          await store.save();
          return out;
        };
        res.statusCode = 202;
        return tasks.start(t.kind, store.state.id, run);
      },
    ],
    [
      'GET',
      /^\/v1\/tasks\/(?<id>[^/]+)$/,
      async ({ params }) => {
        const t = tasks.get(params.id!);
        if (!t) throw new HttpError(404, 'not-found', `no task "${params.id}"`);
        return t;
      },
    ],
    [
      'DELETE',
      /^\/v1\/tasks\/(?<id>[^/]+)$/,
      async ({ params }) => {
        const t = tasks.cancel(params.id!);
        if (!t) throw new HttpError(404, 'not-found', `no task "${params.id}"`);
        return t;
      },
    ],
    [
      'GET',
      /^\/v1\/jobs$/,
      async ({ query }) => {
        const status = query.get('status');
        return engine.jobs.list(status ? { status: status as 'queued' } : {});
      },
    ],
    [
      'POST',
      /^\/v1\/jobs\/(?<id>[^/]+)\/cancel$/,
      async ({ params }) => ({
        cancelled: await engine.jobs.cancel(params.id!),
      }),
    ],
  ];

  let port = 0;
  const allowedOrigins = new Set<string>(opts.allowedOrigins ?? []);
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (!hostAllowed(req, port)) throw new HttpError(403, 'bad-host', 'unexpected Host header');
      const origin = req.headers.origin;
      if (!originAllowed(origin, allowedOrigins))
        throw new HttpError(403, 'bad-origin', `origin ${origin} is not allowed`);
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...SECURITY_HEADERS,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type, last-event-id',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (!tokenMatches(bearer(req), token))
        throw new HttpError(401, 'unauthorized', 'missing or wrong token');

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        if (req.method !== method) continue;
        const out = await handler({
          params: { ...(m.groups ?? {}) },
          query: url.searchParams,
          body: () => readJson(req, maxBody),
          req,
          res,
        });
        if (out !== STREAMING) send(res, res.statusCode === 202 ? 202 : 200, out);
        return;
      }
      const knownPath = routes.some(([, p]) => p.test(url.pathname));
      throw knownPath
        ? new HttpError(405, 'method-not-allowed', `${req.method} is not supported here`)
        : new HttpError(404, 'not-found', `no route ${url.pathname}`);
    } catch (err) {
      const e = describeError(err);
      send(res, e.status, {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      });
    }
  }

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, host, () => done());
  });
  port = (server.address() as AddressInfo).port;
  for (const h of ['127.0.0.1', 'localhost']) allowedOrigins.add(`http://${h}:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    events,
    async close() {
      await tasks.drain();
      for (const off of offs) off();
      events.closeAll();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const STREAMING = Symbol('streaming');
