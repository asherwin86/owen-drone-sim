const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('droneApp', {
  quit: () => ipcRenderer.send('quit'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  isDesktop: true,
});
