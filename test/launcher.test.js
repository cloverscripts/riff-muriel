const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const APP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-launcher-'));
const EXE = path.join(APP_DATA, 'apps', 'Muriel.exe');
const TEMP_EXE = path.join(APP_DATA, 'Temp', 'extracted', 'Muriel.exe');
const START_MENU = path.join(APP_DATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Muriel.lnk');
const TASKBAR_DIR = path.join(APP_DATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
const TASKBAR = path.join(TASKBAR_DIR, 'Muriel.lnk');
const IMPLICIT_DIR = path.join(APP_DATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'ImplicitAppShortcuts', '0123abcd');
const IMPLICIT = path.join(IMPLICIT_DIR, 'Muriel.lnk');

fs.mkdirSync(path.dirname(EXE), { recursive: true });
fs.writeFileSync(EXE, '');
fs.mkdirSync(TASKBAR_DIR, { recursive: true });

// In-memory shortcut store so the tests exercise launcher.js's decisions without writing real Windows links.
const links = new Map();
const electron = {
  app: {
    isPackaged: true,
    getPath: () => APP_DATA,
    getName: () => 'Muriel',
  },
  shell: {
    readShortcutLink(linkPath) {
      const value = links.get(path.resolve(linkPath));
      if (!value) throw new Error('shortcut not found');
      return Object.assign({}, value);
    },
    writeShortcutLink(linkPath, operation, options) {
      const key = path.resolve(linkPath);
      if (operation === 'create' && links.has(key)) return false;
      links.set(key, Object.assign({}, options));
      return true;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electron;
  return originalLoad.apply(this, arguments);
};
const launcher = require('../launcher');
Module._load = originalLoad;

const winOnly = process.platform === 'win32' ? test : test.skip;
process.env.PORTABLE_EXECUTABLE_FILE = EXE;

test.after(() => {
  try { fs.rmSync(APP_DATA, { recursive: true, force: true }); } catch (e) {}
});

function reset() {
  links.clear();
  for (const link of [START_MENU, TASKBAR, IMPLICIT, path.join(TASKBAR_DIR, 'Other.lnk')]) {
    try { fs.unlinkSync(link); } catch (e) {}
  }
  process.env.PORTABLE_EXECUTABLE_FILE = EXE;
}

function addLink(linkPath, details) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.writeFileSync(linkPath, '');
  links.set(path.resolve(linkPath), details);
}

winOnly('installs a Start Menu shortcut that carries the shared AppUserModelID', () => {
  reset();
  const result = launcher.installLauncher();
  assert.strictEqual(result.ok, true);
  const details = links.get(path.resolve(START_MENU));
  assert.strictEqual(details.target, EXE);
  assert.strictEqual(details.appUserModelId, launcher.APP_ID);
});

winOnly('repairs a stale Start Menu shortcut left by an older build', () => {
  reset();
  addLink(START_MENU, { target: TEMP_EXE, icon: TEMP_EXE, description: 'Muriel' });
  launcher.repairWindowsShortcuts();
  const details = links.get(path.resolve(START_MENU));
  assert.strictEqual(details.target, EXE);
  assert.strictEqual(details.icon, EXE);
  assert.strictEqual(details.appUserModelId, launcher.APP_ID);
});

winOnly('repairs a pinned taskbar shortcut that points at the temporary extraction folder', () => {
  reset();
  addLink(TASKBAR, { target: TEMP_EXE, icon: TEMP_EXE, description: 'Muriel' });
  const result = launcher.repairWindowsShortcuts();
  assert.deepStrictEqual(result.repaired, [TASKBAR]);
  const details = links.get(path.resolve(TASKBAR));
  assert.strictEqual(details.target, EXE);
  assert.strictEqual(details.appUserModelId, launcher.APP_ID);
});

winOnly('repairs a pin Windows stored under ImplicitAppShortcuts', () => {
  reset();
  addLink(IMPLICIT, { target: TEMP_EXE, icon: TEMP_EXE, description: 'Muriel' });
  const result = launcher.repairWindowsShortcuts();
  assert.deepStrictEqual(result.repaired, [IMPLICIT]);
  const details = links.get(path.resolve(IMPLICIT));
  assert.strictEqual(details.target, EXE);
  assert.strictEqual(details.appUserModelId, launcher.APP_ID);
});

winOnly('points pins at the running executable while the window is hidden in the tray', () => {
  reset();
  addLink(TASKBAR, { target: EXE, icon: EXE, appUserModelId: launcher.APP_ID });
  const result = launcher.pointPinsAtRunningApp();
  assert.deepStrictEqual(result.retargeted, [TASKBAR]);
  const details = links.get(path.resolve(TASKBAR));
  assert.strictEqual(details.target, process.execPath);
  assert.strictEqual(details.appUserModelId, launcher.APP_ID);
});

winOnly('puts the stable target back when the window is shown again', () => {
  reset();
  addLink(TASKBAR, { target: process.execPath, icon: process.execPath, appUserModelId: launcher.APP_ID });
  launcher.pointPinsAtInstall();
  const details = links.get(path.resolve(TASKBAR));
  assert.strictEqual(details.target, EXE);
  assert.strictEqual(details.icon, EXE);
});

winOnly('leaves other applications pinned to the taskbar alone', () => {
  reset();
  const other = path.join(TASKBAR_DIR, 'Other.lnk');
  addLink(other, { target: 'C:\\Windows\\System32\\notepad.exe', icon: 'C:\\Windows\\System32\\notepad.exe' });
  launcher.repairWindowsShortcuts();
  assert.deepStrictEqual(links.get(path.resolve(other)), {
    target: 'C:\\Windows\\System32\\notepad.exe',
    icon: 'C:\\Windows\\System32\\notepad.exe',
  });
});

winOnly('does nothing when the app is not packaged', () => {
  reset();
  electron.app.isPackaged = false;
  addLink(TASKBAR, { target: TEMP_EXE, icon: TEMP_EXE });
  assert.deepStrictEqual(launcher.repairWindowsShortcuts(), { ok: false, repaired: [] });
  assert.strictEqual(links.get(path.resolve(TASKBAR)).target, TEMP_EXE);
  electron.app.isPackaged = true;
});
