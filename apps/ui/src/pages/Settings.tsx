import { useAppState } from '../app-context.js';

export function SettingsPage() {
  const info = useAppState((s) => s.info);
  return (
    <main className="page narrow">
      <h1>Settings</h1>
      <p className="muted">Providers, API keys and model routes will live here.</p>
      <h2>Engine</h2>
      <dl className="facts" aria-label="Engine">
        <div>
          <dt>API version</dt>
          <dd>{info?.apiVersion ?? '–'}</dd>
        </div>
        <div>
          <dt>Video types</dt>
          <dd>{info?.videoTypes.length ?? 0}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>{info?.commands.length ?? 0}</dd>
        </div>
      </dl>
    </main>
  );
}
