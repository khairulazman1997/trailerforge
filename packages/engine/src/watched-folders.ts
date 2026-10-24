import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomic } from '@trailerforge/core';
import type { FolderWatcher, Ingestor } from '@trailerforge/ingest';
import { z } from 'zod';
import { OpError } from './ops.js';

const Settings = z.strictObject({
  version: z.literal(1),
  folders: z.array(z.string().min(1)).max(20),
});

export interface WatchedFoldersView {
  folders: string[];
  watching: boolean;
  /** Last problem per folder since the list was saved (for example an unplugged drive). */
  problems: { folder: string; message: string }[];
}

/**
 * Folders whose new recordings are imported on their own (app-wide, like the library). The list
 * lives in `<home>/watched-folders.json`; what was already offered lives in the watcher's state
 * file, so a restart neither re-imports old files nor misses ones recorded while the app was shut.
 * Only files that appear after a folder is added are imported.
 */
export class WatchedFolders {
  private folders: string[] = [];
  private watcher: FolderWatcher | null = null;
  private readonly problems = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly ingestor: Ingestor,
    private readonly intervalMs?: number,
  ) {}

  private get settingsFile() {
    return join(this.home, 'watched-folders.json');
  }

  /** Read the saved list and start watching it. A malformed file is reported, not fatal. */
  async start(): Promise<void> {
    try {
      this.folders = Settings.parse(JSON.parse(await readFile(this.settingsFile, 'utf8'))).folders;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.problems.set('', `watched-folders.json is unreadable: ${(err as Error).message}`);
      this.folders = [];
    }
    this.restart();
  }

  async stop(): Promise<void> {
    const w = this.watcher;
    this.watcher = null;
    await w?.stop();
  }

  view(): WatchedFoldersView {
    return {
      folders: [...this.folders],
      watching: this.watcher !== null,
      problems: [...this.problems].map(([folder, message]) => ({ folder, message })),
    };
  }

  /** Replace the list (absolute paths of existing folders), save it and restart the watcher. */
  async set(folders: string[]): Promise<WatchedFoldersView> {
    const clean: string[] = [];
    for (const f of folders) {
      if (!isAbsolute(f)) throw new OpError('usage', `not an absolute path: ${f}`);
      const full = resolve(f);
      const s = await stat(full).catch(() => null);
      if (!s?.isDirectory()) throw new OpError('not-found', `no such folder: ${full}`);
      if (!clean.includes(full)) clean.push(full);
    }
    const parsed = Settings.safeParse({ version: 1, folders: clean });
    if (!parsed.success) throw new OpError('usage', 'at most 20 watched folders');
    await this.stop();
    await writeFileAtomic(this.settingsFile, `${JSON.stringify(parsed.data, null, 2)}\n`);
    this.folders = clean;
    this.problems.clear();
    this.restart();
    return this.view();
  }

  private restart(): void {
    if (this.folders.length === 0) return;
    const w = this.ingestor.watch({
      folders: this.folders,
      stateFile: join(this.home, 'watch-state.json'),
      ...(this.intervalMs !== undefined ? { intervalMs: this.intervalMs } : {}),
      onError: (error, { folder }) =>
        this.problems.set(folder, error instanceof Error ? error.message : String(error)),
    });
    this.watcher = w;
    w.start();
  }
}
