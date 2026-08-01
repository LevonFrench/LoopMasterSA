const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBackend: (model) => ipcRenderer.send('start-backend', model),
    stopBackend: () => ipcRenderer.send('stop-backend'),
    onBackendError: (handler) => ipcRenderer.on('backend-error', (_event, message) => handler(message))
});
