// Preload – expose safe IPC to the renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipDesktop', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  onResetPosition: (cb) => ipcRenderer.on('reset-position', cb),
  onSummon: (cb) => ipcRenderer.on('summon', (_event, pt) => cb(pt)),
});

