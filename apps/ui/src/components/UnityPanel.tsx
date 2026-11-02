import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { parsePaths } from '../footage-view.js';
import { BrowseButton } from './BrowseButton.js';

/** The pack file the Unity package reads, as written by "Write to the project folder". */
export function unityPackPath(projectDir: string): string {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  return [projectDir.replace(/[\\/]+$/, ''), 'exports', 'capture', 'capture-pack.json'].join(sep);
}

/**
 * Setup for recording shots straight from Unity: where the pack is, and the folder the Unity
 * package writes takes to, which TrailerForge watches so they are imported and matched by shot code.
 */
export function UnityPanel({ id }: { id: string }) {
  const store = useStore();
  const dir = useAppState((s) => s.projects[id]?.dir ?? '');
  const watched = useAppState((s) => s.watched);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void store.loadWatched();
  }, [store]);
  const pack = unityPackPath(dir);
  const watch = async (folder: string) => {
    const next = [...new Set([...(watched?.folders ?? []), folder])];
    if (await store.setWatched(next)) setText('');
  };

  return (
    <section className="card" aria-labelledby="cap-unity-h" data-testid="unity-panel">
      <h2 id="cap-unity-h">Record in Unity</h2>
      <p className="muted">
        With the TrailerForge Capture package in your Unity project, press Record on a shot there.
        Takes are saved with their shot code and imported here on their own. Nothing is sent over
        the network, and nothing is written into your game project.
      </p>
      <ol className="unity-steps">
        <li>
          In Unity: Package Manager → Add package from disk, then pick{' '}
          <code>integrations/unity/com.trailerforge.capture/package.json</code> from this
          repository.
        </li>
        <li>
          Write the data file above (Share the pack), then in Unity open Window → TrailerForge →
          Capture and choose it:
          <div className="row">
            <code data-testid="unity-pack-path">{pack}</code>
            <button
              type="button"
              disabled={!dir}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(pack)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy path'}
            </button>
          </div>
        </li>
        <li>Pick the folder Unity saves takes to, and have TrailerForge watch it:</li>
      </ol>
      {watched && watched.folders.length > 0 && (
        <p className="muted">
          Watched now:{' '}
          {watched.folders.map((f) => (
            <code key={f}>{f} </code>
          ))}
        </p>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const [first] = parsePaths(text);
          if (first) void watch(first);
        }}
      >
        <label className="field grow">
          <span>Unity recordings folder</span>
          <input
            type="text"
            value={text}
            placeholder="C:\Users\you\Videos\TrailerForge"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <BrowseButton label="Browse for a folder…" onPick={(p) => void watch(p)} />
        <button type="submit" disabled={parsePaths(text).length === 0}>
          Watch this folder
        </button>
      </form>
      <p className="muted">
        Use the same folder in Unity&apos;s Capture window. Only takes recorded after the folder is
        added are imported; use Footage → Add recordings for ones already there.
      </p>
    </section>
  );
}
