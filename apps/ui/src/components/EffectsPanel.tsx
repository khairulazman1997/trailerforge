import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EffectCraftStatus,
  EffectItemView,
  EffectProposalView,
} from '@trailerforge/service/client';
import { useAppState, useStore } from '../app-context.js';
import { desktop } from '../desktop.js';
import { EC_STATE_LABEL, parseSeconds, proposalFrame } from '../effectcraft-view.js';
import { Link } from '../router.js';
import { BrowseButton } from './BrowseButton.js';
import { EffectDialog } from './EffectDialog.js';
import { useBlobUrl } from './useBlobUrl.js';

/**
 * Custom motion graphics (EffectCraft): describe one, look at the preview, accept or discard it;
 * write the effects the storyboard asked for; open an accepted one in the EffectCraft app and
 * bring the edited copy back.
 */
export function EffectsPanel({ id }: { id: string }) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]?.version);
  const project = useAppState((s) => s.projects[id]?.project);
  const tasks = useAppState((s) => s.tasks);
  const [status, setStatus] = useState<EffectCraftStatus | null>(null);
  const [proposals, setProposals] = useState<EffectProposalView[]>([]);
  const [items, setItems] = useState<EffectItemView[]>([]);
  const [open, setOpen] = useState(false);

  // Proposals are made by tasks; look again when one of them settles.
  const settled = Object.values(tasks).filter(
    (t) => t.projectId === id && t.kind.startsWith('effectcraft') && t.status !== 'running',
  ).length;
  const running = Object.values(tasks).some(
    (t) => t.projectId === id && t.kind.startsWith('effectcraft') && t.status === 'running',
  );

  // Looked at again after every change: `tick` is bumped by the buttons below.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    void store.effectcraftCall((c) => c.effectcraft()).then((s) => s && setStatus(s));
  }, [store]);
  useEffect(() => {
    let live = true;
    void store
      .effectcraftCall((c) => c.effectProposals(id))
      .then((p) => live && p && setProposals(p));
    void store.effectcraftCall((c) => c.effectItems(id)).then((i) => live && i && setItems(i));
    return () => {
      live = false;
    };
  }, [store, id, version, settled, tick]);

  const briefs = useMemo(
    () =>
      (project?.storyboard?.sections ?? [])
        .flatMap((s) => s.slots)
        .filter((slot) => {
          const b = (slot.extensions as { effectcraft?: { brief?: { accepted?: boolean } } }).effectcraft?.brief; // prettier-ignore
          return !!b && !b.accepted;
        }),
    [project],
  );
  const waitingSlots = new Set(proposals.map((p) => p.slotId));
  const unwritten = briefs.filter((b) => !waitingSlots.has(b.id)).length;

  if (!status) return null;
  return (
    <section className="effects-panel" aria-label="Custom effects" data-testid="effects-panel">
      <h2>Custom effects</h2>
      {status.state !== 'ready' ? (
        <p className="hint" data-testid="effectcraft-unavailable">
          {EC_STATE_LABEL[status.state as keyof typeof EC_STATE_LABEL]}, so custom effects are not
          available. Cards and captions keep using the built-in drawing.{' '}
          <Link to="/setup">Open Setup</Link>
        </p>
      ) : (
        <>
          <p>
            Describe a motion graphic in your own words and the AI writes it for EffectCraft. You
            see a preview first; nothing is added until you accept it.
          </p>
          <div className="row">
            <button type="button" onClick={() => setOpen(true)} disabled={running}>
              Describe an effect…
            </button>
            {unwritten > 0 && (
              <button
                type="button"
                disabled={running}
                onClick={() => void store.startTask(id, { kind: 'effectcraft-briefs' })}
              >
                Write the {unwritten} effect{unwritten === 1 ? '' : 's'} the storyboard asks for
              </button>
            )}
            {running && <span role="status">Writing an effect…</span>}
          </div>
          {/* Mounted only while open: every opening starts clean, so agreeing to send pictures never carries over. */}
          {open && <EffectDialog id={id} open onClose={() => setOpen(false)} />}

          {proposals.length > 0 && (
            <ul className="proposals" aria-label="Effects waiting for your decision">
              {proposals.map((p) => (
                <li key={p.id}>
                  <Proposal id={id} p={p} onDone={refresh} />
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <>
              <h3>Effects on the cut</h3>
              <ul className="effect-items">
                {items.map((it) => (
                  <li key={it.itemId}>
                    <EffectItem id={id} it={it} onChanged={refresh} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Proposal({ id, p, onDone }: { id: string; p: EffectProposalView; onDone: () => void }) {
  const store = useStore();
  const [at, setAt] = useState(p.slotId ? '' : '0');
  const [fraction, setFraction] = useState<number | undefined>(undefined);
  const frame = proposalFrame(p, fraction);
  const url = useBlobUrl(() => store.effectcraftCall((c) => c.effectFrame(id, p.id, frame)), `${id}|${p.id}|${frame}`); // prettier-ignore
  const start = at.trim() === '' ? undefined : parseSeconds(at);
  const bad = at.trim() !== '' && start === null;
  return (
    <article aria-label={`Proposed effect ${p.name}`}>
      <h3>{p.name}</h3>
      <p>{p.summary}</p>
      <div
        className="effect-preview"
        style={{ background: 'repeating-conic-gradient(#555 0 25%, #777 0 50%) 0 0 / 16px 16px' }}
      >
        {' '}
        {/* prettier-ignore */}
        {url ? (
          <img src={url} alt={`Preview of ${p.name}, frame ${frame + 1} of ${p.frames ?? '?'}`} style={{ maxWidth: '100%' }} /> /* prettier-ignore */
        ) : (
          <span className="hint">Loading the preview…</span>
        )}
      </div>
      <label>
        Preview
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={fraction ?? frame / Math.max(1, (p.frames ?? 1) - 1)}
          onChange={(e) => setFraction(Number(e.target.value))}
        />
      </label>
      <p className="hint">
        {p.seconds} s{p.landAt !== undefined ? `, the hit at ${p.landAt} s` : ''}
        {p.model ? ` · written by ${p.model}` : p.sent ? '' : ' · written by Claude Code'}. Shown
        over a chequerboard where it is see-through.
      </p>
      <div className="row">
        <label>
          Start at (seconds{p.slotId ? '; empty = where its shot starts' : ''})
          <input value={at} inputMode="decimal" onChange={(e) => setAt(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={bad || (!p.slotId && start === undefined)}
          onClick={() =>
            void store
              .effectcraftCall((c) => c.acceptEffect(id, p.id, start ?? undefined))
              .then((r) => r && onDone())
          }
        >
          Add it to the cut
        </button>
        <button
          type="button"
          onClick={() => void store.effectcraftCall((c) => c.rejectEffect(id, p.id)).then(onDone)}
        >
          Discard
        </button>
      </div>
      {bad && (
        <p className="error" role="alert">
          Use a time like 2 or 0:02.5.
        </p>
      )}
    </article>
  );
}

function EffectItem({
  id,
  it,
  onChanged,
}: {
  id: string;
  it: EffectItemView;
  onChanged: () => void;
}) {
  // prettier-ignore
  const store = useStore();
  const [saved, setSaved] = useState<{ path: string; fileName: string } | null>(null);
  const [file, setFile] = useState('');
  const showItem = desktop()?.showItem;
  return (
    <article aria-label={`Effect ${it.label}`}>
      <h4>{it.label}</h4>
      <p className="hint">
        From {it.start.toFixed(2)} s, {it.duration.toFixed(2)} s long.
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => void store.effectcraftCall((c) => c.exportEffect(id, it.itemId)).then((r) => r && setSaved(r))} // prettier-ignore
        >
          Save a copy to edit in EffectCraft
        </button>
      </div>
      {saved && (
        <p data-testid="effect-saved">
          Saved as <code>{saved.fileName}</code> in the project's <code>exports/effectcraft</code>{' '}
          folder. Open it in the EffectCraft app, change it, save it, and bring it back below. Keep
          the composition named <code>tf-effect</code>.{' '}
          {showItem && (
            <button type="button" onClick={() => void showItem(saved.path)}>
              Show in folder
            </button>
          )}
        </p>
      )}
      <div className="row">
        <label>
          Edited copy
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="C:\…\ember.ecproj"
          />
        </label>
        <BrowseButton file label="Choose file…" onPick={setFile} />
        <button
          type="button"
          disabled={!file.trim()}
          onClick={() =>
            void store
              .effectcraftCall((c) => c.reimportEffect(id, it.itemId, file.trim()))
              .then((r) => {
                if (r) {
                  setFile('');
                  onChanged();
                }
              })
          }
        >
          Use the edited copy
        </button>
      </div>
    </article>
  );
}
