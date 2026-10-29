import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
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
  answerBriefOp,
  assumeMissingOp,
  briefForm,
  briefStatus,
  analyzeOp,
  brandImportOp,
  brandViewOp,
  createDefaultVariantsOp,
  effectsViewOp,
  setSfxFolderOp,
  sfxViewOp,
  templatePreviewOp,
  templatesViewOp,
  variantsViewOp,
  captureExportOp,
  captureRenderOp,
  captureStatusOp,
  captureTipsOp,
  captureViewOp,
  cutGridOp,
  libraryMediaOp,
  claudeCodeConnectOp,
  claudeCodeDisconnectOp,
  claudeCodeStatusOp,
  type ClaudeCodeSetup,
  visionDownloadOp,
  visionStatusOp,
  type LibraryMediaKind,
  footageStatusOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
  matchSuggestOp,
  rankTakesOp,
  approveVersionOp,
  draftFileOp,
  exportVersionOp,
  handoffOp,
  presetsViewOp,
  critiqueFactsOp,
  critiqueOp,
  qualityOp,
  renderDraftOp,
  reviewViewOp,
  clearAnthropicKey,
  generateStoryboardOp,
  HandoffCancelled,
  llmPreviewOp,
  OpError,
  localModelsView,
  providerStatus,
  regenerateSectionOp,
  resetRoutes,
  routesView,
  saveRoutes,
  useOfflineRoutes,
  scanKnowledgeOp,
  secretsView,
  setAnthropicKey,
  suggestBriefAnswerOp,
  type Engine,
} from '@trailerforge/engine';
import { serveMcpHttp } from '@trailerforge/mcp';
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
/** The app's usual port, so the address Claude Code was given survives a restart. */
export const DEFAULT_APP_PORT = 47821;

export interface ServiceOptions {
  engine: Engine;
  /** Loopback only; anything else is refused. Default 127.0.0.1. */
  host?: string;
  /** Default 0: pick a free port. */
  port?: number;
  /**
   * Try this port first and fall back to a free one if it is taken. The app uses a fixed one so
   * the address Claude Code was given keeps working across launches.
   */
  preferredPort?: number;
  /** Token Claude Code uses on `/mcp`. Default: kept in `<home>/mcp-token`, made on first use. */
  mcpToken?: string;
  /** Default: a fresh random token per launch. */
  token?: string;
  /**
   * Browser origins allowed besides the service's own (e.g. the Vite dev server
   * `http://localhost:5173`, or Electron's `app://trailerforge`).
   */
  allowedOrigins?: readonly string[];
  /** Request body cap. Default 5 MiB. */
  maxBodyBytes?: number;
  /** Path of the `claude` CLI used by the opt-in deep scan; default `claude` on PATH. */
  claudeBin?: string;
  /**
   * `apps/cli/dist/bin.js`, so Claude Code can also be set up to start its own copy of the engine
   * (works with the app closed). Null/absent: only the connection to the running app is offered.
   */
  cliPath?: string | null;
  /** Claude Code's user settings file; default `~/.claude.json` (tests use a temporary one). */
  claudeConfigPath?: string;
  /**
   * Folder of a built UI (index.html + assets) to serve at `/`, same origin as the API. The
   * files are public (no token); only `/v1/*` needs one. Served with a strict CSP.
   */
  staticDir?: string;
}

export interface RunningService {
  /** Claude Code's address for this app's tools (MCP over HTTP) and the token it must send. */
  mcp: { url: string; token: string };
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

/** `master` in a URL is the master cut; anything else is a version id. */
const versionParam = (v: string): string | null => (v === 'master' ? null : decodeURIComponent(v));

export function describeError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof OpError) {
    const status = {
      usage: 400,
      'not-found': 404,
      'no-video-type': 422,
      'brief-incomplete': 422,
      'takes-attached': 409,
      'gate-blocked': 422,
      failed: 502,
    }[err.code];
    return new HttpError(status, err.code, err.message, err.details);
  }
  if (err instanceof SectionLockedError) return new HttpError(409, 'locked', err.message);
  if (err instanceof HandoffCancelled) return new HttpError(409, 'cancelled', err.message);
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

