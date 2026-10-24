/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- sandboxed preload scripts must be CommonJS */
// Runs sandboxed in the window; exposes two native pickers and the location of a dropped file. The service address and token
// reach the page through the URL hash, not through here.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('trailerforgeDesktop', {
  pickFolder: () => ipcRenderer.invoke('tforge:pick-folder'),
  pickFile: () => ipcRenderer.invoke('tforge:pick-file'),
  // Where a dropped file is on disk (browsers hide this); only a path string leaves the preload.
  pathForFile: (file) => webUtils.getPathForFile(file),
});
