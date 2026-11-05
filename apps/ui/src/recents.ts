/**
 * Older versions of the app kept the projects you opened in this browser. They now live in the
 * engine's list of known projects; this reads what an older version left, once, so it can be
 * handed over.
 */
const KEY = 'tforge.recent';

/** The folders an older version remembered, most recent first. Empty once handed over. */
export function legacyRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch {
    return [];
  }
}

/** Forget the old list after the engine has taken it over. */
export function clearLegacyRecents(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage blocked: nothing was kept anyway
  }
}
