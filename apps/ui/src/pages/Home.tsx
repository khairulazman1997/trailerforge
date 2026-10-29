import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { BrowseButton } from '../components/BrowseButton.js';
import { joinPath } from '../desktop.js';
import { Link, navigate, projectPath } from '../router.js';
import type { Info } from '../store.js';

/** Selectors must return stable values: a fresh [] each time would re-render forever. */
const NO_VIDEO_TYPES: Info['videoTypes'] = [];

const RECENT_KEY = 'tforge.recent';

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function remember(dir: string) {
  try {
    const next = [dir, ...readRecent().filter((d) => d !== dir)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: recents just won't persist
  }
}

export function HomePage() {
  const store = useStore();
  const projects = useAppState((s) => s.projects);
  const order = useAppState((s) => s.order);
  const videoTypes = useAppState((s) => s.info?.videoTypes ?? NO_VIDEO_TYPES);
  const [openDir, setOpenDir] = useState('');
  const [newDir, setNewDir] = useState('');
  const [name, setName] = useState('');
  const [videoType, setVideoType] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoing, setDemoing] = useState(false);
  const [recent, setRecent] = useState(readRecent);
  const health = useAppState((s) => s.health);
  useEffect(() => {
    if (!health) void store.loadHealth();
  }, [store, health]);

  const open = async (dir: string) => {
    setBusy(true);
    const id = await store.openProject(dir);
    setBusy(false);
    if (id) {
      remember(dir);
      setRecent(readRecent());
      navigate(projectPath(id));
    }
  };

  return (
    <main className="page">
      <h1>Projects</h1>
      {health && !health.ready && (
        <p className="banner warn" role="status" data-testid="setup-banner">
          Something needs attention before you start:{' '}
          {health.checks
            .filter((c) => c.status === 'fail')
            .map((c) => c.title)
            .join(', ')}
          . <Link to="/setup">Open Setup</Link>
        </p>
      )}
      {order.length > 0 && (
        <section aria-labelledby="open-heading">
          <h2 id="open-heading">Open now</h2>
          <ul className="cards">
            {order.map((id) => {
              const p = projects[id]!;
              return (
                <li key={id} className="card">
                  <Link to={projectPath(id)}>{p.project.name}</Link>
                  <small>{p.dir}</small>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="demo-heading" className="demo-offer">
        <h2 id="demo-heading">New here?</h2>
        <p>
          Try a demo: a small finished project with a storyboard, recordings, a cut on the music and
          two versions, so you can look around every tab. It is made on this computer from invented
          footage and generated music; nothing is downloaded or sent anywhere.
        </p>
        <button
          type="button"
          className="primary"
          disabled={busy || demoing}
          onClick={() => {
            setDemoing(true);
            void store
              .createDemo()
              .then((id) => id && navigate(projectPath(id)))
              .finally(() => setDemoing(false));
          }}
        >
          {demoing ? 'Building the demo…' : 'Try a demo'}
        </button>
        {demoing && (
          <p role="status" className="muted">
            Making the footage and music and cutting them. This takes about half a minute.
          </p>
        )}
      </section>

      <div className="two-col">
        <section aria-labelledby="open-form">
          <h2 id="open-form">Open a project</h2>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void open(openDir.trim());
            }}
          >
            <label>
              Project folder
              <input
                value={openDir}
                onChange={(e) => setOpenDir(e.target.value)}
                placeholder="/path/to/MyGame.tforge"
                spellCheck={false}
              />
            </label>
            <div className="row">
              <BrowseButton
                label="Browse for a project…"
                disabled={busy}
                onPick={(p) => {
                  setOpenDir(p);
                  void open(p);
                }}
              />
              <button type="submit" className="primary" disabled={busy || !openDir.trim()}>
                Open
              </button>
            </div>
          </form>
          {recent.length > 0 && (
            <>
              <h3>Recent</h3>
              <ul className="recent">
                {recent.map((d) => (
                  <li key={d}>
                    <button type="button" className="link" onClick={() => void open(d)}>
                      {d}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="new-form">
          <h2 id="new-form">New project</h2>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                setBusy(true);
                const id = await store.createProject({
                  dir: newDir.trim(),
                  name: name.trim(),
                  ...(videoType ? { videoTypeId: videoType } : {}),
                });
                setBusy(false);
                if (id) {
                  remember(newDir.trim());
                  setRecent(readRecent());
                  navigate(projectPath(id));
                }
              })();
            }}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ember Knight"
              />
            </label>
            <label>
              Video type
              <select value={videoType} onChange={(e) => setVideoType(e.target.value)}>
                <option value="">Choose later</option>
                {videoTypes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project folder (will be created)
              <input
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                placeholder="/path/to/MyGame.tforge"
                spellCheck={false}
              />
            </label>
            <BrowseButton
              label="Choose where to put it…"
              disabled={busy || !name.trim()}
              onPick={(parent) => setNewDir(joinPath(parent, `${name.trim()}.tforge`))}
            />
            <button
              type="submit"
              className="primary"
              disabled={busy || !name.trim() || !newDir.trim()}
            >
              Create
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
