const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const updater = require('../desktop-updater');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-updater-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const URL_OK = 'https://github.com/cloverscripts/riff-muriel/releases/download/v1.4.0/file';
const body = Buffer.from('new muriel build '.repeat(5000));
const sha = crypto.createHash('sha256').update(body).digest('hex');
// a fetch that answers in a few chunks, like a real download, after a redirect to GitHub's download servers
const fakeFetch = (bytes, finalUrl = 'https://release-assets.githubusercontent.com/x') => async () => ({
  ok: true, status: 200, url: finalUrl,
  headers: { get: () => String(bytes.length) },
  body: new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 20000) c.enqueue(bytes.subarray(i, i + 20000)); c.close(); } }),
});

test('a download is checked against the checksum and reports progress', async () => {
  const dest = path.join(tmp, 'ok.bin');
  const seen = [];
  await updater.download({ fetch: fakeFetch(body), url: URL_OK, sha256: sha, size: body.length, dest, onProgress: (p) => seen.push(p) });
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.ok(seen.length > 1);
  assert.deepEqual(seen.at(-1), { received: body.length, total: body.length });
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('a tampered or cut-off download is thrown away', async () => {
  const dest = path.join(tmp, 'bad.bin');
  const tampered = Buffer.from(body); tampered[10] ^= 1;
  await assert.rejects(updater.download({ fetch: fakeFetch(tampered), url: URL_OK, sha256: sha, size: body.length, dest }), /checksum/);
  await assert.rejects(updater.download({ fetch: fakeFetch(body.subarray(0, 100)), url: URL_OK, sha256: sha, size: body.length, dest }), /incomplete/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('downloads only come from GitHub', async () => {
  const dest = path.join(tmp, 'elsewhere.bin');
  await assert.rejects(updater.download({ fetch: fakeFetch(body), url: 'https://example.com/file', sha256: sha, dest }), /GitHub/);
  await assert.rejects(updater.download({ fetch: fakeFetch(body, 'https://example.com/file'), url: URL_OK, sha256: sha, dest }), /away from GitHub/);
});

test('only stamped, packaged builds that can replace themselves update in the app', () => {
  const build = (channel) => ({ sha: 'abc', channel });
  const appImage = path.join(tmp, 'Muriel.AppImage');
  assert.equal(updater.installKind({ build: build('windows'), platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Muriel.exe' } }), 'portable');
  assert.equal(updater.installKind({ build: build('windows'), platform: 'win32', env: {} }), null);
  assert.equal(updater.installKind({ build: build('windows-setup'), platform: 'win32', env: {} }), 'nsis');
  assert.equal(updater.installKind({ build: build('linux'), platform: 'linux', env: { APPIMAGE: appImage } }), 'appimage');
  assert.equal(updater.installKind({ build: build('linux'), platform: 'linux', env: {} }), null);
  assert.equal(updater.installKind({ build: { sha: 'dev', channel: 'linux' }, platform: 'linux', env: { APPIMAGE: appImage } }), null);
  assert.equal(updater.installKind({ build: build('linux'), platform: 'linux', env: { APPIMAGE: appImage }, packaged: false }), null);
  const apps = path.join(tmp, 'Applications');
  fs.mkdirSync(path.join(apps, 'Muriel.app', 'Contents', 'MacOS'), { recursive: true });
  assert.equal(updater.installKind({ build: build('mac'), platform: 'darwin', env: {}, exePath: path.join(apps, 'Muriel.app', 'Contents', 'MacOS', 'Muriel') }), 'mac');
  assert.equal(updater.installKind({ build: build('mac'), platform: 'darwin', env: {}, exePath: '/private/var/folders/x/AppTranslocation/y/d/Muriel.app/Contents/MacOS/Muriel' }), null);
});

test('the new AppImage starts without the old one\'s mount in its environment', () => {
  const mount = '/tmp/.mount_MurielAbc';
  const env = updater.appImageEnv({
    APPDIR: mount, APPIMAGE: '/apps/Muriel.AppImage', ARGV0: './Muriel.AppImage', OWD: '/apps', HOME: '/home/me',
    PATH: `${mount}:${mount}/usr/sbin:/usr/bin`, LD_LIBRARY_PATH: `${mount}/usr/lib`,
    XDG_DATA_DIRS: `${mount}/usr/share/:/usr/share`, GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas`,
  });
  assert.deepEqual(env, { HOME: '/home/me', PATH: '/usr/bin', XDG_DATA_DIRS: '/usr/share' });
});

test('the build stamp is read from build-info.js', () => {
  const dir = path.join(tmp, 'stamp');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'build-info.js'), 'window.MURIEL_BUILD = {"sha":"abc","channel":"linux","version":"1.4.0"};\n');
  assert.deepEqual(updater.readBuildInfo(dir), { sha: 'abc', channel: 'linux', version: '1.4.0' });
  assert.deepEqual(updater.readBuildInfo(path.join(tmp, 'missing')), { sha: 'dev' });
});

test('the Mac swap script puts the new app in place and keeps the old one if that fails', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp, 'mac');
  const app = path.join(dir, 'Applications', 'Muriel.app');
  const next = path.join(dir, 'update', 'Muriel.app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(app, 'version'), 'old');
  fs.writeFileSync(path.join(next, 'version'), 'new');
  const script = path.join(dir, 'apply.sh');
  fs.writeFileSync(script, updater.MAC_SCRIPT, { mode: 0o755 });
  // pid 999999 isn't running, so it doesn't wait
  execFileSync('/bin/sh', [script, '999999', next, app, '0']);
  assert.equal(fs.readFileSync(path.join(app, 'version'), 'utf8'), 'new');
  assert.equal(fs.existsSync(next), false);
  assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Muriel.app']);
  // the download is gone: the installed app stays as it was
  assert.throws(() => execFileSync('/bin/sh', [script, '999999', next, app, '0'], { stdio: 'ignore' }));
  assert.equal(fs.readFileSync(path.join(app, 'version'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Muriel.app']);
});

test('the update banner offers the in-app update before the browser one', () => {
  const notifier = fs.readFileSync(path.join(__dirname, '..', 'update-notifier.js'), 'utf8');
  assert.match(notifier, /window\.electronAPI && window\.electronAPI\.updates\) \|\| window\.MurielAppUpdater/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /invoke\('updater-download'\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('update-core.js') < html.indexOf('update-notifier.js'));
});
