// Which release is an update for this build, and which file of it to download. Shared by the page
// (update-notifier.js) and the computer's main process (desktop-updater.js); test/update-core.test.js runs it in Node.
//
// Channels (tools/build-info.mjs stamps one into each CI build):
//  - windows, android, ios: the rolling "<channel>-latest" release, rebuilt on every push to main
//  - windows-setup, linux, mac: the installer, AppImage and app from the versioned releases (release.yml)
(function (root) {
  'use strict';

  const TAGS = { ios: 'ios-latest', android: 'android-latest', windows: 'windows-latest', 'windows-setup': 'latest', linux: 'latest', mac: 'latest' };
  const VERSIONED = new Set(['windows-setup', 'linux', 'mac']);
  // the file the browser fallback opens; iOS (sideloaded) and the Mac go to the release page
  const BROWSER_ASSET = { android: /^Muriel\.apk$/, windows: /^Muriel\.exe$/, 'windows-setup': /-win-x64\.exe$/, linux: /-linux-x86_64\.AppImage$/ };

  const releaseApi = (repo, channel) => {
    const tag = TAGS[channel];
    if (!tag || !/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) return null;
    return `https://api.github.com/repos/${repo}/releases/${tag === 'latest' ? 'latest' : `tags/${tag}`}`;
  };

  // 1.10.0 > 1.9.3; anything after a "-" (1.4.0-beta) is ignored
  function compareVersions(a, b) {
    const parts = (v) => String(v || '').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
    }
    return 0;
  }

  const releaseVersion = (rel) => ((rel.body || '').match(/muriel-version: ([0-9][\w.-]*)/) || [])[1] || String(rel.tag_name || '').replace(/^v(?=\d)/, '');

  // Versioned channels: a higher version. Rolling ones: built from another commit and published after this
  // build was made (so test builds that are newer than the public release don't get told to "update" to an older one).
  function isNewer(rel, build, channel) {
    if (!rel || !build || !build.sha || build.sha === 'dev') return false;
    if (VERSIONED.has(channel)) return compareVersions(releaseVersion(rel), build.version) > 0;
    if (!rel.target_commitish || rel.target_commitish === build.sha) return false;
    const published = Date.parse(rel.published_at || rel.created_at || 0);
    const built = Date.parse(build.builtAt || 0);
    return published > built + 60000;
  }

  // the file an in-app update downloads: kind is desktop-updater.js's (portable, nsis, appimage, mac) or "android"
  const INSTALL_ASSET = {
    portable: () => /^Muriel\.exe$/,
    nsis: () => /-win-x64\.exe$/,
    appimage: () => /-linux-x86_64\.AppImage$/,
    mac: (arch) => new RegExp(`-mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.zip$`),
    android: () => /^Muriel\.apk$/,
  };
  function installAsset(rel, kind, arch) {
    const pattern = INSTALL_ASSET[kind] && INSTALL_ASSET[kind](arch);
    const asset = pattern && ((rel && rel.assets) || []).find((a) => pattern.test(a.name || ''));
    const sha256 = asset && (String(asset.digest || '').match(/^sha256:([0-9a-f]{64})$/) || [])[1];
    // GitHub's own checksum is what makes the download safe to run: no checksum, no in-app update
    if (!asset || !sha256 || !isGithubUrl(asset.browser_download_url)) return null;
    return { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0, sha256 };
  }

  // downloads only ever come from GitHub (release links redirect to its download servers)
  function isGithubUrl(u) {
    let url;
    try { url = new URL(String(u)); } catch (e) { return false; }
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'api.github.com' || /\.githubusercontent\.com$/.test(url.hostname));
  }

  function describe(rel, build, channel) {
    if (!isNewer(rel, build, channel)) return null;
    const pattern = BROWSER_ASSET[channel];
    const asset = pattern && (rel.assets || []).find((a) => pattern.test(a.name || ''));
    const run = Number(((rel.body || '').match(/run (\d+)/) || [])[1]) || 0;
    return {
      sha: rel.target_commitish || rel.tag_name, run, version: releaseVersion(rel),
      url: (asset && asset.browser_download_url) || rel.html_url, page: rel.html_url,
      apk: channel === 'android' ? installAsset(rel, 'android') : null,
    };
  }

  const core = { TAGS, VERSIONED, releaseApi, compareVersions, isNewer, installAsset, isGithubUrl, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.MurielUpdateCore = core;
})(typeof window !== 'undefined' ? window : globalThis);
