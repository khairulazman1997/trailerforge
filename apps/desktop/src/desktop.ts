import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { DEFAULT_APP_PORT, startService } from '@trailerforge/service';
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
  /** Port to try first (tests pass 0 for any free port). Default `DEFAULT_APP_PORT`. */
  port?: number;
  /** The command-line tool (`apps/cli/dist/bin.js`) when it ships with this build, for Claude Code. */
  cliPath?: string | undefined;
  safeStorage: SafeStorageLike;
  createWindow(): WindowLike;
  openExternal(url: string): void;
  pickFolder(): Promise<string | undefined>;
  pickFile(): Promise<string | undefined>;
  /** Register an IPC handler; `senderUrl` is the URL of the frame that called. */
  handle(channel: string, fn: (senderUrl: string) => Promise<unknown>): void;
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
  // Encrypted keys get their own file so the CLI (which reads secrets.json as plain) never
  // mistakes ciphertext for a key.
  const secrets = await openSafeSecretStore(
    join(host.dataDir, 'secrets.safe.json'),
    host.safeStorage,
    join(host.dataDir, 'secrets.json'),
  );
  const engine = await Engine.start({ home: host.dataDir, secrets });
  let svc;
  try {
    svc = await startService({
      engine,
      staticDir: host.uiDir,
      preferredPort: host.port ?? DEFAULT_APP_PORT,
      ...(host.cliPath ? { cliPath: host.cliPath } : {}),
    });
  } catch (err) {
    await engine.close();
    throw err;
  }
  const origin = new URL(svc.url).origin;

  const fromService = (pick: () => Promise<string | undefined>) => async (senderUrl: string) => {
    if (!isServiceUrl(senderUrl, origin)) throw new Error('refused: not the TrailerForge window');
    return pick();
  };
  host.handle(
    'tforge:pick-folder',
    fromService(() => host.pickFolder()),
  );
  host.handle(
    'tforge:pick-file',
    fromService(() => host.pickFile()),
  );

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
