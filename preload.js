const { contextBridge, ipcRenderer, webFrame } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
  // only Muriel's own pages get the token (main.js also stops the window from navigating anywhere else)
  serverToken: (() => {
    if (location.protocol !== 'file:') return '';
    const arg = process.argv.find((a) => a.startsWith('--muriel-token='));
    return arg ? arg.slice('--muriel-token='.length) : '';
  })(),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  getGpuCompositing: () => ipcRenderer.invoke('get-gpu-compositing'),
  pickMedia: () => ipcRenderer.invoke('pick-media'),
  importAudioFiles: (opts) => ipcRenderer.invoke('import-audio-files', opts && opts.folder ? { folder: true } : undefined),
  onWindowVisibility: (callback) => {
    ipcRenderer.on('window-visibility', (event, visible) => callback(visible));
  },
  setZoomFactor: (factor) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch (e) {}
  },
  getZoomFactor: () => {
    try {
      return webFrame.getZoomFactor();
    } catch (e) {
      return 1.0;
    }
  },

  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  pickDataDir: () => ipcRenderer.invoke('pick-data-dir'),
  setDataDir: (dir, move) => ipcRenderer.invoke('set-data-dir', { dir, move }),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),
  setDownloadDir: (dir) => ipcRenderer.invoke('set-download-dir', { dir }),
  resetDownloadDir: () => ipcRenderer.invoke('set-download-dir', { reset: true }),
  restartApp: () => ipcRenderer.send('restart-app'),
  setTrayOnClose: (enabled) => ipcRenderer.send('set-tray-on-close', enabled),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getHwAccel: () => ipcRenderer.invoke('get-hw-accel'),
  setHwAccel: (v) => ipcRenderer.send('set-hw-accel', v),
  trimMemory: () => { try { webFrame.clearCache(); } catch (e) {} },
  onMediaCommand: (cb) => ipcRenderer.on('media-command', (e, cmd) => cb(cmd)),
  toggleMiniWindow: () => ipcRenderer.invoke('toggle-mini-window'),
  setMiniLyrics: (enabled) => ipcRenderer.invoke('set-mini-lyrics', enabled),
  isWindows: process.platform === 'win32',
  setMediaKeys: (v) => ipcRenderer.send('set-media-keys', v),
  mediaKeysActive: () => ipcRenderer.send('media-keys-active'),
  welcomeFinish: (detail) => ipcRenderer.send('welcome-finish', detail),
  onWelcomeResult: (cb) => ipcRenderer.on('welcome-result', (e, d) => cb(d)),
  getLauncherInfo: () => ipcRenderer.invoke('launcher-info'),
  listPlugins: () => ipcRenderer.invoke('plugins-list'),
  setPluginEnabled: (file, on) => ipcRenderer.send('plugins-set-enabled', file, on),
  disableAllPlugins: () => ipcRenderer.send('plugins-disable-all'),
  openPluginsFolder: () => ipcRenderer.send('plugins-open-folder'),
  removePlugin: (file) => ipcRenderer.send('plugins-remove', file),
  importPlugins: () => ipcRenderer.invoke('plugins-import'),
  discordPresenceUpdate: (trackInfo) => ipcRenderer.send('discord-presence-update', trackInfo),
  discordPresenceClear: () => ipcRenderer.send('discord-presence-clear'),
  openExternal: (u) => ipcRenderer.send('open-external', u),
  logError: (level, message, stack) => ipcRenderer.send('log-error', { level, message, stack }),
  openLogsFolder: () => ipcRenderer.send('open-logs-folder'),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  getAudioOutputInfo: () => ipcRenderer.invoke('get-audio-output-info'),
  // YouTube / YouTube Music library import (google-library.js) and playlist files / backups (backup.js)
  googleLogin: (profile) => ipcRenderer.invoke('google-login', profile),
  googleLogout: (profile) => ipcRenderer.invoke('google-logout', profile),
  googleAuthStatus: (profile) => ipcRenderer.invoke('google-auth-status', profile),
  googleImportLibrary: (opts) => ipcRenderer.invoke('google-import-library', opts),
  saveTextFile: (payload) => ipcRenderer.invoke('save-text-file', payload),
});

// macOS uses the native traffic lights instead of the drawn window buttons: tag the page so CSS hides the drawn
// minimize/maximize/close, and hide the traffic lights whenever the titlebar itself is hidden
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('platform-darwin');
    const body = document.body;
    if (!body) return;
    let last = null;
    const sync = () => {
      const c = body.classList;
      const visible = !c.contains('mini') && (!c.contains('hide-titlebar') || c.contains('titlebar-peek'));
      if (visible === last) return;
      last = visible;
      ipcRenderer.send('set-window-buttons-visible', visible);
    };
    new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ['class'] });
    sync();
  });
}
