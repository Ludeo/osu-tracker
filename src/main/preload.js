const { contextBridge, ipcRenderer } = require('electron');

// Electron prefixes errors thrown in ipcMain handlers with this; strip it for display.
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(String(err.message || err).replace(IPC_ERROR_PREFIX, ''));
  }
}

contextBridge.exposeInMainWorld('tracker', {
  getConfig: () => invoke('config:get'),
  saveConfig: (patch) => invoke('config:save', patch),
  addFriend: (username) => invoke('friends:add', username),
  removeFriend: (userId) => invoke('friends:remove', userId),
  fetchScores: (query) => invoke('scores:fetch', query),
  calculatePp: (mods, od) => invoke('pp:calculate', mods, od),
  calculateSkillsets: (query) => invoke('skillsets:calculate', query),
  openBeatmap: (beatmapId) => invoke('osu:open-beatmap', beatmapId),
  downloadBeatmap: (setId, songsFolder) => invoke('osu:download-beatmap', setId, songsFolder),
  onBeatmapImported: (callback) => ipcRenderer.on('library:imported', (_event, setId) => callback(setId)),
  copyText: (text) => invoke('clipboard:write', text),
  getCaptureSources: () => invoke('capture:sources'),
  selectCaptureSource: (id) => invoke('capture:select', id),
  watchKeys: (folders) => invoke('keys:watch', folders),
  unwatchKeys: () => invoke('keys:unwatch'),
  getOverlayState: () => invoke('overlay:state'),
  lockOverlay: (locked) => invoke('overlay:lock', locked),
  setOverlayPb: (pb) => invoke('overlay:pb', pb),
  onOverlayState: (callback) => ipcRenderer.on('overlay:state', (_event, state) => callback(state)),
  onKey: (callback) => ipcRenderer.on('keys:input', (_event, column, pressed) => callback(column, pressed)),
  getRecommendations: (query) => invoke('recommendations:get', query),
  onRecommendationsProgress: (callback) => ipcRenderer.on('recommendations:progress', (_event, progress) => callback(progress)),
  getHistory: (query) => invoke('history:get', query),
  updateProfile: (query) => invoke('history:update-profile', query),
  playStarted: (query) => invoke('history:play-started', query),
  recordPlay: (play) => invoke('history:record', play),
  onHistoryUpdated: (callback) => ipcRenderer.on('history:updated', () => callback()),
  onReplaySaved: (callback) => ipcRenderer.on('replay:saved', (_event, name) => callback(name)),
  getRateLimit: () => invoke('api:rate-limit'),
  onRateLimit: (callback) => ipcRenderer.on('api:rate-limit', (_event, rateLimit) => callback(rateLimit)),
});
