import { useEffect, useMemo, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { desktop, joinPath } from '../desktop.js';
import {
  HANDOFF_FORMATS,
  asExportResult,
  asHandoffResult,
  blockedDetails,
  exportButtonLabel,
  parentFolder,
  parseOptionalNumber,
  type HandoffFormatId,
  type LastRun,
} from '../export-view.js';
import { OverrideField } from '../components/OverrideField.js';
import { Link, projectPath } from '../router.js';
import { progressLabel, verdictLine, versionKey, type GateGroups } from '../review-view.js';
import type { TaskView } from '@trailerforge/service/client';
import type { RenderRun } from '../store.js';

type View = NonNullable<ReturnType<typeof useReviewViews>>[number];
function useReviewViews(id: string) {
  return useAppState((s) => s.review[id]?.views);
}

/** Export: choose how each version is made, render it, check it, and hand it to an editor. */
export function ExportPage({ id }: { id: string }) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]!.version);
  const views = useReviewViews(id);
  useEffect(() => {
    void store.loadPresets();
  }, [store]);
  useEffect(() => {
    void store.refreshReview(id);
  }, [store, id, version]);

  if (!views)
    return (
      <>
        <h1>Export</h1>
        <p className="muted" role="status">
          Loading the versions…
        </p>
      </>
    );
  if (views.length === 0)
    return (
      <>
        <h1>Export</h1>
        <p>
          There is nothing to export yet. Build the rough cut in the Cut tab; each version you add
          in the Versions tab then shows up here.{' '}
          <Link to={projectPath(id, 'cut')}>Open the Cut tab</Link>
        </p>
      </>
    );
  return (
    <>
      <h1>Export</h1>
      <p className="muted">
        Each version is rendered with its preset, then the finished file is checked again (flashing,
        loudness, peaks, size) before it is delivered. Files go to the <code>exports</code> folder
        of the project.
      </p>
      <RenderQueue id={id} />
      {views.map((v) => (
        <ExportCard key={versionKey(v.variantId)} id={id} view={v} />
      ))}
    </>
  );
}

const KIND_LABEL: Record<RenderRun['kind'], string> = {
  'render-draft': 'Review draft',
  export: 'Export',
  handoff: 'Editor files',
};

function useRuns(id: string) {
  const runs = useAppState((s) => s.renderRuns);
  const tasks = useAppState((s) => s.tasks);
  return useMemo(
    () =>
      Object.entries(runs)
        .filter(([, r]) => r.projectId === id)
        .flatMap(([taskId, run]) => (tasks[taskId] ? [{ run, task: tasks[taskId] }] : []))
        .sort((a, b) => (a.task.startedAt < b.task.startedAt ? 1 : -1)),
    [runs, tasks, id],
  );
}

