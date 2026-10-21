'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshInstaller', {
  submit: (spec) => ipcRenderer.invoke('dsh-install:submit', spec),
  cancel: () => ipcRenderer.send('dsh-install:cancel'),
});
