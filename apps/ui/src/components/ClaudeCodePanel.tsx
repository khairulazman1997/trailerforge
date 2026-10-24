import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';

/**
 * Connects Claude Code to TrailerForge's tools (MCP). By default Claude Code talks to this app
 * while it is open: it works on the project open here, its edits appear at once, and undo covers
 * both. The separate tool (Claude Code starts its own copy) is there for working with the app shut.
 */
export function ClaudeCodePanel() {
  const store = useStore();
  const cc = useAppState((s) => s.claudeCode);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void store.loadClaudeCode();
  }, [store]);
  if (!cc) return null;
  const work = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const canApp = cc.available.includes('app');
  const canStandalone = cc.available.includes('standalone');

  return (
    <section aria-labelledby="cc-h" data-testid="claude-code-panel">
      <h2 id="cc-h">Claude Code</h2>
      <p className="muted">
        Lets Claude Code read and edit your projects: show the capture checklist, change the
        storyboard, scan the game repo. With one project open here, just ask; it works on that one.
        Its edits show up here at once and Undo covers them. It can never add footage or run the
        deep repo scan.
      </p>
      <p data-testid="claude-code-state">
        {!cc.installed ? (
          <span className="chip warn">Claude Code not found</span>
        ) : !cc.mode ? (
          <span className="chip">Not connected</span>
        ) : !cc.upToDate ? (
          <span className="chip warn">Needs reconnecting</span>
        ) : cc.mode === 'app' ? (
          <span className="chip ok">Connected to this app</span>
        ) : (
          <span className="chip ok">Connected (separate tool)</span>
        )}
      </p>
      {!cc.installed && (
        <p className="muted">
          Claude Code&rsquo;s settings were not found. Install Claude Code and open it once, then
          come back.
        </p>
      )}
      {cc.mode && !cc.upToDate && (
        <p className="muted">
          This app now runs at a different address (or moved), so Claude Code would not reach it.
        </p>
      )}
      <div className="row">
        {canApp && (
          <button
            type="button"
            className={cc.mode === 'app' && cc.upToDate ? '' : 'primary'}
            disabled={busy || !cc.installed}
            onClick={() => void work(() => store.connectClaudeCode('app'))}
          >
            {cc.mode === 'app' ? 'Reconnect' : 'Connect Claude Code'}
          </button>
        )}
        {cc.mode && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void work(() => store.disconnectClaudeCode())}
          >
            Disconnect
          </button>
        )}
      </div>
      <p className="muted">
        After connecting, start a new Claude Code session. Claude Code reaches TrailerForge while
        this app is open.
      </p>
      {canStandalone && (
        <details>
          <summary>Use Claude Code while this app is closed</summary>
          <p className="muted">
            Claude Code can instead start its own copy of TrailerForge. That works with the app
            closed, but a project open here is then locked for Claude Code, and you name the project
            folder in each request.
          </p>
          <button
            type="button"
            disabled={busy || !cc.installed || cc.mode === 'standalone'}
            onClick={() => void work(() => store.connectClaudeCode('standalone'))}
          >
            Use the separate tool instead
          </button>
        </details>
      )}
    </section>
  );
}
