import { produceWithPatches, enablePatches } from 'immer';
import {
  ServiceError,
  type ProjectView,
  type ServiceEventMessage,
} from '@trailerforge/service/client';
import { describe, expect, it } from 'vitest';
import { AppStore, busyTask, describeFailure, type ClientLike } from './store.js';

enablePatches();

const conn = { baseUrl: 'http://127.0.0.1:1', token: 'x'.repeat(43) };

type Proj = { name: string; n: number };
const view = (id: string, version: number, project: Proj, canUndo = false): ProjectView =>
  ({
    id,
    dir: `/p/${id}`,
    version,
    canUndo,
    canRedo: false,
    busy: null,
    project,
  }) as unknown as ProjectView;

/** An in-memory service: authoritative project copies, an event queue, and call recording. */
class Fake {
  projects = new Map<string, ProjectView>();
  seq = 0;
  eventCalls: { after: number | undefined }[] = [];
  private waiting: ((e: ServiceEventMessage | null) => void)[] = [];
  private queue: ServiceEventMessage[] = [];
  failNext: ServiceError | null = null;
  fetches = 0;
  briefFetches = 0;
  handoffList: unknown[] = [];
  keySet = false;

  emit(type: string, data: unknown): ServiceEventMessage {
    const e = { seq: ++this.seq, type, at: '', data };
    const w = this.waiting.shift();
    if (w) w(e);
    else this.queue.push(e);
    return e;
  }
  /** Apply a rename on the authoritative copy and publish the matching event. */
  rename(id: string, name: string) {
    const v = this.projects.get(id)!;
    const [next, patches] = produceWithPatches(
      v.project as unknown as Proj,
      (d) => void (d.name = name),
    );
    const nv = {
      ...v,
      version: v.version + 1,
      canUndo: true,
      project: next,
    } as unknown as ProjectView;
    this.projects.set(id, nv);
    return this.emit('project.changed', {
      projectId: id,
      version: nv.version,
      canUndo: true,
      canRedo: false,
      patches,
    });
  }
  end() {
    this.waiting.shift()?.(null);
  }

  private async *stream(onOpen?: () => void): AsyncGenerator<ServiceEventMessage> {
    onOpen?.();
    for (;;) {
      const e =
        this.queue.shift() ??
        (await new Promise<ServiceEventMessage | null>((r) => this.waiting.push(r)));
      if (!e) return;
      yield e;
    }
  }

