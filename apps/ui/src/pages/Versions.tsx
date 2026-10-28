import { useEffect, useMemo, useState } from 'react';
import type { ShotSlot, Slot } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { FocusEditor } from '../components/FocusEditor.js';
import { Link, projectPath } from '../router.js';
import { busyTask } from '../store.js';
import {
  CHOICE_LABEL,
  FATE_LABEL,
  LENGTH_CHIPS,
  aspectLabel,
  choiceOf,
  fateTone,
  formatLine,
  parseLength,
  pickableTakes,
  seconds,
  type Choice,
} from '../variants-view.js';

type Entry = NonNullable<ReturnType<typeof useSnapshot>>['variants'][number];

function useSnapshot(id: string) {
  return useAppState((s) => s.versions[id]?.view);
}

/** The versions of the trailer: aspect ratios and lengths cut from the master. */
export function VersionsPage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const snap = useSnapshot(id);
  const busy = useAppState((s) => busyTask(s, id));
  const version = view.version;
  const [target, setTarget] = useState('');
  const [length, setLength] = useState('');
  const [name, setName] = useState('');
  const [remove, setRemove] = useState<Entry | null>(null);
  const project = view.project;
  const sb = project.storyboard;
  const disabled = !!busy;

  useEffect(() => {
    void store.refreshVersions(id);
    // Whether each recording's preview picture exists (for the focus editor) comes with the footage.
    void store.refreshFootage(id);
  }, [store, id, version]);

  const shots = useMemo(
    () => new Map((sb?.sections ?? []).flatMap((s) => s.slots).map((x) => [x.id, x])),
    [sb],
  );
  const lengthValue = parseLength(length);
  const chosenTarget = target || project.formatTargets[0]?.id || '';

  if (!sb) {
    return (
      <>
        <h1>Versions</h1>
        <p>
          Versions are cut from the master.{' '}
          <Link to={projectPath(id, 'storyboard')}>Write the storyboard</Link> first, then build the
          rough cut.
        </p>
      </>
    );
  }

  const run = (type: string, payload: unknown) => store.command(id, type, payload);

  return (
    <>
      <h1>Versions</h1>
      <p>
        One master cut becomes every version your formats ask for. A version stores only its rules
        and your choices; it is worked out from the master each time, so changing the master changes
        every version.
      </p>
      {snap && !snap.hasMaster && (
        <p role="status" className="warn-text">
          There is no rough cut to cut versions from yet.{' '}
          <Link to={projectPath(id, 'cut')}>Build it on the Cut tab</Link>.
        </p>
      )}

      <section aria-labelledby="ver-add">
        <h2 id="ver-add">Add a version</h2>
        <div className="ver-form">
          <label>
            Format
            <select value={chosenTarget} onChange={(e) => setTarget(e.target.value)}>
              {project.formatTargets.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({aspectLabel(f.aspect)})
                </option>
              ))}
            </select>
          </label>
          <label>
            Length in seconds
            <input
              inputMode="decimal"
              value={length}
              placeholder="the master's length"
              aria-invalid={lengthValue === null}
              onChange={(e) => setLength(e.target.value)}
            />
          </label>
          <span role="group" aria-label="Quick lengths" className="ver-chips">
            {LENGTH_CHIPS.map((n) => (
              <button type="button" key={n} onClick={() => setLength(String(n))}>
                {n} s
              </button>
            ))}
          </span>
          <label>
            Name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            type="button"
            className="primary"
            disabled={disabled || !chosenTarget || lengthValue === null}
            onClick={async () => {
              const ok = await run('core/variants.add', {
                formatTargetId: chosenTarget,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(typeof lengthValue === 'number' ? { targetDuration: lengthValue } : {}),
              });
              if (ok) {
                setLength('');
                setName('');
              }
            }}
          >
            Add version
          </button>
        </div>
        {lengthValue === null && (
          <p className="warn-text">Length is a number of seconds, up to 600.</p>
        )}
        {snap && snap.missing.length > 0 && (
          <p>
            {snap.missing.length === 1 ? 'One format has' : `${snap.missing.length} formats have`}{' '}
            no version yet ({snap.missing.map((m) => m.name).join(', ')}).{' '}
            <button
              type="button"
              disabled={disabled}
              onClick={() => void store.createDefaultVersions(id)}
            >
              Add {snap.missing.length === 1 ? 'it' : 'them'} at the master's length
            </button>
          </p>
        )}
      </section>

      <section aria-labelledby="ver-list">
        <h2 id="ver-list">Versions</h2>
        {!snap ? (
          <p role="status">Reading the versions…</p>
        ) : snap.variants.length === 0 ? (
          <p>No versions yet. Add one above.</p>
        ) : (
          <ul className="ver-list">
            {snap.variants.map((v) => (
              <li key={`${v.id}:${v.targetDuration}`} className="card ver-card">
                <VersionCard
                  id={id}
                  v={v}
                  shots={shots}
                  disabled={disabled}
                  onRemove={() => setRemove(v)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!remove}
        title="Remove this version?"
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setRemove(null)}
        onConfirm={async () => {
          if (remove) await run('core/variants.remove', { variantId: remove.id });
          setRemove(null);
        }}
      >
        <p>
          “{remove?.name || remove?.format?.name || remove?.id}” and your choices for its shots are
          removed. The master is not touched. Undo goes back.
        </p>
      </ConfirmDialog>
    </>
  );
}

function VersionCard({
  id,
  v,
  shots,
  disabled,
  onRemove,
}: {
  id: string;
  v: Entry;
  shots: Map<string, Slot>;
  disabled: boolean;
  onRemove: () => void;
}) {
  const store = useStore();
  const project = useAppState((s) => s.projects[id])!.project;
  const footage = useAppState((s) => s.footage[id]);
  const [len, setLen] = useState(v.targetDuration === null ? '' : String(v.targetDuration));
  const [focusFor, setFocusFor] = useState<string | null>(null);
  const parsed = parseLength(len);
  const master =
    project.timelines.find((t) => t.id === 'tl_rough') ??
    project.timelines.find((t) => !t.variantId);
  const set = (patch: unknown) =>
    store.command(id, 'core/variants.set', { variantId: v.id, patch });
  const override = (slotId: string, patch: unknown) =>
    store.command(id, 'core/variants.override', { variantId: v.id, slotId, patch });
  const d = v.derived;
  const vertical =
    v.format &&
    v.format.resolution.width !==
      v.format.resolution.height *
        (master ? master.resolution.width / master.resolution.height : 16 / 9);

  return (
    <>
      <header className="ver-head">
        <h3>{v.name || v.format?.name || v.id}</h3>
        <span className="muted">{v.format ? formatLine(v.format) : 'format target removed'}</span>
        <button type="button" disabled={disabled} onClick={onRemove}>
          Remove
        </button>
      </header>
      <div className="ver-settings">
        <label>
          Length in seconds
          <input
            inputMode="decimal"
            value={len}
            placeholder="the master's length"
            aria-invalid={parsed === null}
            disabled={disabled}
            onChange={(e) => setLen(e.target.value)}
            onBlur={() => {
              if (parsed === null)
                return setLen(v.targetDuration === null ? '' : String(v.targetDuration));
              const next = parsed === '' ? null : parsed;
              if (next !== v.targetDuration) void set({ targetDuration: next });
            }}
          />
        </label>
        <label>
          Fitting the frame
          <select
            value={v.reframe}
            disabled={disabled}
            onChange={(e) => void set({ reframe: { mode: e.target.value } })}
          >
            <option value="crop">Crop, following the subject</option>
            <option value="fill">Show every shot whole over a blurred fill</option>
          </select>
        </label>
      </div>

      {v.error && (
        <p role="alert" className="warn-text">
          {v.error}
        </p>
      )}
      {d && (
        <>
          <p className={d.shortfall ? 'warn-text' : undefined} role="status">
            {seconds(d.duration)} of {seconds(d.target)}
            {d.shortfall ? `: ${d.shortfall}` : ''}
          </p>
          {d.warnings.length > 0 && (
            <ul className="ver-warnings">
              {d.warnings.map((w) => (
                <li key={w} className="warn-text">
                  {w}
                </li>
              ))}
            </ul>
          )}
          <table className="ver-shots">
            <caption className="sr-only">Shots in {v.name || v.format?.name || v.id}</caption>
            <thead>
              <tr>
                <th scope="col">Shot</th>
                <th scope="col">In this version</th>
                <th scope="col">Your choice</th>
                <th scope="col">Take</th>
                <th scope="col">Framing</th>
              </tr>
            </thead>
            <tbody>
              {d.slots.map((s) => {
                const slot = shots.get(s.slotId);
                const shot = slot?.kind === 'shot' ? (slot as ShotSlot) : null;
                const ov = v.overrides[s.slotId] as
                  | { excluded?: boolean; takeId?: string; cropCenter?: { x: number; y: number } }
                  | undefined;
                const choice = choiceOf(ov);
                const takes = shot ? pickableTakes(shot) : [];
                const take = takes.find((t) => t.id === ov?.takeId);
                const preview = take ?? takes.find((t) => t.id === shot?.chosenTakeId) ?? takes[0];
                const canFrame = !!shot && !!preview && s.fate !== 'dropped' && !!vertical;
                const f = footage?.status.footage.find((x) => x.assetId === preview?.assetId);
                return (
                  <tr key={s.slotId}>
                    <th scope="row">{slot?.title || s.slotId}</th>
                    <td>
                      <span className={`chip ${fateTone(s.fate)}`}>{FATE_LABEL[s.fate]}</span>{' '}
                      <small>
                        {s.fate === 'kept'
                          ? `${seconds(s.duration)}. `
                          : s.fate !== 'dropped' && s.masterDuration > 0
                            ? `${seconds(s.masterDuration)} → ${seconds(s.duration)}. `
                            : ''}
                        {s.reason}
                      </small>
                    </td>
                    <td>
                      <select
                        aria-label={`Your choice for ${slot?.title || s.slotId}`}
                        value={choice}
                        disabled={disabled}
                        onChange={(e) => {
                          const c = e.target.value as Choice;
                          void override(s.slotId, {
                            excluded: c === 'drop' ? true : c === 'keep' ? false : null,
                          });
                        }}
                      >
                        {(['auto', 'keep', 'drop'] as const).map((c) => (
                          <option key={c} value={c}>
                            {CHOICE_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {takes.length > 1 ? (
                        <select
                          aria-label={`Take for ${slot?.title || s.slotId}`}
                          value={ov?.takeId ?? ''}
                          disabled={disabled}
                          onChange={(e) =>
                            void override(s.slotId, { takeId: e.target.value || null })
                          }
                        >
                          <option value="">Same as the master</option>
                          {takes.map((t, i) => (
                            <option key={t.id} value={t.id}>
                              Take {i + 1}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {s.reframe && s.fate !== 'dropped' ? (
                        <>
                          <small>
                            {ov?.cropCenter ? 'Focus point set by you' : s.reframe.reason}
                          </small>
                          {canFrame && (
                            <>
                              {' '}
                              <button
                                type="button"
                                aria-expanded={focusFor === s.slotId}
                                onClick={() => setFocusFor(focusFor === s.slotId ? null : s.slotId)}
                              >
                                Focus
                              </button>
                            </>
                          )}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {focusFor === s.slotId && canFrame && v.format && master && preview && (
                        <FocusEditor
                          assetId={preview.assetId}
                          name={slot?.title || s.slotId}
                          ready={!!f?.previews.thumbnail}
                          source={master.resolution}
                          target={v.format.resolution}
                          value={ov?.cropCenter ?? null}
                          disabled={disabled}
                          onChange={(p) => void override(s.slotId, { cropCenter: p })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.keys(v.overrides).length > 0 && (
            <p>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void store.command(id, 'core/variants.clear-override', { variantId: v.id })
                }
              >
                Reset every choice to automatic
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}
