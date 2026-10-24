import { useEffect, useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { megabytes } from '../footage-view.js';
import { ConfirmDialog } from './Dialog.js';

/**
 * The optional local AI vision model: what it is, what downloading it does, and turning it on.
 * Nothing is downloaded until the dialog's button is pressed; hidden when this build pins no model.
 */
export function VisionPanel() {
  const store = useStore();
  const vision = useAppState((s) => s.vision);
  const download = useAppState((s) => s.visionDownload);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void store.loadVision();
  }, [store]);
  if (!vision || vision.status === 'unavailable' || !vision.disclosure) return null;
  const d = vision.disclosure;
  const percent = Math.round((download?.fraction ?? 0) * 100);

  return (
    <section aria-labelledby="vision-h" data-testid="vision-panel">
      <h2 id="vision-h">AI vision (optional)</h2>
      <p className="muted">
        A small model that runs on this computer and compares frames of your recordings with each
        shot&rsquo;s description, to improve the suggestions. Footage and frames never leave this
        computer.
      </p>
      {vision.status === 'ready' ? (
        <p>
          <span className="chip ok">On</span> Analyse recordings to use it; suggestions then show an
          &ldquo;AI vision&rdquo; reason.
        </p>
      ) : download ? (
        <div className="row">
          <progress
            aria-label="Downloading the vision model"
            max={100}
            value={percent}
            data-testid="vision-progress"
          />
          <span role="status">{percent}%</span>
          <button type="button" onClick={() => void store.cancelVisionDownload()}>
            Cancel download
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAsking(true)}>
          Turn on AI vision…
        </button>
      )}
      <ConfirmDialog
        open={asking}
        title="Turn on AI vision?"
        confirmLabel={`Download ${megabytes(d.totalBytes)}`}
        cancelLabel="Not now"
        onCancel={() => setAsking(false)}
        onConfirm={async () => {
          await store.startVisionDownload();
          setAsking(false);
        }}
      >
        <p>
          This downloads <strong>{megabytes(d.totalBytes)}</strong> once, from {d.hosts.join(', ')}.
        </p>
        <ul>
          <li>
            Model: {d.title} ({d.license} licence). Source: {d.source}.
          </li>
          <li>{d.sends}</li>
          <li>{d.afterwards}</li>
          <li>It adds work when you analyse recordings; you can leave it off.</li>
        </ul>
      </ConfirmDialog>
    </section>
  );
}
