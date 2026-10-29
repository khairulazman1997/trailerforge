import { useEffect, useMemo, useRef, useState } from 'react';
import {
  flicksPerFrame,
  itemEnd,
  timelineDuration,
  type DecisionRecord,
  type TimelineItem,
} from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { AccentsPanel } from '../components/AccentsPanel.js';
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
  const bars = gridState?.grid?.bars ?? [];
  return (
    <section aria-labelledby="cut-tl">
      <h2 id="cut-tl">Timeline</h2>
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
            <div className="cut-lane">
              {track.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`cut-item ${kindLabel(item)}${selected === item.id ? ' selected' : ''}${track.locked ? ' locked' : ''}`}
                  style={{
                    left: `${percent(item.start, total)}%`,
                    width: `${Math.max(percent(item.duration, total), 0.5)}%`,
                  }}
                  aria-pressed={selected === item.id}
                  aria-label={`${item.label ?? kindLabel(item)}, ${kindLabel(item)}, ${timecode(item.start, rate)} to ${timecode(itemEnd(item), rate)}`}
                  onClick={() => onSelect(selected === item.id ? null : item.id)}
                >
                  <span className="cut-item-name">{item.label ?? kindLabel(item)}</span>
                </button>
              ))}
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
  const trim = (edge: 'in' | 'out', delta: number | null) => {
    if (delta === null || delta === 0) return;
    void store.command(id, 'core/timeline.trim', { ...ref, edge, delta });
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