/** The version to render: a version id, or null for the master cut. */
const VersionOptions = z.strictObject({ variantId: z.string().min(1).nullable() });

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
    kind: z.literal('rank-takes'),
    options: z.strictObject({ overwriteChosen: z.boolean().optional() }).default({}),
  }),
  z.strictObject({ kind: z.literal('critique'), options: VersionOptions }),
  z.strictObject({ kind: z.literal('render-draft'), options: VersionOptions }),
  z.strictObject({
    kind: z.literal('export'),
    options: VersionOptions.extend({
      overrides: z
        .array(z.strictObject({ checkId: z.string().min(1), reason: z.string() }))
        .optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal('handoff'),
    options: VersionOptions.extend({
      formats: z.array(z.enum(['fcpxml', 'otio', 'edl'])).optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal('capture-tips'),
    options: z
      .strictObject({
        groupKeys: z.array(z.string().min(1)).optional(),
        force: z.boolean().optional(),
        overwriteEdited: z.boolean().optional(),
      })
      .default({}),
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
  const mcpToken = opts.mcpToken ?? (await loadOrCreateToken(join(engine.home, 'mcp-token')));
  if (mcpToken.length < 32) throw new Error('MCP token must be at least 32 characters');
  // With one project open in the window, Claude Code's requests need not name it.
  const openProject = () =>
    engine.projects.size === 1 ? [...engine.projects.keys()][0] : undefined;
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
      const store = stores().find((s) => s.state.id === projectId);
      events.emit('project.changed', {
        projectId,
        version,
        canUndo: store?.canUndo ?? false,
        canRedo: store?.canRedo ?? false,
        ...change,
      });
    }),
    engine.bus.on('core/project.opened', (p) => events.emit('project.opened', p)),
    engine.bus.on('core/project.closed', (p) => {
      versions.delete(p.projectId);
      events.emit('project.closed', p);
    }),
    engine.bus.on('core/project.saved', (p) => events.emit('project.saved', p)),
    engine.bus.on('core/job.updated', (p) => events.emit('job.updated', p)),
  ];

  // Chat Handoff: while this service runs there is somewhere to show a prompt, so the provider is
  // offered; requests and answers are relayed to every connected UI as events.
  engine.handoff.available = true;
  engine.llm.invalidate();
  offs.push(
    engine.handoff.onChange((c) =>
      c.type === 'requested'
        ? events.emit('handoff.requested', c.handoff)
        : events.emit('handoff.resolved', { id: c.id, outcome: c.outcome }),
    ),
  );
  const settingsChanged = (what: 'secrets' | 'routes' | 'watched-folders') =>
    events.emit('settings.changed', { what });

  let visionTaskId: string | undefined;
  // Read at each request: the port is only known once the server listens.
  const claudeSetup = (): ClaudeCodeSetup => ({
    app: { url: `http://127.0.0.1:${port}/mcp`, token: mcpToken },
    cliPath: opts.cliPath ?? null,
    ...(opts.claudeConfigPath ? { configPath: opts.claudeConfigPath } : {}),
  });

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
    ['GET', /^\/v1\/llm\/providers$/, async () => providerStatus(engine)],
    ['GET', /^\/v1\/llm\/routes$/, async () => routesView(engine)],
    ['GET', /^\/v1\/llm\/local-models$/, async () => localModelsView(engine)],
    [
      'POST',
      /^\/v1\/llm\/routes\/offline$/,
      async ({ body }) => {
        const view = await useOfflineRoutes(engine, ((await body()) as { model?: unknown })?.model);
        settingsChanged('routes');
        return view;
      },
    ],
    [
      'PUT',
      /^\/v1\/llm\/routes$/,
      async ({ body }) => {
        const view = await saveRoutes(engine, await body());
        settingsChanged('routes');
        return view;
      },
    ],
    [
      'DELETE',
      /^\/v1\/llm\/routes$/,
      async () => {
        const view = await resetRoutes(engine);
        settingsChanged('routes');
        return view;
      },
    ],
    ['GET', /^\/v1\/secrets$/, async () => secretsView(engine)],
    [
      'PUT',
      /^\/v1\/secrets\/anthropic-api-key$/,
      async ({ body }) => {
        const { value } = z.strictObject({ value: z.unknown() }).parse(await body());
        // The value is stored and never returned, logged or echoed in an error.
        const view = await setAnthropicKey(engine, value);
        settingsChanged('secrets');
        return view;
      },
    ],
    [
      'DELETE',
      /^\/v1\/secrets\/anthropic-api-key$/,
      async () => {
        const view = await clearAnthropicKey(engine);
        settingsChanged('secrets');
        return view;
      },
    ],
    ['GET', /^\/v1\/settings\/watched-folders$/, async () => engine.watched.view()],
    [
      'PUT',
      /^\/v1\/settings\/watched-folders$/,
      async ({ body }) => {
        const { folders } = z
          .strictObject({ folders: z.array(z.string().min(1)).max(20) })
          .parse(await body());
        const view = await engine.watched.set(folders);
        settingsChanged('watched-folders');
        return view;
      },
    ],
    ['GET', /^\/v1\/claude-code$/, async () => claudeCodeStatusOp(engine, claudeSetup())],
    [
      'POST',
      /^\/v1\/claude-code\/connect$/,
      async ({ body }) => {
        const { mode } = z
          .strictObject({ mode: z.enum(['app', 'standalone']).default('app') })
          .default({ mode: 'app' })
          .parse(await body());
        return claudeCodeConnectOp(engine, claudeSetup(), mode);
      },
    ],
    ['DELETE', /^\/v1\/claude-code$/, async () => claudeCodeDisconnectOp(engine, claudeSetup())],
    ['GET', /^\/v1\/vision$/, async () => visionStatusOp(engine)],
    [
      'POST',
      /^\/v1\/vision\/download$/,
      async ({ body, res }) => {
        // Only an explicit `true` counts; the dialog shows the disclosure from GET /v1/vision first.
        const { consent } = z.strictObject({ consent: z.literal(true) }).parse(await body());
        const running = visionTaskId ? tasks.get(visionTaskId) : undefined;
        res.statusCode = 202;
        if (running?.status === 'running') return running;
        let last = 0;
        const task = tasks.start('vision-download', APP_TASK, (signal) =>
          visionDownloadOp(engine, {
            consent,
            signal,
            onProgress: (fraction) => {
              if (fraction < 1 && fraction - last < 0.01) return;
              last = fraction;
              events.emit('vision.progress', { taskId: task.id, fraction });
            },
          }),
        );
        visionTaskId = task.id;
        return task;
      },
    ],
    ['GET', /^\/v1\/handoffs$/, async () => engine.handoff.pending()],
    [
      'POST',
      /^\/v1\/handoffs\/(?<id>[^/]+)\/reply$/,
      async ({ params, body }) => {
        const { text } = z.strictObject({ text: z.string().min(1) }).parse(await body());
        if (!engine.handoff.reply(params.id!, text)) {
          throw new HttpError(404, 'not-found', 'that request was already answered or cancelled');
        }
        return { accepted: true };
      },
    ],
    [
      'POST',
      /^\/v1\/handoffs\/(?<id>[^/]+)\/cancel$/,
      async ({ params }) => {
        if (!engine.handoff.cancel(params.id!)) {
          throw new HttpError(404, 'not-found', 'that request was already answered or cancelled');
        }
        return { cancelled: true };
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/llm-preview$/,
      async ({ params, query }) => {
        const task = z
          .enum([
            'storyboard.generate',
            'storyboard.regenerate-section',
            'brief.suggest',
            'capture.tips',
          ])
          .safeParse(query.get('task'));
        if (!task.success)
          throw new HttpError(
            400,
            'bad-request',
            'task must be storyboard.generate, storyboard.regenerate-section, brief.suggest or capture.tips',
          );
        return llmPreviewOp(engine, storeById(params.id!), task.data);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/capture$/,
      async ({ params, query }) => {
        const include = z
          .enum(['all', 'todo'])
          .default('all')
          .safeParse(query.get('include') ?? undefined);
        if (!include.success)
          throw new HttpError(400, 'bad-request', 'include must be all or todo');
        return captureViewOp(engine, storeById(params.id!), { include: include.data });
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/capture\/status$/,
      async ({ params }) => captureStatusOp(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/capture\/export$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const o = z
          .strictObject({
            formats: z
              .array(z.enum(['md', 'html', 'json']))
              .min(1)
              .optional(),
            omitExcluded: z.boolean().optional(),
          })
          .parse(await body());
        notBusy(store);
        return captureExportOp(engine, store, o);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/footage$/,
      async ({ params }) => footageStatusOp(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/footage\/import$/,
      async ({ params, body }) => {
        const o = z
          .strictObject({ paths: z.array(z.string().min(1)).min(1).max(1000) })
          .parse(await body());
        return importFootageOp(engine, storeById(params.id!), o);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/footage\/analyze$/,
      async ({ params, body }) => {
        const o = z
          .strictObject({ assetIds: z.array(z.string()).optional(), music: z.boolean().optional() })
          .default({})
          .parse(await body());
        return analyzeOp(engine, storeById(params.id!), o);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/footage\/matches$/,
      async ({ params }) => matchSuggestOp(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/footage\/matches\/accept$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const o = z
          .strictObject({
            minConfidence: z.enum(['certain', 'high', 'medium']).optional(),
            assetIds: z.array(z.string()).optional(),
          })
          .default({})
          .parse(await body());
        notBusy(store);
        return matchAcceptOp(engine, store, o);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/cut\/grid$/,
      async ({ params }) => cutGridOp(engine, storeById(params.id!)),
    ],
    [
      'GET',
      /^\/v1\/library\/assets\/(?<asset>[^/]+)\/(?<what>proxy|audio|thumbnail|filmstrip)$/,
      async ({ params, res }) => {
        const f = await libraryMediaOp(
          engine,
          decodeURIComponent(params.asset!),
          params.what as LibraryMediaKind,
        );
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': f.type,
          'Content-Length': f.size,
          'Cache-Control': 'private, max-age=600',
        });
        await pipeline(createReadStream(f.path), res);
        return STREAMING;
      },
    ],
    ['GET', /^\/v1\/export\/presets$/, async () => presetsViewOp(engine)],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/review$/,
      async ({ params }) => reviewViewOp(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/review\/approve$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const o = z
          .strictObject({
            variantId: z.string().min(1).nullable(),
            note: z.string().max(500).optional(),
          })
          .parse(await body());
        notBusy(store);
        return approveVersionOp(engine, store, {
          variantId: o.variantId,
          ...(o.note ? { note: o.note } : {}),
        });
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/versions\/(?<version>[^/]+)\/quality$/,
      async ({ params, body }) => {
        const o = z
          .strictObject({
            overrides: z
              .array(z.strictObject({ checkId: z.string().min(1), reason: z.string() }))
              .optional(),
          })
          .default({})
          .parse(await body().catch(() => ({})));
        return qualityOp(engine, storeById(params.id!), versionParam(params.version!), o.overrides);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/versions\/(?<version>[^/]+)\/critique\/facts$/,
      async ({ params }) =>
        critiqueFactsOp(engine, storeById(params.id!), versionParam(params.version!)),
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/versions\/(?<version>[^/]+)\/draft$/,
      async ({ params, res }) => {
        const file = await draftFileOp(
          engine,
          storeById(params.id!),
          versionParam(params.version!),
        );
        if (!file)
          throw new HttpError(404, 'not-found', 'no review draft for the current content yet');
        const size = (await stat(file)).size;
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'video/mp4',
          'Content-Length': size,
          'Cache-Control': 'no-store',
        });
        await pipeline(createReadStream(file), res);
        return STREAMING;
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/variants$/,
      async ({ params }) => variantsViewOp(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/variants\/defaults$/,
      async ({ params }) => {
        const store = storeById(params.id!);
        notBusy(store);
        return createDefaultVariantsOp(store);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/brand\/files\/(?<name>[^/]+)$/,
      async ({ params, res }) => {
        // Only the project's own logo and font files, by their `<hash>.<ext>` names.
        const store = storeById(params.id!);
        const name = decodeURIComponent(params.name!);
        const b = store.state.brand;
        const files = [b?.logo, ...(b?.fonts.map((f) => f.file) ?? [])].filter(Boolean);
        if (!files.some((f) => `${f!.hash}.${f!.ext}` === name))
          throw new HttpError(404, 'not-found', 'not a brand file of this project');
        const bytes = await readFile(join(store.paths.media, name));
        const ext = name.slice(name.lastIndexOf('.') + 1);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type':
            (
              {
                svg: 'image/svg+xml',
                png: 'image/png',
                ttf: 'font/ttf',
                otf: 'font/otf',
                woff: 'font/woff',
                woff2: 'font/woff2',
              } as Record<string, string>
            )[ext] ?? 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(bytes);
        return STREAMING;
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/brand$/,
      async ({ params }) => brandViewOp(storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/brand\/import$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const o = z
          .strictObject({
            kind: z.enum(['logo', 'font']),
            path: z.string().min(1),
            role: z.enum(['heading', 'body']).optional(),
            family: z.string().min(1).max(100).optional(),
            bold: z.boolean().optional(),
          })
          .parse(await body());
        notBusy(store);
        return brandImportOp(store, o);
      },
    ],
    ['GET', /^\/v1\/templates$/, async () => templatesViewOp(engine)],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/templates\/preview$/,
      async ({ params, body }) => {
        const o = z
          .strictObject({
            templateId: z.string().min(1),
            params: z.record(z.string(), z.unknown()).optional(),
            at: z.number().min(0).max(120).optional(),
            seconds: z.number().positive().max(120).optional(),
            size: z
              .strictObject({ width: z.int().min(16).max(7680), height: z.int().min(16).max(7680) })
              .optional(),
            png: z.boolean().optional(),
          })
          .parse(await body());
        return templatePreviewOp(engine, storeById(params.id!), o);
      },
    ],
    ['GET', /^\/v1\/effects$/, async () => effectsViewOp(engine)],
    ['GET', /^\/v1\/sfx$/, async () => sfxViewOp(engine)],
    [
      'POST',
      /^\/v1\/sfx\/folder$/,
      async ({ body }) => {
        const o = z.strictObject({ folder: z.string().min(1).nullable() }).parse(await body());
        return setSfxFolderOp(engine, o.folder);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/cut$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const o = z
          .strictObject({ leadFrames: z.int().min(0).max(2).optional() })
          .default({})
          .parse(await body());
        notBusy(store);
        return generateCutOp(engine, store, o);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/capture\/render$/,
      async ({ params, body }) => {
        const o = z
          .strictObject({
            format: z.enum(['md', 'html', 'json']),
            omitExcluded: z.boolean().optional(),
          })
          .parse(await body());
        return captureRenderOp(engine, storeById(params.id!), o);
      },
    ],
    [
      'GET',
      /^\/v1\/projects\/(?<id>[^/]+)\/brief$/,
      async ({ params }) => briefForm(engine, storeById(params.id!)),
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/brief\/answers$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        const { questionId, value } = z
          .strictObject({ questionId: z.string().min(1), value: z.unknown() })
          .parse(await body());
        notBusy(store);
        answerBriefOp(engine, store, { questionId, value });
        return editResult(store);
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/brief\/assume$/,
      async ({ params, body }) => {
        const store = storeById(params.id!);
        z.strictObject({}).parse(await body());
        notBusy(store);
        const { added } = assumeMissingOp(engine, store);
        return { added, ...editResult(store) };
      },
    ],
    [
      'POST',
      /^\/v1\/projects\/(?<id>[^/]+)\/brief\/suggest$/,
      async ({ params, body, res }) => {
        const store = storeById(params.id!);
        const { questionId } = z
          .strictObject({ questionId: z.string().min(1) })
          .parse(await body());
        // Read-only, so it may run while an edit is in flight; abandoned when the caller goes away.
        const abort = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) abort.abort();
        });
        return suggestBriefAnswerOp(engine, store, { questionId, signal: abort.signal });
      },
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
        const isRender = t.kind === 'render-draft' || t.kind === 'export' || t.kind === 'handoff';
        if (isRender) {
          // Renders read the project when they start, so editing may go on; one at a time.
          const other = tasks
            .running(store.state.id)
            .find((x) => x.kind === 'render-draft' || x.kind === 'export' || x.kind === 'handoff');
          if (other)
            throw new HttpError(409, 'busy', `a ${other.kind} is already running for this project`);
        } else notBusy(store);
        const progress = (p: unknown) =>
          events.emit('render.progress', {
            projectId: store.state.id,
            kind: t.kind,
            ...(p as object),
          });
        const run = async (signal: AbortSignal) => {
          let out: unknown;
          if (t.kind === 'render-draft')
            return renderDraftOp(engine, store, t.options.variantId, {
              signal,
              onProgress: progress,
            });
          if (t.kind === 'export')
            return exportVersionOp(engine, store, t.options.variantId, {
              signal,
              onProgress: progress,
              ...(t.options.overrides ? { overrides: t.options.overrides } : {}),
            });
          if (t.kind === 'handoff')
            return handoffOp(engine, store, t.options.variantId, {
              signal,
              onProgress: progress,
              ...(t.options.formats ? { formats: t.options.formats } : {}),
            });
          if (t.kind === 'generate')
            out = await generateStoryboardOp(engine, store, { ...t.options, signal });
          else if (t.kind === 'regenerate-section')
            out = await regenerateSectionOp(engine, store, { ...t.options, signal });
          else if (t.kind === 'capture-tips')
            out = await captureTipsOp(engine, store, { ...t.options, signal });
          else if (t.kind === 'rank-takes')
            out = await rankTakesOp(engine, store, { ...t.options, signal });
          else if (t.kind === 'critique')
            out = await critiqueOp(engine, store, t.options.variantId, { signal });
          else {
            out = await scanKnowledgeOp(engine, store, {
              ...t.options,
              signal,
              ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
              onNotice: (message) =>
                events.emit('task.notice', { projectId: store.state.id, message }),
            });
          }
          await store.save();
          return out;
        };
        res.statusCode = 202;
        return tasks.start(t.kind, store.state.id, run, { blocking: !isRender });
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

  const staticRoot = opts.staticDir ? await realpath(resolve(opts.staticDir)) : undefined;
  if (staticRoot) await stat(join(staticRoot, 'index.html'));

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
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type, last-event-id',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Claude Code's door: its own long-lived token, never the UI's (which changes per launch).
      if (url.pathname === '/mcp') {
        if (!tokenMatches(bearer(req), mcpToken))
          throw new HttpError(401, 'unauthorized', 'missing or wrong token');
        if (req.method !== 'POST')
          throw new HttpError(405, 'method-not-allowed', 'this MCP endpoint takes POST only');
        await serveMcpHttp(
          { engine, defaultProject: openProject },
          req,
          res,
          await readJson(req, maxBody),
        );
        return;
      }
      // The UI bundle is public code; only the API needs the token.
      if (staticRoot && !url.pathname.startsWith('/v1/') && url.pathname !== '/v1') {
        await serveStatic(staticRoot, req, res, url.pathname);
        return;
      }
      if (!tokenMatches(bearer(req), token))
        throw new HttpError(401, 'unauthorized', 'missing or wrong token');

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

  const listen = (p: number) =>
    new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(p, host, () => {
        server.off('error', fail);
        done();
      });
    });
  if (opts.port === undefined && opts.preferredPort) {
    await listen(opts.preferredPort).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      await listen(0); // taken (another copy of the app?): any free port; Settings says reconnect
    });
  } else {
    await listen(opts.port ?? 0);
  }
  port = (server.address() as AddressInfo).port;
  for (const h of ['127.0.0.1', 'localhost']) allowedOrigins.add(`http://${h}:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    mcp: { url: `http://127.0.0.1:${port}/mcp`, token: mcpToken },
    events,
    async close() {
      engine.handoff.available = false;
      engine.llm.invalidate();
      for (const p of engine.handoff.pending()) engine.handoff.cancel(p.id);
      await tasks.drain();
      for (const off of offs) off();
      events.closeAll();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const STREAMING = Symbol('streaming');

/** A secret kept in a file only this user can read; made once, then reused across launches. */
async function loadOrCreateToken(path: string): Promise<string> {
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (existing.length >= 32) return existing;
  const fresh = newToken();
  await writeFile(path, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}
/** Tasks that belong to the app rather than a project (the vision model download). */
const APP_TASK = '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** The UI may talk to its own origin only, load nothing from elsewhere, and not be framed. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Serve a built UI. Only files under the UI folder, after resolving symlinks and `..`; unknown
 * extension-less paths get index.html so client-side routes survive a reload.
 */
async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
) {
  if (req.method !== 'GET')
    throw new HttpError(405, 'method-not-allowed', `${req.method} is not supported here`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad-request', 'malformed path');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'bad-request', 'malformed path');
  const wanted = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const inside = (p: string) => {
    const rel = relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const find = async (rel: string): Promise<string | undefined> => {
    try {
      const real = await realpath(join(root, rel));
      return inside(real) && (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  };
  let file = await find(wanted);
  if (!file && extname(wanted) === '') file = await find('index.html');
  if (!file) throw new HttpError(404, 'not-found', `no such file ${pathname}`);
  const body = await readFile(file);
  const immutable = /^\/assets\/.+-[A-Za-z0-9_-]{6,}\.\w+$/.test(decoded);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': UI_CSP,
  });
  res.end(body);
}
