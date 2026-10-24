import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writeFileAtomic } from '@trailerforge/core';
import { collectMediaFiles } from './files.js';

export interface WatchedFile {
  path: string;
  folder: string;
  sizeBytes: number;
}

export interface FolderWatcherOptions {
  folders: string[];
  /** Called once per finished file. If it throws, the file is offered again on the next poll. */
  onReady: (file: WatchedFile) => void | Promise<void>;
  onError?: (error: unknown, context: { folder: string; path?: string }) => void;
  /**
   * Remembers what was already offered, so a restart does not offer it again. Without it the
   * watcher forgets on restart (the library still dedupes by content).
   */
  stateFile?: string;
  /**
   * Offer files already in a folder the first time it is watched. Default false: only files that
   * appear afterwards, so pointing the watcher at a folder of old recordings does not import them.
   */
  includeExisting?: boolean;
  /** Milliseconds between polls (default 2,000). */
  intervalMs?: number;
  /** A file is finished when its size and modified time were the same on this many polls in a row (default 3). */
  stableChecks?: number;
  maxFiles?: number;
  maxDepth?: number;
}

interface FolderState {
  baselined: boolean;
  /** relative path (as listed) -> "size:mtimeMs" at the time it was offered or baselined. */
  announced: Record<string, string>;
}
interface WatchState {
  version: 1;
  folders: Record<string, FolderState>;
}

/**
 * Watches folders by polling (file-system events are unreliable on network drives and for deep
 * folders). A recording still being written is not offered until it stops changing; a restart
 * neither misses files recorded while the app was closed nor offers old ones again.
 */
export class FolderWatcher {
  private readonly folders: string[];
  private state: WatchState | null = null;
  private readonly pending = new Map<string, { sig: string; seen: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling: Promise<void> | null = null;

  constructor(private readonly opts: FolderWatcherOptions) {
    this.folders = opts.folders.map((f) => resolve(f));
  }

  /** Begin polling now and every `intervalMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      this.polling = this.poll().catch((error) => this.opts.onError?.(error, { folder: '' }));
      await this.polling;
      if (this.running) this.timer = setTimeout(() => void loop(), this.opts.intervalMs ?? 2000);
    };
    void loop();
  }

  /** Stop polling and wait for a poll in progress. */
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.polling;
  }

  /** One pass over every folder. `start()` calls this on a timer; tests call it directly. */
  async poll(signal?: AbortSignal): Promise<void> {
    const state = await this.loadState();
    let dirty = false;
    for (const folder of this.folders) {
      signal?.throwIfAborted();
      try {
        dirty = (await this.pollFolder(folder, state, signal)) || dirty;
      } catch (error) {
        if (signal?.aborted) throw error;
        this.opts.onError?.(error, { folder }); // for example an unplugged drive: try again later
      }
    }
    if (dirty) await this.saveState(state);
  }

  private async pollFolder(
    folder: string,
    state: WatchState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const found = await collectMediaFiles([folder], {
      ...(signal ? { signal } : {}),
      ...(this.opts.maxFiles ? { maxFiles: this.opts.maxFiles } : { maxFiles: 20_000 }),
      maxDepth: this.opts.maxDepth ?? 6,
    });
    if (found.skipped.some((s) => s.path === folder && s.reason !== 'unreadable')) {
      throw new Error(`watched folder is not available: ${folder}`);
    }
    if (found.skipped.some((s) => s.path === folder))
      throw new Error(`cannot read watched folder: ${folder}`);

    const fs = (state.folders[folder] ??= { baselined: false, announced: {} });
    const baseline = !fs.baselined && !this.opts.includeExisting;
    const need = this.opts.stableChecks ?? 3;
    let dirty = false;
    const alive = new Set<string>();

    for (const path of found.files) {
      signal?.throwIfAborted();
      let st;
      try {
        st = await lstat(path);
      } catch {
        continue; // vanished between listing and now
      }
      const sig = `${st.size}:${st.mtimeMs}`;
      const rel = path.slice(folder.length);
      if (fs.announced[rel] === sig) continue;
      if (baseline) {
        fs.announced[rel] = sig;
        dirty = true;
        continue;
      }
      alive.add(path);
      const prev = this.pending.get(path);
      const seen = prev && prev.sig === sig ? prev.seen + 1 : 1;
      this.pending.set(path, { sig, seen });
      if (seen < need) continue;
      try {
        await this.opts.onReady({ path, folder, sizeBytes: st.size });
      } catch (error) {
        this.opts.onError?.(error, { folder, path });
        continue; // offered again next poll
      }
      fs.announced[rel] = sig;
      this.pending.delete(path);
      dirty = true;
    }
    for (const path of [...this.pending.keys()]) {
      if (path.startsWith(folder) && !alive.has(path)) this.pending.delete(path);
    }
    if (!fs.baselined) {
      fs.baselined = true;
      dirty = true;
    }
    return dirty;
  }

  private async loadState(): Promise<WatchState> {
    if (this.state) return this.state;
    let state: WatchState = { version: 1, folders: {} };
    if (this.opts.stateFile) {
      try {
        const parsed = JSON.parse(await readFile(this.opts.stateFile, 'utf8')) as WatchState;
        if (parsed.version === 1 && parsed.folders && typeof parsed.folders === 'object')
          state = parsed;
      } catch {
        // missing or unreadable: start fresh (the library dedupes by content anyway)
      }
    }
    this.state = state;
    return state;
  }

  private async saveState(state: WatchState): Promise<void> {
    if (!this.opts.stateFile) return;
    await mkdir(dirname(this.opts.stateFile), { recursive: true });
    await writeFileAtomic(this.opts.stateFile, `${JSON.stringify(state)}\n`);
  }
}
