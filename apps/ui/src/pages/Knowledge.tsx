import { useState } from 'react';
import type { KnowledgeEntity, KnowledgeEntityKind } from '@trailerforge/schema';
import type { ScanSummary } from '@trailerforge/service/client';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog, ConsentDialog } from '../components/Dialog.js';
import { EntityRow } from '../components/EntityRow.js';
import {
  filterEntities,
  KINDS,
  makeEntityId,
  privacySummary,
  type EntityFilter,
  type EntityView,
} from '../knowledge-view.js';
import { busyTask } from '../store.js';

const PAGE = 150;
const VIEW_LABEL: Record<EntityView, string> = {
  all: 'Everything',
  shared: 'Shared with AI',
  excluded: 'Excluded from AI',
  yours: 'Added or edited by you',
  scanned: 'Found by scanning',
  stale: 'Not found in the last scan',
  deep: 'Found by deep scan',
};

export function KnowledgePage({ id }: { id: string }) {
  const store = useStore();
  const project = useAppState((s) => s.projects[id])!.project;
  const busy = useAppState((s) => busyTask(s, id));
  const notice = useAppState((s) => s.notices[id]);
  const lastScan = useAppState(
    (s) =>
      Object.values(s.tasks)
        .filter((t) => t.projectId === id && t.kind === 'scan' && t.status !== 'running')
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0],
  );

  const [repo, setRepo] = useState('');
  const [filter, setFilter] = useState<EntityFilter>({ kind: 'all', view: 'all', query: '' });
  const [showAll, setShowAll] = useState(false);
  const [deepFor, setDeepFor] = useState<string | null>(null); // source id
  const [removeSourceId, setRemoveSourceId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<KnowledgeEntity | null>(null);
  const [adding, setAdding] = useState({
    kind: 'boss' as KnowledgeEntityKind,
    name: '',
    description: '',
  });

  const scanning = busy?.kind === 'scan';
  const privacy = privacySummary(project.knowledge);
  const shown = filterEntities(project.knowledge, filter);
  const visible = showAll ? shown : shown.slice(0, PAGE);
  const deepSource = project.sources.find((s) => s.id === deepFor);
  const removeSource = project.sources.find((s) => s.id === removeSourceId);

  const scan = (options: { repo: string; force?: boolean; deep?: boolean; allowDeep?: boolean }) =>
    store.startTask(id, { kind: 'scan', options });

  return (
    <>
      <h1>Game knowledge</h1>
      <p className="muted">
        Facts about your game (levels, bosses, abilities…) that make the brief and storyboard
        specific. They come from scanning your repo, and you can add and edit your own.
      </p>

      <section className="privacy" aria-label="Privacy">
        <strong data-testid="privacy-summary">
          {privacy.shared} of {privacy.total} {privacy.total === 1 ? 'entry' : 'entries'} can be
          shared with an AI provider
          {privacy.excluded > 0 ? ` · ${privacy.excluded} excluded` : ''}
        </strong>
        <p>
          Only names and short descriptions are ever sent, never source code or footage. Files that
          look like secrets are never read. Exclude any entry below to keep it private.
        </p>
      </section>

      <section aria-labelledby="sources-h">
        <h2 id="sources-h">Game repo</h2>
        {project.sources.length === 0 && (
          <p>
            No repo yet. Point TrailerForge at your game&apos;s folder; it only reads, never writes.
          </p>
        )}
        <ul className="sources">
          {project.sources.map((s) => (
            <li key={s.id} className="source" data-source={s.id}>
              <div>
                <strong>{s.path}</strong>
                <br />
                <small>
                  {s.lastScannedAt
                    ? `Last scanned ${new Date(s.lastScannedAt).toLocaleString()}`
                    : 'Not scanned yet'}{' '}
                  · {s.extractorIds.join(', ')}
                </small>
              </div>
              <div className="row">
                <button type="button" disabled={!!busy} onClick={() => void scan({ repo: s.path })}>
                  Re-scan
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void scan({ repo: s.path, force: true })}
                >
                  Full re-scan
                </button>
                <button type="button" disabled={!!busy} onClick={() => setDeepFor(s.id)}>
                  Deep scan…
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!busy}
                  onClick={() => setRemoveSourceId(s.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>

        <form
          className="row add-repo"
          onSubmit={(e) => {
            e.preventDefault();
            const path = repo.trim();
            void scan({ repo: path }).then((t) => t && setRepo(''));
          }}
        >
          <label className="grow">
            {project.sources.length ? 'Add another repo' : 'Folder of your game repo'}
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="/path/to/YourGame"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="primary" disabled={!!busy || !repo.trim()}>
            Add repo and scan
          </button>
        </form>

        {scanning && (
          <div className="banner" role="status">
            <span>
              Scanning…{' '}
              {notice ?? 'reading files, skipping secrets and anything your .gitignore excludes.'}
            </span>
            <button type="button" onClick={() => void store.cancelTask(busy.id)}>
              Cancel
            </button>
          </div>
        )}
        {lastScan && !scanning && <ScanResult task={lastScan} />}
      </section>

      <section aria-labelledby="entries-h">
        <h2 id="entries-h">Entries</h2>
        <div className="toolbar row">
          <label className="grow">
            Search
            <input
              type="search"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              placeholder="Name, description or file"
            />
          </label>
          <label>
            Kind
            <select
              value={filter.kind}
              onChange={(e) =>
                setFilter({ ...filter, kind: e.target.value as EntityFilter['kind'] })
              }
            >
              <option value="all">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Show
            <select
              value={filter.view}
              onChange={(e) => setFilter({ ...filter, view: e.target.value as EntityView })}
            >
              {(Object.keys(VIEW_LABEL) as EntityView[]).map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {project.knowledge.length === 0 ? (
          <p className="muted">Nothing here yet. Scan your repo above, or add an entry by hand.</p>
        ) : shown.length === 0 ? (
          <p className="muted">No entries match these filters.</p>
        ) : (
          <>
            <p className="muted" aria-live="polite">
              Showing {visible.length} of {project.knowledge.length}
            </p>
            <ul className="entities" aria-label="Game knowledge entries">
              {visible.map((e) => (
                <EntityRow
                  key={e.id}
                  entity={e}
                  disabled={!!busy}
                  onToggleExcluded={(excluded) =>
                    store.command(id, 'core/knowledge.set-excluded', { id: e.id, excluded })
                  }
                  onSave={(patch) =>
                    store.command(id, 'core/knowledge.update-entity', { id: e.id, patch })
                  }
                  onRemove={() => setRemoving(e)}
                />
              ))}
            </ul>
            {!showAll && shown.length > PAGE && (
              <button type="button" onClick={() => setShowAll(true)}>
                Show all {shown.length}
              </button>
            )}
          </>
        )}

        <details className="add-entry">
          <summary>Add an entry by hand</summary>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                const ok = await store.command(id, 'core/knowledge.add-entity', {
                  id: makeEntityId(adding.name),
                  kind: adding.kind,
                  name: adding.name.trim(),
                  description: adding.description,
                });
                if (ok) setAdding({ ...adding, name: '', description: '' });
              })();
            }}
          >
            <div className="row">
              <label className="grow">
                Name
                <input
                  value={adding.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                />
              </label>
              <label>
                Kind
                <select
                  value={adding.kind}
                  onChange={(e) =>
                    setAdding({ ...adding, kind: e.target.value as KnowledgeEntityKind })
                  }
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
                rows={2}
                value={adding.description}
                onChange={(e) => setAdding({ ...adding, description: e.target.value })}
              />
            </label>
            <div>
              <button type="submit" className="primary" disabled={!!busy || !adding.name.trim()}>
                Add entry
              </button>
            </div>
          </form>
        </details>
      </section>

      <ConsentDialog
        open={!!deepSource}
        title="Let Claude Code read this repo?"
        confirmLabel="Run deep scan"
        acknowledge="I understand my project files will be sent to Anthropic."
        onCancel={() => setDeepFor(null)}
        onConfirm={async () => {
          if (deepSource) await scan({ repo: deepSource.path, deep: true, allowDeep: true });
          setDeepFor(null);
        }}
      >
        <p>
          A deep scan lets Claude Code explore <strong>{deepSource?.path}</strong> to find things
          the normal scan can&apos;t, like boss phases or mechanics described in scripts and data
          files.
        </p>
        <ul>
          <li>
            The <strong>contents of your text files are sent to Anthropic</strong> through Claude
            Code.
          </li>
          <li>
            Secrets, files your .gitignore excludes, and binaries are left out of what it can see.
          </li>
          <li>
            Nothing in your repo is changed. Results are marked &quot;Deep scan&quot; and are less
            certain than a normal scan.
          </li>
        </ul>
        <p>The normal scan stays on your computer.</p>
      </ConsentDialog>

      <ConfirmDialog
        open={!!removeSource}
        title="Remove this repo?"
        confirmLabel="Remove repo"
        tone="danger"
        onCancel={() => setRemoveSourceId(null)}
        onConfirm={async () => {
          if (removeSourceId)
            await store.command(id, 'core/knowledge.remove-source', { id: removeSourceId });
          setRemoveSourceId(null);
        }}
      >
        <p>
          Entries found in this repo are removed, except ones your storyboard uses, which stay as
          yours. Anything you added or edited is kept. Your repo itself is not touched.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!removing}
        title={`Remove “${removing?.name ?? ''}”?`}
        confirmLabel="Remove entry"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing)
            await store.command(id, 'core/knowledge.remove-entity', { id: removing.id });
          setRemoving(null);
        }}
      >
        {removing?.origin === 'extracted' ? (
          <p>
            A re-scan will find it again. To keep it from ever being shared instead, cancel and use
            &quot;Exclude from AI&quot;.
          </p>
        ) : (
          <p>This entry was added or edited by you, so it will not come back.</p>
        )}
      </ConfirmDialog>
    </>
  );
}

