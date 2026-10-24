import { useMemo, useState, type DragEvent } from 'react';
import {
  buildCaptureHints,
  buildCapturePlan,
  resolveRecordingSettings,
  type CaptureGroup,
  type CaptureHint,
  type RecordingPatch,
} from '@trailerforge/pack-game-trailer/browser';
import { useAppState, useStore } from '../app-context.js';
import { CaptureItemRow } from '../components/CaptureItemRow.js';
import { RecordingPanel } from '../components/RecordingPanel.js';
import {
  formatSeconds,
  groupTitle,
  moveBefore,
  moveWithin,
  percent,
  splitSetup,
} from '../capture-view.js';
import { Link, projectPath } from '../router.js';
import { busyTask } from '../store.js';

function HintList({ label, hints }: { label: string; hints: CaptureHint[] }) {
  if (hints.length === 0) return null;
  return (
    <div className="cap-hints">
      <h4>{label}</h4>
      <ul>
        {hints.map((h) => (
          <li key={h.entityId}>
            <strong>{h.name}</strong>
            {h.detail ? (
              <span className="muted">
                {' — '}
                {h.detail
                  .split(/(`[^`]*`)/)
                  .map((part, i) =>
                    i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part,
                  )}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Drag {
  groupKey: string;
  slotId: string;
}
interface DropMark {
  groupKey: string;
  beforeSlotId: string | null;
}

export function CapturePage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const busy = useAppState((s) => busyTask(s, id));
  const project = view.project;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  const disabled = !!busy;

  const data = useMemo(() => {
    if (!project.storyboard) return null;
    const plan = buildCapturePlan(project.storyboard, project.knowledge);
    return {
      plan,
      setup: splitSetup(buildCaptureHints(plan, project.knowledge), project.knowledge),
      titles: new Map(
        project.storyboard.sections.flatMap((s) => s.slots).map((s) => [s.id, s.title || s.id]),
      ),
    };
  }, [project.storyboard, project.knowledge]);
  const { brief, formatTargets, storyboard, extensions } = project;
  const rec = useMemo(
    () => resolveRecordingSettings({ brief, formatTargets, storyboard, extensions }),
    [brief, formatTargets, storyboard, extensions],
  );

  const cmd = (type: string, payload: unknown) => store.command(id, type, payload);
  if (!data) {
    return (
      <>
        <h1>Capture</h1>
        <p className="muted">
          The recording checklist comes from the storyboard.{' '}
          <Link to={projectPath(id, 'storyboard')}>Write the storyboard</Link> first.
        </p>
      </>
    );
  }
  const { plan, setup, titles } = data;
  const reorder = (g: CaptureGroup, ids: string[] | null) => {
    if (ids) void cmd('game-trailer/capture.reorder-group', { slotIds: ids });
  };
  const endDrag = () => {
    setDrag(null);
    setDropMark(null);
  };
  const overRow = (g: CaptureGroup, slotId: string, e: DragEvent<HTMLElement>) => {
    if (!drag || drag.groupKey !== g.key || disabled) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const at = g.items.findIndex((x) => x.slotId === slotId);
    setDropMark({
      groupKey: g.key,
      beforeSlotId: before ? slotId : (g.items[at + 1]?.slotId ?? null),
    });
  };
  const drop = (g: CaptureGroup, e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (drag && dropMark && drag.groupKey === g.key) {
      reorder(
        g,
        moveBefore(
          g.items.map((i) => i.slotId),
          drag.slotId,
          dropMark.beforeSlotId,
        ),
      );
    }
    endDrag();
  };
  const markFor = (g: CaptureGroup, slotId: string): 'before' | 'after' | null => {
    if (!dropMark || dropMark.groupKey !== g.key || !drag) return null;
    if (dropMark.beforeSlotId === slotId) return 'before';
    const last = g.items.at(-1)?.slotId;
    return dropMark.beforeSlotId === null && last === slotId ? 'after' : null;
  };

  return (
    <>
      <h1>Capture</h1>
      <div className="cap-progress">
        <progress max={Math.max(plan.total, 1)} value={plan.done} aria-label="Shots recorded" />
        <p data-testid="cap-progress-text" role="status">
          {plan.done} of {plan.total} shots recorded
          {plan.todoRecordSeconds > 0
            ? ` · about ${formatSeconds(plan.todoRecordSeconds)} of footage still to record`
            : ''}{' '}
          ({percent(plan.done, plan.total)}%)
        </p>
      </div>

      <RecordingPanel
        rec={rec}
        disabled={disabled}
        onPatch={(patch: RecordingPatch) => cmd('game-trailer/recording.set-overrides', patch)}
        onReset={() => cmd('game-trailer/recording.reset-overrides', {})}
      />

      {(setup.everywhere.debugCommands.length > 0 || setup.everywhere.saveFiles.length > 0) && (
        <section className="card" aria-labelledby="cap-everywhere-h">
          <h2 id="cap-everywhere-h">Setup that applies everywhere</h2>
          <HintList label="Debug commands" hints={setup.everywhere.debugCommands} />
          <HintList label="Save files" hints={setup.everywhere.saveFiles} />
        </section>
      )}

      {plan.groups.length === 0 ? (
        <p className="muted">There are no shots to record in this storyboard.</p>
      ) : (
        plan.groups.map((g, gi) => {
          const hints = setup.groups[gi]!;
          const ids = g.items.map((i) => i.slotId);
          return (
            <section
              key={g.key}
              className="card cap-group"
              aria-labelledby={`cap-g-${gi}`}
              data-group={g.key}
            >
              <h2 id={`cap-g-${gi}`}>
                {groupTitle(g)}{' '}
                <span className="muted" data-testid={`cap-count-${gi}`}>
                  ({g.done}/{g.total})
                </span>
              </h2>
              <HintList label="Level" hints={hints.levels} />
              <HintList label="Debug commands" hints={hints.debugCommands} />
              <HintList label="Save files" hints={hints.saveFiles} />
              <ol className="cap-items" aria-label={`Shots to record: ${groupTitle(g)}`}>
                {g.items.map((it, i) => (
                  <CaptureItemRow
                    key={it.slotId}
                    item={it}
                    index={i}
                    count={g.items.length}
                    disabled={disabled}
                    dropMark={markFor(g, it.slotId)}
                    onStatus={(status) =>
                      cmd('game-trailer/capture.set-status', { slotId: it.slotId, status })
                    }
                    onNotes={(notes) =>
                      void cmd('game-trailer/capture.set-notes', { slotId: it.slotId, notes })
                    }
                    onTakes={(takes) =>
                      void cmd('game-trailer/capture.set-takes', { slotId: it.slotId, takes })
                    }
                    onSkip={() =>
                      void cmd('game-trailer/capture.set-skipped', {
                        slotId: it.slotId,
                        skipped: true,
                      })
                    }
                    onMove={(dir) => reorder(g, moveWithin(ids, it.slotId, dir))}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', it.slotId);
                      const row = e.currentTarget.closest('li');
                      if (row) e.dataTransfer.setDragImage(row, 12, 12);
                      setDrag({ groupKey: g.key, slotId: it.slotId });
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(e) => overRow(g, it.slotId, e)}
                    onDrop={(e) => drop(g, e)}
                  />
                ))}
              </ol>
            </section>
          );
        })
      )}

      {plan.skippedSlotIds.length > 0 && (
        <section className="card" aria-labelledby="cap-skipped-h">
          <h2 id="cap-skipped-h">Skipped shots</h2>
          <p className="muted">Left out of the checklist and the pack.</p>
          <ul className="cap-skipped">
            {plan.skippedSlotIds.map((slotId) => (
              <li key={slotId} className="row">
                <span>{titles.get(slotId) ?? slotId}</span>
                <span className="spacer" />
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Restore ${titles.get(slotId) ?? slotId}`}
                  onClick={() =>
                    void cmd('game-trailer/capture.set-skipped', { slotId, skipped: false })
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
