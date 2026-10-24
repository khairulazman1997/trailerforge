import { useState } from 'react';
import { useStore } from '../app-context.js';
import { giveConsent } from '../consent.js';
import { ConfirmDialog } from './Dialog.js';
import { Disclosure } from './Disclosure.js';
import { needsConsent, usePreview } from './GenerateDialogs.js';

/**
 * Asks before tips are written: which provider, what it will be sent, and, for a service off this
 * computer, an explicit yes. `groupKey` limits it to one group (a regenerate).
 */
export function CaptureTipsDialog({
  id,
  open,
  groupKey,
  groupName,
  hasEdited,
  hasFresh,
  onClose,
}: {
  id: string;
  open: boolean;
  groupKey?: string | undefined;
  groupName?: string | undefined;
  /** Some group in scope has tips the user wrote or edited. */
  hasEdited: boolean;
  hasFresh: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'capture.tips', open);
  const [force, setForce] = useState(false);
  const [overwriteEdited, setOverwriteEdited] = useState(false);
  const single = groupKey !== undefined;
  const consentNeeded = needsConsent(preview);
  const empty = !!preview && preview.willSend.capture?.groups === 0;

  return (
    <ConfirmDialog
      open={open}
      title={
        single ? `Write tips for “${groupName ?? ''}”` : 'Write tips for the recording session'
      }
      confirmLabel={single ? 'Write tips' : 'Write tips'}
      confirmDisabled={!preview?.available || empty}
      {...(consentNeeded && preview?.provider
        ? { acknowledge: `I understand this information is sent to ${preview.provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available || empty) return;
        if (preview.provider?.sendsDataOffDevice) giveConsent(preview.provider.id);
        await store.startTask(id, {
          kind: 'capture-tips',
          options: {
            ...(single ? { groupKeys: [groupKey], force: true } : force ? { force: true } : {}),
            ...(overwriteEdited ? { overwriteEdited: true } : {}),
          },
        });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          {single
            ? 'Tips and risks are written again for this group only.'
            : 'A few practical tips and things that can ruin a take are written for each group that has shots left to record.'}{' '}
          Your own edits are kept unless you say otherwise, and you can undo this.
        </p>
        {!single && hasFresh && (
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>Also redo tips that are already up to date</span>
          </label>
        )}
        {hasEdited && (
          <label className="check">
            <input
              type="checkbox"
              checked={overwriteEdited}
              onChange={(e) => setOverwriteEdited(e.target.checked)}
            />
            <span>Replace tips I edited by hand</span>
          </label>
        )}
        {empty && (
          <p className="muted">Every shot is recorded, so there is nothing to write tips for.</p>
        )}
        <Disclosure preview={preview} />
      </div>
    </ConfirmDialog>
  );
}