function ScanResult({
  task,
}: {
  task: { status: string; result?: unknown; error?: { message: string } };
}) {
  if (task.status === 'cancelled')
    return <p className="muted">The last scan was cancelled; nothing was changed.</p>;
  if (task.status === 'failed') {
    return (
      <p className="error" role="alert">
        The last scan failed: {task.error?.message ?? 'unknown error'}
      </p>
    );
  }
  const r = task.result as ScanSummary | undefined;
  if (!r) return null;
  const skipped = Object.entries(r.skipped).map(([reason, n]) => `${n} ${reason}`);
  return (
    <div className="scan-result" data-testid="scan-result">
      <strong>
        {r.unchanged
          ? 'Nothing changed since the last scan'
          : `Scanned ${r.files} file${r.files === 1 ? '' : 's'}`}
      </strong>
      {!r.unchanged && (
        <>
          {' '}
          · +{r.added} added, {r.updated} updated, {r.removed} removed
        </>
      )}
      {r.deep && <> · deep scan found {r.deep.entities}</>}
      {skipped.length > 0 && <p className="muted">Skipped: {skipped.join(', ')}.</p>}
      {r.truncated && <p className="muted">Stopped at the file limit.</p>}
      {r.problems.map((p) => (
        <p key={p.extractorId} className="error">
          {p.extractorId}: {p.message}
        </p>
      ))}
    </div>
  );
}
