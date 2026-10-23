import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { startService } from '@trailerforge/service';
import { openSafeSecretStore, type SafeStorageLike } from './safe-secrets.js';
import { isSafeExternalUrl, isServiceUrl } from './window-policy.js';

/** What the app window must offer; `main.ts` adapts Electron's BrowserWindow to this. */
export interface WindowLike {
  load(url: string): Promise<void>;
  /** Called before the window navigates; return false to block. */
  onWillNavigate(decide: (url: string) => boolean): void;
  /** Called when the page tries to open a new window; the window is never created. */
  onWindowOpen(handle: (url: string) => void): void;
  onClosed(cb: () => void): void;
}

export interface DesktopHost {
  /** Per-user app data folder (Electron `app.getPath('userData')`). */
  dataDir: string;
  /** Folder of the built UI. */
  uiDir: string;
  safeStorage: SafeStorageLike;
  createWindow(): WindowLike;
  openExternal(url: string): void;
  pickFolder(): Promise<string | undefined>;
  pickFile(): Promise<string | undefined>;
  handle(channel: string, fn: () => Promise<unknown>): void;
}

export interface Desktop {
  url: string;
  close(): Promise<void>;
}

/**
 * Starts the engine and its loopback service inside the app, then opens a window on it. The
 * window can only ever show the service; links to other sites open in the user's browser.
 */
export async function startDesktop(host: DesktopHost): Promise<Desktop> {
  const secrets = await openSafeSecretStore(join(host.dataDir, 'secrets.json'), host.safeStorage);
  const engine = await Engine.start({ home: host.dataDir, secrets });
  let svc;
  try {
    svc = await startService({ engine, staticDir: host.uiDir });
  } catch (err) {
    await engine.close();
    throw err;
  }
  const origin = new URL(svc.url).origin;

  host.handle('tforge:pick-folder', () => host.pickFolder());
  host.handle('tforge:pick-file', () => host.pickFile());

  const win = host.createWindow();
  win.onWillNavigate((url) => {
    if (isServiceUrl(url, origin)) return true;
    if (isSafeExternalUrl(url)) host.openExternal(url);
    return false;
  });
  win.onWindowOpen((url) => {
    if (isSafeExternalUrl(url) && !isServiceUrl(url, origin)) host.openExternal(url);
  });
  // The token travels in the hash, which the page scrubs and which is never sent anywhere.
  await win.load(`${svc.url}/#token=${svc.token}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await svc.close();
    await engine.close();
  };
  win.onClosed(() => void close());
  return { url: svc.url, close };
}
