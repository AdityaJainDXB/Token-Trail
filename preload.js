const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scan: () => ipcRenderer.invoke('scan'),
  cached: () => ipcRenderer.invoke('cached'),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p))
});
