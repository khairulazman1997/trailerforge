import type { DecisionRecord } from '@trailerforge/schema';
import { describeDecision } from '../storyboard-view.js';

const REASON_LABEL: Record<string, string> = {
  provider: 'Provider',
  model: 'Model',
  targetDuration: 'Target length (s)',
  budget: 'Time to fill (s)',
  requestedSeconds: 'Length the AI asked for (s)',
  instruction: 'Your instruction',
};

/** The automated decisions behind the storyboard, newest first, in plain language. */
export function WhyPanel({
  decisions,
  sectionName,
  onShowAll,
  onClose,
}: {
  decisions: readonly DecisionRecord[];
  /** When set, only this section's history is shown. */
  sectionName: string | null;
  onShowAll: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="why" aria-label="Why this storyboard">
      <div className="row">
        <h2>{sectionName ? `Why “${sectionName}”` : 'Why this storyboard'}</h2>
        <span className="spacer" />
        {sectionName && (
          <button type="button" onClick={onShowAll}>
            Show everything
          </button>
        )}
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {decisions.length === 0 ? (
        <p className="muted">
          Nothing has been generated for {sectionName ? 'this section' : 'this project'} yet, so
          there is nothing to explain. Sections you write yourself have no automated decisions.
        </p>
      ) : (
        <ol className="decisions">
          {decisions.map((d) => (
            <li key={d.id}>
              <strong>{describeDecision(d)}</strong>
              <small> · {new Date(d.at).toLocaleString()}</small>
              <p>{d.summary}</p>
              <details>
                <summary>Details</summary>
                <dl className="facts small">
                  {Object.entries(d.reasons)
                    .filter(([k, v]) => k in REASON_LABEL && v !== null && v !== '')
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{REASON_LABEL[k]}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                  {Array.isArray(d.reasons.pinnedSlotIds) && d.reasons.pinnedSlotIds.length > 0 && (
                    <div>
                      <dt>Kept because you edited them</dt>
                      <dd>{(d.reasons.pinnedSlotIds as string[]).length} slot(s)</dd>
                    </div>
                  )}
                  {Array.isArray(d.reasons.lockedSectionIds) &&
                    d.reasons.lockedSectionIds.length > 0 && (
                      <div>
                        <dt>Left alone because locked</dt>
                        <dd>{(d.reasons.lockedSectionIds as string[]).length} section(s)</dd>
                      </div>
                    )}
                </dl>
              </details>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
