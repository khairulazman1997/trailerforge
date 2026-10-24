import { useState } from 'react';
import type { CaptureTipsEntry } from '@trailerforge/pack-game-trailer/browser';

export type TipsStatus = 'fresh' | 'stale' | 'edited' | null;

const STATUS_TEXT: Record<Exclude<TipsStatus, null>, string> = {
  fresh: 'Up to date',
  stale: 'Out of date',
  edited: 'Edited by you',
};

const MAX_LINES = 8;
const toLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Tips and risk notes for one capture group: show, edit by hand, write again or remove. */
export function CaptureTipsBlock({
  groupName,
  entry,
  status,
  disabled,
  onWrite,
  onSave,
  onRemove,
}: {
  groupName: string;
  entry: CaptureTipsEntry | null;
  status: TipsStatus;
  disabled: boolean;
  onWrite: () => void;
  onSave: (tips: string[], risks: string[]) => Promise<unknown>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tips, setTips] = useState('');
  const [risks, setRisks] = useState('');
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setTips((entry?.tips ?? []).join('\n'));
    setRisks((entry?.risks ?? []).join('\n'));
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const t = toLines(tips);
    const r = toLines(risks);
    if (t.length > MAX_LINES || r.length > MAX_LINES) {
      setError(`Keep it to ${MAX_LINES} lines each.`);
      return;
    }
    await onSave(t, r);
    setEditing(false);
  };
  const has = !!entry && (entry.tips.length > 0 || entry.risks.length > 0);

  return (
    <section className="cap-tips" aria-label={`Tips for ${groupName}`}>
      <div className="row">
        <h3>Tips</h3>
        {status && (
          <span className={`chip ${status === 'stale' ? 'warn' : ''}`}>{STATUS_TEXT[status]}</span>
        )}
        <span className="spacer" />
        {!editing && (
          <>
            <button type="button" disabled={disabled} onClick={onWrite}>
              {has ? 'Write again…' : 'Write tips…'}
            </button>
            <button type="button" disabled={disabled} onClick={startEdit}>
              {has ? 'Edit' : 'Add my own'}
            </button>
            {has && (
              <button type="button" className="ghost" disabled={disabled} onClick={onRemove}>
                Remove
              </button>
            )}
          </>
        )}
      </div>
      {status === 'stale' && !editing && (
        <p className="hint">The shots or setup in this group changed since these were written.</p>
      )}
      {editing ? (
        <div className="stack">
          <label>
            Tips (one per line)
            <textarea rows={4} value={tips} onChange={(e) => setTips(e.target.value)} />
          </label>
          <label>
            Risks (one per line)
            <textarea rows={3} value={risks} onChange={(e) => setRisks(e.target.value)} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={() => void save()}>
              Save tips
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : has ? (
        <div className="cap-tips-body">
          {entry.tips.length > 0 && (
            <ul aria-label="Tips">
              {entry.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          {entry.risks.length > 0 && (
            <>
              <h4>Risks</h4>
              <ul aria-label="Risks">
                {entry.risks.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <p className="muted">No tips yet.</p>
      )}
    </section>
  );
}
