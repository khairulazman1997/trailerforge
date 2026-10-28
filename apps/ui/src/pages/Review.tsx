import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewComment } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { busyTask } from '../store.js';
import {
  APPROVAL_LABEL,
  checkName,
  commentsFor,
  formatTime,
  overridableChecks,
  parseTime,
  percentAt,
  progressLabel,
  seconds,
  toFlicks,
  verdictLine,
  versionKey,
  type GateFindingView,
  type GateGroups,
} from '../review-view.js';

/** Review: watch a draft of each version, comment on moments, read the Quality Gate, approve. */
export function ReviewPage({ id }: { id: string }) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]!.version);
  const views = useReviewViews(id);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    void store.refreshReview(id);
  }, [store, id, version]);

  if (!views)
    return (
      <>
        <h1>Review</h1>
        <p className="muted" role="status">
          Loading the versions…
        </p>
      </>
    );
  if (views.length === 0)
    return (
      <>
        <h1>Review</h1>
        <p>
          There is nothing to review yet. Build the rough cut in the Cut tab; each version you add
          in the Versions tab then shows up here.
        </p>
      </>
    );
  const selected = views.find((v) => versionKey(v.variantId) === picked) ?? views[0]!;
  return (
    <>
      <h1>Review</h1>
      <p className="muted">
        Watch a draft, leave comments on moments, check the Quality Gate and approve a version. An
        approval holds until the picture, graphics or sound change.
      </p>
      <ul className="version-list" aria-label="Versions">
        {views.map((v) => {
          const label = APPROVAL_LABEL[v.approval];
          const key = versionKey(v.variantId);
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={key === versionKey(selected.variantId)}
                onClick={() => setPicked(key)}
                data-testid={`version-${key}`}
              >
                <strong>{v.name}</strong>
                <span className={`chip ${label.tone}`}>{label.text}</span>
                {v.openComments > 0 && (
                  <span className="chip info">
                    {v.openComments} open comment{v.openComments === 1 ? '' : 's'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <VersionReview
        key={`${versionKey(selected.variantId)}|${selected.contentHash}|${selected.draftReady}`}
        id={id}
        view={selected}
      />
    </>
  );
}

type View = NonNullable<ReturnType<typeof useReviewViews>>[number];
function useReviewViews(id: string) {
  return useAppState((s) => s.review[id]?.views);
}

function VersionReview({ id, view }: { id: string; view: View }) {
  const store = useStore();
  const busy = useAppState((s) => busyTask(s, id));
  const comments = useAppState((s) => s.projects[id]!.project.review.comments);
  const progress = useAppState((s) => s.renderProgress[id]);
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [now, setNow] = useState(0);
  const mine = useMemo(() => commentsFor(comments, view.variantId), [comments, view.variantId]);
  const label = APPROVAL_LABEL[view.approval];
  const disabled = !!busy;

  // The current draft, fetched with the token once per content.
  useEffect(() => {
    let live = true;
    if (view.draftReady && view.contentHash)
      void store.draftUrl(id, view.variantId, view.contentHash).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [store, id, view.variantId, view.draftReady, view.contentHash]);

  const seek = (s: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(s, v.duration || s));
    v.focus();
  };
  const rendering = progress?.kind === 'render-draft';

  return (
    <section aria-label={`Review of ${view.name}`} className="review">
      <div className="row">
        <h2>{view.name}</h2>
        <span className="muted">
          {view.size.width}×{view.size.height}, {formatTime(view.seconds)} s
        </span>
        <span className={`chip ${label.tone}`} title={label.hint} data-testid="approval-state">
          {label.text}
        </span>
        <button
          type="button"
          disabled={disabled || !view.contentHash}
          onClick={() => void store.approve(id, view.variantId)}
        >
          {view.approval === 'approved' ? 'Approve again' : 'Approve this version'}
        </button>
        {view.approval !== 'none' && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void store.command(id, 'core/review.revoke', { variantId: view.variantId })
            }
          >
            Withdraw approval
          </button>
        )}
      </div>
      <p className="muted">{label.hint}</p>

      <h3>Draft</h3>
      {src ? (
        <>
          <video
            ref={video}
            src={src}
            controls
            preload="metadata"
            aria-label={`Draft of ${view.name}`}
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            onError={() => setPlaybackFailed(true)}
            className="draft-player"
            data-testid="draft-player"
          />
          {playbackFailed && (
            <p className="banner" role="alert">
              This browser cannot play the draft. Open the file in <code>cache/drafts</code> in the
              project folder with a video player instead.
            </p>
          )}
        </>
      ) : rendering ? (
        <div className="row">
          <progress
            aria-label="Rendering the draft"
            max={100}
            value={Math.round(progress.fraction * 100)}
            data-testid="draft-progress"
          />
          <span role="status">{progressLabel(progress)}</span>
        </div>
      ) : (
        <p>
          <button type="button" onClick={() => void store.startDraft(id, view.variantId)}>
            Render a review draft
          </button>{' '}
          <span className="muted">
            A 720p copy for watching; it is not rendered again until the version changes.
          </span>
        </p>
      )}

      <h3>Comments</h3>
      <Ruler duration={view.seconds} comments={mine} now={src ? now : null} onSeek={seek} />
      <CommentForm
        key={mine.length}
        id={id}
        variantId={view.variantId}
        duration={view.seconds}
        playhead={src ? now : null}
        disabled={disabled}
      />
      <CommentList id={id} comments={mine} onSeek={seek} canSeek={!!src} disabled={disabled} />

      <QualityPanel id={id} view={view} onSeek={seek} canSeek={!!src} />
    </section>
  );
}

function Ruler({
  duration,
  comments,
  now,
  onSeek,
}: {
  duration: number;
  comments: ReviewComment[];
  now: number | null;
  onSeek: (s: number) => void;
}) {
  return (
    <div className="ruler" role="group" aria-label="Comments on the timeline">
      {comments.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`ruler-mark${c.resolved ? ' done' : ''}`}
          style={{ left: `${percentAt(seconds(c.at), duration)}%` }}
          title={`${formatTime(seconds(c.at))} s: ${c.text}`}
          aria-label={`Comment at ${formatTime(seconds(c.at))} seconds: ${c.text}`}
          onClick={() => onSeek(seconds(c.at))}
        />
      ))}
      {now !== null && (
        <span
          className="ruler-now"
          aria-hidden="true"
          style={{ left: `${percentAt(now, duration)}%` }}
        />
      )}
    </div>
  );
}

