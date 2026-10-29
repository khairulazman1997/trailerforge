import type { DragEvent } from 'react';
import type { KnowledgeEntity, Section } from '@trailerforge/schema';
import { stepTarget, type MoveTarget } from '../storyboard-view.js';
import { EditableText } from './EditableText.js';
import { Chunked } from './Chunked.js';
import { SlotRow, type SlotPatch } from './SlotRow.js';

export interface DropMark {
  sectionId: string;
  /** Slot the dragged one would land before; null = end of the section. */
  beforeSlotId: string | null;
}

export interface SectionCardProps {
  section: Section;
  /** All sections, so slot rows can compute their own move targets. */
  sections: readonly Section[];
  index: number;
  count: number;
  seconds: number;
  entities: readonly KnowledgeEntity[];
  /** A task is running on the project: nothing can be changed. */
  busy: boolean;
  dropMark: DropMark | null;
  dragging: boolean;
  onRename: (name: string) => void;
  onLock: (locked: boolean) => void;
  onWhy: () => void;
  onRewrite: () => void;
  onStepSection: (delta: -1 | 1) => void;
  onRemoveSection: () => void;
  onAddSlot: (kind: 'shot' | 'card') => void;
  onPatchSlot: (slotId: string, patch: SlotPatch) => Promise<boolean>;
  onRemoveSlot: (slotId: string) => void;
  onMoveSlot: (slotId: string, target: MoveTarget) => void;
  onDragStart: (slotId: string, e: DragEvent<HTMLElement>, row: HTMLElement) => void;
  onDragEnd: () => void;
  onDragOverRow: (sectionId: string, slotId: string, e: DragEvent<HTMLElement>) => void;
  onDragOverEnd: (sectionId: string, e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

/** A section of the storyboard: its slots, lock, and the controls to reshape it. */
export function SectionCard(p: SectionCardProps) {
  const { section: s } = p;
  const locked = s.locked;
  const readOnly = locked || p.busy;

  return (
    <section
      className={`section${locked ? ' locked' : ''}`}
      data-section={s.id}
      aria-label={s.name}
    >
      <header className="section-head">
        {readOnly ? (
          <h2>{s.name}</h2>
        ) : (
          <h2>
            <EditableText
              label={`Name of section ${s.name}`}
              value={s.name}
              className="title"
              onCommit={p.onRename}
            />
          </h2>
        )}
        {s.role && <span className="chip">{s.role}</span>}
        <span className="chip" data-testid={`seconds-${s.id}`}>
          {p.seconds} s
        </span>
        {locked && <span className="chip warn">Locked</span>}
        <span className="spacer" />
        <button type="button" className="ghost" onClick={p.onWhy} aria-label={`Why ${s.name}?`}>
          Why?
        </button>
        {!readOnly && (
          <button type="button" aria-label={`Rewrite ${s.name}`} onClick={p.onRewrite}>
            Rewrite…
          </button>
        )}
        <button
          type="button"
          aria-pressed={locked}
          disabled={p.busy}
          onClick={() => p.onLock(!locked)}
          title={
            locked
              ? 'Unlock to edit or regenerate'
              : 'Locked sections are never changed by you or the AI'
          }
        >
          {locked ? '🔒 Unlock' : 'Lock'}
        </button>
        {!readOnly && (
          <>
            <button
              type="button"
              className="ghost"
              disabled={p.index === 0}
              aria-label={`Move section ${s.name} up`}
              onClick={() => p.onStepSection(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="ghost"
              disabled={p.index === p.count - 1}
              aria-label={`Move section ${s.name} down`}
              onClick={() => p.onStepSection(1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`Delete section ${s.name}`}
              onClick={p.onRemoveSection}
            >
              Delete
            </button>
          </>
        )}
      </header>
      {s.purpose && <p className="muted section-purpose">{s.purpose}</p>}
      {locked && <p className="hint">This section is locked. Unlock it to change it.</p>}

      <ul
        className={`slots${p.dragging && !locked ? ' dropzone' : ''}`}
        aria-label={`Slots in ${s.name}`}
        onDragOver={(e) => p.onDragOverEnd(s.id, e)}
        onDrop={p.onDrop}
      >
        <Chunked items={s.slots}>
          {(slot, i) => {
            const mark =
              p.dropMark?.sectionId === s.id
                ? p.dropMark.beforeSlotId === slot.id
                  ? 'before'
                  : p.dropMark.beforeSlotId === null && i === s.slots.length - 1
                    ? 'after'
                    : null
                : null;
            return (
              <SlotRow
                key={slot.id}
                slot={slot}
                entities={p.entities}
                readOnly={readOnly}
                canMoveUp={stepTarget(p.sections, slot.id, -1) !== null}
                canMoveDown={stepTarget(p.sections, slot.id, 1) !== null}
                dropMark={mark}
                onPatch={(patch) => p.onPatchSlot(slot.id, patch)}
                onRemove={() => p.onRemoveSlot(slot.id)}
                onStep={(delta) => {
                  const t = stepTarget(p.sections, slot.id, delta);
                  if (t) p.onMoveSlot(slot.id, t);
                }}
                onDragStart={(e, row) => p.onDragStart(slot.id, e, row)}
                onDragEnd={p.onDragEnd}
                onDragOver={(e) => p.onDragOverRow(s.id, slot.id, e)}
                onDrop={p.onDrop}
              />
            );
          }}
        </Chunked>
        {s.slots.length === 0 && (
          <li className="empty-slots muted">
            No slots yet.{!readOnly && ' Add one below, or drag one here.'}
          </li>
        )}
      </ul>

      {!readOnly && (
        <div className="row">
          <button type="button" onClick={() => p.onAddSlot('shot')}>
            Add shot
          </button>
          <button type="button" onClick={() => p.onAddSlot('card')}>
            Add card
          </button>
        </div>
      )}
    </section>
  );
}
