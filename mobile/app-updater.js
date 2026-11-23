// Android in-app updates: gives update-notifier.js the same download / install calls the computer's preload.js
// does, backed by android/.../AppUpdaterPlugin.java (downloads the APK, checks GitHub's SHA-256, opens the installer).
// iOS has nothing here: a sideloaded app can't install another, so the banner keeps opening the release page.
const { Capacitor, registerPlugin } = require('@capacitor/core');

module.exports = function appUpdater() {
  if (Capacitor.getPlatform() !== 'android') return;
  const plugin = registerPlugin('MurielUpdater');
  window.MurielAppUpdater = {
    supported: async () => true,
    async download(update, onProgress) {
      const apk = update && update.apk;
      if (!apk) return { ok: false, error: 'no verified download in this release' };
      const listener = await plugin.addListener('progress', (p) => { if (onProgress) onProgress(p); });
      try {
        await plugin.download({ url: apk.url, sha256: apk.sha256, size: apk.size });
        return { ok: true, version: update.version };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'download failed' };
      } finally {
        listener.remove();
      }
    },
    async install() {
      try { return await plugin.install(); } catch (e) { return { ok: false, error: (e && e.message) || 'install failed' }; }
    },
  };
};
