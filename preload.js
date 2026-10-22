const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scan: () => ipcRenderer.invoke('scan'),
  whoami: () => ipcRenderer.invoke('whoami'),
  cached: () => ipcRenderer.invoke('cached'),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  importChat: () => ipcRenderer.invoke('importChat'),
  removeChat: () => ipcRenderer.invoke('removeChat'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onMenu: (cb) => { ipcRenderer.on('rescan', () => cb('rescan')); ipcRenderer.on('import', () => cb('import')); },
  saveCsv: (text, name) => ipcRenderer.invoke('saveCsv', text, name),
  login: { get: () => ipcRenderer.invoke('login:get'), set: (on) => ipcRenderer.invoke('login:set', on) },
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => ipcRenderer.on('update', (_e, s) => cb(s))
  }
});
