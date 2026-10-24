import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FolderWatcher, type FolderWatcherOptions } from './watcher.js';

let root: string;
let rec: string;
let offered: string[];
let errors: unknown[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-watch-'));
  rec = join(root, 'obs');
  await mkdir(rec);
  offered = [];
  errors = [];
});

const watcher = (extra: Partial<FolderWatcherOptions> = {}) =>
  new FolderWatcher({
    folders: [rec],
    stableChecks: 2,
    onReady: (f) => void offered.push(f.path.slice(rec.length + 1)),
    onError: (e) => void errors.push(e),
    ...extra,
  });
const polls = async (w: FolderWatcher, n: number) => {
  for (let i = 0; i < n; i++) await w.poll();
};

describe('FolderWatcher', () => {
  it('ignores what was already there, then offers a new recording exactly once', async () => {
    await writeFile(join(rec, 'old.mp4'), 'old');
    const w = watcher();
    await polls(w, 3);
    expect(offered).toEqual([]);
    await writeFile(join(rec, 'new.mkv'), 'new recording');
    await w.poll();
    expect(offered).toEqual([]); // seen once: not yet known to be finished
    await polls(w, 5);
    expect(offered).toEqual(['new.mkv']);
  });

  it('waits for a growing file to stop growing', async () => {
    const w = watcher({ stableChecks: 3 });
    await w.poll(); // baseline of the empty folder
    const file = join(rec, 'long.mp4');
    await writeFile(file, 'a');
    for (let i = 0; i < 6; i++) {
      await w.poll();
      await appendFile(file, 'more');
    }
    expect(offered).toEqual([]);
    await polls(w, 4);
    expect(offered).toEqual(['long.mp4']);
  });

  it('finds recordings in subfolders and skips temp files, dot folders and other types', async () => {
    const w = watcher();
    await w.poll();
    await mkdir(join(rec, 'session 1'));
    await mkdir(join(rec, '.trash'));
    await writeFile(join(rec, 'session 1', 'a.mp4'), 'a');
    await writeFile(join(rec, 'session 1', 'b.mp4.part'), 'b');
    await writeFile(join(rec, '.trash', 'c.mp4'), 'c');
    await writeFile(join(rec, 'readme.txt'), 'd');
    await polls(w, 4);
    expect(offered).toEqual([join('session 1', 'a.mp4')]);
  });

  it('remembers across restarts: no repeats, and nothing recorded while closed is missed', async () => {
    const stateFile = join(root, 'state', 'watch.json');
    await writeFile(join(rec, 'old.mp4'), 'old');
    const first = watcher({ stateFile });
    await polls(first, 2);
    await writeFile(join(rec, 'one.mp4'), 'one');
    await polls(first, 4);
    expect(offered).toEqual(['one.mp4']);

    await writeFile(join(rec, 'while-closed.mp4'), 'two'); // app not running
    const second = watcher({ stateFile });
    await polls(second, 4);
    expect(offered).toEqual(['one.mp4', 'while-closed.mp4']);
  });

  it('can offer files that were already there, when asked', async () => {
    await writeFile(join(rec, 'old.mp4'), 'old');
    await polls(watcher({ includeExisting: true }), 3);
    expect(offered).toEqual(['old.mp4']);
  });

  it('offers a file again if handing it over failed', async () => {
    let fail = true;
    const w = watcher({
      onReady: (f) => {
        if (fail) throw new Error('queue is busy');
        offered.push(f.path);
      },
    });
    await w.poll();
    await writeFile(join(rec, 'a.mp4'), 'a');
    await polls(w, 3);
    expect(errors).toHaveLength(2); // polls 2 and 3 tried and failed
    fail = false;
    await polls(w, 2);
    expect(offered).toHaveLength(1);
  });

  it('survives a folder that is not there (unplugged drive) and picks it up later', async () => {
    const gone = join(root, 'external');
    const w = watcher({ folders: [gone] });
    await polls(w, 2);
    expect(errors).toHaveLength(2);
    await mkdir(gone);
    await w.poll(); // baseline
    await writeFile(join(gone, 'a.mp4'), 'a');
    await polls(w, 3);
    expect(offered.map((p) => p.endsWith('a.mp4'))).toEqual([true]);
  });

  it('start and stop run polls on a timer', async () => {
    const w = watcher({ intervalMs: 10, stableChecks: 2 });
    w.start();
    await new Promise((r) => setTimeout(r, 40));
    await writeFile(join(rec, 'a.mp4'), 'a');
    for (let i = 0; i < 100 && offered.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    expect(offered).toEqual(['a.mp4']);
  });
});
