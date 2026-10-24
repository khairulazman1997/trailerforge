import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { CaptureItem } from '@trailerforge/pack-game-trailer/browser';
import type { ShotSlot, SlotStatus } from '@trailerforge/schema';
import { formatSeconds } from '../capture-view.js';
import { Thumb } from './Thumb.js';
import { usePending } from '../use-pending.js';

const STATUS_LABEL: Record<SlotStatus, string> = {
  empty: 'Not recorded',
  recorded: 'Recorded',
  approved: 'Approved',
  rejected: 'Rejected, record again',
};

/** Multi-line text committed on blur; follows the live value while you are not editing. */
function NotesField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      className="cap-notes"
      aria-label={label}
      placeholder="Notes for this shot"
      rows={1}
      disabled={disabled}
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

/** A recording attached to a shot, with what the row needs to show it. */
export interface ImportedTake {
  take: ShotSlot['takes'][number];
  name: string;
  /** The recording's thumbnail has been built. */
  preview: boolean;
}

export interface CaptureItemHandlers {
  onChoose: (takeId: string | null) => void;
  onReject: (takeId: string, rejected: boolean) => void;
  onStatus: (status: SlotStatus) => Promise<unknown>;
  onNotes: (notes: string) => void;
  onTakes: (takes: number) => void;
  onSkip: () => void;
  onMove: (dir: -1 | 1) => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

export function CaptureItemRow({
  item,
  index,
  count,
  disabled,
  dropMark,
  code,
  imported,
  chosenTakeId,
  ...h
}: {
  item: CaptureItem;
  /** Recordings attached to this shot (from the Footage tab or the engine). */
  imported: ImportedTake[];
  chosenTakeId: string | undefined;
  /** Shot code to type into the recording's file name. */
  code: string | undefined;
  index: number;
  count: number;
  disabled: boolean;
  dropMark: 'before' | 'after' | null;
} & CaptureItemHandlers) {
  const name = item.title || item.slotId;
  const [status, setStatus] = usePending(item.status);
  const done = status === 'recorded' || status === 'approved';
  const choose = (next: SlotStatus) => void setStatus(next, () => h.onStatus(next));
  return (
    <li
      className={`cap-item${done ? ' done' : ''}${dropMark ? ` drop-${dropMark}` : ''}`}
      data-slot={item.slotId}
      onDragOver={h.onDragOver}
      onDrop={h.onDrop}
    >
      <div className="cap-main">
        <input
          type="checkbox"
          className="cap-tick"
          aria-label={`Recorded: ${name}`}
          checked={done}
          disabled={disabled}
          onChange={(e) => choose(e.target.checked ? 'recorded' : 'empty')}
        />
        <div className="cap-body">
          <div className="cap-head">
            <strong className="cap-title">{name}</strong>
            {code && (
              <code className="chip cap-code" title="Put this code in the recording's file name">
                {code}
              </code>
            )}
            <span className="chip">{item.sectionName}</span>
            <span className="chip" title="Record a bit more than the cut, so the edit has handles">
              Record {item.recordSeconds} s
            </span>
            <span className="chip">Cut {formatSeconds(item.duration.ideal)}</span>
            <span className="chip">HUD {item.hud}</span>
            {item.priority === 'nice' && <span className="chip">Nice to have</span>}
            {item.status === 'rejected' && <span className="chip warn">Record again</span>}
          </div>
          {item.instruction && <p className="cap-do">{item.instruction}</p>}
          <dl className="cap-facts">
            {item.framing && (
              <>
                <dt>Framing</dt>
                <dd>{item.framing}</dd>
              </>
            )}
            {item.setup && (
              <>
                <dt>Setup</dt>
                <dd>{item.setup}</dd>
              </>
            )}
            {item.entities.length > 0 && (
              <>
                <dt>Features</dt>
                <dd>{item.entities.map((e) => e.name).join(', ')}</dd>
              </>
            )}
            {item.alternates.length > 0 && (
              <>
                <dt>Alternatives</dt>
                <dd>{item.alternates.join('; ')}</dd>
              </>
            )}
          </dl>
          {imported.length > 0 && (
            <ul className="cap-imported" aria-label={`Recordings for ${name}`}>
              {imported.map(({ take, name: file, preview }) => (
                <li key={take.id} className={take.rejected ? 'rejected' : ''}>
                  <Thumb assetId={take.assetId} name={file} ready={preview} />
                  <span>{file}</span>
                  {chosenTakeId === take.id && <span className="chip ok">used in the cut</span>}
                  {take.rejected && <span className="chip warn">rejected</span>}
                  <button
                    type="button"
                    disabled={disabled || take.rejected}
                    aria-label={`${chosenTakeId === take.id ? 'Let the cut choose instead of' : 'Use'} ${file} for ${name}`}
                    onClick={() => h.onChoose(chosenTakeId === take.id ? null : take.id)}
                  >
                    {chosenTakeId === take.id ? 'Let the cut choose' : 'Use this take'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`${take.rejected ? 'Restore' : 'Reject'} ${file} for ${name}`}
                    onClick={() => h.onReject(take.id, !take.rejected)}
                  >
                    {take.rejected ? 'Restore' : 'Reject'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <NotesField
            label={`Notes for ${name}`}
            value={item.notes}
            disabled={disabled}
            onCommit={h.onNotes}
          />
          <div className="row cap-controls">
            <label className="inline">
              Status
              <select
                aria-label={`Status of ${name}`}
                value={status}
                disabled={disabled}
                onChange={(e) => choose(e.target.value as SlotStatus)}
              >
                {(Object.keys(STATUS_LABEL) as SlotStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <span className="cap-takes" role="group" aria-label={`Takes of ${name}`}>
              <button
                type="button"
                aria-label={`One fewer take of ${name}`}
                disabled={disabled || item.takes === 0}
                onClick={() => h.onTakes(item.takes - 1)}
              >
                −
              </button>
              <output aria-label={`Takes recorded of ${name}`}>
                {item.takes} {item.takes === 1 ? 'take' : 'takes'}
              </output>
              <button
                type="button"
                aria-label={`One more take of ${name}`}
                disabled={disabled}
                onClick={() => h.onTakes(item.takes + 1)}
              >
                +
              </button>
            </span>
            <span className="spacer" />
            <button
              type="button"
              aria-label={`Move ${name} up`}
              disabled={disabled || index === 0}
              onClick={() => h.onMove(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${name} down`}
              disabled={disabled || index === count - 1}
              onClick={() => h.onMove(1)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Skip ${name}`}
              disabled={disabled}
              onClick={h.onSkip}
            >
              Skip
            </button>
          </div>
        </div>
        {count > 1 && !disabled && (
          // Mouse-only shortcut: keyboard and screen-reader users have the ↑/↓ buttons.
          <span
            className="ghost handle"
            draggable
            aria-hidden="true"
            title="Drag to reorder within this group"
            onDragStart={h.onDragStart}
            onDragEnd={h.onDragEnd}
          >
            ⠿
          </span>
        )}
      </div>
    </li>
  );
}
