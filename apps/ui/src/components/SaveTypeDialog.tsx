import { useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { Dialog } from './Dialog.js';

/** Save the storyboard's structure as a video type the user can pick in other projects. */
export function SaveTypeDialog({
  id,
  open,
  onClose,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const own = useAppState((s) => {
    const ext = s.projects[id]?.project.brief.extensions['game-trailer'] as
      { customType?: unknown } | undefined;
    return typeof ext?.customType === 'string' ? ext.customType : '';
  });
  // Reset by key from the caller each time it opens, so the fields start fresh.
  const [name, setName] = useState('');
  const [description, setDescription] = useState(own);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const ok = await store.saveVideoType(id, {
      name,
      ...(description.trim() ? { description } : {}),
    });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={open}
      title="Save as a video type"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!name.trim() || saving}
            onClick={() => void save()}
          >
            Save video type
          </button>
        </>
      }
    >
      <p>
        Keeps this storyboard&rsquo;s structure (its sections, their order and roles, and how long
        each part runs) so you can pick it as the video type of other projects.
      </p>
      <p className="muted">
        Shot descriptions, footage and names from your game are not saved. A section whose name
        mentions the game gets a plain name instead. The file stays on this computer.
      </p>
      <label>
        Name
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="Kickstarter teaser"
        />
      </label>
      <label>
        Description
        <textarea
          value={description}
          maxLength={2000}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Leave empty to use the description of this project's video type"
        />
      </label>
    </Dialog>
  );
}
