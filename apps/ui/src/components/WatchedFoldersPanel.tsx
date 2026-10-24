import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { parsePaths } from '../footage-view.js';
import { BrowseButton } from './BrowseButton.js';

/**
 * Folders (such as OBS's output folder) whose new recordings are imported on their own. Only
 * recordings that appear after a folder is added are imported, never what is already there.
 */
export function WatchedFoldersPanel() {
  const store = useStore();
  const watched = useAppState((s) => s.watched);
  const [text, setText] = useState('');
  useEffect(() => {
    void store.loadWatched();
  }, [store]);
  if (!watched) return null;
  const add = async () => {
    const next = [...new Set([...watched.folders, ...parsePaths(text)])];
    if (await store.setWatched(next)) setText('');
  };

  return (
    <section aria-labelledby="watch-h" data-testid="watched-panel">
      <h2 id="watch-h">Watched folders</h2>
      <p className="muted">
        New recordings that finish in these folders are imported automatically. Files already there
        are left alone, and a recording still being written waits until it is complete.
      </p>
      {watched.folders.length === 0 ? (
        <p className="muted">No folders are watched.</p>
      ) : (
        <ul className="watched-list" aria-label="Watched folders">
          {watched.folders.map((f) => (
            <li key={f}>
              <code>{f}</code>
              <button
                type="button"
                aria-label={`Stop watching ${f}`}
                onClick={() => void store.setWatched(watched.folders.filter((x) => x !== f))}
              >
                Stop watching
              </button>
            </li>
          ))}
        </ul>
      )}
      {watched.problems.map((p) => (
        <p key={p.folder} className="banner warn" role="alert">
          {p.folder ? `${p.folder}: ` : ''}
          {p.message}
        </p>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="field grow">
          <span>Folder to watch</span>
          <input
            type="text"
            value={text}
            placeholder="C:\Users\you\Videos\OBS"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <BrowseButton
          label="Browse for a folder…"
          onPick={(p) => void store.setWatched([...new Set([...watched.folders, p])])}
        />
        <button type="submit" disabled={parsePaths(text).length === 0}>
          Watch this folder
        </button>
      </form>
    </section>
  );
}
