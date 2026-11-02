import { useEffect, useState } from 'react';
import type { LlmPreview } from '@trailerforge/service/client';
import type { Section, Storyboard } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { giveConsent, hasConsent } from '../consent.js';
import { commentWhere, isHandEdited, sectionComments } from '../storyboard-view.js';
import { Link, projectPath } from '../router.js';
import { ConfirmDialog } from './Dialog.js';
import { Disclosure } from './Disclosure.js';

export type Task =
  'storyboard.generate' | 'storyboard.regenerate-section' | 'capture.tips' | 'critique.run';

/** Loads the disclosure each time a dialog opens; null while loading. */
export function usePreview(projectId: string, task: Task, open: boolean): LlmPreview | null {
  const store = useStore();
  const [preview, setPreview] = useState<LlmPreview | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void store.llmPreview(projectId, task).then((p) => live && setPreview(p));
    return () => {
      live = false;
      setPreview(null); // never show a stale disclosure the next time the dialog opens
    };
  }, [store, projectId, task, open]);
  return preview;
}

/** Sending to another service needs an explicit yes; it is remembered for this tab session. */
export const needsConsent = (p: LlmPreview | null) =>
  !!p?.provider?.sendsDataOffDevice && !hasConsent(p.provider.id);

export function GenerateDialog({
  id,
  open,
  onClose,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const project = useAppState((s) => s.projects[id])!.project;
  const info = useAppState((s) => s.info);
  const form = useAppState((s) => s.briefs[id]?.form);
  const preview = usePreview(id, 'storyboard.generate', open);

  const videoTypeId = project.brief.videoTypeId;
  const videoType = info?.videoTypes.find((v) => v.id === videoTypeId);
  const templates = (info?.templates ?? []).filter((t) => t.videoTypeId === videoTypeId);
  const typical = videoType?.typicalDuration;
  const defaultLength = Math.min(Math.max(60, typical?.min ?? 0), typical?.max ?? 60);

  const [template, setTemplate] = useState('');
  const [length, setLength] = useState(String(defaultLength));
  const [assume, setAssume] = useState(false);
  const [useComments, setUseComments] = useState(true);

  useEffect(() => {
    if (open && videoTypeId) void store.loadBrief(id);
  }, [open, store, id, videoTypeId]);

  const sb = project.storyboard;
  const locked = sb?.sections.filter((s) => s.locked).length ?? 0;
  // Comments on locked sections stay open: those sections are not rewritten.
  const commented = (sb?.sections ?? [])
    .filter((s) => !s.locked)
    .map((s) => ({ section: s, comments: sectionComments(sb!, s.id).open }))
    .filter((x) => x.comments.length > 0);
  const commentCount = commented.reduce((n, x) => n + x.comments.length, 0);
  const edited =
    sb?.sections
      .filter((s) => !s.locked)
      .flatMap((s) => s.slots)
      .filter(isHandEdited).length ?? 0;
  const missing =
    form && !form.canProceed ? form.fields.filter((f) => f.required && f.state === 'missing') : [];
  const seconds = Number(length);
  const valid =
    seconds > 0 &&
    Number.isFinite(seconds) &&
    !!preview?.available &&
    (missing.length === 0 || assume);
  const consentNeeded = needsConsent(preview);

  if (!videoTypeId) {
    return (
      <ConfirmDialog
        open={open}
        title="Choose a video type first"
        confirmLabel="Go to the brief"
        onCancel={onClose}
        onConfirm={onClose}
      >
        <p>
          The storyboard is shaped by the video type. Pick one on the{' '}
          <Link to={projectPath(id, 'brief')}>Brief tab</Link>.
        </p>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      title={sb ? 'Generate the storyboard again?' : 'Generate a storyboard'}
      confirmLabel="Generate"
      confirmDisabled={!valid}
      {...(consentNeeded && preview?.provider
        ? { acknowledge: `I understand this information is sent to ${preview.provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!valid) return;
        if (preview?.provider?.sendsDataOffDevice) giveConsent(preview.provider.id);
        await store.startTask(id, {
          kind: 'generate',
          options: {
            duration: seconds,
            ...(template ? { template } : {}),
            ...(assume ? { assume: true } : {}),
            ...(commentCount > 0 ? { useComments } : {}),
          },
        });
        onClose();
      }}
    >
      <div className="stack">
        <div className="row">
          <label className="grow">
            Starting structure
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              aria-label="Template"
            >
              <option value="">{videoType?.name ?? 'Default'} (default)</option>
              {templates
                .filter((t) => t.id !== videoType?.defaultTemplateId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Length (seconds)
            <input
              type="number"
              min={5}
              step={5}
              value={length}
              onChange={(e) => setLength(e.target.value)}
            />
          </label>
        </div>
        {typical && (
          <p className="hint">
            {videoType?.name}s usually run {typical.min}–{typical.max} s.
          </p>
        )}

        {sb && (
          <p className="banner">
            This replaces every unlocked section
            {edited > 0
              ? `, including ${edited} slot${edited === 1 ? '' : 's'} you edited by hand`
              : ''}
            .{' '}
            {locked > 0
              ? `${locked} locked section${locked === 1 ? ' is' : 's are'} kept. `
              : 'Lock a section to keep it. '}
            You can undo it.
          </p>
        )}

        {commentCount > 0 && (
          <div>
            <label className="check">
              <input
                type="checkbox"
                checked={useComments}
                onChange={(e) => setUseComments(e.target.checked)}
              />
              <span>
                Work from the {commentCount} open comment{commentCount === 1 ? '' : 's'} (they are
                marked resolved)
              </span>
            </label>
            {useComments && (
              <ul className="comments" aria-label="Comments sent with the generation">
                {commented.flatMap(({ section, comments }) =>
                  comments.map((c) => (
                    <li key={c.id}>
                      <span className="chip">
                        {section.name}: {commentWhere(section, c)}
                      </span>
                      <span className="grow">{c.text}</span>
                    </li>
                  )),
                )}
              </ul>
            )}
          </div>
        )}

        {missing.length > 0 && (
          <div className="banner" role="alert">
            <p>
              The brief is missing {missing.length} required detail{missing.length === 1 ? '' : 's'}
              : {missing.map((m) => m.label).join(', ')}. Fill{' '}
              {missing.length === 1 ? 'it' : 'them'} in on the{' '}
              <Link to={projectPath(id, 'brief')} onClick={onClose}>
                Brief tab
              </Link>
              , or let the generator fill in sensible guesses.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={assume}
                onChange={(e) => setAssume(e.target.checked)}
              />
              <span>
                Proceed with assumptions (they are listed on the Brief tab and can be removed)
              </span>
            </label>
          </div>
        )}

        <Disclosure preview={preview} />
      </div>
    </ConfirmDialog>
  );
}

export function RewriteDialog({
  id,
  section,
  comments,
  onClose,
}: {
  id: string;
  section: Section | null;
  /** The section's open comments; sent with the rewrite unless the user unticks them. */
  comments: Storyboard['comments'];
  onClose: () => void;
}) {
  const store = useStore();
  const open = section !== null;
  const preview = usePreview(id, 'storyboard.regenerate-section', open);
  const [instruction, setInstruction] = useState('');
  const [keepEdited, setKeepEdited] = useState(true);
  const [useComments, setUseComments] = useState(true);

  // A hand-edited slot with a comment on it is rewritten anyway: the comment asks for a change.
  const commented = new Set(
    useComments ? comments.flatMap((c) => (c.slotId ? [c.slotId] : [])) : [],
  );
  const edited = section?.slots.filter((x) => isHandEdited(x) && !commented.has(x.id)).length ?? 0;
  const total = section?.slots.length ?? 0;
  const nothingToWrite = keepEdited && edited > 0 && edited === total;
  const consentNeeded = needsConsent(preview);

  return (
    <ConfirmDialog
      open={open}
      title={`Rewrite “${section?.name ?? ''}”`}
      confirmLabel="Rewrite section"
      confirmDisabled={!preview?.available || nothingToWrite}
      {...(consentNeeded && preview?.provider
        ? { acknowledge: `I understand this information is sent to ${preview.provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!section || !preview?.available || nothingToWrite) return;
        if (preview.provider?.sendsDataOffDevice) giveConsent(preview.provider.id);
        await store.startTask(id, {
          kind: 'regenerate-section',
          options: {
            sectionId: section.id,
            keepEdited,
            useComments,
            ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
          },
        });
        setInstruction('');
        onClose();
      }}
    >
      <div className="stack">
        {section && comments.length > 0 && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={useComments}
                onChange={(e) => setUseComments(e.target.checked)}
              />
              <span>
                Work from the {comments.length} open comment{comments.length === 1 ? '' : 's'} (they
                are marked resolved)
              </span>
            </label>
            {useComments && (
              <ul className="comments" aria-label="Comments sent with the rewrite">
                {comments.map((c) => (
                  <li key={c.id}>
                    <span className="chip">{commentWhere(section, c)}</span>
                    <span className="grow">{c.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <label>
          {comments.length > 0 && useComments
            ? 'Anything else? (optional)'
            : 'What should change? (optional)'}
          <textarea
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. more forest, less boss; open on the parry"
          />
        </label>
        {edited > 0 && (
          <label className="check">
            <input
              type="checkbox"
              checked={keepEdited}
              onChange={(e) => setKeepEdited(e.target.checked)}
            />
            <span>
              Keep the {edited} slot{edited === 1 ? '' : 's'} I edited by hand
            </span>
          </label>
        )}
        {nothingToWrite && (
          <p className="error" role="alert">
            Every slot here was edited by you, so there is nothing to rewrite. Untick the box above
            to rewrite them too.
          </p>
        )}
        <p className="hint">
          The section keeps its place and its length. You can undo the rewrite.
        </p>
        <Disclosure preview={preview} />
      </div>
    </ConfirmDialog>
  );
}

/** Rewrite every unlocked section with open comments, each from its own comments. */
export function RefineDialog({
  id,
  open,
  sections,
  storyboard,
  onClose,
}: {
  id: string;
  open: boolean;
  sections: Section[];
  storyboard: Storyboard;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'storyboard.regenerate-section', open);
  const [keepEdited, setKeepEdited] = useState(true);
  const consentNeeded = needsConsent(preview);

  return (
    <ConfirmDialog
      open={open}
      title="Refine the storyboard from your comments"
      confirmLabel={`Rewrite ${sections.length} section${sections.length === 1 ? '' : 's'}`}
      confirmDisabled={!preview?.available || sections.length === 0}
      {...(consentNeeded && preview?.provider
        ? { acknowledge: `I understand this information is sent to ${preview.provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available || sections.length === 0) return;
        if (preview.provider?.sendsDataOffDevice) giveConsent(preview.provider.id);
        await store.startTask(id, {
          kind: 'refine-storyboard',
          options: { sectionIds: sections.map((s) => s.id), keepEdited },
        });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          Each section below is rewritten by the AI from its open comments, in the time it has now.
          The comments are then marked resolved. Locked sections are left alone.
        </p>
        {sections.map((s) => (
          <div key={s.id}>
            <strong>{s.name}</strong>
            <ul className="comments" aria-label={`Comments on ${s.name}`}>
              {sectionComments(storyboard, s.id).open.map((c) => (
                <li key={c.id}>
                  <span className="chip">{commentWhere(s, c)}</span>
                  <span className="grow">{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={keepEdited}
            onChange={(e) => setKeepEdited(e.target.checked)}
          />
          <span>Keep slots I edited by hand, unless a comment is on them</span>
        </label>
        <p className="hint">
          Shots with recordings are always kept. Each rewrite is one undo step.
        </p>
        <Disclosure preview={preview} />
      </div>
    </ConfirmDialog>
  );
}
