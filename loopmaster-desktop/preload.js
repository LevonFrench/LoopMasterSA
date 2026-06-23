const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBackend: (modelId) => ipcRenderer.send('start-backend', modelId)
});
