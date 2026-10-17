const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getConfig: () => ipcRenderer.invoke('overlay:config'),
  watchKeys: (query) => ipcRenderer.invoke('overlay:keys', query),
  onKey: (callback) => ipcRenderer.on('overlay:key', (_event, column, pressed) => callback(column, pressed)),
  onLocked: (callback) => ipcRenderer.on('overlay:locked', (_event, locked) => callback(locked)),
  onPb: (callback) => ipcRenderer.on('overlay:pb', (_event, pb) => callback(pb)),
  onScale: (callback) => ipcRenderer.on('overlay:scale', (_event, scale) => callback(scale)),
  setSize: (width, height) => ipcRenderer.send('overlay:size', width, height),
  gestureStart: (resize) => ipcRenderer.send('overlay:gesture-start', resize),
  gesture: () => ipcRenderer.send('overlay:gesture'),
  gestureEnd: () => ipcRenderer.send('overlay:gesture-end'),
  lock: () => ipcRenderer.send('overlay:lock'),
});
