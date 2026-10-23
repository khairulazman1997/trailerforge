import { useEffect } from 'react';
import { useAppState, useStore } from './app-context.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Toasts } from './components/Toasts.js';
import { clearConnection } from './connection.js';
import { ConnectPage } from './pages/Connect.js';
import { HomePage } from './pages/Home.js';
import { ProjectPage } from './pages/Project.js';
import { SettingsPage } from './pages/Settings.js';
import { Link, projectPath, useRoute } from './router.js';
import { busyTask, type AppStore, type ConnectionStatus } from './store.js';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Connection failed',
};

export function App() {
  const store = useStore();
  const status = useAppState((s) => s.status);
  const error = useAppState((s) => s.error);

  let body;
  if (status === 'idle' || status === 'failed') {
    body = (
      <ConnectPage
        error={status === 'failed' ? error : null}
        onConnect={(c) => void store.connect(c)}
      />
    );
  } else if (status === 'connecting') {
    body = (
      <main className="page narrow" role="status">
        <p>Connecting…</p>
      </main>
    );
  } else {
    body = <Shell store={store} />;
  }
  return (
    <ErrorBoundary>
      {body}
      <Toasts />
    </ErrorBoundary>
  );
}

function Shell({ store }: { store: AppStore }) {
  const route = useRoute();
  const status = useAppState((s) => s.status);
  const current = route.name === 'project' ? route.id : null;
  const view = useAppState((s) => (current ? s.projects[current] : undefined));
  const busy = useAppState((s) => (current ? busyTask(s, current) : undefined));

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y) undo/redo the open project, except while typing,
  // where the text field's own undo should win.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) void store.undo(current);
      else if ((k === 'z' && e.shiftKey) || k === 'y') void store.redo(current);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, store]);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          TrailerForge
        </Link>
        <nav aria-label="Main">
          <Link to="/" aria-current={route.name === 'home' ? 'page' : undefined}>
            Projects
          </Link>
          {view && (
            <Link
              to={projectPath(view.id)}
              aria-current={route.name === 'project' ? 'page' : undefined}
            >
              {view.project.name}
            </Link>
          )}
          <Link to="/settings" aria-current={route.name === 'settings' ? 'page' : undefined}>
            Settings
          </Link>
        </nav>
        <span className="spacer" />
        {view && (
          <div className="row" role="group" aria-label="History">
            <button
              type="button"
              className="ghost"
              title="Undo (Ctrl+Z)"
              disabled={!view.canUndo || !!busy}
              onClick={() => void store.undo(view.id)}
            >
              ↶ Undo
            </button>
            <button
              type="button"
              className="ghost"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!view.canRedo || !!busy}
              onClick={() => void store.redo(view.id)}
            >
              ↷ Redo
            </button>
          </div>
        )}
        <span className={`status ${status}`} role="status" data-testid="connection-status">
          <span className="dot" aria-hidden="true" />
          {STATUS_TEXT[status]}
        </span>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            clearConnection();
            store.disconnect();
            window.location.reload();
          }}
        >
          Disconnect
        </button>
      </header>
      {route.name === 'home' && <HomePage />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'project' && <ProjectPage id={route.id} tab={route.tab} />}
      {route.name === 'not-found' && (
        <main className="page">
          <h1>Page not found</h1>
          <Link to="/">Back to projects</Link>
        </main>
      )}
    </>
  );
}
