const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  onMenuAction: (callback) => {
    const subscription = (_event, action, payload) => callback(action, payload);
    ipcRenderer.on('menu-action', subscription);
    return () => ipcRenderer.removeListener('menu-action', subscription);
  },
  sendAction: (channel, data) => {
    ipcRenderer.send(channel, data);
  },
  invokeAction: (channel, data) => {
    return ipcRenderer.invoke(channel, data);
  },
  // Dedicated Project Storage APIs
  getAutoSaveInfo: () => ipcRenderer.invoke('project:get-autosave-info'),
  saveAutoSaveState: (payload) => ipcRenderer.invoke('project:save-autosave-state', payload),
  loadAutoSaveState: () => ipcRenderer.invoke('project:load-autosave-state'),
  saveAudioFile: (filename, base64Data) => ipcRenderer.invoke('project:save-audio-file', { filename, base64Data }),
  loadAudioFile: (filename) => ipcRenderer.invoke('project:load-audio-file', { filename }),
  clearAutoSave: () => ipcRenderer.invoke('project:clear-autosave'),
  openProjectsFolder: () => ipcRenderer.invoke('project:open-projects-folder'),
  getProjectsPath: () => ipcRenderer.invoke('project:get-projects-path'),
  // Dedicated AI Engine Setup APIs
  getEngineStatus: () => ipcRenderer.invoke('engine:get-status'),
  startEngineInstall: () => ipcRenderer.invoke('engine:start-install'),
  repairEngine: () => ipcRenderer.invoke('engine:repair'),
  onEngineStatus: (callback) => {
    const subscription = (_event, state) => callback(state);
    ipcRenderer.on('engine:status-update', subscription);
    return () => ipcRenderer.removeListener('engine:status-update', subscription);
  },
  // Persistent Log File APIs
  openLogFile: () => ipcRenderer.invoke('logs:open-file'),
  getLogPath: () => ipcRenderer.invoke('logs:get-path'),
});
