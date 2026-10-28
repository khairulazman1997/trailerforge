import { desktop } from '../desktop.js';

/**
 * Opens the system's folder (or, with `file`, file) chooser in the desktop app. A browser cannot
 * learn where a chosen file is, so there it renders nothing and the path is typed or pasted.
 */
export function BrowseButton({
  label = 'Browse…',
  disabled,
  file,
  onPick,
}: {
  label?: string;
  disabled?: boolean;
  /** Choose a file instead of a folder. */
  file?: boolean;
  onPick: (path: string) => void;
}) {
  const pick = file ? desktop()?.pickFile : desktop()?.pickFolder;
  if (!pick) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() =>
        void pick().then((p) => {
          if (p) onPick(p);
        })
      }
    >
      {label}
    </button>
  );
}
