const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'Muriel';
const COMMENT = 'Muriel - music player';
// Must match build.appId and the ID main.js gives the process, so the Start Menu shortcut, a pinned taskbar
// icon and the running window all share one taskbar identity (#23).
const APP_ID = 'io.github.cloverscripts.muriel';

function winShortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
}

function quickLaunchDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch');
}

function winTaskbarShortcutPath() {
  return path.join(quickLaunchDir(), 'User Pinned', 'TaskBar', `${NAME}.lnk`);
}

// Pins made from a running window have no matching Start Menu shortcut, so Windows stores them in an
// ImplicitAppShortcuts\<id> folder instead of the TaskBar folder.
function implicitAppShortcutsDir() {
  return path.join(quickLaunchDir(), 'ImplicitAppShortcuts');
}

function linuxDesktopPath() {
  return path.join(os.homedir(), '.local', 'share', 'applications', 'muriel.desktop');
}

function linuxIconPath() {
  return path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'muriel.png');
}

function getLauncherInfo() {
  if (process.platform === 'win32') {
    if (!app.isPackaged) return { platform: 'win32', canInstall: false, installed: false, reason: 'Available in the installed app' };
    return { platform: 'win32', canInstall: true, installed: fs.existsSync(winShortcutPath()), reason: '' };
  }
  if (process.platform === 'linux') {
    if (!process.env.APPIMAGE) return { platform: 'linux', canInstall: false, installed: false, reason: 'Available when Muriel runs as an AppImage' };
    return { platform: 'linux', canInstall: true, installed: fs.existsSync(linuxDesktopPath()), reason: '' };
  }
  return { platform: process.platform, canInstall: false, installed: false, reason: 'Not supported on this system' };
}

// The portable build runs from a temporary folder, so process.execPath disappears when the app closes.
// Shortcuts have to point at the outer portable launcher instead.
function launchTarget() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function writeWindowsShortcut(lnk, target) {
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  const options = { target, cwd: path.dirname(target), description: COMMENT, icon: target, iconIndex: 0 };
  if (APP_ID) options.appUserModelId = APP_ID;
  return shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', options);
}

// Windows derives a shortcut's AppUserModelID from its target unless one is written into the link. Only touch
// links that launch Muriel (or already carry our ID).
function isMurielShortcut(details) {
  if (!details) return false;
  if (details.appUserModelId === APP_ID) return true;
  return path.basename(String(details.target || '')).toLowerCase() === `${NAME.toLowerCase()}.exe`;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function repairWindowsShortcut(lnk, target) {
  try {
    if (!fs.existsSync(lnk)) return false;
    const details = shell.readShortcutLink(lnk);
    if (!isMurielShortcut(details)) return false;
    const upToDate = samePath(details.target, target) && details.appUserModelId === APP_ID && samePath(details.icon, target);
    if (upToDate) return true;
    return writeWindowsShortcut(lnk, target);
  } catch (e) {
    return false;
  }
}

function shortcutsIn(dir) {
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return found; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue;
    const lnk = path.join(dir, entry.name);
    try {
      if (isMurielShortcut(shell.readShortcutLink(lnk))) found.push(lnk);
    } catch (e) {}
  }
  return found;
}

function pinnedMurielShortcuts() {
  const found = shortcutsIn(path.dirname(winTaskbarShortcutPath()));
  let groups = [];
  try { groups = fs.readdirSync(implicitAppShortcutsDir(), { withFileTypes: true }); } catch (e) {}
  for (const group of groups) {
    if (group.isDirectory()) found.push(...shortcutsIn(path.join(implicitAppShortcutsDir(), group.name)));
  }
  return found;
}

// Pins and Start Menu entries created by older builds point at the temporary extraction path and carry no
// AppUserModelID, which is why Windows showed a second icon next to the pin and stopped opening the app after
// an update. Rewrite Muriel's shortcuts on every start so they always launch the current build under the shared
// ID (#23). Other applications' pins are left alone.
function repairWindowsShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return { ok: false, repaired: [] };
  const target = launchTarget();
  const links = [winShortcutPath(), ...pinnedMurielShortcuts()];
  const repaired = [];
  for (const lnk of new Set(links)) {
    if (repairWindowsShortcut(lnk, target)) repaired.push(lnk);
  }
  return { ok: repaired.length > 0, repaired };
}

function installWindows() {
  return { ok: writeWindowsShortcut(winShortcutPath(), launchTarget()) };
}

function quoteExec(file) {
  return '"' + file.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"';
}

function installLinux() {
  const image = process.env.APPIMAGE;
  if (!image) return { ok: false };
  try { fs.chmodSync(image, 0o755); } catch (e) {}
  const desktop = linuxDesktopPath();
  const iconDest = linuxIconPath();
  let icon = 'audio-x-generic';
  try {
    fs.mkdirSync(path.dirname(iconDest), { recursive: true });
    fs.writeFileSync(iconDest, fs.readFileSync(path.join(__dirname, 'assets', 'icon.png')));
    icon = iconDest;
  } catch (e) {}
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${NAME}`,
    'GenericName=Music Player',
    `Comment=${COMMENT}`,
    `Exec=${quoteExec(image)} %U`,
    `TryExec=${image}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=AudioVideo;Audio;Player;Music;',
    `StartupWMClass=${app.getName()}`,
    'StartupNotify=true',
    ''
  ];
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, lines.join('\n'));
  fs.chmodSync(desktop, 0o755);
  execFile('update-desktop-database', [path.dirname(desktop)], () => {});
  return { ok: true };
}

function installLauncher() {
  try {
    if (!getLauncherInfo().canInstall) return { ok: false };
    if (process.platform === 'win32') return installWindows();
    if (process.platform === 'linux') return installLinux();
  } catch (e) {}
  return { ok: false };
}

module.exports = { APP_ID, getLauncherInfo, installLauncher, repairWindowsShortcuts };
