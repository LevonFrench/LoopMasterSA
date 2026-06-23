const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBackend: (engine, model) => ipcRenderer.send('start-backend', engine, model)
});
