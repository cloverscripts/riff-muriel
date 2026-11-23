// window.electronAPI for the iOS build. Desktop-only features (window controls, tray, mini player,
// data folders, hardware acceleration) become no-ops; file pickers use the iOS document picker.
const crypto = require('./shims/crypto');
const store = require('./shims/store');
const { Capacitor } = require('@capacitor/core');
const { Share } = require('@capacitor/share');
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');

function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1].toLowerCase();
const noop = () => {};

module.exports = function electronAPI({ ready, port, fs, fileUrlFor }) {
  const visibilityListeners = [];
  document.addEventListener('visibilitychange', () => visibilityListeners.forEach((cb) => cb(!document.hidden)));

  return {
    isWindows: false,
    isMobile: true,
    minimizeWindow: noop, maximizeWindow: noop, closeWindow: noop,
    getServerPort: () => ready.then(() => port),
    getGpuCompositing: async () => 'enabled',
    onWindowVisibility: (cb) => visibilityListeners.push(cb),
    setZoomFactor: noop,
    getZoomFactor: () => 1,

    // Background image/GIF/video: copied into app storage so it survives the picker's temp file.
    async pickMedia() {
      const [file] = await pickFiles('image/*,video/mp4,video/webm,.gif', false);
      if (!file) return null;
      await ready;
      const vpath = `/data/backgrounds/bg_${Date.now()}.${extOf(file.name)}`;
      await fs._writeBlob(vpath, file);
      if (!fs.existsSync(vpath)) return null;
      // the absolute file URL changes when iOS moves the app container (every reinstall); mobile-ui.js
      // rebuilds saved ones on launch from the file name
      return fileUrlFor(vpath);
    },
    // deletes picked files that no saved setting points to any more (called by mobile-ui.js after the repair)
    async pruneMedia(keep) {
      await ready;
      let names = [];
      try { names = fs.readdirSync('/data/backgrounds'); } catch (e) { return; }
      for (const n of names) {
        if (keep.has(n)) continue;
        const pickedAt = Number((n.match(/^bg_(\d+)/) || [])[1]);
        if (!pickedAt || Date.now() - pickedAt < 3600e3) continue; // not ours, or picked just now and not saved yet
        try { fs.unlinkSync(`/data/backgrounds/${n}`); } catch (e) {}
      }
    },

    // Same contract as main.js: copy into the library folder as local_<sha1>.<ext>.
    async importAudioFiles() {
      const files = await pickFiles('audio/*,.mp3,.m4a,.flac,.wav,.aac,.ogg,.opus', true);
      await ready;
      // lossless files take a while to copy; say so, or the app looks stuck
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > 20e6 && window.MurielCore) window.MurielCore.toast(`Adding ${files.length} song${files.length === 1 ? '' : 's'}…`, 'info');
      const out = [];
      for (const f of files) {
        const ext = extOf(f.name);
        const id = 'local_' + crypto._sha1(f.name + f.size).slice(0, 12);
        const file = `${id}.${ext}`;
        const target = `/data/library/${file}`;
        // one at a time, each in pieces (fs._writeBlob); a copy cut short (app closed mid-import) is redone
        if (!fs.existsSync(target) || fs.statSync(target).size !== f.size) await fs._writeBlob(target, f);
        if (!fs.existsSync(target)) continue; // couldn't be saved (storage full): the app has said so
        out.push({ id, file, ext, name: f.name.replace(/\.[^.]+$/, '') });
      }
      await fs._flush();
      return out;
    },

    async getCacheSize() {
      await ready;
      let audio = 0;
      try { for (const n of fs.readdirSync('/data/tracks')) audio += fs.statSync(`/data/tracks/${n}`).size; } catch (e) {}
      return { audio, web: 0, total: audio };
    },
    // like desktop: delete the cached songs and thumbnails (via the in-app server), then wait for the disk.
    // It used to only report success, so the cache never shrank.
    clearCache: async () => {
      await ready;
      try { await fetch('http://127.0.0.1:38472/api/clear-offline-library', { method: 'POST' }); } catch (e) {}
      await fs._flush();
      return true;
    },
    getDataDir: async () => ({ dir: 'On this iPhone (Files → Muriel)', defaultDir: '/data', isCustom: false }),
    pickDataDir: async () => null,
    setDataDir: async () => ({ success: false, error: 'The music folder is fixed on iPhone' }),
    // fixed on phones (Settings hides Change): Files → Muriel → Downloads on iOS, Music/Muriel on Android (shims/store.js)
    async getDownloadDir() {
      if (Capacitor.getPlatform() !== 'android') return { dir: 'Files → Muriel → Downloads', isCustom: false };
      await ready;
      return { dir: store.downloadsFolder() || "Inside the app (other apps can't see it)", isCustom: false };
    },
    pickDownloadDir: async () => null,
    setDownloadDir: async () => ({ success: false }),
    resetDownloadDir: async () => ({ success: true }),
    restartApp: () => location.reload(),
    getAppVersion: async () => { const b = window.MURIEL_BUILD || {}; return b.version ? `${b.version}${b.run ? ` (build ${b.run})` : ''}` : '1.1.2'; },
    getHwAccel: async () => true,
    setHwAccel: noop,
    trimMemory: noop,
    setTrayOnClose: noop,
    toggleMiniWindow: async () => false,
    setMediaKeys: noop,
    mediaKeysActive: noop,
    onMediaCommand: noop, // lock-screen controls come from navigator.mediaSession in app.js
    welcomeFinish: noop,
    onWelcomeResult: noop,
    getLauncherInfo: async () => ({ platform: 'ios', canInstall: false, installed: true }),
    fileUrl: async (vpath) => { await ready; return fs.existsSync(vpath) ? fileUrlFor(vpath) : null; },
    // playlist files and profile backups (backup.js): written to the app's cache, then handed to the share sheet,
    // where "Save to Files" / Drive / Mail take it. In a desktop browser (dev harness) it's a plain download.
    async saveTextFile({ defaultName, content } = {}) {
      if (typeof content !== 'string') return { success: false, error: 'Nothing to save' };
      const name = String(defaultName || 'muriel.json').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'muriel.json';
      if (!Capacitor.isNativePlatform()) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return { success: true };
      }
      const loc = { path: `exports/${name}`, directory: Directory.Cache };
      try {
        await Filesystem.writeFile({ ...loc, data: content, encoding: Encoding.UTF8, recursive: true });
        const { uri } = await Filesystem.getUri(loc);
        await Share.share({ title: name, files: [uri], dialogTitle: name });
        return { success: true };
      } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return { canceled: true };
        return { success: false, error: "Couldn't share the file" };
      } finally {
        // the share sheet has its own copy by now
        setTimeout(() => { Filesystem.deleteFile(loc).catch(() => {}); }, 60000);
      }
    },

    // cover art: written to the app's cache, then handed to the share sheet ("Save Image" included);
    // in a desktop browser (dev harness) it's a plain download.
    async saveImageFile({ base64, fileUrl, defaultName, mime } = {}) {
      const base = String(defaultName || 'cover art').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'cover art';
      const extFor = (m) => (/png/.test(m) ? 'png' : /webp/.test(m) ? 'webp' : /gif/.test(m) ? 'gif' : /svg/.test(m) ? 'svg' : 'jpg');
      const toBlob = (data, type) => {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: type || 'image/jpeg' });
      };
      let data = typeof base64 === 'string' ? base64 : '';
      let type = String(mime || 'image/jpeg');
      if (!data && fileUrl) {
        try {
          const r = await fetch(fileUrl);
          if (r.ok) {
            const blob = await r.blob();
            if (blob.size) {
              type = blob.type || type;
              data = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
                fr.onerror = () => reject(fr.error);
                fr.readAsDataURL(blob);
              });
            }
          }
        } catch (e) {}
      }
      if (!data) return { success: false, error: 'Nothing to save' };
      const name = `${base.replace(/\.[a-z0-9]{1,5}$/i, '')}.${extFor(type)}`;
      if (!Capacitor.isNativePlatform()) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(toBlob(data, type));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return { success: true };
      }
      const loc = { path: `exports/${name}`, directory: Directory.Cache };
      try {
        await Filesystem.writeFile({ ...loc, data, recursive: true });
        const { uri } = await Filesystem.getUri(loc);
        await Share.share({ title: name, files: [uri], dialogTitle: name });
        return { success: true };
      } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return { canceled: true };
        return { success: false, error: "Couldn't save the picture" };
      } finally {
        setTimeout(() => { Filesystem.deleteFile(loc).catch(() => {}); }, 60000);
      }
    },

    // native share sheet (WhatsApp, Mail, …); falls back to the clipboard
    async shareText(title, text) {
      try { await Share.share({ title, text, dialogTitle: title }); return 'shared'; } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return 'cancelled';
        try { await navigator.clipboard.writeText(text); return 'copied'; } catch (x) { return 'failed'; }
      }
    },
  };
};
