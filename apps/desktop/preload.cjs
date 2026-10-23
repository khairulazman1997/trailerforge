/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- sandboxed preload scripts must be CommonJS */
// Runs sandboxed in the window; exposes only two native pickers. The service address and token
// reach the page through the URL hash, not through here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trailerforgeDesktop', {
  pickFolder: () => ipcRenderer.invoke('tforge:pick-folder'),
  pickFile: () => ipcRenderer.invoke('tforge:pick-file'),
});
