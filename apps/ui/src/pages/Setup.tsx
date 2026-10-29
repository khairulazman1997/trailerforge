import { useEffect, useState } from 'react';
import type { HealthCheck } from '@trailerforge/service/client';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { Link } from '../router.js';

const LABEL: Record<HealthCheck['status'], string> = {
  ok: 'Ready',
  info: 'Note',
  warn: 'Check',
  fail: 'Needs attention',
};
const CHIP: Record<HealthCheck['status'], string> = {
  ok: 'ok',
  info: 'info',
  warn: 'warn',
  fail: 'warn',
};

/**
 * Is this computer ready? What each part is, whether it works, and what to do when it does not.
 * Everything here only reads; the one thing that downloads (the analysis tools) asks first and
 * shows its size and source.
 */
export function SetupPage() {
  const store = useStore();
  const health = useAppState((s) => s.health);
  const setup = useAppState((s) => s.analysisSetup);
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState(false);

  const check = async () => {
    setChecking(true);
    await store.loadHealth();
    setChecking(false);
  };
  useEffect(() => {
    void store.loadHealth();
  }, [store]);

  const d = health?.sidecarSetup;
  return (
    <main className="page narrow-ish">
      <h1>Setup</h1>
      <p className="muted">
        What TrailerForge needs on this computer, and whether it is there. Nothing here changes
        anything or sends anything anywhere.
      </p>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        {health && (
          <span
            role="status"
            className={`chip ${health.ready ? 'ok' : 'warn'}`}
            data-testid="setup-verdict"
          >
            {health.ready ? 'Ready to use' : 'Something needs attention'}
          </span>
        )}
      </div>

      {!health ? (
        <p role="status">Checking this computer…</p>
      ) : (
        <ul className="providers" aria-label="Setup checks">
          {health.checks.map((c) => (
            <li key={c.id} data-check={c.id} data-status={c.status}>
              <div>
                <strong>{c.title}</strong>
                <br />
                <small>{c.detail}</small>
                {c.status !== 'ok' && c.fix && (
                  <>
                    <br />
                    <small data-testid={`fix-${c.id}`}>→ {c.fix}</small>
                  </>
                )}
              </div>
              <span className={`chip ${CHIP[c.status]}`}>{LABEL[c.status]}</span>
              {c.action === 'setup-sidecar' && !setup && (
                <button type="button" className="primary" onClick={() => setAsking(true)}>
                  Create the analysis environment…
                </button>
              )}
              {c.action === 'open-settings' && c.status !== 'ok' && (
                <Link to="/settings">Open Settings</Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {setup && (
        <section aria-label="Creating the analysis environment" data-testid="setup-progress">
          <h2>Creating the analysis environment</h2>
          <p className="muted">This takes a few minutes and runs once.</p>
          <pre className="wire" aria-live="polite" tabIndex={0}>
            {setup.lines.length ? setup.lines.join('\n') : 'Starting…'}
          </pre>
          <button type="button" onClick={() => void store.cancelAnalysisSetup()}>
            Cancel
          </button>
        </section>
      )}

      <ConfirmDialog
        open={asking}
        title="Create the analysis environment?"
        confirmLabel="Download and set up"
        onCancel={() => setAsking(false)}
        onConfirm={async () => {
          setAsking(false);
          await store.startAnalysisSetup();
        }}
      >
        <div className="stack" data-testid="setup-disclosure">
          <p>{d?.what}</p>
          <ul>
            <li>
              Download: about <strong>{d?.approxMegabytes} MB</strong>, once.
            </li>
            <li>
              From: <strong>{d?.source}</strong>. This is a one-time setup step, not something the
              app does while you work; it is written to the network log.
            </li>
            <li>No footage, project data or personal information is sent.</li>
          </ul>
        </div>
      </ConfirmDialog>
    </main>
  );
}