  client: ClientLike = {
    info: async () => ({
      apiVersion: 'v1',
      lastSeq: this.seq,
      videoTypes: [],
      templates: [],
      commands: [],
    }),
    listProjects: async () =>
      [...this.projects.values()].map((v) => ({ id: v.id, name: '', dir: v.dir })),
    getProject: async (id) => {
      this.fetches++;
      const v = this.projects.get(id);
      if (!v) throw new ServiceError(404, 'not-open', 'nope');
      return v;
    },
    openProject: async (dir) => [...this.projects.values()].find((v) => v.dir === dir)!,
    createProject: async () => {
      throw new Error('unused');
    },
    closeProject: async (id) => {
      this.projects.delete(id);
      return { closed: true };
    },
    command: async (id, type, payload) => {
      if (this.failNext) throw this.failNext;
      if (type === 'core/project.rename') this.rename(id, (payload as { name: string }).name);
      const v = this.projects.get(id)!;
      return { version: v.version, canUndo: v.canUndo, canRedo: v.canRedo };
    },
    undo: async (id) => ({
      done: true,
      version: this.projects.get(id)!.version,
      canUndo: false,
      canRedo: true,
    }),
    redo: async (id) => ({
      done: false,
      version: this.projects.get(id)!.version,
      canUndo: true,
      canRedo: false,
    }),
    footage: async () => ({ footage: [], music: [], jobs: { queued: 0, running: 0, failed: [] } }),
    footageMatches: async () => ({ matches: [], recordings: [], usedVision: false }),
    graphicTemplates: async () => [],
    effects: async () => ({
      transitions: [],
      effects: [],
      sounds: { folder: null, generated: [], files: [], warnings: [] },
    }),
    variants: async () => ({ hasMaster: false, variants: [], missing: [] }),
    review: async () => [],
    approveVersion: async () => ({ contentHash: 'h' }),
    quality: async () => ({
      variantId: null,
      contentHash: 'h',
      preset: { id: 'core/youtube', name: 'YouTube', extension: 'mp4' },
      findings: [],
      verdict: { allowed: true, blocking: [], needsOverride: [], overridden: [], warnings: [] },
    }),
    draft: async () => new Blob([]),
    brandFile: async () => new Blob([]),
    createDefaultVariants: async () => ({ added: [] }),
    brand: async () => ({
      brand: null,
      warnings: [],
      contrast: [],
      fonts: { heading: 'Inter Bold (shipped)', body: 'Inter (shipped)' },
    }),
    importBrandFile: async () => ({
      file: { hash: 'a'.repeat(64), ext: 'svg' as const, name: 'logo.svg' },
    }),
    cutGrid: async () => null,
    media: async () => new Blob([]),
    generateCut: async () => ({
      timelineId: 'tl_rough',
      items: 0,
      placeholders: 0,
      keptEdits: [],
      warnings: [],
      unanalysed: 0,
    }),
    importFootage: async () => ({ jobs: [], skipped: [], truncated: false }),
    analyzeFootage: async () => ({ jobs: [], skipped: [] }),
    acceptMatches: async () => ({ attached: [] }),
    capture: async () => {
      throw new Error('unused');
    },
    exportCapture: async () => {
      throw new Error('unused');
    },
    renderCapture: async () => {
      throw new Error('unused');
    },
    briefForm: async (id) => {
      this.briefFetches++;
      return {
        videoTypeId: 'vt',
        videoTypeName: 'VT',
        score: 0,
        complete: false,
        canProceed: false,
        fields: [],
        formats: [],
        id,
      } as never;
    },
    answerBrief: async (id) => ({
      version: this.projects.get(id)!.version + 1,
      canUndo: true,
      canRedo: false,
    }),
    assumeMissing: async (id) => ({
      added: 2,
      version: this.projects.get(id)!.version,
      canUndo: true,
      canRedo: false,
    }),
    suggestBrief: async (_id, questionId) => ({
      questionId,
      value: 'x',
      reason: 'r',
      provider: 'core/mock',
    }),
    decisions: async () => [{ id: 'd1' }],
    handoffs: async () => this.handoffList as never,
    replyHandoff: async () => ({ accepted: true }),
    cancelHandoff: async () => ({ cancelled: true }),
    llmProviders: async () => [
      {
        id: 'core/mock',
        name: 'Mock',
        kind: 'mock',
        sendsDataOffDevice: false,
        available: { ok: true },
      },
    ],
    llmRoutes: async () =>
      ({ config: {}, defaults: {}, custom: false, tasks: [], providers: [], models: [] }) as never,
    saveRoutes: async () => ({}) as never,
    resetRoutes: async () => ({}) as never,
    secrets: async () =>
      ({
        anthropicApiKey: { set: this.keySet, source: this.keySet ? 'stored' : null },
        storage: 'memory',
      }) as never,
    setApiKey: async () => {
      this.keySet = true;
      return {} as never;
    },
    clearApiKey: async () => {
      this.keySet = false;
      return {} as never;
    },
    claudeCode: async () => ({ installed: true, mode: null, upToDate: false, available: ['app'] }),
    connectClaudeCode: async (mode = 'app') => ({
      installed: true,
      mode,
      upToDate: true,
      available: ['app'],
    }),
    disconnectClaudeCode: async () => ({
      installed: true,
      mode: null,
      upToDate: false,
      available: ['app'],
    }),
    vision: async () => ({ status: 'unavailable', disclosure: null }),
    downloadVision: async () => {
      throw new Error('unused');
    },
    watchedFolders: async () => ({ folders: [], watching: false, problems: [] }),
    setWatchedFolders: async (folders) => ({ folders, watching: folders.length > 0, problems: [] }),
    llmPreview: async (_id, task) => ({
      task,
      available: true,
      willSend: { brief: [], assumptions: 0, knowledge: [], knowledgeExcluded: 0 },
    }),
    startTask: async (id) => ({
      id: 't1',
      kind: 'generate',
      projectId: id,
      status: 'running',
      startedAt: '',
    }),
    cancelTask: async () => ({
      id: 't1',
      kind: 'generate',
      projectId: 'p',
      status: 'cancelled',
      startedAt: '',
    }),
    events: (opts) => {
      this.eventCalls.push({ after: opts?.after });
      return this.stream(opts?.onOpen);
    },
  };
}

