import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { CampaignsPanel } from '../components/CampaignsPanel.js';
import { PlannedVideoDialog, type PlannedSlot } from '../components/PlannedVideoDialog.js';
import {
  addDays,
  campaignColor,
  effectiveDate,
  filterSlots,
  groupByDate,
  longDate,
  monthGrid,
  monthLabel,
  monthOf,
  moveKeyDelta,
  platformNames,
  shiftMonth,
  statusChip,
  todayIso,
  WEEKDAYS,
  type CampaignFilter,
} from '../planner-view.js';
import { Link } from '../router.js';
import type { PlannerSnapshot } from '../store.js';

type View = 'month' | 'list';
/** The dialog follows the video by id, so it shows the calendar's latest answer. */
type Editing = { key: number; slotId: string | null; date: string };

export function PlannerPage() {
  const store = useStore();
  const on = useAppState((s) => s.features.planner);
  const planner = useAppState((s) => s.planner);
  const [today] = useState(() => todayIso());
  const [month, setMonth] = useState(() => monthOf(today));
  const [view, setView] = useState<View>('month');
  const [filter, setFilter] = useState<CampaignFilter>('all');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dialogs = useRef(0);
  // The video to give focus back to after a keyboard move (its chip is rebuilt in the new day).
  const [refocus, setRefocus] = useState<string | null>(null);

  useEffect(() => {
    if (on) void store.loadPlanner();
  }, [store, on]);

  useEffect(() => {
    if (!refocus) return;
    document.querySelector<HTMLElement>(`[data-slot="${refocus}"]`)?.focus();
  }, [refocus, planner]);

  const slots = useMemo(
    () => (planner ? filterSlots(planner.slots, filter) : []),
    [planner, filter],
  );
  const byDate = useMemo(() => groupByDate(slots), [slots]);

  if (!on) {
    return (
      <main className="page narrow-ish">
        <h1>Planner</h1>
        <p>
          The content calendar is switched off. <Link to="/settings">Turn it on in Settings</Link>.
        </p>
      </main>
    );
  }
  if (!planner) {
    return (
      <main className="page">
        <h1>Planner</h1>
        <p role="status">Loading…</p>
      </main>
    );
  }

  const editedSlot = editing?.slotId
    ? planner.slots.find((s) => s.id === editing.slotId)
    : undefined;

  const open = (slot: PlannedSlot | null, date = today) =>
    setEditing({ key: ++dialogs.current, slotId: slot?.id ?? null, date });

  const move = async (slot: PlannedSlot, date: string) => {
    if (effectiveDate(slot) === date) return;
    const ok = await store.plannerCommand('planner/slot.move', { slotId: slot.id, date });
    if (ok && slot.project && slot.project.state === 'ok')
      await store.commandOnKnownProject(slot.project, 'core/project.set-schedule', {
        scheduledDate: date,
      });
  };

  const colorOf = (slot: PlannedSlot) => {
    const i = planner.campaigns.findIndex((c) => c.id === slot.campaignId);
    return i < 0 ? 'var(--muted)' : campaignColor(planner.campaigns[i]!, i);
  };

  const onChipKey = (slot: PlannedSlot, e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = moveKeyDelta(e.key);
    if (delta === null) return;
    e.preventDefault();
    setRefocus(slot.id);
    void move(slot, addDays(effectiveDate(slot), delta));
  };

  const onDrop = (date: string, e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const slot = planner.slots.find((s) => s.id === e.dataTransfer.getData('text/plain'));
    if (slot) void move(slot, date);
  };

  const chip = (slot: PlannedSlot) => {
    const st = statusChip(slot);
    return (
      <button
        key={slot.id}
        type="button"
        className="plan-chip"
        data-slot={slot.id}
        draggable
        style={{ borderLeftColor: colorOf(slot) }}
        title={`${slot.title}: ${st.label}. Press Shift and an arrow key to move it.`}
        onClick={() => open(slot)}
        onKeyDown={(e) => onChipKey(slot, e)}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', slot.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <span className="plan-title">{slot.title}</span>
        <span className="plan-status">{st.label}</span>
      </button>
    );
  };

  return (
    <main className="page planner">
      <div className="row">
        <h1>Planner</h1>
        <span className="spacer" />
        <div className="row" role="group" aria-label="History">
          <button
            type="button"
            className="ghost"
            disabled={!planner.canUndo}
            title={planner.undoLabel ?? undefined}
            onClick={() => void store.plannerHistory('undo')}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!planner.canRedo}
            title={planner.redoLabel ?? undefined}
            onClick={() => void store.plannerHistory('redo')}
          >
            ↷ Redo
          </button>
        </div>
        <button type="button" className="primary" onClick={() => open(null)}>
          Plan a video
        </button>
      </div>

      <div className="row planner-bar">
        <div className="row" role="group" aria-label="Month">
          <button type="button" onClick={() => setMonth(shiftMonth(month, -1))}>
            ← Previous
          </button>
          <strong aria-live="polite" data-testid="month-label">
            {monthLabel(month)}
          </strong>
          <button type="button" onClick={() => setMonth(shiftMonth(month, 1))}>
            Next →
          </button>
          <button type="button" onClick={() => setMonth(monthOf(today))}>
            Today
          </button>
        </div>
        <span className="spacer" />
        <label>
          Campaign{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="none">No campaign</option>
            {planner.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row" role="group" aria-label="View">
          {(['month', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={view === v ? 'primary' : ''}
              onClick={() => setView(v)}
            >
              {v === 'month' ? 'Month' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {planner.slots.length === 0 && (
        <p className="muted">
          Nothing is planned yet. Use “Plan a video” to put a trailer, teaser or clip on a date.
        </p>
      )}

      {view === 'month' ? (
        <table className="calendar" aria-label={`Calendar, ${monthLabel(month)}`}>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid(month).map((week) => (
              <tr key={week[0]!.date}>
                {week.map((cell) => (
                  <td
                    key={cell.date}
                    data-date={cell.date}
                    className={[
                      cell.inMonth ? '' : 'outside',
                      cell.date === today ? 'today' : '',
                      over === cell.date ? 'drop' : '',
                    ].join(' ')}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOver(cell.date);
                    }}
                    onDragLeave={() => setOver((o) => (o === cell.date ? null : o))}
                    onDrop={(e) => onDrop(cell.date, e)}
                  >
                    <div className="day-head">
                      <span aria-hidden="true">{Number(cell.date.slice(8))}</span>
                      <span className="sr-only">{longDate(cell.date)}</span>
                      <button
                        type="button"
                        className="ghost day-add"
                        aria-label={`Plan a video on ${longDate(cell.date)}`}
                        onClick={() => open(null, cell.date)}
                      >
                        +
                      </button>
                    </div>
                    {(byDate.get(cell.date) ?? []).map(chip)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <PlannedList planner={planner} slots={slots} onOpen={(s) => open(s)} colorOf={colorOf} />
      )}

      <CampaignsPanel planner={planner} />

      {editing && (editing.slotId === null || editedSlot) && (
        <PlannedVideoDialog
          key={editing.key}
          slot={editedSlot ?? null}
          defaultDate={editing.date}
          planner={planner}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}

function PlannedList({
  planner,
  slots,
  onOpen,
  colorOf,
}: {
  planner: PlannerSnapshot;
  slots: PlannedSlot[];
  onOpen: (slot: PlannedSlot) => void;
  colorOf: (slot: PlannedSlot) => string;
}) {
  const store = useStore();
  const sorted = [...slots].sort(
    (a, b) => effectiveDate(a).localeCompare(effectiveDate(b)) || a.title.localeCompare(b.title),
  );
  if (sorted.length === 0) return <p className="muted">No planned videos to show.</p>;
  return (
    <table className="plan-list" aria-label="Planned videos">
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Video</th>
          <th scope="col">Campaign</th>
          <th scope="col">Platforms</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => {
          const st = statusChip(s);
          const campaign = planner.campaigns.find((c) => c.id === s.campaignId);
          return (
            <tr key={s.id} data-slot-row={s.id}>
              <td>{effectiveDate(s)}</td>
              <td>
                <span className="swatch" style={{ background: colorOf(s) }} aria-hidden="true" />{' '}
                <button type="button" className="link" onClick={() => onOpen(s)}>
                  {s.title}
                </button>
              </td>
              <td>{campaign?.name ?? <span className="muted">None</span>}</td>
              <td>{platformNames(s.platformTargets, planner.platforms) || '—'}</td>
              <td>
                <span className={`chip ${st.tone === 'plain' ? '' : st.tone}`}>{st.label}</span>
                {st.suggestion && s.project && (
                  <>
                    {' '}
                    <button
                      type="button"
                      title={st.suggestion.reason}
                      onClick={() =>
                        void store.commandOnKnownProject(s.project!, 'core/project.set-status', {
                          status: st.suggestion!.status,
                        })
                      }
                    >
                      Mark {st.suggestion.label}
                    </button>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
