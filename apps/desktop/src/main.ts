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
  return {
    load: (url) => win.loadURL(url),
    onWillNavigate: (decide) =>
      win.webContents.on('will-navigate', (event, url) => {
        if (!decide(url)) event.preventDefault();
      }),
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
  safeStorage,
  createWindow,
  openExternal: (url) => void shell.openExternal(url),
  pickFolder: () => pick(['openDirectory', 'createDirectory']),
  pickFile: () => pick(['openFile']),
  handle: (channel, fn) => ipcMain.handle(channel, () => fn()),
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let running: Awaited<ReturnType<typeof startDesktop>> | undefined;
  void app.whenReady().then(async () => {
    running = await startDesktop(host);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => void running?.close());
}
