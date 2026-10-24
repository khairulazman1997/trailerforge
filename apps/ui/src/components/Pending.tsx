import type { ReactNode } from 'react';
import { usePending } from '../use-pending.js';

/** A select that keeps your choice on screen while the change is being applied. */
export function PendingSelect<T extends string>({
  value,
  label,
  disabled,
  options,
  onChange,
}: {
  value: T;
  label: string;
  disabled: boolean;
  options: { value: T; label: ReactNode }[];
  onChange: (next: T) => Promise<unknown>;
}) {
  const [shown, run] = usePending(value);
  return (
    <select
      aria-label={label}
      disabled={disabled}
      value={shown}
      onChange={(e) => {
        const next = e.target.value as T;
        void run(next, () => onChange(next));
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PendingCheckbox({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled: boolean;
  onChange: (next: boolean) => Promise<unknown>;
}) {
  const [shown, run] = usePending(checked);
  return (
    <label className="inline">
      <input
        type="checkbox"
        checked={shown}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.checked;
          void run(next, () => onChange(next));
        }}
      />
      {label}
    </label>
  );
}
