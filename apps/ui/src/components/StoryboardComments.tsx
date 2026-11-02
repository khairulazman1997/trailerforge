import { useState } from 'react';
import type { Section, Storyboard } from '@trailerforge/schema';
import { commentWhere } from '../storyboard-view.js';

type Comment = Storyboard['comments'][number];

export interface StoryboardCommentsProps {
  section: Section;
  open: Comment[];
  resolved: Comment[];
  /** A task is running: nothing can be changed. */
  busy: boolean;
  onAdd: (target: { slotId?: string }, text: string) => Promise<boolean>;
  onResolve: (commentId: string, resolved: boolean) => void;
  onDelete: (commentId: string) => void;
  /** Rewrite the section from its open comments (absent when the section is locked). */
  onRefine?: () => void;
}

/**
 * Notes on a section and its slots for the AI: "Rewrite from comments" sends the open ones and
 * marks them resolved. Comments work on locked sections too; only the rewrite needs it unlocked.
 */
export function StoryboardComments(p: StoryboardCommentsProps) {
  const { section: s } = p;
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [adding, setAdding] = useState(false);
  const label = `Comments on ${s.name}`;

  const row = (c: Comment) => (
    <li key={c.id} className={c.resolved ? 'resolved' : undefined} data-comment={c.id}>
      <span className="chip">{commentWhere(s, c)}</span>
      <span className="grow">{c.text}</span>
      {c.addressedAt && <span className="muted">addressed by a rewrite</span>}
      <button
        type="button"
        className="ghost"
        disabled={p.busy}
        onClick={() => p.onResolve(c.id, !c.resolved)}
      >
        {c.resolved ? 'Reopen' : 'Resolve'}
      </button>
      <button
        type="button"
        className="ghost"
        disabled={p.busy}
        aria-label={`Delete comment “${c.text.slice(0, 40)}”`}
        onClick={() => p.onDelete(c.id)}
      >
        Delete
      </button>
    </li>
  );

  return (
    <div className="section-comments" aria-label={label} role="group">
      {p.open.length > 0 && (
        <ul className="comments" aria-label={`Open comments on ${s.name}`}>
          {p.open.map(row)}
        </ul>
      )}
      {p.resolved.length > 0 && (
        <button type="button" className="link-button" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} {p.resolved.length} resolved
        </button>
      )}
      {showResolved && (
        <ul className="comments" aria-label={`Resolved comments on ${s.name}`}>
          {p.resolved.map(row)}
        </ul>
      )}
      {adding ? (
        <form
          className="row comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            void p.onAdd(target ? { slotId: target } : {}, t).then((ok) => {
              if (ok) {
                setText('');
                setTarget('');
                setAdding(false);
              }
            });
          }}
        >
          <label>
            On
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Whole section</option>
              {s.slots.map((x, i) => (
                <option key={x.id} value={x.id}>
                  #{i + 1} {x.title || x.kind}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Comment
            <input
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. too slow; show the arena before the boss"
            />
          </label>
          <button type="submit" disabled={p.busy || !text.trim()}>
            Add comment
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setTarget('');
              setAdding(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="row">
          <button
            type="button"
            className="ghost"
            disabled={p.busy}
            aria-label={`Comment on ${s.name}`}
            onClick={() => setAdding(true)}
          >
            Comment…
          </button>
          {p.onRefine && p.open.length > 0 && (
            <button type="button" disabled={p.busy} onClick={p.onRefine}>
              Rewrite from {p.open.length} comment{p.open.length === 1 ? '' : 's'}…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
