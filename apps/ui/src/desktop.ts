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

/** The platform the page runs on, from what the browser says. */
export function platformOf(ua = navigator.userAgent): 'windows' | 'mac' | 'other' {
  if (/windows/i.test(ua)) return 'windows';
  if (/mac os|macintosh/i.test(ua)) return 'mac';
  return 'other';
}

/** An example path in the style of this computer, for a field's placeholder. */
export function examplePath(name: string, platform = platformOf()): string {
  switch (platform) {
    case 'windows':
      return `C:\\Users\\you\\Games\\${name}`;
    case 'mac':
      return `/Users/you/Games/${name}`;
    default:
      return `/home/you/games/${name}`;
  }
}
