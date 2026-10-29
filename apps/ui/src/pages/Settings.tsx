import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { ClaudeCodePanel } from '../components/ClaudeCodePanel.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { LocalModelsPanel } from '../components/LocalModelsPanel.js';
import { RoutesEditor } from '../components/RoutesEditor.js';
import { VisionPanel } from '../components/VisionPanel.js';
import { SavedTypesPanel } from '../components/SavedTypesPanel.js';
import { WatchedFoldersPanel } from '../components/WatchedFoldersPanel.js';

export function SettingsPage() {
  const store = useStore();
  const info = useAppState((s) => s.info);
  const settings = useAppState((s) => s.settings);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    void store.loadSettings();
  }, [store]);

  const keyState = settings?.secrets.anthropicApiKey;

  return (
    <main className="page narrow-ish">
      <h1>Settings</h1>

      <section aria-labelledby="providers-h">
        <h2 id="providers-h">AI providers</h2>
        <p className="muted">
          TrailerForge can use several ways of getting AI help. Whichever you use, game facts you
          excluded are never sent.
        </p>
        {!settings ? (
          <p role="status">Loading…</p>
        ) : (
          <ul className="providers" aria-label="AI providers">
            {settings.providers.map((p) => (
              <li key={p.id} data-provider={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <br />
                  <small>
                    {p.sendsDataOffDevice
                      ? 'Sends your request to another service'
                      : p.kind === 'interactive'
                        ? 'You copy and paste; nothing is sent automatically'
                        : 'Stays on this computer'}
                  </small>
                </div>
                <span className={`chip ${p.available.ok ? 'ok' : 'warn'}`}>
                  {p.available.ok ? 'Available' : 'Unavailable'}
                </span>
                {!p.available.ok && <small className="reason">{p.available.reason}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="key-h">
        <h2 id="key-h">Anthropic API key</h2>
        {keyState && (
          <p data-testid="key-state">
            {keyState.set
              ? keyState.source === 'stored'
                ? 'A key is saved in settings.'
                : 'Using the key from the ANTHROPIC_API_KEY environment variable.'
              : 'No key yet.'}{' '}
            <small className="muted">Stored in {settings?.secrets.storage}.</small>
          </p>
        )}
        <form
          className="row add-repo"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              // Clear the box at once so the key does not linger on screen; put it back if the
              // save fails, so nothing has to be typed again.
              const value = key.trim();
              setKey('');
              setSaving(true);
              if (!(await store.setApiKey(value))) setKey(value);
              setSaving(false);
            })();
          }}
        >
          <label className="grow">
            {keyState?.source === 'stored' ? 'Replace the key' : 'Paste your key'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-…"
            />
          </label>
          <button type="submit" className="primary" disabled={saving || !key.trim()}>
            Save key
          </button>
          {keyState?.source === 'stored' && (
            <button type="button" className="danger" onClick={() => void store.clearApiKey()}>
              Remove key
            </button>
          )}
        </form>
        <p className="hint">
          The key is sent to this app&apos;s local service once and is never shown again. Using it
          sends your requests to Anthropic. A key in the environment is used when none is saved
          here.
        </p>
      </section>

      <LocalModelsPanel />
      <ClaudeCodePanel />
      <WatchedFoldersPanel />
      <SavedTypesPanel />
      <VisionPanel />

      <section aria-labelledby="routes-h">
        <h2 id="routes-h">
          Which provider does what{' '}
          {settings?.routes.custom && <span className="chip info">Customised</span>}
        </h2>
        <p className="muted">
          Pick the provider, model and effort for each kind of request. Changes apply straight away.
        </p>
        {settings && (
          <RoutesEditor
            key={JSON.stringify(settings.routes.config)}
            view={settings.routes}
            providers={settings.providers}
            onSave={(config) => store.saveRoutes(config)}
            onReset={() => setConfirmReset(true)}
          />
        )}
      </section>

      <section aria-labelledby="engine-h">
        <h2 id="engine-h">Engine</h2>
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
      </section>

      <ConfirmDialog
        open={confirmReset}
        title="Reset routes to the defaults?"
        confirmLabel="Reset routes"
        tone="danger"
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          await store.resetRoutes();
          setConfirmReset(false);
        }}
      >
        <p>
          Your custom provider, model and effort choices are removed and the built-in ones are used
          again.
        </p>
      </ConfirmDialog>
    </main>
  );
}
