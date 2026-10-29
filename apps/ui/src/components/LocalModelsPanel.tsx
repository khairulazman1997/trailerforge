import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';

/**
 * Running the AI on this computer through Ollama: whether it is there, which models it has, and
 * sending every task to one of them (the "fully offline" routes). Nothing is sent anywhere else.
 */
export function LocalModelsPanel() {
  const store = useStore();
  const local = useAppState((s) => s.localModels);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void store.loadLocalModels();
  }, [store]);
  if (!local) return null;
  const chosen =
    pick && local.models.includes(pick) ? pick : (local.offlineModel ?? local.models[0] ?? '');

  return (
    <section aria-labelledby="local-h" data-testid="local-models">
      <h2 id="local-h">AI on this computer (optional)</h2>
      <p className="muted">
        With{' '}
        <a href="https://ollama.com" target="_blank" rel="noreferrer">
          Ollama
        </a>{' '}
        installed, TrailerForge can use a model that runs on this computer. Nothing is sent to
        anyone, and it works offline. Local models are slower and less careful than the hosted ones,
        so expect to review and edit more.
      </p>
      {!local.available ? (
        <p>
          <span className="chip warn">Not available</span> <span>{local.reason}</span>
        </p>
      ) : (
        <>
          <p>
            <span className="chip ok">Running</span> at {local.url}
            {local.offlineModel && (
              <>
                {' '}
                &middot; every task uses <strong>{local.offlineModel}</strong>
              </>
            )}
          </p>
          <div className="row">
            <label className="field inline">
              <span>Model</span>
              <select value={chosen} onChange={(e) => setPick(e.target.value)}>
                {local.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy || !chosen || local.offlineModel === chosen}
              onClick={() => {
                setBusy(true);
                void store.useOfflineRoutes(chosen).finally(() => setBusy(false));
              }}
            >
              Use it for everything
            </button>
          </div>
          <p className="hint">
            This changes every task&rsquo;s route to this model and keeps only copy-to-chat as a
            fallback. &ldquo;Reset routes&rdquo; below goes back to the defaults.
          </p>
        </>
      )}
    </section>
  );
}
