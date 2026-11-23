const { dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./platform');

const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');
const STATE_PATH = path.join(PLUGINS_DIR, 'plugins.json');
const MAX_BYTES = 1024 * 1024;
const safeName = (n) => /^[\w.\- ]+\.js$/.test(String(n)) && !String(n).includes('..');

const EXAMPLE = '/**\n * @name Hello plugin\n * @author Muriel\n * @version 1.0.0\n * @description Shows a message when the track changes. Edit or delete this file.\n */\nconst off = Muriel.on(\'trackchange\', (track) => Muriel.toast(\'Now playing: \' + track.title));\nreturn { stop() { off(); } };\n';

function ensureDir() {
  if (fs.existsSync(PLUGINS_DIR)) return;
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  try { fs.writeFileSync(path.join(PLUGINS_DIR, 'example-hello.js'), EXAMPLE); } catch (e) {}
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return j && typeof j.enabled === 'object' && j.enabled ? j.enabled : {};
  } catch (e) { return {}; }
}

function writeState(enabled) {
  ensureDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled }));
}

function parseMeta(code, fallbackName) {
  const block = code.match(/\/\*[\s\S]*?\*\//);
  const text = block ? block[0] : '';
  const pick = (key) => {
    const m = text.match(new RegExp('@' + key + '[ \\t]+([^\\r\\n*]+)'));
    return m ? m[1].trim() : '';
  };
  return { name: pick('name') || fallbackName, author: pick('author'), version: pick('version'), description: pick('description') };
}

function listAll() {
  ensureDir();
  const enabled = readState();
  return fs.readdirSync(PLUGINS_DIR).filter((f) => f.toLowerCase().endsWith('.js') && safeName(f)).map((f) => {
    try {
      const full = path.join(PLUGINS_DIR, f);
      if (fs.statSync(full).size > MAX_BYTES) return null;
      const code = fs.readFileSync(full, 'utf8');
      return { file: f, ...parseMeta(code, f.replace(/\.js$/i, '')), enabled: !!enabled[f], code };
    } catch (e) { return null; }
  }).filter(Boolean);
}

function register(getWindow) {
  ipcMain.handle('plugins-list', () => listAll());
  ipcMain.on('plugins-set-enabled', (e, file, on) => {
    if (!safeName(file)) return;
    const s = readState();
    if (on) s[file] = true; else delete s[file];
    writeState(s);
  });
  ipcMain.on('plugins-disable-all', () => writeState({}));
  ipcMain.on('plugins-open-folder', () => { ensureDir(); shell.openPath(PLUGINS_DIR); });
  ipcMain.on('plugins-remove', (e, file) => {
    if (!safeName(file)) return;
    try { fs.unlinkSync(path.join(PLUGINS_DIR, file)); } catch (err) {}
    const s = readState();
    delete s[file];
    writeState(s);
  });
  ipcMain.handle('plugins-import', async () => {
    ensureDir();
    const result = await dialog.showOpenDialog(getWindow(), { title: 'Add plugin', properties: ['openFile', 'multiSelections'], filters: [{ name: 'JavaScript plugin', extensions: ['js'] }] });
    if (result.canceled) return 0;
    let added = 0;
    const s = readState();
    for (const file of result.filePaths) {
      try {
        const name = path.basename(file);
        if (!safeName(name) || fs.statSync(file).size > MAX_BYTES) continue;
        fs.copyFileSync(file, path.join(PLUGINS_DIR, name));
        // a plugin replaced by a new file of the same name starts off: its new code runs only once switched on again
        delete s[name];
        added++;
      } catch (e) {}
    }
    writeState(s);
    return added;
  });
}

module.exports = { register };
