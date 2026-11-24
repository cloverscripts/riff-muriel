// iOS stand-in for ../../platform.js: same exports, paths live in the app's virtual data dir.
const path = require('path');

const DATA_DIR = '/data';
const CACHE_DIR = path.join(DATA_DIR, 'tracks');
const CUSTOM_LYRICS_DIR = path.join(DATA_DIR, 'custom-lyrics');
const LYRICS_DIR = path.join(DATA_DIR, 'lyrics');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const METADATA_PATH = path.join(DATA_DIR, 'metadata.json');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'Downloads');
const STARTUP_PATH = path.join(DATA_DIR, 'startup.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BIN_DIR = path.join(DATA_DIR, 'bin');

const noop = () => {};

// A YouTube song as an HLS playlist URL the app can start playing at once (hls.js, see mobile/hls-loader.js),
// or null when this phone's WebView has no Media Source support (then the song is downloaded first, as before).
async function liveStream(target) {
  const Hls = typeof window !== 'undefined' && window.Hls;
  if (!Hls || !Hls.isSupported() || !globalThis.__murielHlsHeaders) return null;
  const audio = await require('../extract').resolveAudio(target);
  if (audio.kind !== 'hls' || (audio.container && audio.container !== 'aac')) return null;
  globalThis.__murielHlsHeaders.remember(audio.url, audio.headers);
  return audio.url;
}

module.exports = {
  clearBinaryCache: noop,
  IS_WIN: false, DATA_DIR, DEFAULT_DATA_DIR: DATA_DIR, CONFIG_PATH, BIN_DIR, CACHE_DIR, CUSTOM_LYRICS_DIR, LYRICS_DIR,
  THUMBNAILS_DIR, METADATA_PATH, LIBRARY_DIR, LIBRARY_PATH, STARTUP_PATH, DOWNLOADS_DIR,
  findInPath: () => null,
  resolveBinary: (name) => name,
  // the child_process shim recognises this and answers with the in-app YouTube/SoundCloud client
  ytDlpCommand: (args) => ({ bin: 'yt-dlp', args }),
  STREAM_VIA_CACHE: true,
  liveStream,
  tutorialDone: () => true, markTutorialDone: noop,
  readStartupConfig: () => ({}), writeStartupConfig: () => true,
  readConfig: () => ({}), resolveDataDir: () => DATA_DIR, setDataDir: noop,
  resolveDownloadDir: () => DOWNLOADS_DIR, setDownloadDir: noop,
  copyDirContents: noop, removeDirContents: noop,
};
