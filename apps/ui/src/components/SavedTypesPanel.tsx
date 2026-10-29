import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { desktop } from '../desktop.js';
import { ConfirmDialog } from './Dialog.js';
import { EditableText } from './EditableText.js';

/** Video types saved from storyboards: rename, describe, delete, or open their folder. */
export function SavedTypesPanel() {
  const store = useStore();
  const view = useAppState((s) => s.savedTypes);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    void store.loadSavedTypes();
  }, [store]);
  if (!view) return null;
  const d = desktop();

  return (
    <section aria-labelledby="types-h" data-testid="saved-types-panel">
      <h2 id="types-h">Saved video types</h2>
      <p className="muted">
        Made with &ldquo;Save as a video type&rdquo; on the Storyboard page. Projects keep their own
        copy, so renaming or deleting a type here never changes a project that uses it.
      </p>
      {view.types.length === 0 ? (
        <p className="muted">You have not saved any video types yet.</p>
      ) : (
        <ul className="saved-types" aria-label="Saved video types">
          {view.types.map((t) => (
            <li key={t.id}>
              <EditableText
                value={t.name}
                label={`Name of ${t.name}`}
                onCommit={(name) => void store.updateSavedType(t.id, { name })}
              />
              <EditableText
                value={t.description}
                label={`Description of ${t.name}`}
                onCommit={(description) => void store.updateSavedType(t.id, { description })}
              />
              <p className="muted">
                {t.sections.map((s) => s.name).join(' → ')}
                {t.duration ? ` · made at ${t.duration} s` : ''}
              </p>
              <button
                type="button"
                aria-label={`Delete ${t.name}`}
                onClick={() => setRemoving({ id: t.id, name: t.name })}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.problems.map((p) => (
        <p key={p.file} className="banner warn" role="alert">
          {p.file} was not loaded: {p.message}
        </p>
      ))}
      <p className="row">
        <span className="muted">
          Folder: <code>{view.dir}</code>
        </span>
        {d?.showItem && (
          <button type="button" onClick={() => void d.showItem!(view.dir)}>
            Show in folder
          </button>
        )}
      </p>
      <ConfirmDialog
        open={removing !== null}
        title={`Delete "${removing?.name ?? ''}"?`}
        confirmLabel="Delete video type"
        tone="danger"
        onConfirm={async () => {
          if (removing) await store.removeSavedType(removing.id);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      >
        It disappears from the video type list. Projects that already use it keep working.
      </ConfirmDialog>
    </section>
  );
}
