import { useState } from 'react';
import { useStore } from '../app-context.js';
import { campaignColor } from '../planner-view.js';
import type { PlannerSnapshot } from '../store.js';
import { ConfirmDialog } from './Dialog.js';
import { EditableText } from './EditableText.js';

/** Campaigns: groups of planned videos. Add, rename, colour, set dates and remove them. */
export function CampaignsPanel({ planner }: { planner: PlannerSnapshot }) {
  const store = useStore();
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const target = planner.campaigns.find((c) => c.id === removing);
  const inCampaign = planner.slots.filter((s) => s.campaignId === removing).length;

  const set = (campaignId: string, fields: Record<string, unknown>) =>
    store.plannerCommand('planner/campaign.set', { campaignId, ...fields });

  return (
    <section aria-labelledby="campaigns-h" className="campaigns">
      <h2 id="campaigns-h">Campaigns</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          void store.plannerCommand('planner/campaign.add', { name: n }).then((ok) => {
            if (ok) setName('');
          });
        }}
      >
        <label>
          New campaign
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch" />
        </label>
        <button type="submit" disabled={!name.trim()}>
          Add campaign
        </button>
      </form>
      {planner.campaigns.length === 0 ? (
        <p className="muted">
          A campaign groups the videos of one push, such as a launch or a sale. It is optional.
        </p>
      ) : (
        <ul className="campaign-list" aria-label="Campaigns">
          {planner.campaigns.map((c, i) => (
            <li key={c.id} data-campaign={c.id}>
              <span
                className="swatch"
                style={{ background: campaignColor(c, i) }}
                aria-hidden="true"
              />
              <EditableText
                label={`Name of campaign ${c.name}`}
                value={c.name}
                onCommit={(next) => void set(c.id, { name: next })}
              />
              <label>
                Colour
                <input
                  type="color"
                  value={campaignColor(c, i)}
                  onChange={(e) => void set(c.id, { color: e.target.value })}
                />
              </label>
              <label>
                From
                <input
                  type="date"
                  value={c.startDate ?? ''}
                  onChange={(e) => void set(c.id, { startDate: e.target.value || null })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={c.endDate ?? ''}
                  onChange={(e) => void set(c.id, { endDate: e.target.value || null })}
                />
              </label>
              {c.sharedFootage.length > 0 && (
                <small className="muted">
                  Shared footage: {c.sharedFootage.map((f) => f.name).join(', ')}
                </small>
              )}
              <button
                type="button"
                className="danger"
                aria-label={`Remove campaign ${c.name}`}
                onClick={() => setRemoving(c.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== undefined}
        title="Remove the campaign?"
        tone="danger"
        confirmLabel="Remove campaign"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await store.plannerCommand('planner/campaign.remove', {
            campaignId: removing,
            slots: 'keep',
          });
          setRemoving(null);
        }}
      >
        <p>
          “{target?.name}” goes away.{' '}
          {inCampaign > 0
            ? `Its ${inCampaign} planned video${inCampaign === 1 ? '' : 's'} stay on the calendar without a campaign.`
            : 'No planned videos are in it.'}{' '}
          You can undo this.
        </p>
      </ConfirmDialog>
    </section>
  );
}
