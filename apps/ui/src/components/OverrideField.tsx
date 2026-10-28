import { useState } from 'react';
import { checkName } from '../review-view.js';

/** One reason field for an overridable Quality Gate check; commits when you leave the field. */
export function OverrideField({
  check,
  value,
  onCommit,
}: {
  check: string;
  value: string;
  onCommit: (reason: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <label className="field">
      <span>{checkName(check)}: why is this fine?</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== value && onCommit(text.trim())}
        placeholder="e.g. the platform normalises loudness anyway"
        data-testid={`override-${check.replace('core/', '')}`}
      />
    </label>
  );
}
