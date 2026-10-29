import { useEffect, useState } from 'react';
import type { BriefField } from '@trailerforge/service/client';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { FieldEditor } from '../components/FieldEditor.js';
import { VideoTypeOptions } from '../components/VideoTypeOptions.js';

const describeValue = (v: unknown) =>
  v === null || v === undefined
    ? 'left open for the generator to fill sensibly'
    : typeof v === 'string'
      ? v
      : JSON.stringify(v);

export function BriefPage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const form = useAppState((s) => s.briefs[id]?.form);
  const videoTypes = useAppState((s) => s.info?.videoTypes);
  const [confirmAssume, setConfirmAssume] = useState(false);
  const videoTypeId = view.project.brief.videoTypeId;
  const version = view.version;

  useEffect(() => {
    if (videoTypeId) void store.loadBrief(id);
  }, [store, id, version, videoTypeId]);

  const typeSelect = (
    <label className="inline">
      Video type
      <select
        value={videoTypeId ?? ''}
        onChange={(e) => e.target.value && void store.setVideoType(id, e.target.value)}
      >
        {!videoTypeId && <option value="">Choose…</option>}
        {videoTypeId && !(videoTypes ?? []).some((v) => v.id === videoTypeId) && (
          // A saved type deleted since: the project still has its own copy.
          <option value={videoTypeId}>{form?.videoTypeName ?? videoTypeId}</option>
        )}
        <VideoTypeOptions types={videoTypes ?? []} />
      </select>
    </label>
  );

  if (!videoTypeId) {
    return (
      <>
        <h1>Brief</h1>
        <p>Pick a video type to see what this trailer needs.</p>
        {typeSelect}
      </>
    );
  }
  if (!form) return <p role="status">Loading the brief…</p>;

  const group = (pred: (f: BriefField) => boolean) => form.fields.filter(pred);
  const needed = group((f) => f.state === 'missing' && f.required);
  const assumed = group((f) => f.state === 'assumed');
  const optional = group((f) => f.state === 'missing' && !f.required);
  const answered = group((f) => f.state === 'answered');
  const pct = Math.round(form.score * 100);
  const labels = new Map(form.fields.map((f) => [f.id, f.label]));
  const assumptions = view.project.brief.assumptions;

  const status = form.complete
    ? 'Ready to generate'
    : form.canProceed
      ? 'Can proceed with assumptions'
      : `${needed.length} required ${needed.length === 1 ? 'detail' : 'details'} still needed`;

  const render = (fields: BriefField[]) => (
    <ul className="fields">
      {fields.map((f) => (
        <FieldEditor
          key={`${f.id}|${JSON.stringify(f.value)}|${f.state}`}
          projectId={id}
          field={f}
          formats={form.formats}
        />
      ))}
    </ul>
  );

  return (
    <>
      <div className="row">
        <h1>Brief</h1>
        <span className="spacer" />
        {typeSelect}
      </div>

      <section aria-label="Completeness" className="meter-box">
        <div
          role="progressbar"
          aria-label="Brief completeness"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="meter"
        >
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="meter-text">
          <strong data-testid="brief-percent">{pct}%</strong> of {form.videoTypeName} ·{' '}
          <span data-testid="brief-status">{status}</span>
        </p>
      </section>

      {needed.length > 0 && (
        <section aria-labelledby="needed-h">
          <h2 id="needed-h">Needs your answer ({needed.length})</h2>
          {render(needed)}
          <div className="row">
            <button type="button" onClick={() => setConfirmAssume(true)}>
              Proceed with assumptions
            </button>
            <span className="hint">
              Marks these as assumptions you can review and replace later.
            </span>
          </div>
        </section>
      )}

      {assumed.length > 0 && (
        <section aria-labelledby="assumed-h">
          <h2 id="assumed-h">Assumed ({assumed.length})</h2>
          {render(assumed)}
        </section>
      )}

      {optional.length > 0 && (
        <section aria-labelledby="optional-h">
          <h2 id="optional-h">Optional ({optional.length})</h2>
          {render(optional)}
        </section>
      )}

      {answered.length > 0 && (
        <details open={needed.length === 0} className="answered">
          <summary>Answered ({answered.length})</summary>
          {render(answered)}
        </details>
      )}

      <section aria-labelledby="assumptions-h" className="assumptions">
        <h2 id="assumptions-h">Assumptions made ({assumptions.length})</h2>
        {assumptions.length === 0 ? (
          <p className="muted">None. Everything above comes from you.</p>
        ) : (
          <ul aria-label="Assumptions">
            {assumptions.map((a) => (
              <li key={a.field} className="assumption">
                <div>
                  <strong>{labels.get(a.field) ?? a.field}</strong>: {describeValue(a.value)}
                  <br />
                  <small>
                    {a.reason} · by {a.source === 'ai' ? 'AI' : 'you'}
                  </small>
                </div>
                <button
                  type="button"
                  aria-label={`Remove assumption for ${labels.get(a.field) ?? a.field}`}
                  onClick={() =>
                    void store.command(id, 'core/brief.remove-assumption', { field: a.field })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmAssume}
        title="Proceed with assumptions?"
        confirmLabel="Mark as assumptions"
        onCancel={() => setConfirmAssume(false)}
        onConfirm={async () => {
          const added = await store.assumeMissing(id);
          setConfirmAssume(false);
          if (added !== null)
            store.toast(
              'info',
              `${added} assumption${added === 1 ? '' : 's'} added. You can review or remove them under "Assumptions made".`,
            );
        }}
      >
        <p>
          The {needed.length} missing required {needed.length === 1 ? 'detail' : 'details'} will be
          marked as assumptions, and the storyboard generator will fill them in sensibly. Nothing is
          hidden: they are listed on this page, and answering a question replaces its assumption.
        </p>
      </ConfirmDialog>
    </>
  );
}
