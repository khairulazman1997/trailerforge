import type { ProjectTab } from '../router.js';
import { shortcutsFor } from '../shortcuts.js';
import { Dialog } from './Dialog.js';

/** The keyboard shortcuts for the page that is open (see `shortcuts.ts`). */
export function ShortcutsDialog({
  open,
  tab,
  onClose,
}: {
  open: boolean;
  tab: ProjectTab | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <table>
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">What it does</th>
          </tr>
        </thead>
        <tbody>
          {shortcutsFor(tab).map((s) => (
            <tr key={`${s.scope}:${s.keys[0]}`}>
              <td>
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && ' or '}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td>{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
