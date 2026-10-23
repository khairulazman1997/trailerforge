import { useEffect } from 'react';
import { useAppState, useStore } from '../app-context.js';

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
  onDismiss,
}: {
  id: number;
  kind: 'error' | 'info';
  message: string;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(id), kind === 'error' ? 10_000 : 4_000);
    return () => clearTimeout(t);
  }, [id, kind, onDismiss]);
  return (
    <div className={`toast ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span>{message}</span>
      <button type="button" className="ghost" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        ×
      </button>
    </div>
  );
}
