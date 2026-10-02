const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('studio', Object.freeze({
  backendAction: action => ipcRenderer.invoke('backend-action', action),
  elevenlabsAction: action => ipcRenderer.invoke('elevenlabs-action', action),
  elevenlabsAudio: (id, index, action) => ipcRenderer.invoke('elevenlabs-audio', id, index, action),
  elevenlabsExport: id => ipcRenderer.invoke('elevenlabs-export', id),
  saveChatResults: ids => ipcRenderer.invoke('save-chat-results',ids),
  chatgptAction: action => ipcRenderer.invoke('chatgpt-action', action),
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
