import { useState } from 'react';
import { BrowseButton } from './BrowseButton.js';

/** A path to a file on this computer (the desktop app can browse); the engine copies it in. */
export function FileImport({
  label,
  hint,
  disabled,
  onImport,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onImport: (path: string) => Promise<boolean>;
}) {
  const [path, setPath] = useState('');
  const go = async (p: string) => {
    if (await onImport(p.trim())) setPath('');
  };
  return (
    <div className="brand-import">
      <label>
        {label}
        <input
          value={path}
          disabled={disabled}
          placeholder="Paste the file’s path"
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <BrowseButton file label="Browse…" disabled={disabled} onPick={(p) => void go(p)} />
      <button type="button" disabled={disabled || !path.trim()} onClick={() => void go(path)}>
        Use this file
      </button>
      <small className="muted">{hint}</small>
    </div>
  );
}
