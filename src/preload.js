const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miovuer', {
  pickRoot: () => ipcRenderer.invoke('pick-root'),
  selectRoot: () => ipcRenderer.invoke('select-root'),
  selectDestination: () => ipcRenderer.invoke('select-destination'),
  copyData: (source, destination, categories) =>
    ipcRenderer.invoke('copy-data', source, destination, categories),
  trimPair: (recordingId, start, end, cameras, mode) =>
    ipcRenderer.invoke('trim-pair', recordingId, start, end, cameras, mode),
  getPlayableFile: filePath => ipcRenderer.invoke('get-playable-file', filePath),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  onCopyProgress: callback => ipcRenderer.on('copy-progress', (_event, value) => callback(value)),
  onCopyFileComplete: callback => ipcRenderer.on('copy-file-complete', (_event, value) => callback(value)),
  onCopyFileError: callback => ipcRenderer.on('copy-file-error', (_event, value) => callback(value))
});
