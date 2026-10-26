// Gives the Draft Dodger page a small, safe bridge to the desktop app. Nothing else from Node is exposed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('draftDodgerApp', {
  getState:         () => ipcRenderer.invoke('gsi:state'),
  getSetup:         () => ipcRenderer.invoke('gsi:setup'),
  rerunSetup:       () => ipcRenderer.invoke('gsi:setup', { rerun: true }),
  chooseDotaFolder: () => ipcRenderer.invoke('gsi:choose'),
  setAlwaysOnTop:   on => ipcRenderer.invoke('win:top', on),
  isAlwaysOnTop:    () => ipcRenderer.invoke('win:isTop'),
  onAlwaysOnTop:    cb => ipcRenderer.on('win:top', (e, on) => cb(on)),
  getInfo:          () => ipcRenderer.invoke('app:info'),
  openLogFolder:    () => ipcRenderer.invoke('app:logs'),
  checkForUpdates:  () => ipcRenderer.invoke('app:update')
});
