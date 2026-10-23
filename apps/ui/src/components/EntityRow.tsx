import { useState } from 'react';
import type { KnowledgeEntity, KnowledgeEntityKind } from '@trailerforge/schema';
import { entityBadges, KINDS } from '../knowledge-view.js';

export interface EntityRowProps {
  entity: KnowledgeEntity;
  /** Editing and toggling are paused while a task runs on the project. */
  disabled: boolean;
  /** Resolves when the change has been applied (or refused). */
  onToggleExcluded: (excluded: boolean) => Promise<boolean>;
  onSave: (patch: {
    name: string;
    kind: KnowledgeEntityKind;
    description: string;
  }) => Promise<boolean>;
  onRemove: () => void;
}

/** One game fact: where it came from, whether an AI may see it, and edit / remove controls. */
export function EntityRow({
  entity: e,
  disabled,
  onToggleExcluded,
  onSave,
  onRemove,
}: EntityRowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(e.name);
  const [kind, setKind] = useState<KnowledgeEntityKind>(e.kind);
  const [description, setDescription] = useState(e.description);
  const [saving, setSaving] = useState(false);
  // Show the switch's new position at once; the engine's answer replaces it a moment later.
  const [pendingExcluded, setPendingExcluded] = useState<boolean | null>(null);
  const excluded = pendingExcluded ?? e.excludedFromLlm;

  const start = () => {
    setName(e.name);
    setKind(e.kind);
    setDescription(e.description);
    setEditing(true);
  };

  if (editing) {
    return (
      <li className="entity editing" data-entity={e.id}>
        <form
          className="stack"
          onSubmit={(ev) => {
            ev.preventDefault();
            void (async () => {
              setSaving(true);
              const ok = await onSave({ name: name.trim(), kind, description });
              setSaving(false);
              if (ok) setEditing(false);
            })();
          }}
        >
          <div className="row">
            <label className="grow">
              Name
              <input value={name} onChange={(ev) => setName(ev.target.value)} />
            </label>
            <label>
              Kind
              <select
                value={kind}
                onChange={(ev) => setKind(ev.target.value as KnowledgeEntityKind)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Description
            <textarea
              rows={3}
              value={description}
              onChange={(ev) => setDescription(ev.target.value)}
            />
          </label>
          {e.origin === 'extracted' && (
            <p className="hint">Saving makes this entry yours: later scans will not change it.</p>
          )}
          <div className="row">
            <button type="submit" className="primary" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`entity${e.excludedFromLlm ? ' excluded' : ''}`} data-entity={e.id}>
      <div className="entity-main">
        <div className="entity-head">
          <strong className="entity-name">{e.name}</strong>
          <span className="chip">{e.kind}</span>
          {entityBadges(e).map((b) => (
            <span key={b.label} className={`chip ${b.tone}`} title={b.title}>
              {b.label}
            </span>
          ))}
        </div>
        {e.description && <p className="entity-desc">{e.description}</p>}
        {e.sourcePaths.length > 0 && (
          <details className="entity-paths">
            <summary>
              Found in {e.sourcePaths.length} file{e.sourcePaths.length === 1 ? '' : 's'}
              {e.origin === 'extracted' && e.confidence < 1
                ? ` · ${Math.round(e.confidence * 100)}% sure`
                : ''}
            </summary>
            <ul>
              {e.sourcePaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="entity-actions">
        <label className="check switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`Exclude ${e.name} from AI`}
            checked={excluded}
            disabled={disabled}
            onChange={(ev) => {
              setPendingExcluded(ev.target.checked);
              void onToggleExcluded(ev.target.checked).finally(() => setPendingExcluded(null));
            }}
          />
          <span>Exclude from AI</span>
        </label>
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={start}
          aria-label={`Edit ${e.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove ${e.name}`}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
