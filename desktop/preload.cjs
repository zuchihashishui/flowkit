const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('studio', Object.freeze({
  api: (method, path, body) => ipcRenderer.invoke('api', method, path, body),
  settings: () => ipcRenderer.invoke('settings'),
  updateSettings: change => ipcRenderer.invoke('update-settings', change),
  chooseOutput: () => ipcRenderer.invoke('choose-output'),
  importVoice: (name, text, consent) => ipcRenderer.invoke('import-voice', name, text, consent),
  exportJob: id => ipcRenderer.invoke('export-job', id),
  preview: (id, index) => ipcRenderer.invoke('preview', id, index),
  openOutput: () => ipcRenderer.invoke('open-output'),
  openFlow: () => ipcRenderer.invoke('open-flow'),
  openExtension: () => ipcRenderer.invoke('open-extension'),
  importScriptSource: kind => ipcRenderer.invoke('import-script-source', kind),
  importScriptAudio: videoId => ipcRenderer.invoke('import-script-audio', videoId),
  importPrompts: () => ipcRenderer.invoke('import-prompts')
}));
