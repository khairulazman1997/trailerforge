import type { ProjectTab } from './router.js';

/** Where a shortcut applies: everywhere in the app, or only on one project tab. */
export type ShortcutScope = 'global' | ProjectTab;

export interface Shortcut {
  /** Key combinations that do the same thing, in the order they are shown. */
  keys: string[];
  what: string;
  scope: ShortcutScope;
}

/**
 * Every keyboard shortcut the app handles. The Shortcuts dialog shows exactly this list for the
 * page that is open, so a handler added elsewhere must be listed here (the end-to-end tests press
 * each one).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Ctrl+Z', '⌘Z'], what: 'Undo the last change to the open project', scope: 'global' },
  {
    keys: ['Ctrl+Shift+Z', 'Ctrl+Y', '⌘⇧Z'],
    what: 'Redo the change that was undone',
    scope: 'global',
  },
  { keys: ['?'], what: 'Show this list', scope: 'global' },
  { keys: ['Esc'], what: 'Close a dialog, or drop an edit you have not finished', scope: 'global' },
  { keys: ['Enter'], what: 'Keep the text you typed in a one-line field', scope: 'global' },
  { keys: ['←', '→'], what: 'Move the selected clip one frame', scope: 'cut' },
  {
    keys: ['Shift+←', 'Shift+→'],
    what: 'Move the selected clip to the previous or next beat',
    scope: 'cut',
  },
  {
    keys: ['Alt+←', 'Alt+→'],
    what: 'Move the selected clip, and the clips after it along',
    scope: 'cut',
  },
  { keys: ['Alt + drag'], what: 'Place or trim a clip freely, without snapping', scope: 'cut' },
  {
    keys: ['Shift + drag'],
    what: 'Move or trim a clip, and the clips after it along',
    scope: 'cut',
  },
];

/** The shortcuts for a page: the global ones first, then the tab's own. */
export function shortcutsFor(tab: ProjectTab | null): Shortcut[] {
  return [
    ...SHORTCUTS.filter((s) => s.scope === 'global'),
    ...SHORTCUTS.filter((s) => tab !== null && s.scope === tab),
  ];
}

/** True when a key press is going into a text field, where typing keys must not be taken. */
export function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable === true)
  );
}
