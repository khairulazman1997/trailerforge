import { useEffect, useRef, useState } from 'react';

/**
 * Text that is edited in place and committed on Enter or blur. While you are not editing, it
 * follows the live value, so changes made elsewhere (another window, Claude Code) show up.
 */
export function EditableText({
  value,
  onCommit,
  label,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      className={`editable ${className ?? ''}`}
      aria-label={label}
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
