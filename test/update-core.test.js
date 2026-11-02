const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../update-core');

const SHA = 'a'.repeat(64);
const asset = (name, extra = {}) => ({ name, size: 10, digest: `sha256:${SHA}`, browser_download_url: `https://github.com/cloverscripts/riff-muriel/releases/download/v1.4.0/${name}`, ...extra });
const versioned = { tag_name: 'v1.4.0', target_commitish: 'b'.repeat(40), html_url: 'https://github.com/cloverscripts/riff-muriel/releases/tag/v1.4.0', assets: [
  asset('muriel-1.4.0-win-x64.exe'), asset('muriel-1.4.0-linux-x86_64.AppImage'),
  asset('Muriel-1.4.0-mac-arm64.zip'), asset('Muriel-1.4.0-mac-x64.zip'), asset('Muriel-1.4.0-mac-x64.dmg'),
] };

test('each channel asks its own release', () => {
  assert.equal(core.releaseApi('cloverscripts/riff-muriel', 'windows'), 'https://api.github.com/repos/cloverscripts/riff-muriel/releases/tags/windows-latest');
  assert.equal(core.releaseApi('cloverscripts/riff-muriel', 'linux'), 'https://api.github.com/repos/cloverscripts/riff-muriel/releases/latest');
  assert.equal(core.releaseApi('cloverscripts/riff-muriel', ''), null);
  assert.equal(core.releaseApi('evil/../x?y', 'linux'), null);
});

test('versions compare by number', () => {
  assert.equal(core.compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(core.compareVersions('v1.3.10', '1.3.10'), 0);
  assert.equal(core.compareVersions('1.3.9', '1.3.10'), -1);
});

test('versioned builds update to a higher version only', () => {
  const build = { sha: 'c'.repeat(40), version: '1.3.10', builtAt: '2026-11-01T00:00:00Z' };
  assert.equal(core.isNewer(versioned, build, 'linux'), true);
  assert.equal(core.isNewer(versioned, { ...build, version: '1.4.0' }, 'linux'), false);
  assert.equal(core.isNewer(versioned, { ...build, version: '1.5.0' }, 'mac'), false);
  assert.equal(core.isNewer(versioned, { ...build, sha: 'dev' }, 'linux'), false);
});

test('rolling builds update to a later build from another commit', () => {
  const rel = { target_commitish: 'new', published_at: '2026-11-02T00:00:00Z', body: 'run 90 <!-- muriel-version: 1.3.11 -->', assets: [asset('Muriel.exe')] };
  const build = { sha: 'old', builtAt: '2026-11-01T00:00:00Z', version: '1.3.10' };
  assert.equal(core.isNewer(rel, build, 'windows'), true);
  assert.equal(core.isNewer(rel, { ...build, sha: 'new' }, 'windows'), false);
  assert.equal(core.isNewer(rel, { ...build, builtAt: '2026-11-03T00:00:00Z' }, 'windows'), false);
  const update = core.describe(rel, build, 'windows');
  assert.equal(update.version, '1.3.11');
  assert.equal(update.run, 90);
  assert.match(update.url, /Muriel\.exe$/);
});

test('the in-app download is the right file for the install, with GitHub\'s checksum', () => {
  assert.match(core.installAsset(versioned, 'nsis').name, /win-x64\.exe$/);
  assert.match(core.installAsset(versioned, 'appimage').name, /AppImage$/);
  assert.equal(core.installAsset(versioned, 'mac', 'arm64').name, 'Muriel-1.4.0-mac-arm64.zip');
  assert.equal(core.installAsset(versioned, 'mac', 'x64').name, 'Muriel-1.4.0-mac-x64.zip');
  assert.equal(core.installAsset(versioned, 'mac', 'x64').sha256, SHA);
  assert.equal(core.installAsset(versioned, 'portable'), null);
});

test('no checksum or a link off GitHub: no in-app update', () => {
  const rel = (a) => ({ assets: [a] });
  assert.equal(core.installAsset(rel(asset('Muriel.exe', { digest: null })), 'portable'), null);
  assert.equal(core.installAsset(rel(asset('Muriel.exe', { digest: 'sha256:short' })), 'portable'), null);
  assert.equal(core.installAsset(rel(asset('Muriel.exe', { browser_download_url: 'https://example.com/Muriel.exe' })), 'portable'), null);
  assert.equal(core.isGithubUrl('http://github.com/x'), false);
  assert.equal(core.isGithubUrl('https://release-assets.githubusercontent.com/x'), true);
  assert.equal(core.isGithubUrl('https://github.com.evil.com/x'), false);
});

test('Android updates carry the APK to download; iOS has none', () => {
  const rel = { target_commitish: 'new', published_at: '2026-11-02T00:00:00Z', html_url: 'https://github.com/x/y/releases/tag/ios-latest', assets: [asset('Muriel.apk')] };
  const build = { sha: 'old', builtAt: '2026-11-01T00:00:00Z' };
  assert.equal(core.describe(rel, build, 'android').apk.sha256, SHA);
  const ios = core.describe(rel, build, 'ios');
  assert.equal(ios.apk, null);
  assert.equal(ios.url, rel.html_url);
});