async function setup() {
  const fake = new Fake();
  fake.projects.set('p1', view('p1', 0, { name: 'One', n: 0 }));
  const store = new AppStore(() => fake.client);
  expect(await store.connect(conn)).toBe(true);
  return { fake, store };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const name = (s: AppStore, id = 'p1') =>
  (s.getState().projects[id]!.project as unknown as Proj).name;

describe('AppStore', () => {
  it('loads open projects on connect and reports ready', async () => {
    const { store } = await setup();
    expect(store.getState()).toMatchObject({ status: 'ready', order: ['p1'] });
    store.disconnect();
  });

  it('fails cleanly when the service rejects the connection', async () => {
    const store = new AppStore(() => ({
      ...new Fake().client,
      info: async () => {
        throw new ServiceError(401, 'unauthorized', 'missing or wrong token');
      },
    }));
    expect(await store.connect(conn)).toBe(false);
    expect(store.getState()).toMatchObject({ status: 'failed', error: 'missing or wrong token' });
  });

  it('applies change events as patches, in order, and tracks undo state', async () => {
    const { fake, store } = await setup();
    fake.rename('p1', 'Two');
    fake.rename('p1', 'Three');
    await tick();
    expect(name(store)).toBe('Three');
    expect(store.getState().projects.p1).toMatchObject({ version: 2, canUndo: true });
    expect(fake.fetches).toBe(1); // only the initial load: events were applied, not refetched
    store.disconnect();
  });

  it('ignores events it already has and refetches when it missed one', async () => {
    const { fake, store } = await setup();
    // A change we hear about late, after having fetched past it: skipped.
    fake.rename('p1', 'Two');
    await tick();
    const stale = { ...fake.rename('p1', 'Three') };
    await tick();
    fake.emit('project.changed', { ...(stale.data as object) }); // duplicate delivery
    await tick();
    expect(name(store)).toBe('Three');

    // Skip one event: the next one arrives with a version gap, so the store refetches.
    const before = fake.fetches;
    const v = fake.projects.get('p1')!;
    fake.projects.set('p1', {
      ...v,
      version: v.version + 2,
      project: { name: 'Five', n: 0 },
    } as unknown as ProjectView);
    fake.emit('project.changed', {
      projectId: 'p1',
      version: v.version + 2,
      canUndo: true,
      canRedo: false,
      patches: [],
    });
    await tick();
    expect(name(store)).toBe('Five');
    expect(fake.fetches).toBe(before + 1);
    store.disconnect();
  });

  it('refetches everything on a reset, and removes closed projects', async () => {
    const { fake, store } = await setup();
    fake.projects.set('p2', view('p2', 0, { name: 'Two', n: 0 }));
    fake.emit('reset', { reason: 'gap' });
    await tick();
    expect(store.getState().order.sort()).toEqual(['p1', 'p2']);
    fake.emit('project.closed', { projectId: 'p2', dir: '/p/p2' });
    await tick();
    expect(Object.keys(store.getState().projects)).toEqual(['p1']);
    store.disconnect();
  });

  it('a command resolves only after the local copy shows its result', async () => {
    const { store } = await setup();
    const ok = await store.command('p1', 'core/project.rename', { name: 'Renamed' });
    expect(ok).toBe(true);
    expect(name(store)).toBe('Renamed'); // read-your-writes
    expect(await store.undo('p1')).toBe(true);
    store.disconnect();
  });

  it('turns failures into toasts and reports false', async () => {
    const { fake, store } = await setup();
    fake.failNext = new ServiceError(409, 'locked', 'section "sec_end" is locked');
    expect(await store.command('p1', 'core/project.rename', { name: 'x' })).toBe(false);
    expect(store.getState().toasts.map((t) => t.message)).toEqual(['section "sec_end" is locked']);
    store.dismissToast(store.getState().toasts[0]!.id);
    expect(store.getState().toasts).toEqual([]);
    store.disconnect();
  });

  it('tracks tasks, shows busy projects, and toasts failed tasks', async () => {
    const { fake, store } = await setup();
    const task = { id: 't1', kind: 'generate', projectId: 'p1', status: 'running', startedAt: '' };
    fake.emit('task.updated', task);
    await tick();
    expect(busyTask(store.getState(), 'p1')?.id).toBe('t1');
    fake.emit('task.updated', {
      ...task,
      status: 'failed',
      error: { code: 'x', message: 'provider unavailable' },
    });
    await tick();
    expect(busyTask(store.getState(), 'p1')).toBeUndefined();
    expect(store.getState().toasts[0]!.message).toBe('generate failed: provider unavailable');
    store.disconnect();
  });

  it('resumes the event stream from the last sequence after a drop', async () => {
    const { fake, store } = await setup();
    fake.rename('p1', 'Two');
    await tick();
    fake.end(); // server closes the stream
    await tick(400);
    expect(fake.eventCalls.at(-1)?.after).toBe(1);
    expect(store.getState().status).toBe('ready');
    fake.rename('p1', 'Three');
    await tick();
    expect(name(store)).toBe('Three');
    store.disconnect();
  });
});

describe('brief data', () => {
  it('loads the form once per project version and reloads after a change', async () => {
    const { fake, store } = await setup();
    await Promise.all([store.loadBrief('p1'), store.loadBrief('p1')]); // overlapping calls share one fetch
    await store.loadBrief('p1'); // current: no fetch
    expect(fake.briefFetches).toBe(1);
    expect(store.getState().briefs.p1?.version).toBe(0);

    fake.rename('p1', 'Two');
    await tick();
    await store.loadBrief('p1');
    expect(fake.briefFetches).toBe(2);
    expect(store.getState().briefs.p1?.version).toBe(1);
    store.disconnect();
  });

  it('drops the form when the project closes, and ignores unknown projects', async () => {
    const { fake, store } = await setup();
    await store.loadBrief('p1');
    await store.loadBrief('nope');
    expect(fake.briefFetches).toBe(1);
    fake.emit('project.closed', { projectId: 'p1', dir: '/p/p1' });
    await tick();
    expect(store.getState().briefs).toEqual({});
    store.disconnect();
  });

  it('answers wait for the local copy, suggestions change nothing, assumptions report a count', async () => {
    const { fake, store } = await setup();
    const answering = store.answerBrief('p1', 'brief.title', 'Ember');
    fake.rename('p1', 'After answer'); // the service publishes the change the answer caused
    expect(await answering).toBe(true);
    expect(store.getState().projects.p1!.version).toBe(1);
    expect(await store.suggestBrief('p1', 'brief.title')).toMatchObject({
      value: 'x',
      provider: 'core/mock',
    });
    expect(store.getState().projects.p1!.version).toBe(1);
    expect(await store.assumeMissing('p1')).toBe(2);
    store.disconnect();
  });
});

describe('Copy-to-chat requests', () => {
  const h = (id: string, round = 0) => ({
    id,
    task: 'brief.suggest',
    prompt: 'p',
    round,
    createdAt: '',
  });

  it('loads waiting requests on connect, then follows requests and answers in order', async () => {
    const fake = new Fake();
    fake.projects.set('p1', view('p1', 0, { name: 'One', n: 0 }));
    fake.handoffList = [h('early')];
    const store = new AppStore(() => fake.client);
    await store.connect(conn);
    expect(store.getState().handoffs.map((x) => x.id)).toEqual(['early']);

    fake.emit('handoff.requested', h('a'));
    fake.emit('handoff.requested', h('a')); // duplicate delivery does not duplicate the request
    fake.emit('handoff.requested', h('b', 1));
    await tick();
    expect(store.getState().handoffs.map((x) => x.id)).toEqual(['early', 'a', 'b']);
    fake.emit('handoff.resolved', { id: 'early', outcome: 'replied' });
    await tick();
    expect(store.getState().handoffs.map((x) => x.id)).toEqual(['a', 'b']);
    expect(await store.replyHandoff('a', 'text')).toBe(true);
    expect(await store.cancelHandoff('b')).toBe(true);
    store.disconnect();
  });
});

describe('settings', () => {
  it('loads once asked, and re-reads when the service says settings changed', async () => {
    const { fake, store } = await setup();
    expect(store.getState().settings).toBeNull();
    await store.loadSettings();
    expect(store.getState().settings?.secrets.anthropicApiKey.set).toBe(false);

    expect(await store.setApiKey('sk-x')).toBe(true);
    expect(store.getState().settings?.secrets.anthropicApiKey).toEqual({
      set: true,
      source: 'stored',
    });
    fake.keySet = false;
    fake.emit('settings.changed', { what: 'secrets' }); // changed elsewhere
    await tick();
    expect(store.getState().settings?.secrets.anthropicApiKey.set).toBe(false);
    expect(await store.saveRoutes({})).toBe(true);
    expect(await store.resetRoutes()).toBe(true);
    store.disconnect();
  });

  it('does not fetch settings nobody is looking at', async () => {
    const { fake, store } = await setup();
    fake.emit('settings.changed', { what: 'routes' });
    await tick();
    expect(store.getState().settings).toBeNull();
    store.disconnect();
  });
});

describe('task results', () => {
  it('announces finished generations and rewrites, and not other tasks', async () => {
    const { fake, store } = await setup();
    const base = { projectId: 'p1', startedAt: '', status: 'succeeded' };
    fake.emit('task.updated', {
      ...base,
      id: 'g',
      kind: 'generate',
      result: { provider: 'core/mock', slots: 7, seconds: 30 },
    });
    fake.emit('task.updated', {
      ...base,
      id: 'r',
      kind: 'regenerate-section',
      result: { provider: 'core/mock', section: { name: 'Hook' } },
    });
    fake.emit('task.updated', { ...base, id: 's', kind: 'scan', result: {} });
    await tick();
    expect(store.getState().toasts.map((t) => t.message)).toEqual([
      'Storyboard written with core/mock: 7 slots, 30 s. Undo goes back to what you had.',
      'Rewrote “Hook” with core/mock. Undo goes back.',
    ]);
    store.disconnect();
  });
});

describe('task notices', () => {
  it('shows the latest notice while a task runs and clears it when the task ends', async () => {
    const { fake, store } = await setup();
    const task = { id: 't1', kind: 'scan', projectId: 'p1', status: 'running', startedAt: '' };
    fake.emit('task.updated', task);
    fake.emit('task.notice', { projectId: 'p1', message: 'Deep scan: reading 12 files' });
    await tick();
    expect(store.getState().notices).toEqual({ p1: 'Deep scan: reading 12 files' });
    fake.emit('task.updated', { ...task, status: 'succeeded' });
    await tick();
    expect(store.getState().notices).toEqual({});
    store.disconnect();
  });
});

describe('decision log', () => {
  it('loads decisions for an open project and drops them when it closes', async () => {
    const { fake, store } = await setup();
    await store.loadDecisions('p1');
    await store.loadDecisions('nope'); // not open: ignored
    expect(Object.keys(store.getState().decisions)).toEqual(['p1']);
    fake.emit('project.closed', { projectId: 'p1', dir: '/p/p1' });
    await tick();
    expect(store.getState().decisions).toEqual({});
    store.disconnect();
  });
});

describe('describeFailure', () => {
  it('adds the first details of a rejected command', () => {
    const err = new ServiceError(422, 'invalid', 'core/x: invalid payload', [
      { path: 'a', message: 'Expected string' },
      { path: 'b', message: 'Required' },
    ]);
    expect(describeFailure(err)).toBe('core/x: invalid payload (Expected string; Required)');
    expect(describeFailure(new Error('boom'))).toBe('boom');
  });
});