/** The renders started here, newest first; the running one shows progress and can be stopped. */
function RenderQueue({ id }: { id: string }) {
  const store = useStore();
  const runs = useRuns(id);
  const progress = useAppState((s) => s.renderProgress[id]);
  const names = useAppState((s) => s.review[id]?.views);
  if (runs.length === 0) return null;
  const nameOf = (variantId: string | null) =>
    names?.find((v) => v.variantId === variantId)?.name ?? variantId ?? 'Master';
  return (
    <section aria-label="Renders">
      <h2>Renders</h2>
      <ul className="queue">
        {runs.slice(0, 8).map(({ run, task }) => (
          <li key={task.id}>
            <strong>{KIND_LABEL[run.kind]}</strong> of {nameOf(run.variantId)}
            <TaskChip task={task} />
            {task.status === 'running' && (
              <>
                {progress && (
                  <>
                    <progress
                      aria-label={`${KIND_LABEL[run.kind]} of ${nameOf(run.variantId)}`}
                      max={100}
                      value={Math.round(progress.fraction * 100)}
                    />
                    <span role="status">{progressLabel(progress)}</span>
                  </>
                )}
                <button type="button" onClick={() => void store.cancelTask(task.id)}>
                  Cancel
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TaskChip({ task }: { task: TaskView }) {
  const blocked = blockedDetails(task.error);
  const [text, tone] =
    task.status === 'running'
      ? ['Running', 'info']
      : task.status === 'succeeded'
        ? ['Done', 'ok']
        : task.status === 'cancelled'
          ? ['Cancelled', 'warn']
          : blocked
            ? ['Stopped by the Quality Gate', 'bad']
            : ['Failed', 'bad'];
  return <span className={`chip ${tone}`}>{text}</span>;
}

function lastRunOf(runs: { task: TaskView }[]): LastRun {
  const t = runs[0]?.task;
  if (!t) return 'none';
  if (t.status === 'running' || t.status === 'succeeded') return 'succeeded';
  if (t.status === 'cancelled') return 'cancelled';
  return blockedDetails(t.error) ? 'blocked' : 'failed';
}

function ExportCard({ id, view }: { id: string; view: View }) {
  const store = useStore();
  const key = `${id}|${versionKey(view.variantId)}`;
  const dir = useAppState((s) => s.projects[id]!.dir);
  const settings = useAppState(
    (s) =>
      s.projects[id]!.project.storyboard?.variants.find((v) => v.id === view.variantId)?.export,
  );
  const presets = useAppState((s) => s.presets);
  const quality = useAppState((s) => s.quality[key]);
  const overrides = useAppState((s) => s.gateOverrides[key]);
  const progress = useAppState((s) => s.renderProgress[id]);
  const anyRunning = useAppState((s) =>
    Object.values(s.tasks).some(
      (t) =>
        t.projectId === id &&
        t.status === 'running' &&
        ['render-draft', 'export', 'handoff'].includes(t.kind),
    ),
  );
  const all = useRuns(id).filter((r) => r.run.variantId === view.variantId);
  const exports = all.filter((r) => r.run.kind === 'export');
  const handoffs = all.filter((r) => r.run.kind === 'handoff');
  const version = useAppState((s) => s.projects[id]!.version);
  const [formats, setFormats] = useState<HandoffFormatId[]>(['fcpxml', 'otio', 'edl']);

  useEffect(() => {
    void store.loadQuality(id, view.variantId);
  }, [store, id, view.variantId, version]);

  const isVersion = view.variantId !== null;
  const set = (patch: Record<string, unknown>) =>
    // Stored settings are merged, so only what changed is sent (the review snapshot can lag a
    // moment behind a change just made). Without any, the preset shown is stored with the change.
    void store.command(id, 'core/export.set', {
      variantId: view.variantId,
      ...(settings ? {} : { presetId: view.export.presetId }),
      ...patch,
    });
  const running = exports.find((r) => r.task.status === 'running');
  const lastExport = exports[0];
  const result =
    lastExport?.task.status === 'succeeded' ? asExportResult(lastExport.task.result) : null;
  const blocked = lastExport ? blockedDetails(lastExport.task.error) : null;
  const groups = quality ? (quality.report.verdict as unknown as GateGroups) : null;
  const line = groups && quality ? verdictLine(groups, quality.report.verdict.allowed) : null;
  const outDir = joinPath(joinPath(joinPath(dir, 'exports'), 'render'), versionKey(view.variantId));
  const label = `${view.name}`;

  return (
    <section className="export-card" aria-label={`Export of ${label}`}>
      <div className="row">
        <h2>{view.name}</h2>
        <span className="muted">
          {view.size.width}×{view.size.height}, {view.seconds} s
        </span>
      </div>

      <div className="export-settings">
        <label className="field">
          <span>Preset</span>
          <select
            value={view.export.presetId}
            disabled={!isVersion}
            aria-label={`Preset for ${label}`}
            onChange={(e) => set({ presetId: e.target.value })}
          >
            {(presets?.presets ?? [{ id: view.export.presetId, name: view.export.presetName }]).map(
              (p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="field">
          <span>File name</span>
          <input
            key={settings?.fileName ?? ''}
            defaultValue={settings?.fileName ?? ''}
            disabled={!isVersion}
            placeholder="{project}-{version}-{preset}"
            aria-label={`File name pattern for ${label}`}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (settings?.fileName ?? '')) set({ fileName: v === '' ? null : v });
            }}
          />
        </label>
        <NumberField
          key={`l${settings?.loudnessLufs ?? ''}`}
          label="Loudness (LUFS)"
          aria={`Loudness target for ${label}`}
          value={settings?.loudnessLufs}
          min={-30}
          max={-6}
          disabled={!isVersion}
          placeholder="preset's"
          onCommit={(v) => set({ loudnessLufs: v })}
        />
        <NumberField
          key={`p${settings?.posterSeconds ?? ''}`}
          label="Poster frame (s)"
          aria={`Poster frame for ${label}`}
          value={settings?.posterSeconds}
          min={0}
          max={600}
          disabled={!isVersion}
          placeholder="early"
          onCommit={(v) => set({ posterSeconds: v })}
        />
        {isVersion && settings && (
          <button
            type="button"
            onClick={() =>
              void store.command(id, 'core/export.reset', { variantId: view.variantId })
            }
          >
            Reset to the default
          </button>
        )}
      </div>
      {!isVersion && (
        <p className="muted">
          The master cut uses the preset that suits its shape. Add a version in the Versions tab to
          choose a preset and a file name.
        </p>
      )}
      <p className="muted">
        The file will be <code>{view.export.fileName}</code> in <code>{outDir}</code>.
      </p>
      {view.export.issues.length > 0 && (
        <ul aria-label="Problems with this preset" className="warn-list">
          {view.export.issues.map((m) => (
            <li key={m} className="warn-text">
              {m}
            </li>
          ))}
        </ul>
      )}

      {line && (
        <p>
          <span
            className={`chip ${line.tone}`}
            data-testid={`export-gate-${versionKey(view.variantId)}`}
          >
            {line.text}
          </span>{' '}
          <Link to={projectPath(id, 'review')}>Open the Quality Gate report</Link>
        </p>
      )}

      <div className="row">
        <button
          type="button"
          disabled={anyRunning || quality?.report.verdict.allowed === false}
          onClick={() => void store.startExport(id, view.variantId)}
        >
          {exportButtonLabel(lastRunOf(exports))}
        </button>
        {quality?.report.verdict.allowed === false && (
          <span className="muted">
            Fix what blocks it, or give an override reason in the report.
          </span>
        )}
        {running && progress?.kind === 'export' && (
          <>
            <progress
              aria-label={`Exporting ${label}`}
              max={100}
              value={Math.round(progress.fraction * 100)}
              data-testid="export-progress"
            />
            <span role="status">{progressLabel(progress)}</span>
            <button type="button" onClick={() => void store.cancelTask(running.task.id)}>
              Cancel
            </button>
          </>
        )}
      </div>
      {lastExport?.task.status === 'cancelled' && (
        <p className="muted" role="status">
          Cancelled. Starting again resumes: the parts already rendered are kept.
        </p>
      )}
      {lastExport?.task.status === 'failed' && !blocked && (
        <p className="warn-text" role="alert">
          The export failed: {lastExport.task.error?.message}. Starting again resumes where it
          stopped.
        </p>
      )}
      {blocked && (
        <div role="alert" className="banner">
          <p>
            The Quality Gate stopped the export{' '}
            {blocked.stage === 'plan' ? 'before rendering' : 'after checking the finished file'}:
          </p>
          <ul>
            {blocked.lines.map((l) => (
              <li key={l.text}>
                {l.text}
                {l.needsOverride && ' (can be overridden with a reason)'}
              </li>
            ))}
          </ul>
          {[...new Set(blocked.lines.filter((l) => l.needsOverride).map((l) => l.checkId))].map(
            (c) => (
              <OverrideField
                key={c}
                check={c}
                value={overrides?.[c] ?? ''}
                onCommit={(reason) => store.setGateOverride(id, view.variantId, c, reason)}
              />
            ),
          )}
          {blocked.lines.some((l) => l.needsOverride) && (
            <p className="muted">
              Give a reason, then export again. It is written to the decision log.
            </p>
          )}
        </div>
      )}
      {result && (
        <div className="export-result" aria-label="Export result" data-testid="export-result">
          <p>
            <strong>Exported.</strong> <code>{result.file}</code>
          </p>
          <ul className="muted">
            <li>
              Preset {result.preset}; sha256 {result.sha256.slice(0, 16)}…
            </li>
            {!result.reproducible && (
              <li>A hardware encoder made this file: it is not byte-for-byte reproducible.</li>
            )}
            {result.overridden.length > 0 && (
              <li>
                Overridden: {result.overridden.map((c) => c.replace('core/', '')).join(', ')}{' '}
                (logged).
              </li>
            )}
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <PathActions path={result.file} folder={parentFolder(result.file)} />
        </div>
      )}

      <fieldset className="handoff">
        <legend>Hand it to an editor</legend>
        <p className="muted">
          Writes the version for DaVinci Resolve, Final Cut Pro or Premiere. Recordings stay where
          they are; cards and captions come as ProRes clips with transparency.
        </p>
        <div className="row">
          {HANDOFF_FORMATS.map((f) => (
            <label key={f.id} className="check">
              <input
                type="checkbox"
                checked={formats.includes(f.id)}
                onChange={(e) =>
                  setFormats((cur) =>
                    e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id),
                  )
                }
              />{' '}
              {f.label} <span className="muted">({f.hint})</span>
            </label>
          ))}
          <button
            type="button"
            disabled={anyRunning || formats.length === 0}
            onClick={() => void store.startHandoff(id, view.variantId, formats)}
          >
            Write editor files
          </button>
        </div>
        <HandoffResult runs={handoffs} />
      </fieldset>
    </section>
  );
}

function HandoffResult({ runs }: { runs: { task: TaskView }[] }) {
  const t = runs[0]?.task;
  if (!t) return null;
  if (t.status === 'running')
    return (
      <p className="muted" role="status">
        Writing…
      </p>
    );
  if (t.status === 'failed')
    return (
      <p className="warn-text" role="alert">
        Could not write the files: {t.error?.message}
      </p>
    );
  const r = asHandoffResult(t.result);
  if (!r) return null;
  return (
    <div data-testid="handoff-result">
      <ul>
        {r.files.map((f) => (
          <li key={f.file}>
            {f.format.toUpperCase()}: <code>{f.file}</code>
          </li>
        ))}
        <li>
          {r.graphics.length} card or caption clip{r.graphics.length === 1 ? '' : 's'} with
          transparency
        </li>
      </ul>
      {r.warnings.length > 0 && (
        <ul aria-label="Things to know" className="warn-list">
          {r.warnings.map((w) => (
            <li key={w} className="warn-text">
              {w}
            </li>
          ))}
        </ul>
      )}
      <PathActions path={r.files[0]?.file ?? r.dir} folder={r.dir} />
    </div>
  );
}

/** "Show in folder" (the desktop app) and "Copy path" (any browser). */
function PathActions({ path, folder }: { path: string; folder: string }) {
  const [copied, setCopied] = useState(false);
  const d = desktop();
  return (
    <div className="row">
      {d?.showItem && (
        <button type="button" onClick={() => void d.showItem!(path)}>
          Show in folder
        </button>
      )}
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(folder).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        Copy folder path
      </button>
      {copied && <span role="status">Copied</span>}
    </div>
  );
}

function NumberField({
  label,
  aria,
  value,
  min,
  max,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string;
  aria: string;
  value: number | undefined;
  min: number;
  max: number;
  disabled: boolean;
  placeholder: string;
  onCommit: (v: number | null) => void;
}) {
  const [bad, setBad] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        defaultValue={value ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={aria}
        aria-invalid={bad}
        inputMode="decimal"
        size={8}
        onBlur={(e) => {
          const n = parseOptionalNumber(e.target.value, min, max);
          setBad(n === undefined);
          if (n !== undefined && n !== (value ?? null)) onCommit(n);
        }}
      />
      {bad && (
        <span className="warn-text" role="alert">
          A number from {min} to {max}.
        </span>
      )}
    </label>
  );
}
