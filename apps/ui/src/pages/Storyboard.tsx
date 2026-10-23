import { useEffect, useState, type DragEvent } from 'react';
import type { Section } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { GenerateDialog, RewriteDialog } from '../components/GenerateDialogs.js';
import { SectionCard, type DropMark } from '../components/SectionCard.js';
import type { SlotPatch } from '../components/SlotRow.js';
import { TimingBar } from '../components/TimingBar.js';
import { WhyPanel } from '../components/WhyPanel.js';
import { makeId } from '../ids.js';
import { busyTask } from '../store.js';
import { decisionsFor, dropTarget, storyboardTiming, type MoveTarget } from '../storyboard-view.js';

export function StoryboardPage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const decisions = useAppState((s) => s.decisions[id]);
  const busyT = useAppState((s) => busyTask(s, id));
  const busy = !!busyT;
  const sb = view.project.storyboard;
  const entities = view.project.knowledge;

  const [drag, setDrag] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [whySection, setWhySection] = useState<string | null>(null);
  const [removingSection, setRemovingSection] = useState<Section | null>(null);
  const [newSection, setNewSection] = useState('');
  const [generating, setGenerating] = useState(false);
  const [rewriting, setRewriting] = useState<Section | null>(null);

  const revision = sb?.revision;
  const hasStoryboard = sb !== null;
  useEffect(() => {
    if (hasStoryboard) void store.loadDecisions(id);
  }, [store, id, revision, hasStoryboard]);

  if (!sb) {
    return (
      <>
        <h1>Storyboard</h1>
        {busyT?.kind === 'generate' ? (
          <p className="banner" role="status">
            Generating the storyboard…{' '}
            <button type="button" onClick={() => void store.cancelTask(busyT.id)}>
              Cancel
            </button>
          </p>
        ) : (
          <>
            <p>
              No storyboard yet. TrailerForge writes a first draft from your brief and game facts,
              shaped by a template for the video type. You then edit, reorder and lock it.
            </p>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => setGenerating(true)}
            >
              Generate storyboard…
            </button>
          </>
        )}
        <GenerateDialog id={id} open={generating} onClose={() => setGenerating(false)} />
      </>
    );
  }

  const timing = storyboardTiming(sb);
  const cmd = (type: string, payload: unknown) => store.command(id, type, payload);
  const slotCount = sb.sections.reduce((n, s) => n + s.slots.length, 0);
  const sectionName = whySection
    ? (sb.sections.find((s) => s.id === whySection)?.name ?? null)
    : null;

  const move = (slotId: string, t: MoveTarget) =>
    void cmd('core/storyboard.move-slot', { slotId, toSectionId: t.toSectionId, index: t.index });

  const endDrag = () => {
    setDrag(null);
    setDropMark(null);
  };

  const overRow = (sectionId: string, slotId: string, e: DragEvent<HTMLElement>) => {
    const section = sb.sections.find((s) => s.id === sectionId);
    if (!drag || !section || section.locked || busy) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const at = section.slots.findIndex((x) => x.id === slotId);
    setDropMark({ sectionId, beforeSlotId: before ? slotId : (section.slots[at + 1]?.id ?? null) });
  };

  const overEnd = (sectionId: string, e: DragEvent<HTMLElement>) => {
    const section = sb.sections.find((s) => s.id === sectionId);
    if (!drag || !section || section.locked || busy) return;
    e.preventDefault();
    setDropMark((m) => (m?.sectionId === sectionId ? m : { sectionId, beforeSlotId: null }));
  };

  const drop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag && dropMark) {
      const t = dropTarget(sb.sections, drag, dropMark.sectionId, dropMark.beforeSlotId);
      if (t) move(drag, t);
    }
    endDrag();
  };

  const addSlot = (sectionId: string, kind: 'shot' | 'card') => {
    const title = kind === 'shot' ? 'New shot' : 'New card';
    const base = {
      id: makeId(kind === 'shot' ? 'sh' : 'cd', title),
      kind,
      title,
      duration: { min: 1.5, ideal: 2, max: 3 },
    };
    void cmd('core/storyboard.add-slot', {
      sectionId,
      slot:
        kind === 'shot'
          ? base
          : { ...base, cardKind: 'custom', templateId: 'core/custom-card', text: '' },
    });
  };

  return (
    <>
      <div className="row">
        <h1>Storyboard</h1>
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => setGenerating(true)}>
          Generate again…
        </button>
        <button
          type="button"
          aria-pressed={whyOpen && whySection === null}
          onClick={() => {
            setWhySection(null);
            setWhyOpen(!(whyOpen && whySection === null));
          }}
        >
          Why this storyboard?
        </button>
      </div>
      <p className="muted">
        {sb.sections.length} sections · {slotCount} slots · revision {sb.revision}
        {sb.meta.templateId ? ` · from ${sb.meta.templateId}` : ''}
      </p>

      {busyT && (
        <p className="banner" role="status">
          Working: {busyT.kind}… editing is paused.{' '}
          <button type="button" onClick={() => void store.cancelTask(busyT.id)}>
            Cancel
          </button>
        </p>
      )}

      <TimingBar
        timing={timing}
        sections={sb.sections}
        disabled={busy}
        onTarget={(seconds) => void cmd('core/storyboard.set-target-duration', { seconds })}
      />

      {whyOpen && (
        <WhyPanel
          decisions={decisionsFor(decisions ?? [], whySection)}
          sectionName={sectionName}
          onShowAll={() => setWhySection(null)}
          onClose={() => setWhyOpen(false)}
        />
      )}

      <div className="sections">
        {sb.sections.map((section, i) => (
          <SectionCard
            key={section.id}
            section={section}
            sections={sb.sections}
            index={i}
            count={sb.sections.length}
            seconds={timing.sections[i]!.seconds}
            entities={entities}
            busy={busy}
            dropMark={dropMark}
            dragging={drag !== null}
            onRename={(name) =>
              void cmd('core/storyboard.update-section', { sectionId: section.id, patch: { name } })
            }
            onLock={(locked) =>
              void cmd('core/storyboard.set-section-locked', { sectionId: section.id, locked })
            }
            onRewrite={() => setRewriting(section)}
            onWhy={() => {
              setWhySection(section.id);
              setWhyOpen(true);
            }}
            onStepSection={(delta) =>
              void cmd('core/storyboard.move-section', { sectionId: section.id, index: i + delta })
            }
            onRemoveSection={() => setRemovingSection(section)}
            onAddSlot={(kind) => addSlot(section.id, kind)}
            onPatchSlot={(slotId: string, patch: SlotPatch) =>
              cmd('core/storyboard.update-slot', { slotId, patch })
            }
            onRemoveSlot={(slotId) => void cmd('core/storyboard.remove-slot', { slotId })}
            onMoveSlot={move}
            onDragStart={(slotId, e, row) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', slotId);
              e.dataTransfer.setDragImage(row, 8, 8);
              setDrag(slotId);
            }}
            onDragEnd={endDrag}
            onDragOverRow={overRow}
            onDragOverEnd={overEnd}
            onDrop={drop}
          />
        ))}
      </div>

      <form
        className="row add-section"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newSection.trim();
          if (!name) return;
          void cmd('core/storyboard.add-section', { id: makeId('sec', name), name }).then(
            (ok) => ok && setNewSection(''),
          );
        }}
      >
        <label className="grow">
          New section
          <input
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
            placeholder="e.g. Boss reveal"
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy || !newSection.trim()}>
          Add section
        </button>
      </form>

      <GenerateDialog id={id} open={generating} onClose={() => setGenerating(false)} />
      <RewriteDialog id={id} section={rewriting} onClose={() => setRewriting(null)} />

      <ConfirmDialog
        open={!!removingSection}
        title={`Delete “${removingSection?.name ?? ''}”?`}
        confirmLabel="Delete section"
        tone="danger"
        onCancel={() => setRemovingSection(null)}
        onConfirm={async () => {
          if (removingSection)
            await cmd('core/storyboard.remove-section', { sectionId: removingSection.id });
          setRemovingSection(null);
        }}
      >
        <p>
          The section and its {removingSection?.slots.length ?? 0} slot(s) are removed, along with
          voice-over lines and music cues that pointed at them. You can undo this.
        </p>
      </ConfirmDialog>
    </>
  );
}
