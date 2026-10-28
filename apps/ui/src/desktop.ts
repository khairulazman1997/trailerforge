/** What the desktop app's preload offers the page; absent in a browser. */
export interface Desktop {
  pickFolder?: () => Promise<string | null>;
  pickFile?: () => Promise<string | null>;
  pathForFile?: (file: File) => string;
  /** Show a file or folder in the file manager; false when it is not there. */
  showItem?: (path: string) => Promise<boolean>;
}

export const desktop = (): Desktop | undefined =>
  (window as unknown as { trailerforgeDesktop?: Desktop }).trailerforgeDesktop;

/** `parent` + `name` with the separator the parent already uses (Windows or not). */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`;
}
