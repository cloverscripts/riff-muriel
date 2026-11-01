// window.electronAPI for the Rust app: the same bridge preload.js gives the Electron build, so app.js runs
// unchanged. main.rs puts the backend's port and token in __MURIEL__ before this runs.
(() => {
  const B = window.__MURIEL__ || {};
  const T = () => window.__TAURI__;
  const invoke = (cmd, args) => T().core.invoke(cmd, args);
  const win = () => T().window.getCurrentWindow();
  const on = (ev, cb) => { try { T().event.listen(ev, (e) => cb(e.payload)); } catch (_) {} };
  const nothing = () => Promise.resolve(null);
  const api = (path, opts) => fetch(`http://127.0.0.1:${B.port}${path}`, Object.assign({ headers: { 'x-muriel-token': B.token } }, opts)).then((r) => r.json());

  window.electronAPI = {
    serverToken: B.token || '',
    isWindows: navigator.userAgent.includes('Windows'),
    isRust: true,
    getServerPort: () => Promise.resolve(B.port),
    minimizeWindow: () => win().minimize(),
    maximizeWindow: () => win().toggleMaximize(),
    closeWindow: () => invoke('close_window'),
    restartApp: () => invoke('restart_app'),
    getAppVersion: () => invoke('app_version'),
    openExternal: (u) => { if (/^https?:\/\//i.test(String(u))) invoke('open_url', { url: String(u) }); },
    copyText: (text) => invoke('copy_text', { text: String(text == null ? '' : text) }).then(() => true, () => false),
    saveTextFile: (p) => invoke('save_text_file', { name: String((p && p.defaultName) || ''), text: (p && typeof p.content === 'string') ? p.content : '' }),
    importAudioFiles: (opts) => invoke('import_audio_files', { folder: !!(opts && opts.folder) }),
    pickMedia: () => invoke('import_audio_files', { folder: false }),
    getDataDir: () => Promise.resolve({ dir: B.dataDir, defaultDir: B.defaultDataDir, isCustom: B.dataDir !== B.defaultDataDir }),
    pickDataDir: nothing,
    setDataDir: () => Promise.resolve({ ok: false, error: 'Not available in the Rust build yet' }),
    getDownloadDir: nothing,
    pickDownloadDir: nothing,
    setDownloadDir: nothing,
    resetDownloadDir: nothing,
    setTrayOnClose: (v) => invoke('set_tray_on_close', { enabled: !!v }),
    getAudioOutputInfo: () => api('/api/audio-output-info').catch(() => null),
    setZoomFactor: (f) => { try { T().webview.getCurrentWebview().setZoom(Number(f) || 1); } catch (_) {} },
    getZoomFactor: () => 1,
    logError: (level, message, stack) => { try { console[level === 'warn' ? 'warn' : 'error']('[muriel]', message, stack || ''); } catch (_) {} },
    onWindowVisibility: (cb) => document.addEventListener('visibilitychange', () => cb(!document.hidden)),
    onMediaCommand: (cb) => on('media-command', cb),
    onWelcomeResult: () => {},
    welcomeFinish: () => {},
    // the system web view hands media keys and the Windows media overlay to navigator.mediaSession itself
    setMediaKeys: () => {},
    mediaKeysActive: () => {},
    getCacheSize: () => Promise.resolve(0),
    clearCache: nothing,
    getHwAccel: () => Promise.resolve(true),
    setHwAccel: () => {},
    getGpuCompositing: () => Promise.resolve(true),
    trimMemory: () => {},
    toggleMiniWindow: nothing,
    setMiniLyrics: nothing,
    getLauncherInfo: nothing,
    listPlugins: () => Promise.resolve([]),
    setPluginEnabled: () => {},
    disableAllPlugins: () => {},
    openPluginsFolder: () => {},
    removePlugin: () => {},
    importPlugins: nothing,
    discordPresenceUpdate: () => {},
    discordPresenceClear: () => {},
    openLogsFolder: () => { if (B.dataDir) invoke('open_path', { path: B.dataDir }); },
    getDiagnostics: () => Promise.resolve({ shell: 'rust', version: B.version, dataDir: B.dataDir }),
    googleLogin: () => Promise.resolve({ ok: false, error: 'Not available in the Rust build yet' }),
    googleLogout: nothing,
    googleAuthStatus: () => Promise.resolve({ signedIn: false }),
    googleImportLibrary: () => Promise.resolve({ ok: false, error: 'Not available in the Rust build yet' }),
  };

  // Muriel draws its own titlebar; Tauri drags a frameless window from elements marked data-tauri-drag-region
  const markDrag = () => document.querySelectorAll('.titlebar-drag').forEach((el) => el.setAttribute('data-tauri-drag-region', ''));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markDrag); else markDrag();
})();
