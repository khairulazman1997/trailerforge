import { useEffect } from 'react';
import { useAppState, useStore } from '../app-context.js';
import type { NextStep } from '../failure-view.js';
import { Link } from '../router.js';

export function Toasts() {
  const store = useStore();
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          id={t.id}
          kind={t.kind}
          message={t.message}
          next={t.next ?? null}
          onDismiss={store.dismissToast}
        />
      ))}
    </div>
  );
}

function Toast({
  id,
  kind,
  message,
  next,
  onDismiss,
}: {
  id: number;
  kind: 'error' | 'info';
  message: string;
  next: NextStep | null;
  onDismiss: (id: number) => void;
}) {
  // Errors stay until dismissed: a message that vanishes after ten seconds is easy to miss.
  useEffect(() => {
    if (kind === 'error') return;
    const t = setTimeout(() => onDismiss(id), 4_000);
    return () => clearTimeout(t);
  }, [id, kind, onDismiss]);
  return (
    <div className={`toast ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span>
        {message}
        {next && (
          <>
            {' '}
            <Link to={next.to} onClick={() => onDismiss(id)}>
              {next.label}
            </Link>
          </>
        )}
      </span>
      <button type="button" className="ghost" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        ×
      </button>
    </div>
  );
}
