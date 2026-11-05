import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PLANNER_SCHEMA_VERSION, PlannerFile } from '@trailerforge/schema';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { CommandError } from '../commands.js';
import { cleanupTempFiles, writeFileAtomic } from '../store/fs-atomic.js';
import { acquireLockWaiting } from '../store/lock.js';
import { plannerCommands, type PlannerCommandDef } from './planner-commands.js';

enablePatches();

export class PlannerOpenError extends Error {
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`planner file at ${path} is unreadable (${reason}); it was left untouched`, options);
    this.name = 'PlannerOpenError';
  }
}

export interface PlannerStoreOptions {
  lockTimeoutMs?: number;
  now?: () => Date;
  /** Called after every write (command, undo, redo) with the new file. */
  onChange?: (file: PlannerFile, change: PlannerChange) => void;
}

export interface PlannerChange {
  kind: 'command' | 'undo' | 'redo';
  type: string;
  label: string;
}

interface Step {
  type: string;
  label: string;
  patches: Patch[];
  inverse: Patch[];
  mergeKey?: string | undefined;
  at: number;
}

const emptyFile = (): PlannerFile => ({
  schemaVersion: PLANNER_SCHEMA_VERSION,
  campaigns: [],
  slots: [],
});

/**
 * The planner's app-level file, `<home>/planner/planner.json`. Every change is a typed command
 * applied under a short-lived lock to a fresh read of the file, validated and written
 * atomically, so a crash leaves the old or the new file and two processes never lose each
 * other's writes. Undo and redo are kept per store; they refuse to run (and are cleared) once
 * another process has changed the file, rather than guess.
 */
export class PlannerStore {
  private snapshot: PlannerFile = emptyFile();
  /** The JSON this store last wrote or read: tells whether someone else changed the file. */
  private seen = '';
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private readonly defs = new Map<string, PlannerCommandDef<unknown>>();

  private constructor(
    readonly dir: string,
    private readonly opts: PlannerStoreOptions,
  ) {
    for (const def of plannerCommands) this.defs.set(def.type, def);
  }

  get file(): string {
    return join(this.dir, 'planner.json');
  }

  private get lockFile(): string {
    return join(this.dir, 'planner.lock');
  }

  static async open(home: string, opts: PlannerStoreOptions = {}): Promise<PlannerStore> {
    const store = new PlannerStore(join(resolve(home), 'planner'), opts);
    await mkdir(store.dir, { recursive: true });
    await cleanupTempFiles(store.file);
    await store.reload();
    return store;
  }

  /** Command types this store accepts. */
  commandTypes(): string[] {
    return [...this.defs.keys()].sort();
  }

  get state(): PlannerFile {
    return this.snapshot;
  }

  async reload(): Promise<PlannerFile> {
    const { file, text } = await this.read();
    if (text !== this.seen) this.forgetHistory();
    this.snapshot = file;
    this.seen = text;
    return file;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label;
  }

  redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label;
  }

  async dispatch(type: string, payload: unknown): Promise<PlannerFile> {
    const def = this.defs.get(type);
    if (!def) throw new CommandError(type, 'unknown command');
    const parsed = def.payload.safeParse(payload);
    if (!parsed.success)
      throw new CommandError(
        type,
        'invalid payload',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const p = parsed.data;
    const now = this.now();
    const ctx = {
      now: now.toISOString(),
      newId: (prefix: 'cmp' | 'cal') => `${prefix}_${randomUUID().slice(0, 8)}`,
    };
    const label = def.label(p);
    return this.write({ kind: 'command', type, label }, (current) => {
      const [next, patches, inverse] = produceWithPatches(current, (d) => def.apply(d, p, ctx));
      if (patches.length === 0) return null;
      const mergeKey = def.merge ? `${type}:${def.merge.key(p)}` : undefined;
      const last = this.undoStack.at(-1);
      if (
        mergeKey &&
        last?.mergeKey === mergeKey &&
        now.getTime() - last.at <= def.merge!.windowMs
      ) {
        this.undoStack[this.undoStack.length - 1] = {
          ...last,
          patches: [...last.patches, ...patches],
          inverse: [...inverse, ...last.inverse],
          at: now.getTime(),
        };
      } else this.undoStack.push({ type, label, patches, inverse, mergeKey, at: now.getTime() });
      this.redoStack = [];
      return next;
    });
  }

  async undo(): Promise<PlannerFile | null> {
    const step = this.undoStack.at(-1);
    if (!step) return null;
    return this.write({ kind: 'undo', type: step.type, label: step.label }, (current) => {
      this.undoStack.pop();
      this.redoStack.push({ ...step, mergeKey: undefined });
      return applyPatches(current, step.inverse);
    });
  }

  async redo(): Promise<PlannerFile | null> {
    const step = this.redoStack.at(-1);
    if (!step) return null;
    return this.write({ kind: 'redo', type: step.type, label: step.label }, (current) => {
      this.redoStack.pop();
      this.undoStack.push(step);
      return applyPatches(current, step.patches);
    });
  }

  private forgetHistory() {
    this.undoStack = [];
    this.redoStack = [];
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async read(): Promise<{ file: PlannerFile; text: string }> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file: emptyFile(), text: '' };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new PlannerOpenError(this.file, 'not valid JSON', { cause: err });
    }
    const parsed = PlannerFile.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new PlannerOpenError(this.file, `${first?.path.join('.')}: ${first?.message}`);
    }
    return { file: parsed.data, text };
  }

  /**
   * Read under the lock, let `fn` produce the next file (or null for no change), validate and
   * write it. Undo/redo (`kind` other than command) refuse when the file changed elsewhere.
   */
  private async write(
    change: PlannerChange,
    fn: (current: PlannerFile) => PlannerFile | null,
  ): Promise<PlannerFile> {
    const lock = await acquireLockWaiting(
      this.lockFile,
      this.opts.lockTimeoutMs ?? 5000,
      'the planner',
    );
    try {
      const { file: current, text } = await this.read();
      if (text !== this.seen) {
        this.forgetHistory();
        if (change.kind !== 'command') {
          this.snapshot = current;
          this.seen = text;
          throw new CommandError(
            change.type,
            `cannot ${change.kind}: the planner was changed elsewhere`,
          );
        }
      }
      const undo = [...this.undoStack];
      const redo = [...this.redoStack];
      try {
        const next = fn(current);
        if (!next) {
          this.snapshot = current;
          this.seen = text;
          return current;
        }
        const checked = PlannerFile.safeParse(next);
        if (!checked.success)
          throw new CommandError(
            change.type,
            'the planner would be invalid',
            checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        const out = `${JSON.stringify(checked.data, null, 2)}\n`;
        await writeFileAtomic(this.file, out);
        this.snapshot = checked.data;
        this.seen = out;
        this.opts.onChange?.(checked.data, change);
        return checked.data;
      } catch (err) {
        this.undoStack = undo;
        this.redoStack = redo;
        throw err;
      }
    } finally {
      await lock.release();
    }
  }
}
