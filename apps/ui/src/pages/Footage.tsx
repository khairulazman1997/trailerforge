import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { ShotSlot } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import {
  confidenceChip,
  confidenceLabel,
  confidentCount,
  lengthText,
  parsePaths,
} from '../footage-view.js';
import { Link, projectPath } from '../router.js';
import { busyTask } from '../store.js';

interface Desktop {
  pickFolder?: () => Promise<string | null>;
  pickFile?: () => Promise<string | null>;
  pathForFile?: (file: File) => string;
}
const desktop = (): Desktop | undefined =>
  (window as unknown as { trailerforgeDesktop?: Desktop }).trailerforgeDesktop;

/** Paths of dropped files, where the host can say (the desktop app); browsers hide them. */
function droppedPaths(e: DragEvent): string[] {
  const d = desktop();
  return [...e.dataTransfer.files]
    .map((f) => d?.pathForFile?.(f) ?? (f as File & { path?: string }).path ?? '')
    .filter(Boolean);
}

export function FootagePage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const snap = useAppState((s) => s.footage[id]);
  const busy = useAppState((s) => busyTask(s, id));
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const version = view.version;
  const active = (snap?.status.jobs.running ?? 0) + (snap?.status.jobs.queued ?? 0) > 0;

  useEffect(() => {
    void store.refreshFootage(id);
  }, [store, id, version]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void store.refreshFootage(id), 1500);
    return () => clearInterval(t);
  }, [store, id, active]);

  const sb = view.project.storyboard;
  const shots = useMemo(
    () =>
      (sb?.sections ?? []).flatMap((s) => s.slots).filter((x): x is ShotSlot => x.kind === 'shot'),
    [sb],
  );
  const names = useMemo(
    () => new Map((snap?.status.footage ?? []).map((f) => [f.assetId, f.name])),
    [snap],
  );
  const title = (slotId: string) => shots.find((x) => x.id === slotId)?.title || slotId;
  const disabled = !!busy;
  const matches = snap?.matches.matches ?? [];
  const recName = (assetId: string) =>
    snap?.matches.recordings.find((r) => r.assetId === assetId)?.name ??
    names.get(assetId) ??
    assetId;

  const add = async (paths: string[]) => {
    if (paths.length && (await store.importFootage(id, paths))) setText('');
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = droppedPaths(e);
    if (paths.length) void add(paths);
    else
      store.toast(
        'error',
        'This browser does not share where dropped files are. Paste the folder path below instead (the desktop app handles drops).',
      );
  };
  const attach = async (assetId: string, slotId: string, code: boolean) => {
    await store.command(id, 'core/takes.attach', {
      slotId,
      assetId,
      matchedBy: code ? 'code' : 'suggestion',
    });
    await store.refreshFootage(id);
  };

  return (
    <>
      <h1>Footage</h1>
      <p className="muted">
        Recordings stay where they are; TrailerForge reads them on this computer and never uploads
        them. Put a shot code (shown in the Capture tab) in a file name and it matches by itself.
      </p>
      {!sb && (
        <p className="banner" role="status">
          This project has no storyboard yet, so recordings cannot be matched to shots.{' '}
          <Link to={projectPath(id, 'storyboard')}>Open the storyboard</Link>
        </p>
      )}

      <section aria-labelledby="foot-add">
        <h2 id="foot-add">Add recordings</h2>
        <div
          className={`foot-drop${over ? ' over' : ''}`}
          role="group"
          aria-label="Drop recordings here"
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <p>Drop video files or a folder here, or paste where they are.</p>
          <label className="field">
            <span>Folders or files (one per line)</span>
            <textarea
              rows={2}
              value={text}
              disabled={disabled}
              placeholder="C:\Users\you\Videos\OBS"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              type="button"
              disabled={disabled || parsePaths(text).length === 0}
              onClick={() => void add(parsePaths(text))}
            >
              Add recordings
            </button>
            {desktop()?.pickFolder && (
              <button
                type="button"
                disabled={disabled}
                onClick={async () => {
                  const p = await desktop()!.pickFolder!();
                  if (p) void add([p]);
                }}
              >
                Choose folder…
              </button>
            )}
            {desktop()?.pickFile && (
              <button
                type="button"
                disabled={disabled}
                onClick={async () => {
                  const p = await desktop()!.pickFile!();
                  if (p) void add([p]);
                }}
              >
                Choose file…
              </button>
            )}
          </div>
        </div>
      </section>

      {snap && (
        <p className="muted" role="status" data-testid="foot-progress">
          {active
            ? `Working: ${snap.status.jobs.running} running, ${snap.status.jobs.queued} waiting…`
            : snap.status.footage.length
              ? `${snap.status.footage.length} recording${snap.status.footage.length === 1 ? '' : 's'}, nothing running.`
              : 'No recordings yet.'}
        </p>
      )}
      {snap?.status.jobs.failed.map((j) => (
        <p key={j.id} className="banner warn" role="alert">
          {j.type.replace(/^.*\//, '')} failed: {j.error}
        </p>
      ))}

      {snap && snap.status.footage.length > 0 && (
        <section aria-labelledby="foot-list">
          <div className="row">
            <h2 id="foot-list">Recordings</h2>
            <span className="spacer" />
            <button type="button" disabled={disabled} onClick={() => void store.analyzeFootage(id)}>
              Analyse recordings and music
            </button>
          </div>
          <ul className="foot-list" aria-label="Recordings">
            {snap.status.footage.map((f) => (
              <li key={f.assetId} data-asset={f.assetId}>
                <strong>{f.name}</strong> <span className="muted">{lengthText(f.durationSec)}</span>
                {f.file !== 'ok' && <span className="chip warn">file {f.file}</span>}
                <span className="chip">{f.analyzed ? 'analysed' : 'not analysed'}</span>
                {f.slotIds.map((s) => (
                  <span key={s} className="chip">
                    take of {title(s)}
                  </span>
                ))}
                {f.warnings.length > 0 && (
                  <ul className="foot-warnings">
                    {f.warnings.map((w) => (
                      <li key={w.code} className={w.severity === 'warn' ? 'warn-text' : 'muted'}>
                        {w.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {sb && matches.length > 0 && (
        <section aria-labelledby="foot-match">
          <div className="row">
            <h2 id="foot-match">Which shot is each recording?</h2>
            <span className="spacer" />
            <button
              type="button"
              disabled={disabled || confidentCount(matches) === 0}
              onClick={() => void store.acceptMatches(id)}
            >
              Attach the {confidentCount(matches)} confident
            </button>
          </div>
          <ul className="foot-matches" aria-label="Suggestions">
            {matches.map((m) => {
              const top = m.candidates[0];
              const picked = choice[m.assetId] ?? top?.slotId ?? shots[0]?.id ?? '';
              const ranked = new Set(m.candidates.map((c) => c.slotId));
              return (
                <li key={m.assetId} data-asset={m.assetId}>
                  <div className="row">
                    <strong>{recName(m.assetId)}</strong>
                    <span
                      className={`chip${m.confidence === 'low' ? ' warn' : ''}`}
                      title={confidenceLabel(m.confidence)}
                    >
                      {confidenceChip(m.confidence)}
                    </span>
                    {m.take !== null && <span className="chip">take {m.take}</span>}
                  </div>
                  <label className="field inline">
                    <span>Shot for {recName(m.assetId)}</span>
                    <select
                      value={picked}
                      disabled={disabled}
                      onChange={(e) => setChoice((c) => ({ ...c, [m.assetId]: e.target.value }))}
                    >
                      {m.candidates.map((c) => (
                        <option key={c.slotId} value={c.slotId}>
                          {title(c.slotId)} (suggested)
                        </option>
                      ))}
                      {shots
                        .filter((x) => !ranked.has(x.id))
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.title || x.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={disabled || !picked}
                    aria-label={`Attach ${recName(m.assetId)}`}
                    onClick={() =>
                      void attach(m.assetId, picked, m.kind === 'code' && picked === top?.slotId)
                    }
                  >
                    Attach
                  </button>
                  {top && (
                    <details>
                      <summary>Why this shot</summary>
                      <ul>
                        {top.reasons.map((r) => (
                          <li key={r.signal}>{r.detail}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {shots.some((x) => x.takes.length > 0) && (
        <section aria-labelledby="foot-takes">
          <h2 id="foot-takes">Shots and their takes</h2>
          <ul className="foot-takes" aria-label="Takes">
            {shots
              .filter((x) => x.takes.length > 0)
              .map((x) => (
                <li key={x.id} data-slot={x.id}>
                  <strong>{x.title || x.id}</strong>
                  <ul>
                    {x.takes.map((t) => (
                      <li key={t.id} className={t.rejected ? 'rejected' : ''}>
                        <span>{names.get(t.assetId) ?? t.assetId}</span>{' '}
                        <span className="chip">{t.matchedBy}</span>
                        {x.chosenTakeId === t.id && (
                          <span className="chip ok">used in the cut</span>
                        )}
                        <button
                          type="button"
                          disabled={disabled || t.rejected}
                          aria-label={`Use ${names.get(t.assetId) ?? t.id} for ${x.title || x.id}`}
                          onClick={() =>
                            void store.command(id, 'core/takes.choose', {
                              slotId: x.id,
                              takeId: x.chosenTakeId === t.id ? null : t.id,
                            })
                          }
                        >
                          {x.chosenTakeId === t.id ? 'Let the cut choose' : 'Use this take'}
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`${t.rejected ? 'Restore' : 'Reject'} ${names.get(t.assetId) ?? t.id}`}
                          onClick={() =>
                            void store.command(id, 'core/takes.reject', {
                              slotId: x.id,
                              takeId: t.id,
                              rejected: !t.rejected,
                            })
                          }
                        >
                          {t.rejected ? 'Restore' : 'Reject'}
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`Detach ${names.get(t.assetId) ?? t.id}`}
                          onClick={() =>
                            void store.command(id, 'core/takes.detach', {
                              slotId: x.id,
                              takeId: t.id,
                            })
                          }
                        >
                          Detach
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}
