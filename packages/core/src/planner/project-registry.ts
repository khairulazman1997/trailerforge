import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  PROJECT_REGISTRY_SCHEMA_VERSION,
  ProjectRegistryFile,
  type RegisteredProject,
} from '@trailerforge/schema';
import { cleanupTempFiles, writeFileAtomic } from '../store/fs-atomic.js';
import { projectPaths } from '../store/layout.js';
import { acquireLockWaiting } from '../store/lock.js';

/** Runtime state of a registered folder: never stored. */
export type RegisteredProjectState =
  | 'ok'
  /** The folder or its `project.json` is gone (moved or deleted). */
  | 'missing'
  /** The folder now holds a different project. */
  | 'replaced'
  /** `project.json` is there but cannot be read. */
  | 'unreadable';

export interface RegisteredProjectView extends RegisteredProject {
  state: RegisteredProjectState;
}

export interface ProjectRegistryOptions {
  lockTimeoutMs?: number;
  now?: () => Date;
}

/** Absolute, with a Windows drive letter upper-cased, so one folder has one key. */
export function normalizeProjectDir(dir: string): string {
  const abs = resolve(dir);
  return /^[a-z]:/.test(abs) ? abs[0]!.toUpperCase() + abs.slice(1) : abs;
}

/**
 * Every project folder the app has created or opened (`<home>/projects.json`), so the planner,
 * the CLI and MCP can find projects. Folders that moved or vanished are reported, never
 * dropped on their own: only `forget` removes an entry.
 */
export class ProjectRegistry {
  private snapshot: RegisteredProject[] = [];

  private constructor(
    readonly file: string,
    private readonly opts: ProjectRegistryOptions,
  ) {}

  static async open(home: string, opts: ProjectRegistryOptions = {}): Promise<ProjectRegistry> {
    const dir = resolve(home);
    await mkdir(dir, { recursive: true });
    const reg = new ProjectRegistry(join(dir, 'projects.json'), opts);
    await cleanupTempFiles(reg.file);
    await reg.reload();
    return reg;
  }

  async reload(): Promise<readonly RegisteredProject[]> {
    this.snapshot = (await this.read()).projects;
    return this.snapshot;
  }

  /** Most recently opened first. */
  list(): readonly RegisteredProject[] {
    return [...this.snapshot].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  /** The most recently opened folder with this id (a copied folder keeps its id). */
  byId(id: string): RegisteredProject | undefined {
    return this.list().find((p) => p.id === id);
  }

  byDir(dir: string): RegisteredProject | undefined {
    const key = normalizeProjectDir(dir);
    return this.snapshot.find((p) => p.dir === key);
  }

  /** `list()` with each folder checked on disk. */
  async views(): Promise<RegisteredProjectView[]> {
    return Promise.all(this.list().map(async (p) => ({ ...p, state: await folderState(p) })));
  }

  /** Add the folder, or refresh its id, name and last-opened time. */
  async register(entry: { id: string; dir: string; name: string }): Promise<RegisteredProject> {
    const dir = normalizeProjectDir(entry.dir);
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    let out!: RegisteredProject;
    await this.mutate((projects) => {
      const old = projects.find((p) => p.dir === dir);
      out = {
        id: entry.id,
        dir,
        name: entry.name,
        registeredAt: old?.registeredAt ?? now,
        lastOpenedAt: now,
      };
      return [...projects.filter((p) => p.dir !== dir), out];
    });
    return out;
  }

  /** Keep the entry's name in step with a rename, without touching its last-opened time. */
  async rename(dir: string, name: string): Promise<void> {
    const key = normalizeProjectDir(dir);
    await this.mutate((projects) => {
      const old = projects.find((p) => p.dir === key);
      if (!old || old.name === name) return null;
      return projects.map((p) => (p.dir === key ? { ...p, name } : p));
    });
  }

  /** Remove an entry (the folder itself is never touched). */
  async forget(dir: string): Promise<boolean> {
    const key = normalizeProjectDir(dir);
    let removed = false;
    await this.mutate((projects) => {
      removed = projects.some((p) => p.dir === key);
      return removed ? projects.filter((p) => p.dir !== key) : null;
    });
    return removed;
  }

  private async read(): Promise<ProjectRegistryFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] };
      throw err;
    }
    let parsed;
    try {
      parsed = ProjectRegistryFile.safeParse(JSON.parse(text));
    } catch (err) {
      throw new Error(`project list at ${this.file} is not valid JSON; it was left untouched`, {
        cause: err,
      });
    }
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `project list at ${this.file} is unreadable (${first?.path.join('.')}: ${first?.message}); it was left untouched`,
      );
    }
    return parsed.data;
  }

  private async mutate(
    fn: (projects: RegisteredProject[]) => RegisteredProject[] | null,
  ): Promise<void> {
    const lock = await acquireLockWaiting(
      `${this.file}.lock`,
      this.opts.lockTimeoutMs ?? 5000,
      'the project list',
    );
    try {
      const current = await this.read();
      const next = fn(current.projects);
      if (next) {
        const file = ProjectRegistryFile.parse({
          schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
          projects: next,
        });
        await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`);
        this.snapshot = file.projects;
      } else this.snapshot = current.projects;
    } finally {
      await lock.release();
    }
  }
}

async function folderState(p: RegisteredProject): Promise<RegisteredProjectState> {
  let text: string;
  try {
    text = await readFile(projectPaths(p.dir).projectFile, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const id = (JSON.parse(text) as { id?: unknown }).id;
    return id === p.id ? 'ok' : 'replaced';
  } catch {
    return 'unreadable';
  }
}
