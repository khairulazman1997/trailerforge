import { useState, type DragEvent } from 'react';
import type { KnowledgeEntity, Slot } from '@trailerforge/schema';
import { isHandEdited } from '../storyboard-view.js';
import { EditableText } from './EditableText.js';

export interface SlotPatch {
  [field: string]: unknown;
}

export interface SlotRowProps {
  slot: Slot;
  entities: readonly KnowledgeEntity[];
  /** Locked section, or a task is running: show it, don't change it. */
  readOnly: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dropMark: 'before' | 'after' | null;
  onPatch: (patch: SlotPatch) => Promise<boolean>;
  onRemove: () => void;
  onStep: (delta: -1 | 1) => void;
  onDragStart: (e: DragEvent<HTMLElement>, row: HTMLElement) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

const lines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** One shot or card: title and length editable in place, the rest in an expandable editor. */
export function SlotRow(p: SlotRowProps) {
  const { slot, readOnly } = p;
  const [open, setOpen] = useState(false);
  const names = new Map(p.entities.map((e) => [e.id, e.name]));
  const summary = slot.kind === 'card' ? slot.text : slot.captureInstruction;

  return (
    <li
      className={`slot ${slot.kind}${p.dropMark ? ` drop-${p.dropMark}` : ''}`}
      data-slot={slot.id}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
    >
      <div className="slot-main">
        {!readOnly && (
          <button
            type="button"
            className="ghost handle"
            draggable
            aria-label={`Drag ${slot.title || slot.id} to move it`}
            title="Drag to move"
            onDragStart={(e) => p.onDragStart(e, e.currentTarget.closest('li') as HTMLElement)}
            onDragEnd={p.onDragEnd}
          >
            ⠿
          </button>
        )}
        <span className="chip kind">{slot.kind === 'card' ? 'Card' : 'Shot'}</span>
        {readOnly ? (
          <strong className="slot-title">{slot.title || slot.id}</strong>
        ) : (
          <EditableText
            label={`Title of ${slot.title || slot.id}`}
            value={slot.title}
            className="slot-title"
            onCommit={(title) => void p.onPatch({ title })}
          />
        )}
        {isHandEdited(slot) && (
          <span
            className="chip ok"
            title="You changed this slot; regenerating its section keeps it."
          >
            Edited
          </span>
        )}
        {slot.priority === 'nice' && (
          <span className="chip" title="Can be dropped from shorter cuts">
            Optional
          </span>
        )}
        <label className="inline seconds">
          <span className="sr-only">Length of {slot.title || slot.id} in seconds</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            defaultValue={slot.duration.ideal}
            key={slot.duration.ideal}
            disabled={readOnly}
            onBlur={(e) => {
              const ideal = Math.round(Number(e.target.value) * 10) / 10;
              if (!(ideal > 0) || ideal === slot.duration.ideal) return;
              void p.onPatch({
                duration: {
                  min: Math.min(slot.duration.min, ideal),
                  ideal,
                  max: Math.max(slot.duration.max, ideal),
                },
              });
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />{' '}
          s
        </label>
        {!readOnly && (
          <div className="slot-actions">
            <button
              type="button"
              className="ghost"
              disabled={!p.canMoveUp}
              aria-label={`Move ${slot.title || slot.id} up`}
              onClick={() => p.onStep(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!p.canMoveDown}
              aria-label={`Move ${slot.title || slot.id} down`}
              onClick={() => p.onStep(1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="ghost"
              aria-expanded={open}
              aria-label={`${open ? 'Close' : 'Edit'} details of ${slot.title || slot.id}`}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Done' : 'Details'}
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`Delete ${slot.title || slot.id}`}
              onClick={p.onRemove}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {summary && !open && <p className="slot-summary">{summary}</p>}
      {slot.entityIds.length > 0 && !open && (
        <p className="slot-entities">
          {slot.entityIds.map((id) => (
            <span key={id} className="chip">
              {names.get(id) ?? id}
            </span>
          ))}
        </p>
      )}
      {open && !readOnly && (
        <SlotEditor
          slot={slot}
          entities={p.entities}
          onSave={p.onPatch}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  );
}

function SlotEditor({
  slot,
  entities,
  onSave,
  onClose,
}: {
  slot: Slot;
  entities: readonly KnowledgeEntity[];
  onSave: (patch: SlotPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const [purpose, setPurpose] = useState(slot.purpose);
  const [audioNotes, setAudioNotes] = useState(slot.audioNotes);
  const [priority, setPriority] = useState(slot.priority);
  const [min, setMin] = useState(String(slot.duration.min));
  const [max, setMax] = useState(String(slot.duration.max));
  const [entityIds, setEntityIds] = useState(slot.entityIds);
  const [capture, setCapture] = useState(slot.kind === 'shot' ? slot.captureInstruction : '');
  const [setup, setSetup] = useState(slot.kind === 'shot' ? slot.setup : '');
  const [location, setLocation] = useState(slot.kind === 'shot' ? slot.location : '');
  const [framing, setFraming] = useState(slot.kind === 'shot' ? slot.framing : '');
  const [hud, setHud] = useState(slot.kind === 'shot' ? slot.hud : 'any');
  const [alternates, setAlternates] = useState(
    slot.kind === 'shot' ? slot.alternates.join('\n') : '',
  );
  const [text, setText] = useState(slot.kind === 'card' ? slot.text : '');
  const [saving, setSaving] = useState(false);

  const numMin = Number(min);
  const numMax = Number(max);
  const rangeOk = numMin > 0 && numMax >= slot.duration.ideal && numMin <= slot.duration.ideal;

  const save = async () => {
    const patch: SlotPatch = {};
    if (purpose !== slot.purpose) patch.purpose = purpose;
    if (audioNotes !== slot.audioNotes) patch.audioNotes = audioNotes;
    if (priority !== slot.priority) patch.priority = priority;
    if (numMin !== slot.duration.min || numMax !== slot.duration.max) {
      patch.duration = { min: numMin, ideal: slot.duration.ideal, max: numMax };
    }
    if (entityIds.join() !== slot.entityIds.join()) patch.entityIds = entityIds;
    if (slot.kind === 'shot') {
      if (capture !== slot.captureInstruction) patch.captureInstruction = capture;
      if (setup !== slot.setup) patch.setup = setup;
      if (location !== slot.location) patch.location = location;
      if (framing !== slot.framing) patch.framing = framing;
      if (hud !== slot.hud) patch.hud = hud;
      if (alternates !== slot.alternates.join('\n')) patch.alternates = lines(alternates);
    } else if (text !== slot.text) {
      patch.text = text;
    }
    if (Object.keys(patch).length === 0) return onClose();
    setSaving(true);
    const ok = await onSave(patch);
    setSaving(false);
    if (ok) onClose();
  };

  const free = entities.filter((e) => !entityIds.includes(e.id));
  return (
    <form
      className="slot-editor stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {slot.kind === 'shot' ? (
        <>
          <label>
            What to capture
            <textarea rows={3} value={capture} onChange={(e) => setCapture(e.target.value)} />
          </label>
          <div className="row">
            <label className="grow">
              Setup
              <input value={setup} onChange={(e) => setSetup(e.target.value)} />
            </label>
            <label className="grow">
              Location
              <input value={location} onChange={(e) => setLocation(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <label className="grow">
              Framing
              <input value={framing} onChange={(e) => setFraming(e.target.value)} />
            </label>
            <label>
              HUD
              <select value={hud} onChange={(e) => setHud(e.target.value as typeof hud)}>
                <option value="any">Either</option>
                <option value="on">Show</option>
                <option value="off">Hide</option>
              </select>
            </label>
          </div>
          <label>
            Alternatives if this can&apos;t be captured (one per line)
            <textarea rows={2} value={alternates} onChange={(e) => setAlternates(e.target.value)} />
          </label>
        </>
      ) : (
        <label>
          Text on the card
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <label>
        Why it is in the edit
        <textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <label>
        Audio notes
        <input value={audioNotes} onChange={(e) => setAudioNotes(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Shortest (s)
          <input
            type="number"
            step={0.1}
            min={0.1}
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label>
          Longest (s)
          <input
            type="number"
            step={0.1}
            min={0.1}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="must">Needed</option>
            <option value="nice">Optional</option>
          </select>
        </label>
      </div>
      {!rangeOk && (
        <p className="error">
          Shortest must be at most {slot.duration.ideal} s and longest at least that.
        </p>
      )}
      <div>
        <span className="field-label">Game facts shown here</span>
        <p className="slot-entities">
          {entityIds.map((id) => (
            <span key={id} className="chip">
              {entities.find((e) => e.id === id)?.name ?? id}
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${entities.find((e) => e.id === id)?.name ?? id} from this slot`}
                onClick={() => setEntityIds(entityIds.filter((x) => x !== id))}
              >
                ×
              </button>
            </span>
          ))}
        </p>
        {free.length > 0 && (
          <select
            aria-label="Add a game fact to this slot"
            value=""
            onChange={(e) => e.target.value && setEntityIds([...entityIds, e.target.value])}
          >
            <option value="">Add a game fact…</option>
            {free.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.kind})
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={saving || !rangeOk}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
