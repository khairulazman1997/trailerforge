import { desktop } from '../desktop.js';

/**
 * Opens the system's folder chooser (Windows File Explorer) in the desktop app. A browser cannot
 * learn where a chosen folder is, so there it renders nothing and the path is typed or pasted.
 */
export function BrowseButton({
  label = 'Browse…',
  disabled,
  onPick,
}: {
  label?: string;
  disabled?: boolean;
  onPick: (path: string) => void;
}) {
  const pick = desktop()?.pickFolder;
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
