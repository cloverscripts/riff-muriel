// In-app updates for the computer: "Update" in the update banner (update-notifier.js) downloads the new build here,
// checks it against GitHub's SHA-256 for that file, and puts it in place of this one on "Restart now", or when
// Muriel quits after "Later". Nothing opens in the browser. What gets replaced depends on how Muriel was installed:
//  - portable: the single Muriel.exe from windows-latest (windows.yml); swapped by a small PowerShell script once
//    Muriel has let go of the file
//  - nsis: the installer from a versioned release, run silently
//  - appimage: the AppImage file itself, renamed over (Linux lets a running file be replaced)
//  - mac: the Muriel.app bundle, swapped by a shell script; the builds are unsigned, so macOS's own updater can't
// Builds without a stamped channel (local and dev builds, `npm start`) never update themselves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { spawn, execFile } = require('child_process');
const updateCore = require('./update-core');

function readBuildInfo(dir = __dirname) {
  try {
    const text = fs.readFileSync(path.join(dir, 'build-info.js'), 'utf8');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) {
    return { sha: 'dev' };
  }
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}

// how this copy of Muriel was installed, or null when it can't replace itself
function installKind({ build, platform = process.platform, env = process.env, exePath = '', packaged = true }) {
  if (!build || !build.sha || build.sha === 'dev' || !packaged) return null;
  if (platform === 'win32' && build.channel === 'windows' && env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (platform === 'win32' && build.channel === 'windows-setup') return 'nsis';
  if (platform === 'linux' && build.channel === 'linux' && env.APPIMAGE && writable(path.dirname(env.APPIMAGE))) return 'appimage';
  if (platform === 'darwin' && build.channel === 'mac') {
    const bundle = macBundle(exePath);
    // a quarantined app run straight from Downloads is moved to a read-only spot by macOS (App Translocation)
    if (bundle && !bundle.includes('/AppTranslocation/') && writable(path.dirname(bundle))) return 'mac';
  }
  return null;
}

// .../Muriel.app/Contents/MacOS/Muriel -> .../Muriel.app
function macBundle(exePath) {
  const bundle = path.resolve(String(exePath || ''), '..', '..', '..');
  return /\.app$/.test(bundle) ? bundle : null;
}

// Streams url to dest, checking the size and SHA-256 on the way; dest only appears once both match.
async function download({ fetch, url, sha256, size, dest, onProgress = () => {}, signal }) {
  if (!updateCore.isGithubUrl(url)) throw new Error('not a GitHub download');
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  if (res.url && !updateCore.isGithubUrl(res.url)) throw new Error('redirected away from GitHub');
  const total = size || Number(res.headers.get('content-length')) || 0;
  const part = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await once(out, 'drain');
      onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (size && received !== size) throw new Error('download incomplete');
    if (hash.digest('hex') !== sha256) throw new Error("download doesn't match GitHub's checksum");
    fs.renameSync(part, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
}

// Windows: wait until Muriel has let go of its exe (the portable launcher holds it a moment after the app quits),
// then put the new one in its place or run the installer
const WINDOWS_SCRIPT = `param([int]$WaitPid, [string]$Kind, [string]$Src, [string]$Dst, [int]$Relaunch)
Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue
if ($Kind -eq 'nsis') {
  $installArgs = @('/S')
  if ($Relaunch -eq 1) { $installArgs += '--force-run' }
  Start-Process -FilePath $Src -ArgumentList $installArgs
  exit 0
}
$deadline = (Get-Date).AddMinutes(2)
while ($true) {
  try { Move-Item -LiteralPath $Src -Destination $Dst -Force -ErrorAction Stop; break }
  catch { if ((Get-Date) -gt $deadline) { exit 1 }; Start-Sleep -Milliseconds 500 }
}
if ($Relaunch -eq 1) { Start-Process -FilePath $Dst }
`;

// Mac: once Muriel has quit, swap the bundle (keeping the old one until the new one is in place), clear the
// download quarantine the unsigned app would otherwise be stopped by, and open it again
const MAC_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; app="$3"; relaunch="$4"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 0.5; i=$((i + 1)); done
old="$app.old-$$"
mv "$app" "$old" || exit 1
if ! mv "$new" "$app"; then mv "$old" "$app"; exit 1; fi
rm -rf "$old"
xattr -cr "$app" 2>/dev/null
[ "$relaunch" = 1 ] && open "$app"
exit 0
`;

// Linux: start the new AppImage once this one has quit
const APPIMAGE_RELAUNCH = 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.2; i=$((i + 1)); done; exec "$2"';

// the environment for the new AppImage: without what the old one's launcher pointed into its own mount
// (APPDIR, its libraries and schemas, and those entries in PATH and XDG_DATA_DIRS), which is gone by then
function appImageEnv(env) {
  const mount = env.APPDIR;
  const out = { ...env };
  for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[key];
  if (!mount) return out;
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string' || !value.includes(mount)) continue;
    const kept = value.split(':').filter((p) => p && !p.startsWith(mount));
    if (kept.length) out[key] = kept.join(':');
    else delete out[key];
  }
  return out;
}

function register() {
  const { app, ipcMain, net } = require('electron');
  const build = readBuildInfo();
  const kind = installKind({ build, exePath: app.getPath('exe'), packaged: app.isPackaged });
  const workDir = path.join(os.tmpdir(), 'muriel-update');
  let downloading = null;
  let staged = null; // { kind, file, version } once a verified update is ready to go in
  let applied = false;

  ipcMain.handle('updater-supported', () => !!kind);

  ipcMain.handle('updater-download', async (event) => {
    if (!kind) return { ok: false, error: 'unsupported' };
    if (staged) return { ok: true, version: staged.version };
    if (!downloading) {
      downloading = fetchUpdate((p) => { if (!event.sender.isDestroyed()) event.sender.send('updater-progress', p); })
        .then((s) => { staged = s; return { ok: true, version: s.version }; })
        .catch((e) => ({ ok: false, error: e.message }))
        .finally(() => { downloading = null; });
    }
    return downloading;
  });

  // "Restart now": on success Muriel exits here and the answer never arrives
  ipcMain.handle('updater-install', () => {
    if (!staged || applied) return { ok: false, error: 'nothing downloaded' };
    try {
      apply(true);
      return { ok: true };
    } catch (e) {
      applied = false;
      return { ok: false, error: e.message };
    }
  });

  // "Later": the downloaded update goes in as Muriel quits
  app.on('will-quit', () => {
    if (staged && !applied) { try { apply(false); } catch (e) {} }
  });

  async function fetchUpdate(onProgress) {
    const api = updateCore.releaseApi(build.repo, build.channel);
    const res = await net.fetch(api, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    if (!updateCore.isNewer(rel, build, build.channel)) throw new Error('no newer build');
    const asset = updateCore.installAsset(rel, kind, process.arch);
    if (!asset) throw new Error('no verified download in this release');
    const version = updateCore.describe(rel, build, build.channel).version;

    // the AppImage is downloaded next to the old one, so putting it in place is a rename on the same disk
    const dir = kind === 'appimage' ? path.dirname(process.env.APPIMAGE) : workDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = kind === 'appimage' ? path.join(dir, `.${path.basename(process.env.APPIMAGE)}.update`) : path.join(dir, asset.name);
    fs.rmSync(file, { recursive: true, force: true });
    let last = 0;
    await download({
      fetch: net.fetch, url: asset.url, sha256: asset.sha256, size: asset.size, dest: file,
      onProgress: (p) => { const now = Date.now(); if (now - last > 150 || p.received === p.total) { last = now; onProgress(p); } },
    });
    if (kind === 'appimage') fs.chmodSync(file, 0o755);
    if (kind === 'mac') return { kind, file: await unzipApp(file), version };
    return { kind, file, version };
  }

  async function unzipApp(zip) {
    const out = path.join(workDir, 'app');
    fs.rmSync(out, { recursive: true, force: true });
    await new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, out], (e) => (e ? reject(e) : resolve())));
    fs.rmSync(zip, { force: true });
    const name = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('no app in the download');
    return path.join(out, name);
  }

  function runDetached(cmd, args, options = {}) {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options }).unref();
  }

  function apply(relaunch) {
    applied = true;
    const { file } = staged;
    if (kind === 'appimage') {
      fs.renameSync(file, process.env.APPIMAGE);
      // not app.relaunch(): its helper is this build's binary, inside the AppImage's mount that goes away as Muriel
      // quits, and the new AppImage then can't mount ("Cannot mount AppImage, please check your FUSE setup")
      if (relaunch) {
        runDetached('/bin/sh', ['-c', APPIMAGE_RELAUNCH, 'muriel-update', String(process.pid), process.env.APPIMAGE],
          { cwd: path.dirname(process.env.APPIMAGE), env: appImageEnv(process.env) });
        app.exit(0);
      }
      return;
    }
    if (kind === 'portable' || kind === 'nsis') {
      const script = path.join(workDir, 'apply-update.ps1');
      fs.writeFileSync(script, WINDOWS_SCRIPT);
      runDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-WaitPid', String(process.pid), '-Kind', kind, '-Src', file, '-Dst', process.env.PORTABLE_EXECUTABLE_FILE || '', '-Relaunch', relaunch ? '1' : '0']);
    } else if (kind === 'mac') {
      const script = path.join(workDir, 'apply-update.sh');
      fs.writeFileSync(script, MAC_SCRIPT, { mode: 0o755 });
      runDetached('/bin/sh', [script, String(process.pid), file, macBundle(app.getPath('exe')), relaunch ? '1' : '0']);
    }
    if (relaunch) app.exit(0);
  }
}

module.exports = { register, readBuildInfo, installKind, macBundle, download, appImageEnv, WINDOWS_SCRIPT, MAC_SCRIPT, APPIMAGE_RELAUNCH };
