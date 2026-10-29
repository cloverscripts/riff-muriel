const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { IS_WIN, BIN_DIR, resolveBinary, clearBinaryCache } = require('./platform');
const logger = require('./logger');

const state = { status: 'idle', tool: '', percent: 0, error: '' };
const STAMP = path.join(BIN_DIR, '.ytdlp-update-stamp');

// macOS: the single-file yt-dlp_macos build unpacks its whole Python runtime into a new temp folder on every
// launch, and macOS rescans those unsigned libraries each time: 20-70 s a call, so stream lookups timed out and
// nothing played. The folder build (yt-dlp_macos.zip) is scanned once and then starts in about a second. It lives
// in bin/yt-dlp_macos/ with bin/yt-dlp a symlink to it, so resolveBinary() and every caller stay the same.
const MAC_YTDLP_DIR = path.join(BIN_DIR, 'yt-dlp_macos');
const MAC_YTDLP_EXE = path.join(MAC_YTDLP_DIR, 'yt-dlp_macos');

function ytDlpAsset() {
  const a = process.arch;
  if (IS_WIN) return a === 'arm64' ? 'yt-dlp_arm64.exe' : a === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos.zip';
  return a === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ffmpegAsset() {
  const a = process.arch === 'arm64' ? 'arm64' : '64';
  if (IS_WIN) return { name: `ffmpeg-master-latest-win${a}-gpl.zip` };
  if (process.platform === 'linux') return { name: `ffmpeg-master-latest-linux${a}-gpl.tar.xz` };
  return null;
}

// Without a timeout a stalled download kept the status at 'downloading' forever, and ensureTools()
// refuses to start again while it says that. 60s without a single byte counts as failed.
function get(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Muriel' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    // destroying the request also errors a response that is already being read (downloadFile/getText)
    req.on('timeout', () => req.destroy(new Error(`Download stalled: ${url}`)));
  });
}

async function getText(url) {
  const res = await get(url);
  let out = '';
  res.setEncoding('utf8');
  for await (const chunk of res) out += chunk;
  return out;
}

async function downloadFile(url, dest) {
  const res = await get(url);
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on('data', (c) => {
      hash.update(c);
      done += c.length;
      if (total) state.percent = Math.round((done / total) * 100);
    });
    res.on('error', (e) => { out.destroy(); reject(e); });
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  return hash.digest('hex');
}

function expectedHash(sums, fileName) {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/i);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

function run(cmd, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(t);
      try { logger.error(`${cmd} spawn error`, e); } catch (_) {}
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve();
      } else {
        const lastStderr = (err || '').split('\n').slice(-20).join('\n');
        try { logger.error(`${cmd} exited with ${code}`, new Error(lastStderr)); } catch (_) {}
        reject(new Error(err || `${cmd} exited with ${code}`));
      }
    });
  });
}

function findFile(dir, fileName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, fileName);
      if (hit) return hit;
    } else if (entry.name === fileName) return full;
  }
  return null;
}

async function installYtDlp() {
  const asset = ytDlpAsset();
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const sums = await getText(`${base}/SHA2-256SUMS`);
  const want = expectedHash(sums, asset);
  if (!want) throw new Error(`No checksum published for ${asset}`);
  const target = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const tmp = `${target}.download`;
  const got = await downloadFile(`${base}/${asset}`, tmp);
  if (got !== want) { fs.rmSync(tmp, { force: true }); throw new Error('yt-dlp checksum mismatch'); }
  if (process.platform === 'darwin') return installMacYtDlpDir(tmp, target);
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, target);
}

