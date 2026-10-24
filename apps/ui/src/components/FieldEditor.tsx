import { useId, useState } from 'react';
import type { BriefField } from '@trailerforge/service/client';
import { useStore } from '../app-context.js';

const lines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const asDraft = (field: BriefField, v: unknown): string | string[] => {
  if (field.input === 'multi-choice')
    return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  if (Array.isArray(v)) return v.map(String).join('\n');
  return typeof v === 'string' ? v : '';
};

const sameDraft = (a: string | string[], b: string | string[]) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x, i) => x === b[i])
    : a === b;

/** The "Other…" entry of a single choice; not a value anyone would choose. */
const OTHER = '__other__';

const STATE_LABEL: Record<BriefField['state'], string> = {
  answered: 'Answered',
  missing: 'Needs an answer',
  assumed: 'Assumed',
};

/**
 * One brief question: edit, "Suggest for me" (fills the box for review; nothing is saved until
 * you press Save), and for assumed fields a way to drop the assumption.
 *
 * Mount it with a `key` that includes the saved value, so it starts fresh after a save or an
 * outside change.
 */
export function FieldEditor({
  projectId,
  field,
  formats,
}: {
  projectId: string;
  field: BriefField;
  formats: { id: string; name: string }[];
}) {
  const store = useStore();
  const uid = useId();
  const isFormats = field.id === 'formatTargets';
  const saved = asDraft(field, field.value);
  // Output formats are additive: the box offers the presets that are not in the project yet.
  const have = new Set(formats.map((f) => f.name));
  const choices = (field.choices ?? []).filter((c) => !isFormats || !have.has(c));

  const [draft, setDraft] = useState<string | string[]>(isFormats ? [] : saved);
  // Single choices are suggestions: "Other…" takes any answer (an unusual genre, say).
  const listed = (v: unknown) => typeof v === 'string' && (field.choices ?? []).includes(v);
  const [other, setOther] = useState(
    field.input === 'choice' && typeof saved === 'string' && saved !== '' && !listed(saved),
  );
  const [suggestion, setSuggestion] = useState<{ reason: string; provider: string } | null>(null);
  const [pending, setPending] = useState<'save' | 'suggest' | null>(null);

  const baseline = isFormats ? [] : saved;
  const empty = Array.isArray(draft) ? draft.length === 0 : draft.trim() === '';
  const dirty = !sameDraft(draft, baseline);
  const value = (): unknown =>
    field.input === 'list' && typeof draft === 'string'
      ? lines(draft)
      : typeof draft === 'string'
        ? draft.trim()
        : draft;

  const save = async () => {
    setPending('save');
    await store.answerBrief(projectId, field.id, value());
    setPending(null);
  };

  const suggest = async () => {
    setPending('suggest');
    const s = await store.suggestBrief(projectId, field.id);
    setPending(null);
    if (!s) return;
    setDraft(asDraft(field, s.value));
    if (field.input === 'choice') setOther(!listed(s.value));
    setSuggestion({ reason: s.reason, provider: s.provider });
  };

  const inputId = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const describedBy =
    [field.help || field.why ? hintId : null].filter(Boolean).join(' ') || undefined;

  let editor;
  switch (field.input) {
    case 'long-text':
      editor = (
        <textarea
          id={inputId}
          rows={4}
          value={draft as string}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={describedBy}
        />
      );
      break;
    case 'list':
      editor = (
        <textarea
          id={inputId}
          rows={Math.max(3, Math.min(8, lines(draft as string).length + 1))}
          value={draft as string}
          placeholder="One per line"
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={describedBy}
        />
      );
      break;
    case 'choice':
      editor = (
        <>
          <select
            id={inputId}
            value={other ? OTHER : (draft as string)}
            onChange={(e) => {
              const v = e.target.value;
              setOther(v === OTHER);
              setDraft(v === OTHER ? '' : v);
            }}
            aria-describedby={describedBy}
          >
            <option value="">Choose…</option>
            {(field.choices ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {other && (
            <input
              type="text"
              className="other-choice"
              aria-label={`Other ${field.label.toLowerCase()}`}
              placeholder="Type your own"
              value={draft as string}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
        </>
      );
      break;
    case 'multi-choice':
      editor = (
        <fieldset className="choices" aria-describedby={describedBy}>
          <legend className="sr-only">{field.label}</legend>
          {choices.map((c) => {
            const on = (draft as string[]).includes(c);
            return (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setDraft(
                      on ? (draft as string[]).filter((x) => x !== c) : [...(draft as string[]), c],
                    )
                  }
                />
                <span>{c}</span>
              </label>
            );
          })}
        </fieldset>
      );
      break;
    default:
      editor = (
        <input
          id={inputId}
          value={draft as string}
          placeholder={field.input === 'date' ? '2027-02-14, or a window like Q2 2027' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={describedBy}
        />
      );
  }

  return (
    <li className={`field ${field.state}`} data-field={field.id}>
      <div className="field-head">
        <label
          htmlFor={field.input === 'multi-choice' ? undefined : inputId}
          className="field-label"
        >
          {field.label}
          {field.required && <span aria-label="required"> *</span>}
        </label>
        <span className={`chip ${field.state}`}>{STATE_LABEL[field.state]}</span>
      </div>
      {(field.help || field.why) && (
        <p id={hintId} className="hint">
          {[field.help, field.why].filter(Boolean).join(' · ')}
        </p>
      )}

      {isFormats && formats.length > 0 && (
        <ul className="formats" aria-label="Output formats in this project">
          {formats.map((f) => (
            <li key={f.id}>
              <span>{f.name}</span>
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${f.name}`}
                onClick={() =>
                  void store.command(projectId, 'core/project.remove-format-target', { id: f.id })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {field.state === 'assumed' && field.assumption && (
        <p className="assumption-note">
          Assumed: {field.assumption.reason}{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              void store.command(projectId, 'core/brief.remove-assumption', { field: field.id })
            }
          >
            Remove assumption
          </button>
        </p>
      )}

      {editor}

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!dirty || empty || pending !== null}
          onClick={() => void save()}
        >
          {pending === 'save' ? 'Saving…' : field.state === 'answered' ? 'Update' : 'Save'}
        </button>
        <button type="button" disabled={pending !== null} onClick={() => void suggest()}>
          {pending === 'suggest' ? 'Thinking…' : 'Suggest for me'}
        </button>
      </div>
      <p className="suggestion" aria-live="polite">
        {suggestion && (
          <>
            <strong>Suggested</strong> ({suggestion.provider}): {suggestion.reason}. Edit it if you
            like, then Save.
          </>
        )}
      </p>
    </li>
  );
}
