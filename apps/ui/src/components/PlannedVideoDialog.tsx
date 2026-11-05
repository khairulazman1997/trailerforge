import { useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { examplePath, joinPath } from '../desktop.js';
import { isIsoDate, STATUS_LABEL, statusChip, statusLabel } from '../planner-view.js';
import { navigate, projectPath } from '../router.js';
import type { PlannerSnapshot } from '../store.js';
import { BrowseButton } from './BrowseButton.js';
import { ConfirmDialog, Dialog } from './Dialog.js';
import { VideoTypeOptions } from './VideoTypeOptions.js';

export type PlannedSlot = PlannerSnapshot['slots'][number];

const STATUSES = Object.keys(STATUS_LABEL);

/**
 * One planned video: its title, date, campaign, platforms and notes, and, once it has a
 * project, that project's status. Mount it fresh for each video (a new `key`); it closes by
 * calling `onClose`.
 */
export function PlannedVideoDialog({
  slot,
  defaultDate,
  planner,
  onClose,
}: {
  /** The video being edited, or null for a new one. */
  slot: PlannedSlot | null;
  defaultDate: string;
  planner: PlannerSnapshot;
  onClose: () => void;
}) {
  const store = useStore();
  const videoTypes = useAppState((s) => s.info?.videoTypes ?? []);
  const [title, setTitle] = useState(slot?.title ?? '');
  const [date, setDate] = useState(slot ? (slot.project?.scheduledDate ?? slot.date) : defaultDate);
  const [campaignId, setCampaignId] = useState(slot?.campaignId ?? '');
  const [platforms, setPlatforms] = useState<string[]>([...(slot?.platformTargets ?? [])]);
  const [videoType, setVideoType] = useState(slot?.videoTypeId ?? '');
  const [notes, setNotes] = useState(slot?.notes ?? '');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const project = slot?.project ?? null;
  const chip = statusChip({ project });
  const dateOk = isIsoDate(date);
  const valid = title.trim().length > 0 && dateOk;
  const platformSet = platforms.join(',');
  const dirty =
    slot !== null &&
    (title.trim() !== slot.title ||
      (campaignId || null) !== slot.campaignId ||
      platformSet !== slot.platformTargets.join(',') ||
      (videoType || '') !== (slot.videoTypeId ?? '') ||
      notes !== slot.notes ||
      date !== (project?.scheduledDate ?? slot.date));

  const toggle = (id: string) =>
    setPlatforms((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));

  const save = async (): Promise<boolean> => {
    if (!valid) return false;
    setBusy(true);
    try {
      if (!slot) {
        return await store.plannerCommand('planner/slot.add', {
          title: title.trim(),
          date,
          campaignId: campaignId || null,
          platformTargets: platforms,
          ...(videoType ? { videoTypeId: videoType } : {}),
          ...(notes ? { notes } : {}),
        });
      }
      const ok = await store.plannerCommand('planner/slot.set', {
        slotId: slot.id,
        title: title.trim(),
        campaignId: campaignId || null,
        platformTargets: platforms,
        videoTypeId: videoType || null,
        notes,
      });
      if (!ok) return false;
      if (date !== (project?.scheduledDate ?? slot.date)) {
        const moved = await store.plannerCommand('planner/slot.move', { slotId: slot.id, date });
        if (!moved) return false;
        if (project && project.state === 'ok')
          return store.commandOnKnownProject(project, 'core/project.set-schedule', {
            scheduledDate: date,
          });
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: string) => {
    if (!project) return;
    setBusy(true);
    await store.commandOnKnownProject(project, 'core/project.set-status', { status });
    setBusy(false);
  };

  const createProject = async () => {
    if (!slot) return;
    setBusy(true);
    const id = await store.createProjectFromSlot(slot.id, folder.trim() || undefined);
    setBusy(false);
    if (id) {
      onClose();
      navigate(projectPath(id));
    }
  };

  const openProject = async () => {
    if (!project?.dir) return;
    setBusy(true);
    const id = await store.openProject(project.dir);
    setBusy(false);
    if (id) {
      onClose();
      navigate(projectPath(id));
    }
  };

  return (
    <>
      <Dialog
        open
        title={slot ? 'Planned video' : 'Plan a video'}
        onClose={onClose}
        footer={
          <>
            {slot && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                Remove from the calendar
              </button>
            )}
            <span className="spacer" />
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !valid || (slot !== null && !dirty)}
              onClick={() =>
                void save().then((ok) => {
                  if (ok) onClose();
                })
              }
            >
              {slot ? 'Save' : 'Add to the calendar'}
            </button>
          </>
        }
      >
        <div className="stack">
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Release trailer"
              autoFocus
            />
          </label>
          <label>
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={!dateOk}
            />
          </label>
          <label>
            Campaign
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">No campaign</option>
              {planner.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Platforms</legend>
            <div className="platform-list">
              {planner.platforms.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={platforms.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />{' '}
                  {p.name} <small className="muted">{p.aspect}</small>
                </label>
              ))}
            </div>
            <small className="muted">
              Each platform gets its own version (shape, size and export preset) when the project is
              made.
            </small>
          </fieldset>
          <label>
            Video type
            <select value={videoType} onChange={(e) => setVideoType(e.target.value)}>
              <option value="">Choose later</option>
              <VideoTypeOptions types={videoTypes} />
            </select>
          </label>
          <label>
            Notes
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>

          {slot && (
            <section aria-labelledby="planned-project-h" className="planned-project">
              <h3 id="planned-project-h">Project</h3>
              {project ? (
                <>
                  <p>
                    <strong>{project.name}</strong>{' '}
                    <span className={`chip ${chip.tone === 'plain' ? '' : chip.tone}`}>
                      {chip.label}
                    </span>
                  </p>
                  {project.state === 'ok' && project.status !== null && (
                    <label>
                      Status
                      <select
                        value={project.status}
                        disabled={busy}
                        onChange={(e) => void setStatus(e.target.value)}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {statusLabel(s)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {chip.suggestion && (
                    <p>
                      {chip.suggestion.reason} Mark it {chip.suggestion.label}?{' '}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void setStatus(chip.suggestion!.status)}
                      >
                        Apply
                      </button>
                    </p>
                  )}
                  <div className="row">
                    <button
                      type="button"
                      disabled={busy || project.state !== 'ok' || !project.dir}
                      onClick={() => void openProject()}
                    >
                      Open project
                    </button>
                    {project.state !== 'ok' && (
                      <small className="warn-text">
                        The project folder is {project.state}; the calendar cannot open it.
                      </small>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="muted">
                    No project yet.
                    {platforms.length === 0 && ' Pick a platform first to get a version for it.'}
                  </p>
                  <label>
                    Project folder (optional)
                    <input
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      placeholder={examplePath('MyGame.tforge')}
                      spellCheck={false}
                    />
                  </label>
                  <div className="row">
                    <BrowseButton
                      label="Choose where to put it…"
                      disabled={busy}
                      onPick={(parent) =>
                        setFolder(joinPath(parent, `${title.trim() || 'Planned video'}.tforge`))
                      }
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || dirty}
                      onClick={() => void createProject()}
                    >
                      Create project
                    </button>
                    {dirty && <small className="muted">Save your changes first.</small>}
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove from the calendar?"
        tone="danger"
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          if (!slot) return;
          const ok = await store.plannerCommand('planner/slot.remove', { slotId: slot.id });
          setConfirmRemove(false);
          if (ok) onClose();
        }}
      >
        <p>
          “{slot?.title}” leaves the calendar.{' '}
          {project ? 'The project made from it is not touched.' : 'You can undo this.'}
        </p>
      </ConfirmDialog>
    </>
  );
}
