import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { startDesktop, type DesktopHost, type WindowLike } from './desktop.js';
import { WINDOW_PREFERENCES } from './window-policy.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): WindowLike {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: 'TrailerForge',
    webPreferences: { ...WINDOW_PREFERENCES, preload: join(here, '..', 'preload.cjs') },
  });
  // No camera, microphone, notifications, etc.; no embedded <webview>s.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  return {
    load: (url) => win.loadURL(url),
    onWillNavigate: (decide) => {
      const guard = (event: { preventDefault(): void }, url: string) => {
        if (!decide(url)) event.preventDefault();
      };
      win.webContents.on('will-navigate', guard);
      win.webContents.on('will-redirect', guard);
    },
    onWindowOpen: (handle) =>
      win.webContents.setWindowOpenHandler(({ url }) => {
        handle(url);
        return { action: 'deny' };
      }),
    onClosed: (cb) => win.on('closed', cb),
  };
}

const pick = async (properties: Array<'openDirectory' | 'openFile' | 'createDirectory'>) => {
  const r = await dialog.showOpenDialog({ properties });
  return r.canceled ? undefined : r.filePaths[0];
};

const host: DesktopHost = {
  dataDir: join(app.getPath('userData'), 'engine'),
  uiDir: app.isPackaged ? join(process.resourcesPath, 'ui') : join(here, '..', '..', 'ui', 'dist'),
  cliPath: app.isPackaged ? undefined : join(here, '..', '..', 'cli', 'dist', 'bin.js'),
  safeStorage,
  createWindow,
  openExternal: (url) => void shell.openExternal(url),
  pickFolder: () => pick(['openDirectory', 'createDirectory']),
  pickFile: () => pick(['openFile']),
  showItem: (path) => shell.showItemInFolder(path),
  handle: (channel, fn) =>
    ipcMain.handle(channel, (event, arg: unknown) => fn(event.senderFrame?.url ?? '', arg)),
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let running: Awaited<ReturnType<typeof startDesktop>> | undefined;
  void app.whenReady().then(async () => {
    try {
      running = await startDesktop(host);
    } catch (err) {
      dialog.showErrorBox('TrailerForge could not start', (err as Error).message);
      app.exit(1);
    }
  });
  app.on('window-all-closed', () => app.quit());
  // Hold the quit until the engine has saved and released its project locks.
  app.on('before-quit', (event) => {
    const r = running;
    if (!r) return;
    running = undefined;
    event.preventDefault();
    void r.close().finally(() => app.quit());
  });
}
