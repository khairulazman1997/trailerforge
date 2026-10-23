import { isDeepStrictEqual } from 'node:util';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import {
  Project,
  parseProject,
  validateProjectRefs,
  type ProjectInput,
  type RefIssue,
} from '@trailerforge/schema';
import { CommandError, type CommandDef, type CommandRegistry } from '../commands.js';
import { appendDurable, cleanupTempFiles, truncateTornTail, writeFileAtomic } from './fs-atomic.js';
import { projectPaths, SNAPSHOT_PREFIX, type ProjectPaths } from './layout.js';
import { acquireLock, type Lock } from './lock.js';

enablePatches();

export interface ProjectStoreOptions {
  commands: CommandRegistry;
  /** Debounce for autosave after a change; 0 disables autosave. Default 2000 ms. */
  autosaveMs?: number;
  /** Write a full snapshot every N history entries. Default 50. */
  snapshotEvery?: number;
  now?: () => Date;
}

export interface HistoryEntry {
  seq: number;
  at: string;
  type: string;
  label: string;
  patches: Patch[];
}

export type VersionInfo = Omit<HistoryEntry, 'patches'>;

export interface ChangeEvent {
  kind: 'command' | 'undo' | 'redo';
  type: string;
  label: string;
  project: Project;
  patches: Patch[];
}

interface UndoEntry {
  type: string;
  label: string;
  patches: Patch[];
  inverse: Patch[];
  at: number;
  mergeKey?: string;
}

export class ProjectOpenError extends Error {
  constructor(
    message: string,
    readonly issues: RefIssue[] = [],
  ) {
    super(message);
    this.name = 'ProjectOpenError';
  }
}

/**
 * Owns one open project: the in-memory state (frozen), command dispatch with validation,
 * undo/redo, autosave, atomic saves and the on-disk version history.
 */
export class ProjectStore {
  private current: Project;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private unsaved: HistoryEntry[] = [];
  private listeners = new Set<(e: ChangeEvent) => void>();
  private saveChain: Promise<void> = Promise.resolve();
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private closed = false;
  private sinceSnapshot = 0;
  private readonly commands: CommandRegistry;
  private readonly autosaveMs: number;
  private readonly snapshotEvery: number;
  private readonly now: () => Date;

  private constructor(
    readonly paths: ProjectPaths,
    project: Project,
    private seq: number,
    private readonly lock: Lock,
    opts: ProjectStoreOptions,
  ) {
    this.current = Object.freeze(project) as Project;
    this.commands = opts.commands;
    this.autosaveMs = opts.autosaveMs ?? 2000;
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.now = opts.now ?? (() => new Date());
  }

  /** Create a new project folder. Fails if `dir` already contains a project. */
  static async create(
    dir: string,
    init: ProjectInput,
    opts: ProjectStoreOptions,
  ): Promise<ProjectStore> {
    const paths = projectPaths(dir);
    if (await exists(paths.projectFile))
      throw new ProjectOpenError(`a project already exists in ${dir}`);
    const parsed = parseProject(init);
    if (!parsed.ok) throw new ProjectOpenError('invalid initial project', parsed.issues);
    await makeFolders(paths);
    const lock = await acquireLock(paths.lock);
    const store = new ProjectStore(paths, parsed.project, 0, lock, opts);
    await writeFileAtomic(paths.projectFile, serialize(parsed.project));
    await store.recordOpen('create');
    return store;
  }