async function installMacYtDlpDir(archive, target) {
  const work = fs.mkdtempSync(path.join(BIN_DIR, '.yt-dlp-unpack-'));
  try {
    await run('/usr/bin/ditto', ['-x', '-k', archive, work]);
    const exe = path.join(work, 'yt-dlp_macos');
    if (!fs.existsSync(exe)) throw new Error('yt-dlp_macos not found inside the archive');
    fs.chmodSync(exe, 0o755);
    // the first start is slow while macOS scans the bundled libraries: do it now, not in the first stream lookup
    try { await run(exe, ['--version'], 180000); } catch (_) {}
    fs.rmSync(MAC_YTDLP_DIR, { recursive: true, force: true });
    fs.renameSync(work, MAC_YTDLP_DIR);
    fs.rmSync(target, { force: true });
    fs.symlinkSync(MAC_YTDLP_EXE, target);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}

// Earlier versions installed the slow single-file build on macOS: it is swapped for the folder build once.
// A yt-dlp installed some other way (Homebrew, pip) is not in BIN_DIR and is left alone.
function hasSlowMacYtDlp() {
  if (process.platform !== 'darwin') return false;
  try { return fs.lstatSync(path.join(BIN_DIR, 'yt-dlp')).isFile(); } catch (_) { return false; }
}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

async function installFfmpeg() {
  const asset = ffmpegAsset();
  if (!asset) throw new Error('No ffmpeg build for this system. Install ffmpeg with your package manager (for macOS: brew install ffmpeg).');
  const base = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download';
  const sums = await getText(`${base}/checksums.sha256`);
  const want = expectedHash(sums, asset.name);
  if (!want) throw new Error(`No checksum published for ${asset.name}`);
  // a private folder (0700) instead of a fixed name in the shared temp dir, which another local user could
  // create or swap before tar reads it; the hash is checked again on what is actually on disk
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-ffmpeg-dl-'));
  const archive = path.join(dlDir, asset.name);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-ffmpeg-'));
  try {
    const got = await downloadFile(`${base}/${asset.name}`, archive);
    if (got !== want || await sha256OfFile(archive) !== want) throw new Error('ffmpeg checksum mismatch');
    // On Windows, a Git/MSYS GNU tar earlier in PATH reads "C:\..." as host:path and can't open zips;
    // the bsdtar that ships in System32 handles both.
    const tar = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await run(tar, ['-xf', archive, '-C', work]);
    for (const name of ['ffmpeg', 'ffprobe']) {
      const exe = IS_WIN ? `${name}.exe` : name;
      const src = findFile(work, exe);
      if (!src) throw new Error(`${exe} not found inside the archive`);
      const dest = path.join(BIN_DIR, exe);
      fs.copyFileSync(src, dest);
      if (!IS_WIN) fs.chmodSync(dest, 0o755);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dlDir, { recursive: true, force: true });
  }
}

function toolsStatus() {
  return {
    ytDlp: !!resolveBinary('yt-dlp'),
    ffmpeg: !!resolveBinary('ffmpeg'),
    progress: Object.assign({}, state)
  };
}

async function ensureTools() {
  if (state.status === 'downloading') return toolsStatus();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  state.status = 'downloading';
  state.error = '';
  try {
    if (!resolveBinary('yt-dlp') || hasSlowMacYtDlp()) { state.tool = 'yt-dlp'; state.percent = 0; await installYtDlp(); clearBinaryCache(); }
    if (!resolveBinary('ffmpeg')) { state.tool = 'ffmpeg'; state.percent = 0; await installFfmpeg(); clearBinaryCache(); }
    state.status = 'done';
  } catch (e) {
    try { logger.error(`Tool download failed: ${state.tool}`, e); } catch (_) {}
    state.status = 'error';
    state.error = e.message;
  }
  return toolsStatus();
}

async function updateYtDlpIfManaged() {
  const bin = resolveBinary('yt-dlp');
  if (!bin || path.dirname(bin) !== BIN_DIR) return false;
  if (hasSlowMacYtDlp()) {
    try {
      await installYtDlp();
      clearBinaryCache();
      fs.writeFileSync(STAMP, String(Date.now()));
      return true;
    } catch (e) {
      try { logger.error('yt-dlp macOS folder build install failed', e); } catch (_) {}
      return false;
    }
  }
  try {
    const last = Number(fs.readFileSync(STAMP, 'utf8')) || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return false;
  } catch (e) {}
  try {
    // the real file, not the bin/yt-dlp symlink, so the macOS folder build updates in place
    await run(fs.realpathSync(bin), ['-U'], 120000);
    fs.writeFileSync(STAMP, String(Date.now()));
    return true;
  } catch (e) {
    try { logger.error('yt-dlp update failed', e); } catch (_) {}
    return false;
  }
}

module.exports = { ensureTools, toolsStatus, updateYtDlpIfManaged, expectedHash, ytDlpAsset, ffmpegAsset };
