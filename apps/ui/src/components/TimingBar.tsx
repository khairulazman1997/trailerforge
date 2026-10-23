import { useState } from 'react';
import type { Section } from '@trailerforge/schema';
import type { Timing } from '../storyboard-view.js';

/**
 * The storyboard's length against its target: one segment per section, widths in proportion.
 * Edits never change the target on their own; this shows the gap and lets you decide.
 */
export function TimingBar({
  timing,
  sections,
  disabled,
  onTarget,
}: {
  timing: Timing;
  sections: readonly Section[];
  disabled: boolean;
  onTarget: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const scale = Math.max(timing.actual, timing.target, 1);
  const state = timing.delta === 0 ? 'on target' : timing.delta > 0 ? 'over' : 'under';
  const commit = () => {
    const n = Number(draft);
    setDraft(null);
    if (draft !== null && Number.isFinite(n) && n > 0 && n !== timing.target) onTarget(n);
  };
  return (
    <section className="timing" aria-label="Length">
      <div className="timing-text">
        <strong data-testid="timing-actual">{timing.actual} s</strong> of{' '}
        <label className="inline target">
          <span className="sr-only">Target length in seconds</span>
          <input
            type="number"
            min={1}
            step={1}
            value={draft ?? timing.target}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />{' '}
          s target
        </label>
        <span className={`chip ${timing.delta === 0 ? 'ok' : 'warn'}`} data-testid="timing-state">
          {timing.delta === 0 ? 'On target' : `${Math.abs(timing.delta)} s ${state}`}
        </span>
      </div>
      <div
        className="timing-bar"
        role="img"
        aria-label={`Sections: ${timing.sections.map((s) => `${s.seconds} seconds`).join(', ')}`}
      >
        {timing.sections.map((t, i) => (
          <div
            key={t.id}
            className={`timing-seg seg-${i % 5}`}
            style={{ width: `${(t.seconds / scale) * 100}%` }}
            title={`${sections[i]?.name}: ${t.seconds} s`}
          />
        ))}
        {timing.target < scale && (
          <div className="timing-target" style={{ left: `${(timing.target / scale) * 100}%` }} />
        )}
      </div>
    </section>
  );
}