function CommentForm({
  id,
  variantId,
  duration,
  playhead,
  disabled,
}: {
  id: string;
  variantId: string | null;
  duration: number;
  playhead: number | null;
  disabled: boolean;
}) {
  const store = useStore();
  const [at, setAt] = useState(formatTime(playhead ?? 0));
  const [text, setText] = useState('');
  const t = parseTime(at);
  const bad = t === null || t > duration + 0.5;
  return (
    <form
      className="row comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (bad || !text.trim()) return;
        void store.command(id, 'core/review.comment', {
          variantId,
          at: toFlicks(t),
          text: text.trim(),
        });
      }}
    >
      <label className="field">
        <span>At (seconds)</span>
        <input
          value={at}
          onChange={(e) => setAt(e.target.value)}
          inputMode="decimal"
          aria-invalid={bad}
          size={7}
        />
      </label>
      {playhead !== null && (
        <button type="button" onClick={() => setAt(formatTime(playhead))}>
          Use the playhead
        </button>
      )}
      <label className="field grow">
        <span>Comment</span>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      </label>
      <button type="submit" disabled={disabled || bad || !text.trim()}>
        Add comment
      </button>
    </form>
  );
}

function CommentList({
  id,
  comments,
  onSeek,
  canSeek,
  disabled,
}: {
  id: string;
  comments: ReviewComment[];
  onSeek: (s: number) => void;
  canSeek: boolean;
  disabled: boolean;
}) {
  const store = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (comments.length === 0) return <p className="muted">No comments on this version yet.</p>;
  return (
    <ul className="comments" aria-label="Comments">
      {comments.map((c) => (
        <li key={c.id} className={c.resolved ? 'resolved' : undefined}>
          <button
            type="button"
            className="link-button"
            disabled={!canSeek}
            onClick={() => onSeek(seconds(c.at))}
            aria-label={`Go to ${formatTime(seconds(c.at))} seconds`}
          >
            {formatTime(seconds(c.at))} s
          </button>
          {editing === c.id ? (
            <>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Comment text"
                className="grow"
              />
              <button
                type="button"
                disabled={disabled || !draft.trim()}
                onClick={() => {
                  void store.command(id, 'core/review.edit', { commentId: c.id, text: draft });
                  setEditing(null);
                }}
              >
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="grow">
                {c.text}
                {c.resolved && <span className="chip ok"> resolved</span>}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void store.command(
                    id,
                    c.resolved ? 'core/review.reopen' : 'core/review.resolve',
                    { commentId: c.id },
                  )
                }
              >
                {c.resolved ? 'Reopen' : 'Resolve'}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setEditing(c.id);
                  setDraft(c.text);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Delete the comment at ${formatTime(seconds(c.at))} seconds`}
                onClick={() => void store.command(id, 'core/review.delete', { commentId: c.id })}
              >
                Delete
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function QualityPanel({
  id,
  view,
  onSeek,
  canSeek,
}: {
  id: string;
  view: View;
  onSeek: (s: number) => void;
  canSeek: boolean;
}) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]!.version);
  const key = `${id}|${versionKey(view.variantId)}`;
  const snap = useAppState((s) => s.quality[key]);
  const chosen = useAppState((s) => s.gateOverrides[key]);

  useEffect(() => {
    void store.loadQuality(id, view.variantId);
  }, [store, id, view.variantId, version]);

  if (!snap)
    return (
      <>
        <h3>Quality Gate</h3>
        <p className="muted" role="status">
          Checking…
        </p>
      </>
    );
  const { report } = snap;
  const groups: GateGroups = report.verdict as unknown as GateGroups;
  const line = verdictLine(groups, report.verdict.allowed);
  const checks = overridableChecks(groups);
  return (
    <>
      <h3>Quality Gate</h3>
      <p className={`chip ${line.tone}`} role="status" data-testid="gate-verdict">
        {line.text}
      </p>
      <p className="muted">
        Checked for {report.preset.name}. The rendered file is checked again after rendering.
      </p>
      <FindingList
        title="Always blocks an export"
        items={groups.blocking}
        mark="X"
        onSeek={onSeek}
        canSeek={canSeek}
      />
      <FindingList
        title="Blocks until you override it with a reason"
        items={groups.needsOverride}
        mark="!"
        onSeek={onSeek}
        canSeek={canSeek}
      />
      <FindingList
        title="Overridden for the next export"
        items={groups.overridden}
        mark="~"
        onSeek={onSeek}
        canSeek={canSeek}
      />
      {checks.length > 0 && (
        <fieldset className="overrides">
          <legend>Overrides</legend>
          <p className="muted">
            A reason is written to the decision log when the export goes ahead. It applies to the
            next export of this version only.
          </p>
          {checks.map((c) => (
            <OverrideField
              key={c}
              check={c}
              value={chosen?.[c] ?? ''}
              onCommit={(reason) => {
                store.setGateOverride(id, view.variantId, c, reason);
                void store.loadQuality(id, view.variantId);
              }}
            />
          ))}
        </fieldset>
      )}
      <FindingList
        title="Worth a look"
        items={groups.warnings}
        mark="-"
        onSeek={onSeek}
        canSeek={canSeek}
      />
    </>
  );
}

function OverrideField({
  check,
  value,
  onCommit,
}: {
  check: string;
  value: string;
  onCommit: (reason: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <label className="field">
      <span>{checkName(check)}: why is this fine?</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== value && onCommit(text.trim())}
        placeholder="e.g. the platform normalises loudness anyway"
        data-testid={`override-${check.replace('core/', '')}`}
      />
    </label>
  );
}

function FindingList({
  title,
  items,
  mark,
  onSeek,
  canSeek,
}: {
  title: string;
  items: GateFindingView[];
  mark: string;
  onSeek: (s: number) => void;
  canSeek: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4>
        {title} ({items.length})
      </h4>
      <ul className="findings">
        {items.map((f, i) => (
          <li key={`${f.checkId}-${i}`}>
            <span className="finding-mark" aria-hidden="true">
              {mark}
            </span>
            <span>
              <strong>{checkName(f.checkId)}.</strong> {f.message}
              {'reason' in f && <em> Overridden: {String((f as { reason: string }).reason)}.</em>}
              {f.suggestion && <span className="muted"> {f.suggestion}.</span>}
            </span>
            {f.at && (
              <button
                type="button"
                className="link-button"
                disabled={!canSeek}
                onClick={() => onSeek(f.at!.start)}
                aria-label={`Go to ${formatTime(f.at.start)} seconds`}
              >
                {formatTime(f.at.start)} s
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