  /** Open an existing project: lock, clean crash leftovers, migrate (with backup), validate. */
  static async open(dir: string, opts: ProjectStoreOptions): Promise<ProjectStore> {
    const paths = projectPaths(dir);
    if (!(await exists(paths.projectFile))) throw new ProjectOpenError(`no project.json in ${dir}`);
    await makeFolders(paths);
    const lock = await acquireLock(paths.lock);
    try {
      await cleanupTempFiles(paths.projectFile);
      await truncateTornTail(paths.patchLog);
      const raw = await readFile(paths.projectFile, 'utf8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        throw new ProjectOpenError(`project.json is not valid JSON: ${String(err)}`);
      }
      const parsed = parseProject(json);
      if (!parsed.ok) throw new ProjectOpenError('project.json failed validation', parsed.issues);
      const lastSeq = (await readHistory(paths)).at(-1)?.seq ?? 0;
      const store = new ProjectStore(paths, parsed.project, lastSeq, lock, opts);
      if (parsed.migratedFrom !== null) {
        const stamp = store.now().toISOString().replace(/[:.]/g, '-');
        await copyFile(
          paths.projectFile,
          join(paths.history, `pre-migration-v${parsed.migratedFrom}-${stamp}.json`),
        );
        await writeFileAtomic(paths.projectFile, serialize(parsed.project));
      }
      await store.recordOpen(
        parsed.migratedFrom === null ? 'open' : `open (migrated: ${parsed.applied.join('; ')})`,
      );
      return store;
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  get state(): Project {
    return this.current;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Typed entry point: run a command definition directly. */
  run<P>(def: CommandDef<P>, payload: NoInfer<P>): Project {
    return this.dispatch(def.type, payload);
  }

  /** Untyped entry point (plugins, IPC): look the command up by type and validate the payload. */
  dispatch(type: string, payload: unknown): Project {
    this.assertOpen();
    const def = this.commands.get(type);
    if (!def) throw new CommandError(type, 'unknown command');
    const parsedPayload = def.payload.safeParse(payload);
    if (!parsedPayload.success) {
      throw new CommandError(
        type,
        'invalid payload',
        parsedPayload.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const p = parsedPayload.data;
    const [next, patches, inverse] = produceWithPatches(this.current, (d) => def.apply(d, p));
    if (patches.length === 0) return this.current;
    this.validate(type, next);

    const label = def.label(p);
    const at = this.now().getTime();
    const mergeKey = def.merge?.key(p);
    const last = this.undoStack.at(-1);
    if (
      def.merge &&
      last &&
      last.type === type &&
      last.mergeKey === mergeKey &&
      at - last.at <= def.merge.windowMs
    ) {
      last.patches.push(...patches);
      last.inverse = [...inverse, ...last.inverse];
      last.label = label;
      last.at = at;
    } else {
      this.undoStack.push({
        type,
        label,
        patches,
        inverse,
        at,
        ...(mergeKey === undefined ? {} : { mergeKey }),
      });
    }
    this.redoStack = [];
    this.commit('command', type, label, next, patches);
    return next;
  }

  undo(): boolean {
    this.assertOpen();
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(entry);
    this.commit(
      'undo',
      'core/undo',
      `Undo: ${entry.label}`,
      applyPatches(this.current, entry.inverse),
      entry.inverse,
    );
    return true;
  }

  redo(): boolean {
    this.assertOpen();
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push(entry);
    this.commit(
      'redo',
      'core/redo',
      `Redo: ${entry.label}`,
      applyPatches(this.current, entry.patches),
      entry.patches,
    );
    return true;
  }

  subscribe(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persist now. Saves are serialized; concurrent calls queue behind each other. */
  save(): Promise<void> {
    this.clearAutosave();
    const run = this.saveChain.then(() => this.writeNow());
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /** Flush pending changes and release the lock. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.save();
    this.closed = true;
    this.listeners.clear();
    await this.lock.release();
  }

  async listVersions(): Promise<VersionInfo[]> {
    await this.saveChain;
    return (await readHistory(this.paths)).map(({ patches: _p, ...info }) => info);
  }

  /** Reconstruct the project as it was right after history entry `seq`. */
  async readVersion(seq: number): Promise<Project> {
    await this.saveChain;
    const snaps = (await readdir(this.paths.history))
      .filter((n) => n.startsWith(SNAPSHOT_PREFIX))
      .map((n) => Number(n.slice(SNAPSHOT_PREFIX.length, -'.json'.length)))
      .filter((n) => n <= seq)
      .sort((a, b) => a - b);
    const base = snaps.at(-1);
    if (base === undefined) throw new Error(`no snapshot at or before version ${seq}`);
    let state = JSON.parse(await readFile(this.paths.snapshot(base), 'utf8')) as Project;
    for (const entry of await readHistory(this.paths)) {
      if (entry.seq > base && entry.seq <= seq) state = applyPatches(state, entry.patches);
    }
    return state;
  }

  private validate(type: string, next: Project): void {
    const parsed = Project.safeParse(next);
    if (!parsed.success) {
      throw new CommandError(
        type,
        'result failed validation',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    if (!isDeepStrictEqual(parsed.data, next)) {
      throw new CommandError(
        type,
        'result has objects with missing defaults; build them with Schema.parse()',
      );
    }
    const refIssues = validateProjectRefs(next);
    if (refIssues.length) throw new CommandError(type, 'result has broken references', refIssues);
  }

  private commit(
    kind: ChangeEvent['kind'],
    type: string,
    label: string,
    next: Project,
    patches: Patch[],
  ) {
    this.current = next;
    this.unsaved.push({ seq: ++this.seq, at: this.now().toISOString(), type, label, patches });
    this.dirty = true;
    this.scheduleAutosave();
    const event: ChangeEvent = { kind, type, label, project: next, patches };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must not break editing; the event bus (1.5) adds reporting.
      }
    }
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return;
    const entries = this.unsaved;
    this.unsaved = [];
    this.dirty = false;
    // updatedAt is bookkeeping, not an edit: it is not part of undo history.
    this.current = Object.freeze({ ...this.current, updatedAt: this.now().toISOString() });
    const snapshot = this.current;
    try {
      await writeFileAtomic(this.paths.projectFile, serialize(snapshot));
      await appendDurable(
        this.paths.patchLog,
        entries.map((e) => JSON.stringify(e) + '\n').join(''),
      );
      this.sinceSnapshot += entries.length;
      if (this.sinceSnapshot >= this.snapshotEvery) {
        await writeFileAtomic(this.paths.snapshot(entries.at(-1)!.seq), serialize(snapshot));
        this.sinceSnapshot = 0;
      }
    } catch (err) {
      this.unsaved = [...entries, ...this.unsaved];
      this.dirty = true;
      throw err;
    }
  }

  /** Every session starts with a history entry plus a snapshot of the state as loaded. */
  private async recordOpen(label: string): Promise<void> {
    const entry: HistoryEntry = {
      seq: ++this.seq,
      at: this.now().toISOString(),
      type: 'core/open',
      label,
      patches: [],
    };
    await appendDurable(this.paths.patchLog, JSON.stringify(entry) + '\n');
    await writeFileAtomic(this.paths.snapshot(entry.seq), serialize(this.current));
  }

  private scheduleAutosave() {
    if (this.autosaveMs <= 0 || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined;
      this.save().catch(() => {
        // Changes stay in memory and dirty; the next save retries. Surfaced via events in 1.5.
      });
    }, this.autosaveMs);
  }

  private clearAutosave() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
  }

  private assertOpen() {
    if (this.closed) throw new Error('project store is closed');
  }
}

function serialize(project: unknown): string {
  return JSON.stringify(project, null, 2) + '\n';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeFolders(paths: ProjectPaths): Promise<void> {
  for (const dir of [paths.dir, paths.history, paths.media, paths.cache, paths.logs]) {
    await mkdir(dir, { recursive: true });
  }
}

/** Reads the patch log, skipping a torn final line left by a crash mid-append. */
async function readHistory(paths: ProjectPaths): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(paths.patchLog, 'utf8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // torn write; only possible on the last line
    }
  }
  return entries;
}
