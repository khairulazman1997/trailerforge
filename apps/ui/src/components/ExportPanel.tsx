import { useState } from 'react';
import { useAppState, useStore } from '../app-context.js';

type Format = 'md' | 'html' | 'json';
const FORMATS: { id: Format; label: string; short: string }[] = [
  { id: 'md', label: 'Markdown checklist', short: 'Markdown' },
  { id: 'html', label: 'Printable page', short: 'Printable page' },
  { id: 'json', label: 'Data file (for importing footage later)', short: 'Data file' },
];

/** Saves the browser-side copy: works the same in a browser and in the desktop app. */
function download(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportPanel({ id, disabled }: { id: string; disabled: boolean }) {
  const store = useStore();
  const dir = useAppState((s) => s.projects[id]?.dir ?? '');
  const [picked, setPicked] = useState<Record<Format, boolean>>({
    md: true,
    html: true,
    json: true,
  });
  const [omit, setOmit] = useState(false);
  const [written, setWritten] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const formats = FORMATS.filter((f) => picked[f.id]).map((f) => f.id);

  return (
    <section className="card" aria-labelledby="cap-export-h">
      <h2 id="cap-export-h">Share the pack</h2>
      <p className="muted">
        The checklist, recording settings and tips as files you can print or send. Nothing is
        uploaded.
      </p>
      <fieldset className="cap-formats">
        <legend>Include</legend>
        {FORMATS.map((f) => (
          <label key={f.id} className="check">
            <input
              type="checkbox"
              checked={picked[f.id]}
              onChange={(e) => setPicked((p) => ({ ...p, [f.id]: e.target.checked }))}
            />
            <span>{f.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={omit} onChange={(e) => setOmit(e.target.checked)} />
        <span>Leave out anything about game facts I excluded from AI use (for sharing)</span>
      </label>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={disabled || busy || formats.length === 0}
          onClick={async () => {
            setBusy(true);
            const r = await store.exportCapture(id, { formats, omitExcluded: omit });
            setBusy(false);
            setWritten(r ? r.files : null);
          }}
        >
          Write to the project folder
        </button>
        <span className="muted">or save a copy:</span>
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={disabled || busy}
            aria-label={`Download ${f.short}`}
            onClick={async () => {
              const r = await store.renderCapture(id, { format: f.id, omitExcluded: omit });
              if (r) download(r.filename, r.mime, r.content);
            }}
          >
            Download {f.short.toLowerCase()}
          </button>
        ))}
      </div>
      {written && (
        <div role="status" data-testid="cap-export-result">
          <p>Written to {dir}:</p>
          <ul>
            {written.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
