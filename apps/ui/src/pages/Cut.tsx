import { useEffect, useMemo, useRef, useState } from 'react';
import {
  planDrag,
  snapTargets,
  type DragMode,
  type DragPlan,
  type SnapTarget,
} from '@trailerforge/cut';
import {
  flicksPerFrame,
  itemEnd,
  timelineDuration,
  type DecisionRecord,
  type Rate,
  type TimelineItem,
} from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { AccentsPanel } from '../components/AccentsPanel.js';
import { DRAG_SLOP_PX, SNAP_PX, dragNote, planKeyMove } from '../cut-drag.js';
import { ConfirmDialog, Dialog } from '../components/Dialog.js';
import {
  F,
  applySourceEdit,
  canTrim,
  deltaToBeat,
  fitSourceIn,
  fadeOutOf,
  heldPastEnd,
  musicLengthPlan,
  captionAt,
  kindLabel,
  percent,
  pictureAt,
  planLength,
  planSourceEdit,
  timecode,
  transformStyle,
  type LengthMode,
  type SourceEdit,
} from '../cut-view.js';
import { Link, projectPath } from '../router.js';
import { busyTask } from '../store.js';

const TIMELINE_ID = 'tl_rough';
const NO_DECISIONS: DecisionRecord[] = [];

export function CutPage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const snap = useAppState((s) => s.footage[id]);
  const gridState = useAppState((s) => s.cutGrid[id]);
  const decisions = useAppState((s) => s.decisions[id]) ?? NO_DECISIONS;
  const busy = useAppState((s) => busyTask(s, id));
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const version = view.version;
  const sb = view.project.storyboard;
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID);
  const grid = gridState?.grid ?? null;
  const disabled = !!busy;
  const music = snap?.status.music ?? [];
  const active = (snap?.status.jobs.running ?? 0) + (snap?.status.jobs.queued ?? 0) > 0;

  useEffect(() => {
    void store.refreshFootage(id);
    void store.loadCutGrid(id);
    void store.loadDecisions(id);
  }, [store, id, version]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void store.refreshFootage(id), 1500);
    return () => clearInterval(t);
  }, [store, id, active]);
  // Analysis finishing does not change the project, so read the grid again when the work stops.
  useEffect(() => {
    if (!active) void store.loadCutGrid(id);
  }, [store, id, active]);

  const chosenMusic = music.find((m) => m.chosen);
  const allItems = useMemo(
    () => (tl ? tl.tracks.flatMap((t) => t.items.map((i) => ({ item: i, track: t }))) : []),
    [tl],
  );
  const sel = allItems.find((x) => x.item.id === selected) ?? null;

  const build = async () => {
    const r = await store.generateCut(id);
    if (r) setWarnings(r.warnings);
  };

  return (
    <>
      <h1>Cut</h1>
      <p className="muted">
        A first cut on the music. It is a starting point: trim, swap and rearrange it, and
        rebuilding keeps your edits and locked tracks.
      </p>

      {!sb ? (
        <p className="banner" role="status">
          Make a storyboard first.{' '}
          <Link to={projectPath(id, 'storyboard')}>Open the storyboard</Link>
        </p>
      ) : (
        <section aria-labelledby="cut-setup">
          <h2 id="cut-setup">Music and footage</h2>
          <div className="row">
            <label className="field inline">
              <span>Music track</span>
              <select
                value={chosenMusic?.assetId ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  void store.command(id, 'core/music.set-track', {
                    assetId: e.target.value || null,
                  })
                }
              >
                <option value="">None chosen</option>
                {music.map((m) => (
                  <option key={m.assetId} value={m.assetId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || !chosenMusic}
              onClick={() => void store.analyzeFootage(id)}
            >
              Analyse the music and recordings
            </button>
            <span className="spacer" />
            <button
              type="button"
              disabled={!view.canUndo || disabled}
              onClick={() => void store.undo(id)}
            >
              Undo
            </button>
            <button
              type="button"
              disabled={!view.canRedo || disabled}
              onClick={() => void store.redo(id)}
            >
              Redo
            </button>
            <button
              type="button"
              className="primary"
              disabled={disabled || !grid}
              onClick={() => (tl ? setConfirm(true) : void build())}
            >
              {tl ? 'Rebuild the cut' : 'Build the cut'}
            </button>
          </div>
          <p className="muted" role="status" data-testid="cut-status">
            {music.length === 0
              ? 'No music yet: add a music file on the Footage tab.'
              : !chosenMusic
                ? 'Choose the music track.'
                : active
                  ? 'Analysing on this computer…'
                  : !grid
                    ? 'The music has not been analysed yet.'
                    : `Music analysed: ${Math.round(grid.tempo)} BPM, ${grid.bars.length} bars.`}
          </p>
        </section>
      )}

      {warnings.length > 0 && (
        <ul className="banner warn" aria-label="Cut warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {tl && (
        <>
          <Player id={id} focus={sel ? { key: sel.item.id, at: sel.item.start } : null} />
          <Timeline id={id} selected={selected} onSelect={setSelected} />
          {sel && (
            <Inspector
              id={id}
              item={sel.item}
              trackLocked={sel.track.locked}
              trackName={sel.track.name || sel.track.id}
              decisions={decisions}
              beats={grid?.beats ?? []}
              bars={grid?.bars ?? []}
              onGone={() => setSelected(null)}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm}
        title="Rebuild the cut?"
        confirmLabel="Rebuild"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await build();
          setConfirm(false);
        }}
      >
        <p>
          Clips you edited by hand and locked tracks are kept. Clips you deleted come back, and
          everything else is made again from the music and your takes. Undo goes back.
        </p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

interface Drag {
  itemId: string;
  mode: DragMode;
  x0: number;
  laneWidth: number;
  targets: SnapTarget[];
  moved: boolean;
  ripple: boolean;
  plan: DragPlan | null;
}

function Timeline({
  id,
  selected,
  onSelect,
}: {
  id: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const gridState = useAppState((s) => s.cutGrid[id]);
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID)!;
  const total = Math.max(timelineDuration(tl), 1);
  const rate = tl.frameRate;
  const grid = gridState?.grid ?? null;
  const bars = grid?.bars ?? [];
  const lanes = useRef(new Map<string, HTMLDivElement>());
  const dragged = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [note, setNote] = useState('');

  const targetsFor = (itemId: string) =>
    snapTargets(tl, grid ? { beats: grid.beats, bars: grid.bars } : null, {
      exclude: itemId,
    });
  const find = (itemId: string) => {
    for (const track of tl.tracks) {
      const item = track.items.find((i) => i.id === itemId);
      if (item) return { track, item };
    }
    return undefined;
  };
  const trackName = (trackId: string) => {
    const t = tl.tracks.find((x) => x.id === trackId);
    return t ? t.name || t.id : trackId;
  };
  const drop = (plan: DragPlan, item: TimelineItem, mode: DragMode, ripple: boolean) => {
    const sameTrack = find(item.id)?.track.id === plan.trackId;
    setNote(
      dragNote(plan, item, rate, {
        mode,
        ripple,
        ...(sameTrack ? {} : { trackName: trackName(plan.trackId) }),
      }),
    );
    if (plan.ok && plan.command) void store.command(id, plan.command.type, plan.command.payload);
  };

  const start = (e: React.PointerEvent, itemId: string, mode: DragMode, trackId: string) => {
    const lane = lanes.current.get(trackId);
    if (e.button !== 0 || !lane || tl.tracks.find((t) => t.id === trackId)?.locked) return;
    e.stopPropagation();
    (e.currentTarget.closest('.cut-item') as HTMLElement | null)?.setPointerCapture(e.pointerId);
    dragged.current = false;
    setDrag({
      itemId,
      mode,
      x0: e.clientX,
      laneWidth: lane.getBoundingClientRect().width,
      targets: targetsFor(itemId),
      moved: false,
      ripple: false,
      plan: null,
    });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const over = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId;
    const from = find(drag.itemId)?.track.id;
    const toTrackId = drag.mode === 'move' && over && over !== from ? over : undefined;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP_PX && !toTrackId) return;
    const perPx = total / drag.laneWidth;
    const plan = planDrag({
      timeline: tl,
      itemId: drag.itemId,
      mode: drag.mode,
      delta: dx * perPx,
      ripple: e.shiftKey,
      snap: e.altKey ? null : { targets: drag.targets, threshold: SNAP_PX * perPx },
      ...(toTrackId ? { toTrackId } : {}),
    });
    setDrag({ ...drag, moved: true, ripple: e.shiftKey, plan });
  };
  const end = () => {
    if (!drag) return;
    const hit = find(drag.itemId);
    if (drag.moved && drag.plan && hit) {
      dragged.current = true;
      drop(drag.plan, hit.item, drag.mode, drag.ripple);
    }
    setDrag(null);
  };
  const keys = (e: React.KeyboardEvent, item: TimelineItem, locked: boolean) => {
    if (locked || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const plan = planKeyMove(tl, item, e.key === 'ArrowLeft' ? -1 : 1, {
      toBeat: e.shiftKey,
      ripple: e.altKey,
      targets: targetsFor(item.id),
    });
    drop(plan, item, 'move', e.altKey);
  };

  const live = drag?.plan;
  const dragItem = drag ? find(drag.itemId)?.item : undefined;
  return (
    <section aria-labelledby="cut-tl">
      <h2 id="cut-tl">Timeline</h2>
      <p className="muted">
        Drag a clip to move it, or its edges to trim. It snaps to beats, bars, sections and other
        clips; hold Alt to place it freely and Shift to move the clips after it along. With a clip
        selected, the arrow keys move it by a frame (with Shift, to the next beat; with Alt, moving
        the clips after it).
      </p>
      <div className="cut-tl" style={{ position: 'relative' }}>
        <div className="cut-ruler" aria-hidden="true">
          {bars
            .filter((b) => b < total)
            .map((b) => (
              <span key={b} className="cut-bar" style={{ left: `${percent(b, total)}%` }} />
            ))}
        </div>
        {tl.tracks.map((track) => (
          <div
            key={track.id}
            className="cut-track"
            role="group"
            aria-label={`${track.name || track.id} track`}
          >
            <div className="cut-track-head">
              <strong>{track.name || track.id}</strong>
              <button
                type="button"
                aria-pressed={track.locked}
                onClick={() =>
                  void store.command(id, 'core/timeline.set-track-locked', {
                    timelineId: tl.id,
                    trackId: track.id,
                    locked: !track.locked,
                  })
                }
              >
                {track.locked ? 'Unlock' : 'Lock'}
                <span className="sr-only"> {track.name || track.id}</span>
              </button>
            </div>
            <div
              className="cut-lane"
              data-track-id={track.id}
              ref={(el) => {
                if (el) lanes.current.set(track.id, el);
                else lanes.current.delete(track.id);
              }}
            >
              {track.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`cut-item ${kindLabel(item)}${selected === item.id ? ' selected' : ''}${track.locked ? ' locked' : ''}${drag?.itemId === item.id && drag.moved ? ' dragging' : ''}`}
                  style={{
                    left: `${percent(item.start, total)}%`,
                    width: `${Math.max(percent(item.duration, total), 0.5)}%`,
                  }}
                  aria-pressed={selected === item.id}
                  aria-label={`${item.label ?? kindLabel(item)}, ${kindLabel(item)}, ${timecode(item.start, rate)} to ${timecode(itemEnd(item), rate)}`}
                  data-item-id={item.id}
                  onClick={() => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    onSelect(selected === item.id ? null : item.id);
                  }}
                  onKeyDown={(e) => keys(e, item, track.locked)}
                  onPointerDown={(e) => start(e, item.id, 'move', track.id)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={() => setDrag(null)}
                >
                  {!track.locked && (
                    <span
                      className="cut-edge in"
                      aria-hidden="true"
                      data-edge="in"
                      onPointerDown={(e) => start(e, item.id, 'trim-in', track.id)}
                    />
                  )}
                  <span className="cut-item-name">{item.label ?? kindLabel(item)}</span>
                  {!track.locked && (
                    <span
                      className="cut-edge out"
                      aria-hidden="true"
                      data-edge="out"
                      onPointerDown={(e) => start(e, item.id, 'trim-out', track.id)}
                    />
                  )}
                </button>
              ))}
              {live && live.trackId === track.id && (
                <span
                  className={`cut-ghost${live.ok ? '' : ' refused'}`}
                  data-testid="cut-ghost"
                  aria-hidden="true"
                  style={{
                    left: `${percent(live.start, total)}%`,
                    width: `${Math.max(percent(live.end - live.start, total), 0.5)}%`,
                  }}
                />
              )}
              {live?.shifted
                .filter((s) => s.trackId === track.id)
                .map((s) => {
                  const it = track.items.find((i) => i.id === s.itemId);
                  return it ? (
                    <span
                      key={s.itemId}
                      className="cut-ghost shifted"
                      aria-hidden="true"
                      style={{
                        left: `${percent(s.start, total)}%`,
                        width: `${Math.max(percent(it.duration, total), 0.5)}%`,
                      }}
                    />
                  ) : null;
                })}
              {live?.snapped && (
                <span
                  className="cut-snap"
                  data-testid="cut-snap"
                  aria-hidden="true"
                  style={{ left: `${percent(live.snapped.at, total)}%` }}
                />
              )}
            </div>
          </div>
        ))}
        <div className="cut-markers" role="group" aria-label="Markers">
          {tl.markers
            .filter((m) => m.kind === 'section' || m.kind === 'hit')
            .map((m) => (
              <span
                key={m.id}
                className={`cut-marker ${m.kind}`}
                style={{ left: `${percent(m.at, total)}%` }}
              >
                {m.kind === 'hit' ? `● ${m.label}` : m.label}
              </span>
            ))}
        </div>
      </div>
      <p className="cut-drag-note" role="status" data-testid="cut-drag-note">
        {live && dragItem
          ? dragNote(live, dragItem, rate, { mode: drag!.mode, ripple: drag!.ripple })
          : note}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

function Inspector({
  id,
  item,
  trackLocked,
  trackName,
  decisions,
  beats,
  bars,
  onGone,
}: {
  id: string;
  item: TimelineItem;
  trackLocked: boolean;
  trackName: string;
  decisions: readonly DecisionRecord[];
  beats: readonly number[];
  bars: readonly number[];
  onGone: () => void;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const snap = useAppState((s) => s.footage[id]);
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID)!;
  const rate = tl.frameRate;
  const fpf = flicksPerFrame(rate);
  const ref = { timelineId: tl.id, itemId: item.id };
  const decision = [...decisions].reverse().find((d) => d.subject.id === item.id);
  const shot = view.project.storyboard?.sections
    .flatMap((s) => s.slots)
    .find((s) => s.id === item.slotId);
  const takes = shot?.kind === 'shot' ? shot.takes.filter((t) => !t.rejected) : [];
  const name = (assetId: string) =>
    snap?.status.footage.find((f) => f.assetId === assetId)?.name ?? assetId;
  const songLength = (assetId: string) => {
    const d = snap?.status.music.find((m) => m.assetId === assetId)?.durationSec;
    return d === undefined || d === null ? null : Math.round(d * F);
  };
  const lengthOf = (assetId: string) => {
    const d = snap?.status.footage.find((f) => f.assetId === assetId)?.durationSec;
    return d === undefined || d === null ? null : Math.round(d * F);
  };
  const locked = trackLocked;
  const [ripple, setRipple] = useState(false);
  const [trimNote, setTrimNote] = useState('');
  const trim = (edge: 'in' | 'out', delta: number | null) => {
    if (delta === null || delta === 0) return;
    const mode = edge === 'in' ? 'trim-in' : 'trim-out';
    const plan = planDrag({ timeline: tl, itemId: item.id, mode, delta, ripple });
    setTrimNote(plan.ok ? '' : dragNote(plan, item, rate, { mode, ripple }));
    if (plan.ok && plan.command) void store.command(id, plan.command.type, plan.command.payload);
  };
  const edge = (e: 'in' | 'out') => (e === 'in' ? item.start : itemEnd(item));
  const window = decision?.reasons['window'];

  return (
    <section aria-labelledby="cut-insp" className="cut-inspector">
      <h2 id="cut-insp">{item.label ?? kindLabel(item)}</h2>
      <p className="muted">
        {kindLabel(item)} on {trackName}, {timecode(item.start, rate)} to{' '}
        {timecode(itemEnd(item), rate)}
        {locked && ' (track is locked)'}
      </p>

      <h3>Why</h3>
      {decision ? (
        <>
          <p data-testid="cut-why">{decision.summary}</p>
          {Array.isArray(window) && (
            <ul>
              {window.map((w) => (
                <li key={String(w)}>{String(w)}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">No automatic decision recorded (you made this one).</p>
      )}

      {item.kind === 'clip' && item.id.startsWith('rc_music') ? (
        <MusicLength
          id={id}
          item={item}
          bars={bars}
          songLength={songLength(item.assetId)}
          locked={locked}
        />
      ) : (
        <LengthControl
          key={item.id}
          id={id}
          item={item}
          beats={beats}
          held={heldPastEnd(item, item.kind === 'clip' ? lengthOf(item.assetId) : null)}
        />
      )}

      <h3>Trim</h3>
      <label className="field inline">
        <input
          type="checkbox"
          checked={ripple}
          disabled={locked}
          onChange={(e) => setRipple(e.target.checked)}
        />
        <span>Ripple: move the clips after it along</span>
      </label>
      {(['in', 'out'] as const).map((e) => (
        <div
          key={e}
          className="row"
          role="group"
          aria-label={e === 'in' ? 'Trim the start' : 'Trim the end'}
        >
          <strong>{e === 'in' ? 'Start' : 'End'}</strong>
          <button
            type="button"
            disabled={locked || !canTrim(item, e, -fpf, rate)}
            onClick={() => trim(e, -fpf)}
          >
            1 frame earlier
          </button>
          <button
            type="button"
            disabled={locked || !canTrim(item, e, fpf, rate)}
            onClick={() => trim(e, fpf)}
          >
            1 frame later
          </button>
          <button
            type="button"
            disabled={locked || deltaToBeat(edge(e), beats, 'previous', rate) === null}
            onClick={() => trim(e, deltaToBeat(edge(e), beats, 'previous', rate))}
          >
            To the previous beat
          </button>
          <button
            type="button"
            disabled={locked || deltaToBeat(edge(e), beats, 'next', rate) === null}
            onClick={() => trim(e, deltaToBeat(edge(e), beats, 'next', rate))}
          >
            To the next beat
          </button>
        </div>
      ))}
      {trimNote && (
        <p className="banner warn" role="status">
          {trimNote}
        </p>
      )}

      {item.kind === 'clip' && !item.id.startsWith('rc_music') && (
        <SourcePanel
          key={item.assetId}
          id={id}
          item={item}
          length={lengthOf(item.assetId)}
          name={name(item.assetId)}
          rate={rate}
          locked={locked}
          onSlip={(sourceIn) =>
            void store.command(id, 'core/timeline.swap-take', {
              ...ref,
              assetId: item.assetId,
              sourceIn,
            })
          }
          onTrim={trim}
        />
      )}

      {(item.kind === 'clip' || item.kind === 'placeholder') && takes.length > 0 && (
        <label className="field inline">
          <span>Take</span>
          <select
            value={item.kind === 'clip' ? item.assetId : ''}
            disabled={locked}
            onChange={(e) => {
              const take = takes.find((t) => t.assetId === e.target.value);
              if (!take) return;
              const cur = item.kind === 'clip' ? item.sourceIn : 0;
              void store.command(id, 'core/timeline.swap-take', {
                ...ref,
                assetId: take.assetId,
                sourceIn: fitSourceIn(cur, item.duration, lengthOf(take.assetId)),
              });
            }}
          >
            {item.kind === 'placeholder' && <option value="">Choose a take…</option>}
            {takes.map((t) => (
              <option key={t.id} value={t.assetId}>
                {name(t.assetId)}
              </option>
            ))}
          </select>
        </label>
      )}

      {!item.id.startsWith('rc_music') && <AccentsPanel id={id} item={item} locked={locked} />}

      <div className="row">
        {item.kind === 'clip' &&
          !item.id.startsWith('rc_music') &&
          item.assetId !== undefined &&
          item.slotId && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void store.command(id, 'core/timeline.to-placeholder', ref)}
            >
              Replace with a placeholder
            </button>
          )}
        <button
          type="button"
          className="danger"
          disabled={locked}
          onClick={() => {
            void store.command(id, 'core/timeline.delete', ref);
            onGone();
          }}
        >
          Delete
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

/** Plays the cut from the editing copies, in time with the music (no render). */
function Player({ id, focus }: { id: string; focus: { key: string; at: number } | null }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID)!;
  const musicId = view.project.storyboard?.music.trackAssetId;
  const total = timelineDuration(tl);
  const rate = tl.frameRate;
  const fpf = flicksPerFrame(rate);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const clock = useRef({ startedAt: 0, from: 0 });
  const shown = useRef<string | null>(null);
  const item = pictureAt(tl, Math.min(t, Math.max(total - 1, 0)));
  const caption = captionAt(tl, Math.min(t, Math.max(total - 1, 0)));

  // The music is the master clock when it can play; otherwise the wall clock.
  useEffect(() => {
    let off = false;
    if (musicId)
      void store.mediaUrl(musicId, 'audio').then((u) => {
        if (!off && u && audio.current) audio.current.src = u;
      });
    return () => {
      off = true;
    };
  }, [store, musicId]);

  const sync = async (at: number, play: boolean) => {
    const v = video.current;
    const it = pictureAt(tl, Math.min(at, Math.max(total - 1, 0)));
    if (!v) return;
    if (it?.kind !== 'clip') {
      v.pause();
      shown.current = null;
      return;
    }
    const want = (it.sourceIn + (at - it.start) * it.speed) / F;
    if (shown.current !== it.assetId) {
      const u = await store.mediaUrl(it.assetId, 'proxy');
      if (!u) return;
      v.src = u;
      shown.current = it.assetId;
      await new Promise<void>((r) => {
        v.onloadeddata = () => r();
        v.onerror = () => r();
        setTimeout(r, 1500);
      });
    }
    if (Math.abs(v.currentTime - want) > 0.2 || !play) v.currentTime = want;
    if (play && v.paused) void v.play().catch(() => undefined);
    if (!play) v.pause();
  };
  // The player loop reads the latest version of `sync` without restarting.
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  });

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audio.current;
      const now =
        a && a.src && !a.paused
          ? a.currentTime * F
          : clock.current.from + ((performance.now() - clock.current.startedAt) / 1000) * F;
      if (now >= total) {
        setPlaying(false);
        setT(total);
        return;
      }
      setT(now);
      void syncRef.current(now, true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  const stop = () => {
    audio.current?.pause();
    video.current?.pause();
    setPlaying(false);
  };
  const play = () => {
    const from = t >= total ? 0 : t;
    clock.current = { startedAt: performance.now(), from };
    setT(from);
    const a = audio.current;
    if (a && a.src) {
      a.currentTime = from / F;
      void a.play().catch(() => undefined);
    }
    setPlaying(true);
  };
  const seek = (frames: number) => {
    const at = Math.min(total, Math.max(0, frames * fpf));
    setT(at);
    if (audio.current?.src) audio.current.currentTime = at / F;
    clock.current = { startedAt: performance.now(), from: at };
    void sync(at, false);
  };
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  // Selecting an item on the timeline moves the playhead to its start, so its picture shows.
  const seekRef = useRef(seek);
  useEffect(() => {
    seekRef.current = seek;
  });
  const focusKey = focus?.key ?? null;
  const focusAt = focus?.at ?? null;
  useEffect(() => {
    if (focusKey !== null && focusAt !== null) seekRef.current(Math.round(focusAt / fpf));
  }, [focusKey, focusAt, fpf]);
  // Show the first picture before anything is played or picked.
  useEffect(() => {
    void syncRef.current(0, false);
  }, []);

  return (
    <section aria-labelledby="cut-play">
      <h2 id="cut-play">Preview</h2>
      <div className="cut-screen">
        <video
          ref={video}
          muted
          playsInline
          aria-label="Preview picture"
          hidden={item?.kind !== 'clip'}
          style={transformStyle(item, t)}
        />
        {item?.kind !== 'clip' && (
          <p
            className="cut-card"
            role="img"
            aria-label={item ? `${kindLabel(item)}: ${item.label ?? ''}` : 'Nothing here'}
          >
            {item ? `${kindLabel(item)}${item.label ? `: ${item.label}` : ''}` : 'End'}
          </p>
        )}
        {caption && (
          <p
            className={`cut-caption${caption.styleId === 'core/lower-third' ? ' lower-third' : ''}`}
            data-testid="cut-caption"
          >
            {caption.text}
          </p>
        )}
        <audio ref={audio} preload="auto" />
      </div>
      <div className="row">
        <button type="button" onClick={() => (playing ? stop() : play())}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <label className="field inline">
          <span>Playhead</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(total / fpf))}
            value={Math.round(t / fpf)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-valuetext={timecode(t, rate)}
          />
        </label>
        <output data-testid="cut-time" aria-live="off">
          {timecode(t, rate)} / {timecode(total, rate)}
        </output>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

type Clip = Extract<TimelineItem, { kind: 'clip' }>;

/** A recording's editing copy in a <video>, and its filmstrip once one exists. */
function useSourceMedia(assetId: string, video: React.RefObject<HTMLVideoElement | null>) {
  const store = useStore();
  const [filmstrip, setFilmstrip] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    void store.mediaUrl(assetId, 'proxy').then((u) => {
      if (!off && u && video.current) video.current.src = u;
    });
    void store.mediaUrl(assetId, 'filmstrip').then((u) => {
      if (!off) setFilmstrip(u);
    });
    return () => {
      off = true;
    };
  }, [store, assetId, video]);
  return filmstrip;
}

interface StripDrag {
  mode: SourceEdit;
  x0: number;
  width: number;
}

/**
 * The whole recording as a strip with the used part as a window: drag the window (slip) or its
 * edges (trim); the arrow keys move one frame, ten with Shift. `onEdit` gets the drag's offset in
 * source flicks while it moves (`final` false) and once more when it is let go (`final` true).
 */
function SourceStrip({
  winIn,
  winOut,
  total,
  rate,
  speed,
  filmstrip,
  locked,
  playhead,
  tall,
  onEdit,
  onLook,
  onScrub,
}: {
  winIn: number;
  winOut: number;
  total: number;
  rate: Rate;
  speed: number;
  filmstrip: string | null;
  locked: boolean;
  playhead?: number | null;
  tall?: boolean;
  onEdit: (mode: SourceEdit, delta: number, final: boolean) => void;
  onLook: (edge: 'in' | 'out') => void;
  onScrub?: (at: number) => void;
}) {
  const fpf = flicksPerFrame(rate);
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<StripDrag | null>(null);
  const offset = (e: React.PointerEvent, d: StripDrag) =>
    ((e.clientX - d.x0) / Math.max(1, d.width)) * total;

  const start = (e: React.PointerEvent, mode: SourceEdit) => {
    if (locked || e.button !== 0 || !strip.current) return;
    e.stopPropagation();
    strip.current.setPointerCapture(e.pointerId);
    if (mode !== 'slip') onLook(mode);
    setDrag({ mode, x0: e.clientX, width: strip.current.getBoundingClientRect().width });
  };
  const scrub = (e: React.PointerEvent) => {
    if (!onScrub || e.button !== 0 || !strip.current) return;
    const box = strip.current.getBoundingClientRect();
    onScrub(Math.min(total, Math.max(0, ((e.clientX - box.left) / box.width) * total)));
  };
  const move = (e: React.PointerEvent) => {
    if (drag) onEdit(drag.mode, offset(e, drag), false);
  };
  const end = (e: React.PointerEvent) => {
    if (!drag) return;
    onEdit(drag.mode, offset(e, drag), true);
    setDrag(null);
  };
  const keys = (e: React.KeyboardEvent, mode: SourceEdit) => {
    const step = (e.shiftKey ? 10 : 1) * fpf * (mode === 'slip' ? 1 : speed);
    const by = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!by || locked) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode !== 'slip') onLook(mode);
    onEdit(mode, by, true);
  };
  const slider = (at: number) => ({
    role: 'slider',
    tabIndex: locked ? -1 : 0,
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(total / fpf),
    'aria-valuenow': Math.round(at / fpf),
    'aria-disabled': locked,
  });

  return (
    <div
      ref={strip}
      className={`src-strip${tall ? ' tall' : ''}`}
      style={filmstrip ? { backgroundImage: `url(${filmstrip})` } : undefined}
      onPointerDown={scrub}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => {
        if (drag) onEdit(drag.mode, 0, true);
        setDrag(null);
      }}
    >
      <span className="src-dim" style={{ left: 0, width: `${percent(winIn, total)}%` }} />
      <span className="src-dim" style={{ left: `${percent(winOut, total)}%`, right: 0 }} />
      <div
        className={`src-window${drag ? ' dragging' : ''}${locked ? ' locked' : ''}`}
        style={{ left: `${percent(winIn, total)}%`, width: `${percent(winOut - winIn, total)}%` }}
      >
        <span
          className="src-body"
          {...slider(winIn)}
          aria-label="Used part of the recording"
          aria-valuetext={`${timecode(winIn, rate)} to ${timecode(winOut, rate)}`}
          onPointerDown={(e) => start(e, 'slip')}
          onKeyDown={(e) => keys(e, 'slip')}
        />
        {(['in', 'out'] as const).map((edge) => (
          <span
            key={edge}
            className={`src-handle ${edge}`}
            {...slider(edge === 'in' ? winIn : winOut)}
            aria-label={edge === 'in' ? 'Source start' : 'Source end'}
            aria-valuetext={timecode(edge === 'in' ? winIn : winOut, rate)}
            onPointerDown={(e) => start(e, edge)}
            onKeyDown={(e) => keys(e, edge)}
            onFocus={() => onLook(edge)}
          />
        ))}
      </div>
      {playhead !== null && playhead !== undefined && (
        <span className="src-playhead" style={{ left: `${percent(playhead, total)}%` }} />
      )}
    </div>
  );
}

/**
 * The clip's whole recording with the part the cut uses as a window: drag the window to use
 * another moment (slip), drag its edges to trim. Every change applies at once; the trimmer
 * window stages a re-cut instead.
 */
function SourcePanel({
  id,
  item,
  length,
  name,
  rate,
  locked,
  onSlip,
  onTrim,
}: {
  id: string;
  item: Clip;
  length: number | null;
  name: string;
  rate: Rate;
  locked: boolean;
  onSlip: (sourceIn: number) => void;
  onTrim: (edge: 'in' | 'out', delta: number) => void;
}) {
  const fpf = flicksPerFrame(rate);
  const video = useRef<HTMLVideoElement>(null);
  const filmstrip = useSourceMedia(item.assetId, video);
  const [live, setLive] = useState<{ mode: SourceEdit; delta: number } | null>(null);
  const [looking, setLooking] = useState<'in' | 'out'>('in');
  const [playing, setPlaying] = useState(false);
  const [trimmer, setTrimmer] = useState(false);
  const span = item.duration * item.speed;
  const total = Math.max(length ?? 0, item.sourceIn + span, 1);
  const shown = live ? applySourceEdit(item, live.mode, live.delta, length, rate) : item;
  const winIn = shown.sourceIn;
  const winOut = shown.sourceIn + shown.duration * shown.speed;
  // Show the frame under the edit while not playing.
  const frameAt = looking === 'out' ? Math.max(winIn, winOut - fpf * item.speed) : winIn;
  useEffect(() => {
    const v = video.current;
    if (!v || playing) return;
    const go = () => {
      v.currentTime = frameAt / F;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
    return () => v.removeEventListener('loadedmetadata', go);
  }, [frameAt, playing]);

  const edit = (mode: SourceEdit, delta: number, final: boolean) => {
    if (!final) return setLive({ mode, delta });
    setLive(null);
    const p = planSourceEdit(item, mode, delta, length, rate);
    if (mode === 'slip') {
      if (p.sourceDelta !== 0) onSlip(item.sourceIn + p.sourceDelta);
    } else if (p.timelineDelta !== 0) onTrim(mode, p.timelineDelta);
  };
  const playWindow = () => {
    const v = video.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
      return;
    }
    const stopAt = (item.sourceIn + span) / F;
    v.currentTime = item.sourceIn / F;
    v.playbackRate = item.speed;
    v.ontimeupdate = () => {
      if (v.currentTime < stopAt) return;
      v.pause();
      v.ontimeupdate = null;
      setPlaying(false);
    };
    setPlaying(true);
    void v.play().catch(() => setPlaying(false));
  };

  return (
    <div className="src-panel" role="group" aria-label="Source recording">
      <h3>Source: {name}</h3>
      <div className="cut-screen src-screen">
        <video ref={video} muted playsInline aria-label="Source picture" />
      </div>
      <SourceStrip
        winIn={winIn}
        winOut={winOut}
        total={total}
        rate={rate}
        speed={item.speed}
        filmstrip={filmstrip}
        locked={locked}
        onEdit={edit}
        onLook={setLooking}
      />
      <div className="row">
        <button type="button" onClick={playWindow}>
          {playing ? 'Stop' : 'Play the used part'}
        </button>
        <button type="button" disabled={locked} onClick={() => setTrimmer(true)}>
          Open the trimmer…
        </button>
        <output data-testid="src-window">
          Uses {timecode(winIn, rate)} to {timecode(winOut, rate)}
          {length !== null && ` of ${timecode(length, rate)}`}
        </output>
      </div>
      <p className="muted">
        Drag the window to use another moment of the recording, or drag its edges to trim. With a
        handle or the window focused, the arrow keys move one frame (ten with Shift). Not happy with
        the cut? The trimmer lets you try a new one before you keep it.
      </p>
      {trimmer && (
        <TrimDialog
          id={id}
          item={item}
          length={length}
          name={name}
          rate={rate}
          onClose={() => setTrimmer(false)}
        />
      )}
    </div>
  );
}

/**
 * A phone-style trimmer: a big picture that loops the chosen part, the recording as a filmstrip
 * with handles, and nothing changes in the cut until Done (one undo step).
 */
function TrimDialog({
  id,
  item,
  length,
  name,
  rate,
  onClose,
}: {
  id: string;
  item: Clip;
  length: number | null;
  name: string;
  rate: Rate;
  onClose: () => void;
}) {
  const store = useStore();
  const fpf = flicksPerFrame(rate);
  const video = useRef<HTMLVideoElement>(null);
  const filmstrip = useSourceMedia(item.assetId, video);
  const [staged, setStaged] = useState({
    sourceIn: item.sourceIn,
    duration: item.duration,
    speed: item.speed,
  });
  const [live, setLive] = useState<{ mode: SourceEdit; delta: number } | null>(null);
  const [looking, setLooking] = useState<'in' | 'out' | number>('in');
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [ripple, setRipple] = useState(true);
  const [saving, setSaving] = useState(false);
  const shown = live ? applySourceEdit(staged, live.mode, live.delta, length, rate) : staged;
  const winIn = shown.sourceIn;
  const winOut = shown.sourceIn + shown.duration * shown.speed;
  const total = Math.max(length ?? 0, item.sourceIn + item.duration * item.speed, winOut, 1);
  const changed = staged.sourceIn !== item.sourceIn || staged.duration !== item.duration;
  const seconds = (flicks: number) => `${(flicks / F).toFixed(2)} s`;
  // Show the frame under the edit while not playing.
  const frameAt =
    typeof looking === 'number'
      ? looking
      : looking === 'out'
        ? Math.max(winIn, winOut - fpf * shown.speed)
        : winIn;
  useEffect(() => {
    const v = video.current;
    if (!v || playing) return;
    const go = () => {
      v.currentTime = frameAt / F;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
    return () => v.removeEventListener('loadedmetadata', go);
  }, [frameAt, playing]);

  // While playing, loop the chosen part and move the playhead along the strip.
  const bounds = useRef({ winIn, winOut });
  useEffect(() => {
    bounds.current = { winIn, winOut };
  });
  useEffect(() => {
    const v = video.current;
    if (!playing || !v) return;
    let raf = 0;
    const tick = () => {
      const { winIn: a, winOut: b } = bounds.current;
      if (v.currentTime * F >= b || v.currentTime * F < a - fpf) v.currentTime = a / F;
      setPlayhead(v.currentTime * F);
      raf = requestAnimationFrame(tick);
    };
    v.playbackRate = item.speed;
    v.currentTime = bounds.current.winIn / F;
    void v.play().catch(() => setPlaying(false));
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.pause();
      setPlayhead(null);
    };
  }, [playing, video, fpf, item.speed]);

  const edit = (mode: SourceEdit, delta: number, final: boolean) => {
    if (!final) return setLive({ mode, delta });
    setLive(null);
    setStaged(applySourceEdit(staged, mode, delta, length, rate));
  };
  const done = async () => {
    if (!changed) return onClose();
    setSaving(true);
    const ok = await store.command(id, 'core/timeline.set-source', {
      timelineId: TIMELINE_ID,
      itemId: item.id,
      sourceIn: staged.sourceIn,
      duration: staged.duration,
      ripple,
    });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      wide
      title={`Trim ${item.label ?? 'clip'}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={!changed || saving}
            onClick={() =>
              setStaged({ sourceIn: item.sourceIn, duration: item.duration, speed: item.speed })
            }
          >
            Start over
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => void done()}>
            Done
          </button>
        </>
      }
    >
      <p className="muted">{name}</p>
      <div className="cut-screen trim-screen">
        <video
          ref={video}
          muted
          playsInline
          aria-label="Trim preview"
          onClick={() => setPlaying((p) => !p)}
        />
      </div>
      <SourceStrip
        winIn={winIn}
        winOut={winOut}
        total={total}
        rate={rate}
        speed={item.speed}
        filmstrip={filmstrip}
        locked={false}
        playhead={playhead}
        tall
        onEdit={(mode, delta, final) => {
          setPlaying(false);
          edit(mode, delta, final);
        }}
        onLook={setLooking}
        onScrub={(at) => {
          setPlaying(false);
          setLooking(at);
        }}
      />
      <div className="row">
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play the selection'}
        </button>
        <output data-testid="trim-length">
          {seconds(shown.duration)}
          {shown.duration !== item.duration && ` (was ${seconds(item.duration)})`}
        </output>
        <output className="muted" data-testid="trim-range">
          {timecode(winIn, rate)} to {timecode(winOut, rate)} of the recording
        </output>
      </div>
      <label className="field inline">
        <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} />
        <span>Move the clips after it along when the length changes</span>
      </label>
      {!ripple && staged.duration > item.duration && (
        <p className="muted">
          Without that, a longer clip needs room before the next one on its track.
        </p>
      )}
      <p className="muted">
        Drag the ends to choose where the clip starts and stops, or drag the middle to use another
        moment. Click the strip to look at a frame. Nothing changes in the cut until Done.
      </p>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * The item's length: type it, or step to the previous or next beat. By default a longer shot
 * takes its time from the shot after it, so everything later stays on the beat.
 */
function LengthControl({
  id,
  item,
  beats,
  held,
}: {
  id: string;
  item: TimelineItem;
  beats: readonly number[];
  held: number;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID)!;
  const rate = tl.frameRate;
  const [mode, setMode] = useState<LengthMode>('roll');
  const [note, setNote] = useState('');
  const locked = tl.tracks.some((t) => t.locked && t.items.some((i) => i.id === item.id));
  const apply = (duration: number) => {
    const plan = planLength(tl, item.id, duration, mode);
    if (!plan) return setNote('');
    if (!plan.ok) return setNote(`Can't make it ${(duration / F).toFixed(2)} s: ${plan.reason}.`);
    setNote('');
    void store.command(id, plan.type, plan.payload);
  };
  const toBeat = (direction: 'next' | 'previous') => {
    const delta = deltaToBeat(itemEnd(item), beats, direction, rate);
    if (delta !== null) apply(item.duration + delta);
  };

  return (
    <div role="group" aria-label="Length" className="cut-length">
      <h3>Length</h3>
      <div className="row">
        <label className="field inline">
          <span>Seconds</span>
          <input
            key={item.duration}
            type="number"
            min={0}
            step={0.1}
            defaultValue={+(item.duration / F).toFixed(3)}
            disabled={locked}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && e.target.value !== '') apply(Math.round(v * F));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
        <button
          type="button"
          disabled={locked || deltaToBeat(itemEnd(item), beats, 'previous', rate) === null}
          onClick={() => toBeat('previous')}
        >
          Shorter, to the previous beat
        </button>
        <button
          type="button"
          disabled={locked || deltaToBeat(itemEnd(item), beats, 'next', rate) === null}
          onClick={() => toBeat('next')}
        >
          Longer, to the next beat
        </button>
      </div>
      <fieldset className="cut-length-mode" disabled={locked}>
        <legend>When the length changes</legend>
        <label>
          <input
            type="radio"
            name={`length-mode-${item.id}`}
            checked={mode === 'roll'}
            onChange={() => setMode('roll')}
          />{' '}
          Take the time from the shot after it (everything later stays on the beat)
        </label>
        <label>
          <input
            type="radio"
            name={`length-mode-${item.id}`}
            checked={mode === 'ripple'}
            onChange={() => setMode('ripple')}
          />{' '}
          Move everything after it along
        </label>
      </fieldset>
      {held > 0 && (
        <p className="muted" data-testid="cut-held">
          The recording ends {(held / F).toFixed(2)} s before this clip does: its last frame holds
          still for that time. Pick an earlier start in the source, or another take, to fill it.
        </p>
      )}
      {note && (
        <p className="banner warn" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** How long the music runs: by the bar, to the end of the song, or back to the picture's end. */
function MusicLength({
  id,
  item,
  bars,
  songLength,
  locked,
}: {
  id: string;
  item: Clip;
  bars: readonly number[];
  songLength: number | null;
  locked: boolean;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const tl = view.project.timelines.find((t) => t.id === TIMELINE_ID)!;
  const rate = tl.frameRate;
  const fpf = flicksPerFrame(rate);
  const plan = musicLengthPlan(tl, item, bars, songLength);
  const fade = fadeOutOf(item);
  const set = (duration: number | null, fadeLen?: number) => {
    if (duration === null) return;
    const d = Math.max(fpf, Math.round(duration / fpf) * fpf);
    void store.command(id, 'core/timeline.set-audio-length', {
      timelineId: tl.id,
      itemId: item.id,
      duration: songLength === null ? d : Math.min(d, songLength - item.sourceIn),
      ...(fadeLen === undefined ? {} : { fade: Math.round(fadeLen / fpf) * fpf }),
    });
  };
  const seconds = (f: number) => (f / F).toFixed(2);
  const numberField = (label: string, value: number, onValue: (flicks: number) => void) => (
    <label className="field inline">
      <span>{label}</span>
      <input
        key={value}
        type="number"
        min={0}
        step={0.5}
        defaultValue={seconds(value)}
        disabled={locked}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(v) || v < 0) return;
          if (Math.round(v * F) !== value) onValue(Math.round(v * F));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );

  return (
    <div role="group" aria-label="Music length" className="cut-length">
      <h3>Music length</h3>
      <p data-testid="music-use">
        Uses {timecode(item.sourceIn, rate)} to {timecode(item.sourceIn + item.duration, rate)} of
        the song{songLength !== null && ` (${timecode(songLength, rate)} long)`}. The picture ends
        at {timecode(plan.pictureEnd, rate)}.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={locked || plan.shorter === null}
          onClick={() => set(plan.shorter)}
        >
          Shorter by a bar
        </button>
        <button
          type="button"
          disabled={locked || plan.longer === null}
          onClick={() => set(plan.longer)}
        >
          Longer by a bar
        </button>
        <button
          type="button"
          disabled={locked || plan.toSongEnd === null || plan.toSongEnd === item.duration}
          onClick={() => set(plan.toSongEnd)}
        >
          To the end of the song
        </button>
        <button
          type="button"
          disabled={locked || plan.pictureEnd - item.start === item.duration}
          onClick={() => set(plan.pictureEnd - item.start)}
        >
          End with the picture
        </button>
      </div>
      <div className="row">
        {numberField('Music seconds', item.duration, (v) => set(v))}
        {numberField('Fade-out seconds', fade, (v) => set(item.duration, v))}
      </div>
      {item.start + item.duration > plan.pictureEnd && (
        <p className="muted" data-testid="music-past-picture">
          The music runs {seconds(item.start + item.duration - plan.pictureEnd)} s past the last
          picture, over black. Make the last shot or card longer (Length) to fill it.
        </p>
      )}
      <p className="muted">Rebuilding the cut keeps the music length you set here.</p>
    </div>
  );
}
