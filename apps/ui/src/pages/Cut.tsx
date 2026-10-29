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
  type TimelineItem,
} from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { AccentsPanel } from '../components/AccentsPanel.js';
import { DRAG_SLOP_PX, SNAP_PX, dragNote, planKeyMove } from '../cut-drag.js';
import { ConfirmDialog } from '../components/Dialog.js';
import {
  F,
  canTrim,
  deltaToBeat,
  fitSourceIn,
  captionAt,
  kindLabel,
  percent,
  pictureAt,
  timecode,
  transformStyle,
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
          <Player id={id} />
          <Timeline id={id} selected={selected} onSelect={setSelected} />
          {sel && (
            <Inspector
              id={id}
              item={sel.item}
              trackLocked={sel.track.locked}
              trackName={sel.track.name || sel.track.id}
              decisions={decisions}
              beats={grid?.beats ?? []}
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
  onGone,
}: {
  id: string;
  item: TimelineItem;
  trackLocked: boolean;
  trackName: string;
  decisions: readonly DecisionRecord[];
  beats: readonly number[];
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
function Player({ id }: { id: string }) {
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
