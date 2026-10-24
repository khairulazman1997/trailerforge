import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';

/**
 * Connects Claude Code to TrailerForge's tools (an MCP server), so it can read and edit a
 * project from the terminal. One click registers it; the command is shown for anyone who would
 * rather run it themselves.
 */
export function ClaudeCodePanel() {
  const store = useStore();
  const cc = useAppState((s) => s.claudeCode);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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

  return (
    <section aria-labelledby="cc-h" data-testid="claude-code-panel">
      <h2 id="cc-h">Claude Code</h2>
      <p className="muted">
        Lets Claude Code in your terminal read and edit your projects: show the capture checklist,
        change the storyboard, scan the game repo. Edits are saved at once and can be undone. Claude
        Code can never add footage, and cannot run the deep repo scan.
      </p>
      <p>
        {!cc.installed ? (
          <span className="chip warn">Claude Code not found</span>
        ) : cc.connected ? (
          <span className="chip ok">Connected</span>
        ) : (
          <span className="chip">Not connected</span>
        )}
      </p>
      {!cc.installed && (
        <p className="muted">
          Neither the claude command nor Claude Code's settings file was found. Install and open
          Claude Code once, then come back.
        </p>
      )}
      {cc.canConnect ? (
        <div className="row">
          <button
            type="button"
            disabled={busy || !cc.installed}
            onClick={() => void work(() => store.connectClaudeCode())}
          >
            {cc.connected ? 'Reconnect' : 'Connect Claude Code'}
          </button>
          {cc.connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void work(() => store.disconnectClaudeCode())}
            >
              Disconnect
            </button>
          )}
        </div>
      ) : (
        <p className="muted">
          This copy of TrailerForge does not include the command-line tool Claude Code needs.
        </p>
      )}
      {cc.command && (
        <details>
          <summary>Run it yourself instead</summary>
          <p className="muted">Paste this in a terminal:</p>
          <pre className="cc-command">
            <code>{cc.command}</code>
          </pre>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(cc.command!)
                .then(() => setCopied(true))
                .catch(() =>
                  store.toast('error', 'Could not copy. Select the command and copy it.'),
                );
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </details>
      )}
      <p className="muted">
        A project can be open in only one place at a time. If Claude Code reports that a project is
        locked, close it in TrailerForge first (or the other way round).
      </p>
    </section>
  );
}
