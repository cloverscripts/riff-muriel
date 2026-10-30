const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const dns = require('dns');
const net = require('net');

const PORT = 38472;
const { DATA_DIR, CACHE_DIR, CUSTOM_LYRICS_DIR, LYRICS_DIR, THUMBNAILS_DIR, METADATA_PATH, LIBRARY_DIR, LIBRARY_PATH, ytDlpCommand, resolveDownloadDir, resolveBinary } = require('./platform');
// iOS can't hand a cross-origin stream to Web Audio, so it plays everything from the disk cache.
const STREAM_VIA_CACHE = !!require('./platform').STREAM_VIA_CACHE;
const logger = require('./logger');
const { getSystemAudioOutputInfo } = require('./audio-output');
const ytmArtist = require('./ytm-artist');
const libraryPages = require('./library-pages');
const recommendCore = require('./recommend-core');
const { createTaskQueue, lowerPriority } = require('./ytdlp-queue');
const { searchSoundcloudApi } = require('./soundcloud-search');
const { copyStreamToCache } = require('./cache-copy');
const streamSource = require('./stream-source');
// request headers yt-dlp would use for each media URL it resolved (#17), for the audio proxy
const streamHeaders = new Map();
function rememberStreamHeaders(url, headers) {
  if (!url || !headers) return;
  streamHeaders.delete(url);
  streamHeaders.set(url, headers);
  while (streamHeaders.size > 200) streamHeaders.delete(streamHeaders.keys().next().value);
}
// MURIEL_DEBUG_YTDLP=1 logs every yt-dlp run with its reason and arguments
const YTDLP_DEBUG = !!process.env.MURIEL_DEBUG_YTDLP;
const AUDIO_PROXY_DEBUG = YTDLP_DEBUG || process.env.MURIEL_DEBUG === '1';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SAFE_MEDIA_URL = /^https?:\/\//i;

function isSafeMediaUrl(value) {
  return typeof value === 'string' && SAFE_MEDIA_URL.test(value);
}

function ipv4IsPrivate(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIp(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const p = address.split('.').map(Number);
    return ipv4IsPrivate(p[0], p[1]);
  }
  if (kind === 6) {
    const w = ipv6Words(address);
    if (!w) return true;
    const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
    if (zeros(0, 8)) return true; // ::
    if (zeros(0, 7) && w[7] === 1) return true; // ::1
    if ((w[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local
    if ((w[0] & 0xff00) === 0xff00) return true; // multicast
    // forms that carry an IPv4 address: ::ffff:a.b.c.d (also written ::ffff:7f00:1), ::a.b.c.d, NAT64 64:ff9b::/96,
    // 6to4 2002:AABB:CCDD::. new URL() normalises [::ffff:127.0.0.1] to [::ffff:7f00:1], which used to pass as public.
    const v4 = (hi) => ipv4IsPrivate(hi >> 8, hi & 255);
    if (zeros(0, 5) && (w[5] === 0xffff || w[5] === 0)) return v4(w[6]);
    if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return v4(w[6]);
    if (w[0] === 0x2002) return v4(w[1]);
    return false;
  }
  return true;
}

// "::ffff:7f00:1" or "::ffff:127.0.0.1" -> eight 16-bit numbers, or null
function ipv6Words(address) {
  let a = String(address).toLowerCase().replace(/%.*$/, '');
  const dotted = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const b = dotted.slice(2).map(Number);
    if (b.some((n) => n > 255)) return null;
    a = `${dotted[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...new Array(fill).fill('0'), ...tail].map((x) => parseInt(x, 16));
  return words.length === 8 && words.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? words : null;
}

function normalizeNumericHost(h) {
  if (/^\d+$/.test(h) && h.length < 11) {
    const n = Number(h);
    if (n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  const hex = h.match(/^0x([0-9a-f]+)$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    if (n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  return null;
}

async function isPrivateHost(hostname) {
  return !(await publicAddressOf(hostname));
}

// The address to connect to for a public host, or null when the host is (or resolves to) anything private.
async function publicAddressOf(hostname) {
  let host = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  const numeric = normalizeNumericHost(host);
  if (numeric) host = numeric;
  if (net.isIP(host)) return isPrivateIp(host) ? null : { address: host, family: net.isIP(host) };
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
    return addrs[0];
  } catch (e) {
    return null;
  }
}

function streamFileToResponse(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) {
      try { res.writeHead(500); } catch (e) {}
      try { res.end('Error reading file'); } catch (e) {}
    } else {
      // the headers already promised a Content-Length: ending normally would leave the client waiting for it
      try { res.destroy(); } catch (e) {}
    }
    try { stream.destroy(); } catch (e) {}
  });
  res.on('close', () => { try { stream.destroy(); } catch (e) {} });
  stream.pipe(res);
}

// Serves an audio file with HTTP Range support. An end past the file is clamped (a Content-Length larger
// than the bytes sent leaves the player waiting forever) and an unsatisfiable range gets a 416.
function sendFileWithRange(req, res, filePath, fileSize, contentType) {
  const range = req.headers.range;
  if (!range || !/^bytes=/i.test(range)) {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    return streamFileToResponse(fs.createReadStream(filePath), res);
  }
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)/i.exec(range);
  let start = m && m[1] ? Number(m[1]) : NaN;
  let end = m && m[2] ? Number(m[2]) : fileSize - 1;
  if (m && !m[1] && m[2]) { // "bytes=-500": the last 500 bytes
    start = Math.max(0, fileSize - Number(m[2]));
    end = fileSize - 1;
  }
  end = Math.min(end, fileSize - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': (end - start) + 1,
    'Content-Type': contentType,
  });
  streamFileToResponse(fs.createReadStream(filePath, { start, end }), res);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// The in-memory caches live as long as the app does; past `max` entries the oldest go first.
function trimCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// A bare fetch() waits up to five minutes on a server that stops answering.
function fetchWithTimeout(target, options = {}, timeoutMs = 15000) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  return fetch(target, signal ? { ...options, signal } : options);
}

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(CUSTOM_LYRICS_DIR)) fs.mkdirSync(CUSTOM_LYRICS_DIR, { recursive: true });
if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });

// library.json and metadata.json used to be rewritten in place: a crash halfway left half a file, the next
// start read that as empty and the next save wiped the index. On desktop the new file is written beside the
// old one and swapped in. Phones keep the plain write (their file store's rename onto an existing file is
// not something to rely on); there the write goes through an in-memory copy first anyway.
const SWAP_WRITES = !(process.versions && process.versions.mobile);

function writeJsonFile(file, value) {
  const text = JSON.stringify(value, null, 2);
  if (!SWAP_WRITES) return fs.writeFileSync(file, text, 'utf-8');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows refuses the swap while something (a virus scanner) holds the file: write it directly
    fs.writeFileSync(file, text, 'utf-8');
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) {
    // move the unreadable file aside (once): the next save would otherwise overwrite the only copy
    try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch (_) {}
    return {};
  }
}

let trackMetadataIndex = readJsonFile(METADATA_PATH);

// The SoundCloud fallback used to cache 30-second previews as the whole song (see soundcloudFallback), and a
// cached song plays from disk from then on. Drop those, so the song is looked up again.
function dropCachedPreviews() {
  let changed = false;
  for (const [id, m] of Object.entries(trackMetadataIndex)) {
    if (!m || m.platform !== 'soundcloud') continue;
    const want = Number(m.duration) || 0;
    const size = Number(m.fileSize) || 0;
    // a full song is about 16 KB a second (128 kbps); a 30-second preview of a 3-minute one is a sixth of that
    if (want < 60 || !size || size > want * 16000 * 0.6) continue;
    for (const ext of ['.opus', '.webm', '.m4a', '.mp3', '.aac']) {
      try { fs.unlinkSync(path.join(CACHE_DIR, `${id}${ext}`)); } catch (e) {}
    }
    delete trackMetadataIndex[id];
    changed = true;
  }
  if (changed) try { writeJsonFile(METADATA_PATH, trackMetadataIndex); } catch (e) {}
}
try { dropCachedPreviews(); } catch (e) {}

function saveTrackMetadata(cleanId, meta) {
  // "__proto__" survives cleanTrackId and would swap the index's prototype instead of adding an entry
  if (!cleanId || cleanId === '__proto__') return;
  trackMetadataIndex[cleanId] = {
    ...(trackMetadataIndex[cleanId] || {}),
    ...meta,
    lastPlayed: Date.now()
  };
  try {
    writeJsonFile(METADATA_PATH, trackMetadataIndex);
  } catch (e) {}
}

let libraryIndex = readJsonFile(LIBRARY_PATH);

function saveLibraryIndex() {
  try {
    writeJsonFile(LIBRARY_PATH, libraryIndex);
  } catch (e) {}
}

const searchCache = new Map();
const streamUrlCache = new Map();
const lyricsCache = new Map();
const artistCache = new Map();
const vibeCache = new Map();
const ytArtistCache = new Map();
const downloadingSet = new Set();
const downloadingPromises = new Map(); // cleanId -> promise of the running download, so callers can wait on it
const prefetchingSet = new Set();
const downloadInFlight = new Map();
const downloadProcs = new Map(); // cleanId -> the yt-dlp process caching it (phones cancel it on skip)

// Search results go stale (isCached flags, new uploads) and every query adds a key, so they expire after
// five minutes and the cache keeps at most 500 of them.
function cacheSearchResult(key, value, ttlMs = 300000) {
  searchCache.set(key, value);
  const timer = setTimeout(() => { if (searchCache.get(key) === value) searchCache.delete(key); }, ttlMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  trimCache(searchCache, 500);
}

let currentAppState = {};
const sseClients = new Set();

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function cleanTrackId(id) {
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// YouTube Music tracks (platform 'ytmusic', music.youtube.com URLs) are the same videos as on youtube.com.
// Given to yt-dlp as music.youtube.com links without our player clients they hit YouTube Music's web client,
// whose media URLs answer "HTTP Error 403: Forbidden" on many desktops (#18). Extract every YouTube-family
// track from a plain youtube.com watch URL with the same clients the YouTube source uses.
const YT_PLAYER_CLIENTS = 'youtube:player_client=default,android';
const YT_RETRY_CLIENTS = 'youtube:player_client=tv,web_safari,android_vr';
function youtubeVideoId(trackUrl) {
  try {
    const u = new URL(trackUrl);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return u.searchParams.get('v') || '';
  } catch (_) {}
  return '';
}
function youtubeExtractTarget(trackUrl, trackId, platform) {
  const fromUrl = trackUrl ? youtubeVideoId(trackUrl) : '';
  const isYt = platform === 'youtube' || platform === 'ytmusic' || !!fromUrl;
  if (!isYt) return { url: trackUrl, youtube: false };
  const id = cleanTrackId(fromUrl || trackId);
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return { url: trackUrl, youtube: platform === 'youtube' };
  return { url: `https://www.youtube.com/watch?v=${id}`, youtube: true };
}

async function findCachedFile(trackId) {
  const cleanId = cleanTrackId(trackId);
  const extensions = ['.opus', '.webm', '.m4a', '.mp3', '.aac'];
  for (const ext of extensions) {
    const filePath = path.join(CACHE_DIR, `${cleanId}${ext}`);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 60000) {
        const now = new Date();
        try {
          await fs.promises.utimes(filePath, now, now);
        } catch (e) {}
        return filePath;
      }
    } catch (e) {}
  }
  return null;
}

async function pruneDiskCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const now = Date.now();
    for (const file of files) {
      const fullPath = path.join(CACHE_DIR, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (file.includes('.temp.')) {
          if (now - stat.mtimeMs > 10 * 60 * 1000) {
            await fs.promises.unlink(fullPath);
          }
          continue;
        }
        if (stat.size < 1000) {
          await fs.promises.unlink(fullPath);
          continue;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn('Prune cache error:', e);
  }
}

pruneDiskCache();

function parseDurationSeconds(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function isSpamOrUnofficial(title, duration, channelName = '') {
  if (duration && (duration < 90 || duration > 420)) return true;

  const t = (title || '').toLowerCase();
  const c = (channelName || '').toLowerCase();
  const combined = `${t} ${c}`;

  const nonMusicWordPatterns = [
    /\blecture\b/i,
    /\btalk\b/i,
    /\bconversation\b/i,
    /\bin conversation\b/i,
    /\bacademy\b/i,
    /\bmasterclass\b/i,
    /\bdocumentary\b/i,
    /\bbehind the scenes\b/i,
    /\bmaking of\b/i,
    /\bexplained\b/i,
    /\bhistory of\b/i,
    /\bhow to\b/i,
    /\bnews\b/i,
    /\blive stream\b/i,
    /\blivestream\b/i,
    /\bfull concert\b/i,
    /\bfull set\b/i,
    /\blive at\b/i,
    /\bofficial video essay\b/i
  ];
  if (nonMusicWordPatterns.some(pat => pat.test(combined))) return true;

  const nonMusicPatterns = [
    /\bepisode\s*\d+/i,
    /\bseason\s*\d+/i,
    /\bs\d+e\d+\b/i,
    /\bep\s*\.?\s*\d+\b/i,
    /\bseries\b/i,
    /\btrailer\b/i,
    /\bteaser\b/i,
    /\bfull movie\b/i,
    /\bshort film\b/i,
    /\bpodcast\b/i,
    /\bgameplay\b/i,
    /\bwalkthrough\b/i,
    /\bplaythrough\b/i,
    /\breview\b/i,
    /\breaction\b/i,
    /\binterview\b/i,
    /\baudiobook\b/i,
    /\bvlog\b/i,
    /\bunboxing\b/i,
    /\btutorial\b/i,
    /\bparody\b/i
  ];
  if (nonMusicPatterns.some(pat => pat.test(combined))) return true;

  const badKeywords = [
    '1 hour', '2 hours', '10 hours', 'hour loop', 'hours loop',
    'full album', 'discography', 'ost compilation', 'soundtrack compilation',
    'playlist mix', 'dj set', 'type beat', 'slowed + reverb', 'slowed down',
    'sped up', 'bass boosted', 'nightcore', 'reaction to', 'reacting to'
  ];
  if (badKeywords.some(bad => combined.includes(bad))) return true;

  return false;
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function getTrackNormalizedKey(artist, title) {
  let a = String(artist || '').toLowerCase();
  let t = String(title || '').toLowerCase();
  t = t.replace(/\s*\([^)]*official[^)]*\)/gi, '')
       .replace(/\s*\[[^\]]*\]/gi, '')
       .replace(/\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)/gi, '');
  t = t.replace(/\s*(feat\.?|ft\.?)\s+[^(\[-]+/gi, '')
       .replace(/\s*\((feat\.?|ft\.?)[^)]*\)/gi, '');
  a = a.replace(/\s*(feat\.?|ft\.?)\s+.*$/gi, '');
  a = a.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return `${a}::${t}`;
}

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const title = String(track.title || '').trim();
  const artist = String(track.artist || '').trim();
  const id = String(track.id || track.url || `${artist.toLowerCase()}:${title.toLowerCase()}`).trim();
  if (!id && !title) return null;
  return {
    id,
    title: title || 'untitled',
    artist: artist || 'unknown artist',
    duration: Number(track.duration) || 0,
    thumbnail: track.thumbnail || '',
    url: track.url || '',
    platform: track.platform || 'soundcloud',
    searchQuery: track.searchQuery || ''
  };
}

function normalizeArtistName(name) {
  return String(name || '')
    .replace(/\b(official|vevo|records|topic)\b/gi, '')
    .replace(/[^\w\s&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function trackFingerprint(track) {
  const clean = normalizeTrack(track);
  if (!clean) return '';
  return getTrackNormalizedKey(clean.artist, clean.title);
}

const recentlyRecommendedTrackIds = new Set();
const recentlyRecommendedKeys = new Set();

// The SoundCloud web client's public client_id, read from soundcloud.com's script bundles (it rotates now and then).
let scClientIdCache = { id: '', at: 0 };
async function soundcloudClientId(html) {
  if (scClientIdCache.id && Date.now() - scClientIdCache.at < 6 * 3600 * 1000) return scClientIdCache.id;
  const page = html || await fetchWithTimeout('https://soundcloud.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000).then((r) => r.text());
  const scripts = [...page.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((x) => x[1]).reverse();
  for (const s of scripts) {
    try {
      const m = (await fetchWithTimeout(s, {}, 8000).then((r) => r.text())).match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,})["']/);
      if (m) { scClientIdCache = { id: m[1], at: Date.now() }; return m[1]; }
    } catch (_) {}
  }
  throw new Error('SoundCloud client id not found');
}

// Whether SoundCloud streams a track in a form that can be played here: many major-label songs are only
// offered encrypted (DRM; yt-dlp: "This video is DRM protected") or as a 30-second Go+ preview.
function soundcloudTrackPlayable(t) {
  if (!t || t.policy === 'SNIP' || t.policy === 'BLOCK') return false;
  const list = (t.media && t.media.transcodings) || [];
  return list.some((x) => x && !x.snipped && x.format && (x.format.protocol === 'progressive' || x.format.protocol === 'hls'));
}

// Of these SoundCloud track ids, the ones that can be played; null when SoundCloud couldn't be asked
// (then nothing is left out: a song that fails still falls back to YouTube when played).
async function soundcloudPlayableIds(ids) {
  if (!ids.length) return new Set();
  try {
    const cid = await soundcloudClientId();
    const items = await fetchWithTimeout(`https://api-v2.soundcloud.com/tracks?ids=${ids.slice(0, 50).join(',')}&client_id=${cid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000).then((r) => (r.ok ? r.json() : null));
    if (!Array.isArray(items)) return null;
    return new Set(items.filter(soundcloudTrackPlayable).map((t) => String(t.id)));
  } catch (_) {
    return null;
  }
}

// SoundCloud search without a yt-dlp process (#17): SoundCloud's api first, yt-dlp's scsearch only when that
// fails. Resolves to the flat-search JSON yt-dlp would print ({ entries }).
async function soundcloudFlatSearch(query, limit, priority, reason) {
  try {
    const entries = await searchSoundcloudApi(query, limit, {
      fetch: (u) => fetchWithTimeout(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000),
      clientId: () => soundcloudClientId(),
      resetClientId: () => { scClientIdCache = { id: '', at: 0 }; },
    });
    return { entries };
  } catch (e) {
    try { logger.log('warn', `SoundCloud api search failed, using yt-dlp: ${String(e && e.message || e).slice(0, 200)}`); } catch (_) {}
  }
  const raw = await executeYtDlp([`scsearch${limit}:${query}`, '--dump-single-json', '--flat-playlist', '--skip-download', '--no-warnings'], 18000, { priority, reason });
  return JSON.parse(raw);
}

async function searchSoundcloud(query, limit = 14, priority = 'normal') {
  const cacheKey = `sc:${limit}:${String(query || '').trim().toLowerCase()}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const searchPromise = (async () => {
    try {
      const data = await soundcloudFlatSearch(query, limit, priority, 'soundcloud-search');
      let entries = (data.entries || []).map((item) => {
        let thumbnail = '';
        if (item.thumbnails && item.thumbnails.length > 0) {
          thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
        } else if (item.thumbnail) {
          thumbnail = item.thumbnail;
        }

        const cleanTitle = (item.title || 'untitled');
        const cleanArtist = (item.uploader || item.channel || item.artist || 'unknown artist');
        const trackUrl = item.webpage_url || item.url || '';

        return {
          id: String(item.id || Math.random().toString(36).substring(2)),
          title: cleanTitle,
          artist: cleanArtist,
          duration: item.duration || 0,
          thumbnail: thumbnail,
          url: trackUrl,
          platform: 'soundcloud',
          playable: item.playable === true
        };
      // SoundCloud Go+ previews (always exactly 30 s) only ever play the first 30 seconds
      }).filter((t) => !(t.duration >= 29.5 && t.duration <= 30.5));
      // yt-dlp's search doesn't say which songs are DRM-only and can never play; ask SoundCloud
      // (the phone build's search already checked, and marks its results playable)
      const unknown = entries.filter((t) => !t.playable && /^\d+$/.test(t.id)).map((t) => t.id);
      const ok = unknown.length ? await soundcloudPlayableIds(unknown) : null;
      entries = entries.filter((t) => !ok || !unknown.includes(t.id) || ok.has(t.id)).map(({ playable, ...t }) => t);

      if (entries.length > 0) {
        cacheSearchResult(cacheKey, entries);
      } else if (searchCache.get(cacheKey) === searchPromise) {
        searchCache.delete(cacheKey);
      }
      return entries;
    } catch (err) {
      if (searchCache.get(cacheKey) === searchPromise) {
        searchCache.delete(cacheKey);
      }
      return [];
    }
  })();
  searchCache.set(cacheKey, searchPromise);
  return searchPromise;
}

function buildDiscoveryQueries(profile) {
  const artists = (profile.topArtists || []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
  const shuffled = [...artists].sort(() => Math.random() - 0.5);
  const queries = [];

  if (shuffled.length > 0) {
    queries.push(shuffled[0]);
    if (shuffled.length > 1) {
      queries.push(shuffled[1]);
    }
  }

  if (profile.dominantScript === 'Cyrillic' && shuffled.length > 0) {
    queries.push(`${shuffled[0]} похожие песни`);
  }

  if (queries.length === 0) {
    queries.push('synthwave chill', 'indie electronic');
  }

  return queries;
}

function scoreDiscoveryCandidate(track, profile, heardKeys, heardIds) {
  const normalized = normalizeTrack(track);
  if (!normalized) return null;
  const key = getTrackNormalizedKey(normalized.artist, normalized.title);
  if (!normalized.url || !normalized.id) return null;

  if (heardIds.has(normalized.id) || (key && heardKeys.has(key))) return null;
  if (recentlyRecommendedTrackIds.has(normalized.id) || (key && recentlyRecommendedKeys.has(key))) return null;
  if (isSpamOrUnofficial(normalized.title, normalized.duration, normalized.artist)) return null;

  let score = 1.0;

  if (/-\s*topic$/i.test(normalized.artist || '')) {
    score += 1.5;
  }

  if (/^.+?\s+-\s+.+$/.test(normalized.title || '')) {
    score += 1.0;
  }

  const candArtist = normalizeArtistName(normalized.artist);
  const artistNames = (profile.topArtists || []).map(a => typeof a === 'string' ? a : a.name);
  if (artistNames.some(a => candArtist.includes(a) || a.includes(candArtist))) {
    score += 3.0;
  }

  const isCyrillic = /[\u0400-\u04FF]/.test(normalized.title);
  if (profile.dominantScript === 'Cyrillic' && isCyrillic) {
    score += 2.0;
  } else if (profile.dominantScript !== 'Cyrillic' && !isCyrillic) {
    score += 1.0;
  }

  if (normalized.duration > 0 && profile.typicalDuration > 0) {
    const delta = Math.abs(normalized.duration - profile.typicalDuration);
    score += Math.max(0, 2.0 - (delta / 60));
  }

  score += Math.random() * 1.5;

  return {
    ...normalized,
    score
  };
}

async function httpGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.get(url, { headers: { 'User-Agent': 'Muriel' }, timeout: timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve(null);
        }
        // a connection dropped mid-body fires neither 'end' nor 'timeout', only this
        res.on('error', () => resolve(null));
        let data = '';
        let bytesRead = 0;
        res.on('data', chunk => {
          bytesRead += chunk.length;
          if (bytesRead > 1024 * 1024) {
            res.destroy();
            return resolve(null);
          }
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => {
        resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const dzArtistIdCache = new Map();

async function dzArtistId(name) {
  if (!name || typeof name !== 'string') return null;
  const clean = normalizeArtistName(name);
  if (!clean) return null;
  const cached = dzArtistIdCache.get(clean);
  if (cached && Date.now() < cached.expires) {
    return cached.id;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const lookupPromise = (async () => {
    try {
      const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name.trim())}&limit=1`;
      const data = await httpGetJson(url, 6000);
      const id = data?.data?.[0]?.id ? String(data.data[0].id) : null;
      // a failed request also lands here as null: retry that after 10 minutes, not a day
      dzArtistIdCache.set(clean, { id, expires: Date.now() + (data ? 24 * 3600 * 1000 : 10 * 60 * 1000) });
      trimCache(dzArtistIdCache, 500);
      return id;
    } catch (_) {
      if (dzArtistIdCache.get(clean)?.promise === lookupPromise) {
        dzArtistIdCache.delete(clean);
      }
      return null;
    }
  })();
  dzArtistIdCache.set(clean, { promise: lookupPromise, expires: 0 });
  return lookupPromise;
}

async function dzRelatedTracks(artist) {
  try {
    const id = await dzArtistId(artist);
    if (!id) return [];
    const relUrl = `https://api.deezer.com/artist/${encodeURIComponent(id)}/related?limit=12`;
    const relData = await httpGetJson(relUrl, 6000);
    const relatedList = (relData?.data || []).slice(0, 6);
    if (relatedList.length === 0) return [];

    const tracksNested = await Promise.all(relatedList.map(async (relArtist, relatedIndex) => {
      try {
        if (!relArtist?.id) return [];
        const topUrl = `https://api.deezer.com/artist/${encodeURIComponent(relArtist.id)}/top?limit=4`;
        const topData = await httpGetJson(topUrl, 6000);
        const topTracks = topData?.data || [];
        const match = 1 - (relatedIndex / 12) * 0.6;
        return topTracks.map(item => ({
          artist: item.artist?.name || relArtist.name || 'unknown artist',
          title: item.title || 'untitled',
          match,
          source: 'deezer'
        }));
      } catch (_) {
        return [];
      }
    }));
    return tracksNested.flat();
  } catch (_) {
    return [];
  }
}

async function dzRadioTracks(artist) {
  try {
    const id = await dzArtistId(artist);
    if (!id) return [];
    const radUrl = `https://api.deezer.com/artist/${encodeURIComponent(id)}/radio?limit=25`;
    const radData = await httpGetJson(radUrl, 6000);
    const items = radData?.data || [];
    return items.map(item => ({
      artist: item.artist?.name || 'unknown artist',
      title: item.title || 'untitled',
      match: 0.7,
      source: 'deezer'
    }));
  } catch (_) {
    return [];
  }
}

const ytMixCache = new Map();

async function ytMixTracks(seed) {
  if (!seed || seed.platform !== 'youtube') return [];
  let id = cleanTrackId(seed.id || '');
  if (id.length > 11 && (id.startsWith('yt_') || id.startsWith('youtube_'))) {
    id = id.replace(/^(yt_|youtube_)/, '');
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return [];

  const cached = ytMixCache.get(id);
  if (cached && Date.now() < cached.expires) {
    return cached.tracks;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const lookupPromise = (async () => {
    try {
      const args = [
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--playlist-end',
        '25',
        '--extractor-args',
        'youtube:player_client=android',
        `https://www.youtube.com/watch?v=${id}&list=RD${id}`
      ];
      const raw = await executeYtDlp(args, 25000, { reason: 'recommend-mix' });
      const data = JSON.parse(raw);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      const results = [];

      entries.forEach((entry, index) => {
        if (!entry || !entry.id || entry.id === id) return;
        const duration = Number(entry.duration) || 0;
        if (duration > 480) return;
        const artist = entry.uploader || entry.channel || 'unknown artist';
        const title = entry.title || 'untitled';
        if (isSpamOrUnofficial(title, duration, artist)) return;

        let thumbnail = '';
        if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
          thumbnail = entry.thumbnails[entry.thumbnails.length - 1].url || '';
        } else if (entry.thumbnail) {
          thumbnail = entry.thumbnail;
        }

        results.push({
          id: entry.id,
          title,
          artist,
          duration,
          thumbnail,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
          platform: 'youtube',
          isCached: false,
          match: 1 - (index / 25) * 0.5,
          source: 'ytmix',
          playable: true
        });
      });

      ytMixCache.set(id, { expires: Date.now() + 30 * 60 * 1000, tracks: results });
      trimCache(ytMixCache, 200);
      return results;
    } catch (_) {
      if (ytMixCache.get(id)?.promise === lookupPromise) {
        ytMixCache.delete(id);
      }
      return [];
    }
  })();
  ytMixCache.set(id, { expires: 0, promise: lookupPromise });
  return lookupPromise;
}

// YouTube Music's radio for a song (#19): what it would play next, over plain HTTPS (no yt-dlp, so it works on
// phones too). These are songs, not search results, and play as they are.
const ytmRadioCache = new Map();
function seedVideoId(seed) {
  if (!seed || (seed.platform && seed.platform !== 'youtube' && seed.platform !== 'ytmusic')) return '';
  const id = cleanTrackId(String(seed.id || '')).replace(/^(yt_|youtube_)/, '');
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
}
async function ytmRadioTracks(seed) {
  const id = seedVideoId(seed);
  if (!id) return [];
  const cached = ytmRadioCache.get(id);
  if (cached && Date.now() < cached.expires) return cached.tracks;
  if (cached && cached.promise) return cached.promise;
  const lookup = (async () => {
    let tracks = [];
    try {
      const json = await ytmRequest('next', { videoId: id, playlistId: `RDAMVM${id}`, isAudioOnly: true }, 6000);
      const found = recommendCore.parseWatchPlaylist(json, id).slice(0, 30);
      tracks = found.filter((t) => !isSpamOrUnofficial(t.title, t.duration, t.artist)).map((t, index) => ({
        ...t, isCached: false, match: 1 - (index / 30) * 0.5, source: 'ytmradio', playable: true,
      }));
    } catch (_) {}
    // nothing (or a failure): try again in 5 minutes rather than half an hour
    ytmRadioCache.set(id, { expires: Date.now() + (tracks.length ? 30 : 5) * 60 * 1000, tracks });
    trimCache(ytmRadioCache, 200);
    return tracks;
  })();
  ytmRadioCache.set(id, { expires: 0, promise: lookup });
  return lookup;
}

// Last.fm's similar songs (track.getSimilar), with the key Muriel scrobbles with; when Last.fm knows none for the
// song, the top songs of the artists most like this one (artist.getSimilar). Found on YouTube when picked.
const lastfmSimilarCache = new Map();
function lastfmGet(params) {
  const q = new URLSearchParams({ ...params, api_key: LASTFM_API_KEY, format: 'json', autocorrect: '1' });
  return httpGetJson(`https://ws.audioscrobbler.com/2.0/?${q}`, 6000);
}
async function lastfmSimilarTracks(seed) {
  const artist = String((seed && seed.artist) || '').replace(/\s*-\s*Topic$/i, '').trim();
  const title = String((seed && seed.title) || '').trim();
  if (!artist || /unknown artist/i.test(artist)) return [];
  const key = getTrackNormalizedKey(artist, title) || normalizeArtistName(artist);
  const cached = lastfmSimilarCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.tracks;
  if (cached && cached.promise) return cached.promise;
  const lookup = (async () => {
    let tracks = [];
    let reached = false;
    try {
      if (title) {
        const data = await lastfmGet({ method: 'track.getsimilar', artist, track: title, limit: '30' });
        if (data && !data.error) reached = true;
        tracks = recommendCore.parseSimilarTracks(data).map((t) => ({ artist: t.artist, title: t.title, match: 0.5 + t.match * 0.7, source: 'lastfm' }));
      }
      if (tracks.length < 5) {
        const data = await lastfmGet({ method: 'artist.getsimilar', artist, limit: '8' });
        if (data && !data.error) reached = true;
        const similar = recommendCore.parseSimilarArtists(data).slice(0, 5);
        const tops = await Promise.all(similar.map(async (a, i) => {
          const top = await lastfmGet({ method: 'artist.gettoptracks', artist: a.name, limit: '3' }).catch(() => null);
          return recommendCore.parseTopTracks(top, a.name).map((t) => ({ artist: t.artist, title: t.title, match: 0.4 + a.match * 0.5 - i * 0.03, source: 'lastfm' }));
        }));
        tracks.push(...tops.flat());
      }
    } catch (_) {}
    lastfmSimilarCache.set(key, { expires: Date.now() + (reached ? 6 * 3600 : 5 * 60) * 1000, tracks });
    trimCache(lastfmSimilarCache, 300);
    return tracks;
  })();
  lastfmSimilarCache.set(key, { expires: 0, promise: lookup });
  return lookup;
}

async function gatherCandidates(seeds) {
  const seedList = (Array.isArray(seeds) ? seeds : []).slice(0, 4);
  const perSeed = await Promise.all(seedList.map(async (seed) => {
    const weight = Number(seed?.weight) || 1;
    const [radio, similar, dzRel, dzRad] = await Promise.all([
      ytmRadioTracks(seed).catch(() => []),
      lastfmSimilarTracks(seed).catch(() => []),
      dzRelatedTracks(seed?.artist).catch(() => []),
      dzRadioTracks(seed?.artist).catch(() => [])
    ]);
    // the yt-dlp mix only when YouTube Music's radio had nothing (it costs a yt-dlp run, and phones have none)
    const ytmix = radio && radio.length ? [] : await ytMixTracks(seed).catch(() => []);
    const list = [];
    (radio || []).forEach(t => {
      list.push({ ...t, match: (Number(t.match) || 0.7) * 1.4, seedWeight: weight });
    });
    (similar || []).forEach(t => {
      list.push({ ...t, seedWeight: weight });
    });
    (ytmix || []).forEach(t => {
      list.push({ ...t, match: (Number(t.match) || 0.7) * 1.3, seedWeight: weight });
    });
    (dzRel || []).forEach(t => {
      list.push({ ...t, seedWeight: weight });
    });
    (dzRad || []).forEach(t => {
      list.push({ ...t, seedWeight: weight });
    });
    return list;
  }));
  return perSeed.flat();
}

function rankCandidates(cands, profile, heardKeys, avoid, limit = 10) {
  const avoidKeys = avoid?.keys instanceof Set ? avoid.keys : new Set();
  const avoidArtists = avoid?.artists instanceof Set ? avoid.artists : new Set();
  const heardKeySet = heardKeys instanceof Set ? heardKeys : new Set();

  const grouped = new Map();
  for (const c of (cands || [])) {
    const artist = c.artist || '';
    const title = c.title || '';
    const key = getTrackNormalizedKey(artist, title);
    if (!key) continue;
    if (heardKeySet.has(key)) continue;
    if (recentlyRecommendedKeys && recentlyRecommendedKeys.has(key)) continue;
    if (avoidKeys.has(key)) continue;

    const normArtist = normalizeArtistName(artist);
    if (avoidArtists.has(normArtist)) continue;
    // "Queen & David Bowie" when Queen is blocked (library-pages.js)
    if (avoid?.artistNames?.length && libraryPages.isArtistBlocked(avoid.artistNames, artist)) continue;

    const weight = Number(c.seedWeight) || 1;
    const match = Number(c.match) || 0.5;
    const scoreVal = match * weight;

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        title,
        artist,
        normArtist,
        scoreSum: scoreVal,
        sources: new Set([c.source]),
        bestCand: c
      });
    } else {
      const g = grouped.get(key);
      g.scoreSum += scoreVal;
      g.sources.add(c.source);
      if (c.playable && !g.bestCand.playable) {
        g.bestCand = c;
      }
    }
  }

  const topArtistNames = new Set(
    (profile?.topArtists || [])
      .map(a => typeof a === 'string' ? a : a?.name)
      .filter(Boolean)
      .map(normalizeArtistName)
  );
  const isCyrillicProfile = profile?.dominantScript === 'Cyrillic';

  const scoredList = [];
  for (const entry of grouped.values()) {
    let score = entry.scoreSum;
    const isTop = topArtistNames.has(entry.normArtist) || Array.from(topArtistNames).some(a => entry.normArtist.includes(a) || a.includes(entry.normArtist));
    score += isTop ? -0.4 : 0.6;
    if (isCyrillicProfile && /[\u0400-\u04FF]/.test(entry.title)) {
      score += 0.3;
    }
    score += Math.random() * 0.15;

    scoredList.push({
      ...entry.bestCand,
      key: entry.key,
      normArtist: entry.normArtist,
      isTop,
      rankScore: score
    });
  }

  scoredList.sort((a, b) => b.rankScore - a.rankScore);

  const targetCount = (limit || 10) * 2;
  const maxTopCount = Math.max(1, Math.floor(targetCount * 0.3));
  const artistCounts = {};
  let topCount = 0;
  const result = [];

  for (const item of scoredList) {
    const aCount = artistCounts[item.normArtist] || 0;
    if (aCount >= 2) continue;
    if (item.isTop && topCount >= maxTopCount) continue;

    artistCounts[item.normArtist] = aCount + 1;
    if (item.isTop) topCount++;
    result.push(item);
    if (result.length >= targetCount) break;
  }

  return result;
}

const resolvedCache = new Map();

async function resolveCandidate(c) {
  if (!c) return null;
  if (c.playable) {
    const { match, source, seedWeight, playable, key, normArtist, isTop, rankScore, ...clean } = c;
    return clean;
  }

  const key = getTrackNormalizedKey(c.artist, c.title);
  if (!key) return null;

  const cached = resolvedCache.get(key);
  if (cached && Date.now() < cached.expires) {
    return cached.track;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const lookupPromise = (async () => {
    let resolved = null;
    // the song on YouTube Music (a song row, by the same artist and title) first; SoundCloud after
    try {
      const candArtistNorm = normalizeArtistName(c.artist);
      const candTitleNorm = (c.title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (Date.now() >= ytmFailUntil && candArtistNorm && candTitleNorm) {
        const songs = await searchYtmTracks(`${c.artist} ${c.title}`.trim(), 5);
        const hit = (songs || []).find((r) => {
          const rArtistNorm = normalizeArtistName(r.artist || '');
          const rTitleNorm = (r.title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
          return rArtistNorm && rTitleNorm && (rArtistNorm.includes(candArtistNorm) || candArtistNorm.includes(rArtistNorm))
            && (rTitleNorm.includes(candTitleNorm) || candTitleNorm.includes(rTitleNorm));
        });
        if (hit) resolved = { ...hit, isCached: false };
      }
    } catch (_) {}
    if (!resolved) try {
      const candArtistNorm = normalizeArtistName(c.artist);
      const candTitleNorm = (c.title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const query = `${c.artist} ${c.title}`.trim();
      const scResults = await searchSoundcloud(query, 4);

      for (const r of (scResults || [])) {
        const rArtistNorm = normalizeArtistName(r.artist || r.uploader || '');
        const rTitleNorm = (r.title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        const artistMatch = rArtistNorm.includes(candArtistNorm) || candArtistNorm.includes(rArtistNorm);
        const titleMatch = rTitleNorm.includes(candTitleNorm) || candTitleNorm.includes(rTitleNorm);
        if (artistMatch && titleMatch) {
          resolved = normalizeTrack(r);
          break;
        }
      }
    } catch (_) {}

    if (resolvedCache.get(key)?.promise === lookupPromise) {
      if (!resolved && !resolveBinary('yt-dlp')) {
        // yt-dlp isn't installed yet (first run): nothing was really searched, so remember nothing
        resolvedCache.delete(key);
      } else {
        // no match can also be a network blip: keep that for 10 minutes, a real match for a day
        resolvedCache.set(key, { expires: Date.now() + (resolved ? 24 * 3600 * 1000 : 10 * 60 * 1000), track: resolved });
      }
    }
    return resolved;
  })();

  if (resolvedCache.size >= 500) {
    const oldest = resolvedCache.keys().next().value;
    resolvedCache.delete(oldest);
  }
  resolvedCache.set(key, { expires: 0, promise: lookupPromise });
  return lookupPromise;
}

function pickWeightedSeeds(seeds, count = 4) {
  const pool = [...seeds];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((acc, s) => acc + (Number(s.weight) || 1), 0);
    let r = Math.random() * totalWeight;
    let selectedIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= (Number(pool[i].weight) || 1);
      if (r <= 0) {
        selectedIdx = i;
        break;
      }
    }
    picked.push(pool[selectedIdx]);
    pool.splice(selectedIdx, 1);
  }
  return picked;
}

async function recommendVibeTracks(historyTracks, favoriteTracks, platform = 'youtube', limit = 10, clientProfile = null, extra = {}) {
  const normalizedHistory = (historyTracks || []).map(normalizeTrack).filter(Boolean);
  const normalizedFavorites = (favoriteTracks || []).map(normalizeTrack).filter(Boolean);
  const totalUserTracks = normalizedFavorites.length + normalizedHistory.length;
  const hasExtraSeeds = Array.isArray(extra?.seeds) && extra.seeds.length > 0;

  const heardIds = new Set();
  const heardKeys = new Set();
  [...normalizedHistory, ...normalizedFavorites].forEach(track => {
    if (track.id) heardIds.add(track.id);
    const key = getTrackNormalizedKey(track.artist, track.title);
    if (key) heardKeys.add(key);
  });

  const artistCounts = {};
  let cyrillicCount = 0;
  const durations = [];

  [...normalizedFavorites, ...normalizedHistory].forEach(t => {
    if (t.artist && t.artist.trim()) {
      const a = normalizeArtistName(t.artist);
      artistCounts[a] = (artistCounts[a] || 0) + 1;
    }
    if (t.title && /[\u0400-\u04FF]/.test(t.title)) cyrillicCount++;
    if (t.duration > 0) durations.push(t.duration);
  });

  const sortedArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);

  const profile = {
    topArtists: (clientProfile?.topArtists && clientProfile.topArtists.length > 0) ? clientProfile.topArtists : sortedArtists.slice(0, 5),
    dominantScript: clientProfile?.dominantScript || (cyrillicCount > (normalizedFavorites.length + normalizedHistory.length) * 0.35 ? 'Cyrillic' : 'Latin'),
    typicalDuration: clientProfile?.avgDuration || (durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 210),
    trackCount: totalUserTracks
  };

  if (totalUserTracks < 5 && !hasExtraSeeds) {
    return {
      profile,
      tracks: []
    };
  }

  let candidateSeeds = [];
  if (hasExtraSeeds) {
    candidateSeeds = extra.seeds.map(s => ({
      artist: s.artist || '',
      title: s.title || '',
      id: s.id || '',
      platform: s.platform || 'youtube',
      weight: Number(s.weight) || 1
    }));
  } else {
    const seedMap = new Map();
    normalizedFavorites.forEach(t => {
      const k = getTrackNormalizedKey(t.artist, t.title);
      if (k && !seedMap.has(k)) {
        seedMap.set(k, { artist: t.artist, title: t.title, id: t.id, platform: t.platform || 'youtube', weight: 3 });
      }
    });
    normalizedHistory.forEach(t => {
      const k = getTrackNormalizedKey(t.artist, t.title);
      if (k && !seedMap.has(k)) {
        seedMap.set(k, { artist: t.artist, title: t.title, id: t.id, platform: t.platform || 'youtube', weight: 1 });
      }
    });
    candidateSeeds = Array.from(seedMap.values()).slice(0, 8);
  }

  const chosenSeeds = pickWeightedSeeds(candidateSeeds, 4);

  const avoidKeys = new Set(Array.isArray(extra?.avoid?.keys) ? extra.avoid.keys : []);
  const avoidArtists = new Set(
    (Array.isArray(extra?.avoid?.artists) ? extra.avoid.artists : [])
      .map(normalizeArtistName)
      .filter(Boolean)
  );
  const avoidArtistNames = (Array.isArray(extra?.avoid?.artists) ? extra.avoid.artists : []).filter((a) => typeof a === 'string');
  const avoid = { keys: avoidKeys, artists: avoidArtists, artistNames: avoidArtistNames };

  const sortedSeedKeys = chosenSeeds.map(s => getTrackNormalizedKey(s.artist, s.title) || s.id).sort().join('|');
  if (!extra?.refresh && sortedSeedKeys && vibeCache.has(sortedSeedKeys)) {
    const cached = vibeCache.get(sortedSeedKeys);
    if (cached && Date.now() < cached.expires) {
      const filtered = (cached.tracks || []).filter(t => {
        const k = getTrackNormalizedKey(t.artist, t.title);
        return !recentlyRecommendedTrackIds.has(t.id) && (!k || !recentlyRecommendedKeys.has(k));
      });
      if (filtered.length >= limit) {
        return { profile, tracks: filtered.slice(0, limit) };
      }
    }
  }

  let finalTracks = [];
  try {
    const cands = await gatherCandidates(chosenSeeds);
    const ranked = rankCandidates(cands, profile, heardKeys, avoid, limit);
    let rIdx = 0;
    const resolveWorker = async () => {
      while (rIdx < ranked.length && finalTracks.length < limit) {
        const c = ranked[rIdx++];
        try {
          const track = await resolveCandidate(c);
          if (track && !finalTracks.some(t => t.id === track.id)) {
            const k = getTrackNormalizedKey(track.artist, track.title);
            if (!heardIds.has(track.id) && (!k || !heardKeys.has(k)) &&
                !recentlyRecommendedTrackIds.has(track.id) && (!k || !recentlyRecommendedKeys.has(k))) {
              if (finalTracks.length < limit) {
                finalTracks.push(track);
              }
            }
          }
        } catch (_) {}
      }
    };
    const concurrency = Math.min(4, ranked.length);
    if (concurrency > 0) {
      await Promise.all(Array.from({ length: concurrency }, () => resolveWorker()));
    }
  } catch (_) {}

  // a video's title without "Artist - " and "(Official Video)" (recommend-core.js), so it reads like a song
  finalTracks = finalTracks.map((t) => {
    if (!t || t.platform !== 'youtube') return t;
    const named = recommendCore.cleanVideoTitle(t.title, t.artist);
    return named.title === t.title && named.artist === t.artist ? t : { ...t, title: named.title, artist: named.artist };
  });
  // blocked artists and songs (and collaborations of a blocked artist), and anything heard or picked just now
  finalTracks = recommendCore.dropUnwanted(finalTracks, {
    blocks: { artists: avoidArtistNames, songs: [] },
    recentKeys: new Set([...heardKeys, ...avoidKeys]),
    recentIds: heardIds,
    keyOf: (t) => getTrackNormalizedKey(t.artist, t.title),
  });
  if (finalTracks.length > 0) {
    finalTracks.forEach(track => {
      recentlyRecommendedTrackIds.add(track.id);
      const nKey = getTrackNormalizedKey(track.artist, track.title);
      if (nKey) recentlyRecommendedKeys.add(nKey);
      if (recentlyRecommendedTrackIds.size > 100) {
        const first = recentlyRecommendedTrackIds.values().next().value;
        recentlyRecommendedTrackIds.delete(first);
      }
      if (recentlyRecommendedKeys.size > 100) {
        const firstK = recentlyRecommendedKeys.values().next().value;
        recentlyRecommendedKeys.delete(firstK);
      }
    });

    if (sortedSeedKeys) {
      vibeCache.delete(sortedSeedKeys);
      vibeCache.set(sortedSeedKeys, {
        expires: Date.now() + 20 * 60 * 1000,
        tracks: finalTracks
      });
      trimCache(vibeCache, 50);
    }

    return {
      profile,
      tracks: finalTracks
    };
  }

  const queries = [];
  if (profile.topArtists && profile.topArtists.length > 0) {
    queries.push(...buildDiscoveryQueries(profile));
  }
  if (queries.length === 0) {
    queries.push('Top Hits 2025', 'Trending Music', 'Pop Hits');
  }

  const resultsArr = await Promise.all(queries.slice(0, 3).map(q => searchYtmTracks(q, 16)));
  const candidateMap = new Map();
  const allFound = [];

  for (const results of resultsArr) {
    if (Array.isArray(results)) {
      for (const track of results) {
        allFound.push(track);
        const scored = scoreDiscoveryCandidate(track, profile, heardKeys, heardIds);
        if (scored) {
          if (!candidateMap.has(scored.id) || candidateMap.get(scored.id).score < scored.score) {
            candidateMap.set(scored.id, scored);
          }
        }
      }
    }
  }

  if (candidateMap.size < limit) {
    for (const track of allFound) {
      if (!candidateMap.has(track.id)) {
        candidateMap.set(track.id, { ...track, score: 50 });
      }
      if (candidateMap.size >= limit * 2) break;
    }
  }

  let ranked = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);

  const unshown = ranked.filter(t => !recentlyRecommendedTrackIds.has(t.id));
  if (unshown.length >= limit) {
    ranked = unshown;
  }

  const artistTrackCount = {};
  const fallbackTracks = [];
  for (const track of ranked) {
    const a = normalizeArtistName(track.artist);
    if ((artistTrackCount[a] || 0) < 3) {
      artistTrackCount[a] = (artistTrackCount[a] || 0) + 1;
      fallbackTracks.push(track);
      recentlyRecommendedTrackIds.add(track.id);
      const nKey = getTrackNormalizedKey(track.artist, track.title);
      if (nKey) recentlyRecommendedKeys.add(nKey);
      if (recentlyRecommendedTrackIds.size > 100) {
        const first = recentlyRecommendedTrackIds.values().next().value;
        recentlyRecommendedTrackIds.delete(first);
      }
      if (recentlyRecommendedKeys.size > 100) {
        const firstK = recentlyRecommendedKeys.values().next().value;
        recentlyRecommendedKeys.delete(firstK);
      }
      if (fallbackTracks.length >= limit) break;
    }
  }

  if (fallbackTracks.length < limit) {
    for (const track of allFound) {
      if (!fallbackTracks.some(t => t.id === track.id)) {
        fallbackTracks.push(track);
        if (fallbackTracks.length >= limit) break;
      }
    }
  }

  return {
    profile,
    tracks: recommendCore.dropUnwanted(fallbackTracks, {
      blocks: { artists: avoidArtistNames, songs: [] },
      recentKeys: avoidKeys,
      keyOf: (t) => getTrackNormalizedKey(t.artist, t.title),
    })
  };
}

function directYoutubeSearch(query, filterSpam = false) {
  return new Promise((resolve) => {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const req = https.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                          'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 7000
    }, (res) => {
      let html = '';
      const dec = new StringDecoder('utf8');
      res.on('error', () => resolve([]));
      res.on('data', chunk => { html += dec.write(chunk); });
      res.on('end', async () => {
        try {
          const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
          if (!match) return resolve([]);

          const json = JSON.parse(match[1]);
          const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
          const tracks = [];

          for (const section of contents) {
            const items = section.itemSectionRenderer?.contents || [];
            for (const item of items) {
              const v = item.videoRenderer;
              if (v && v.videoId) {
                const vidId = v.videoId;
                const title = (v.title?.runs?.[0]?.text || 'untitled');
                const artist = (v.ownerText?.runs?.[0]?.text || 'unknown artist');
                const artistId = ytmArtist.channelId(v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId);
                const durStr = v.lengthText?.simpleText || '0:00';
                const durSec = parseDurationSeconds(durStr);
                const thumbs = v.thumbnail?.thumbnails || [];
                const thumbnail = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';

                if (filterSpam && isSpamOrUnofficial(title, durSec, artist)) {
                  continue;
                }

                const isCached = await findCachedFile(vidId);
                const isExplicit = libraryPages.isExplicitText(title) || (v.badges || []).some((b) => /explicit/i.test((b.metadataBadgeRenderer && b.metadataBadgeRenderer.label) || ''));

                tracks.push({
                  id: vidId,
                  title: title,
                  artist: artist,
                  artistId,
                  duration: durSec,
                  thumbnail: thumbnail,
                  url: `https://www.youtube.com/watch?v=${vidId}`,
                  platform: 'youtube',
                  isCached: !!isCached,
                  ...(isExplicit ? { isExplicit: true } : {})
                });
              }
            }
          }
          resolve(tracks);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// Every yt-dlp run goes through one queue (#16): each can start a JavaScript runtime at full CPU, so at
// most two run at once (one for background work), a song the listener started goes first, identical
// requests share one run, and background work that failed waits before it is tried again.
// opts.priority: 'play' (someone is waiting on it), 'normal' or 'background'; opts.key dedupes,
// opts.cacheMs remembers the output, opts.reason names the caller in the log.
const ytdlpQueue = createTaskQueue({ limit: 2, backgroundLimit: 1 });

function spawnYtDlp(cmd, priority, reason) {
  const proc = spawn(cmd.bin, cmd.args, { windowsHide: true, env: cmd.env });
  // background runs (and the JS runtime they start, which inherits it) yield to the app and the desktop
  if (priority !== 'play') lowerPriority(proc.pid);
  if (YTDLP_DEBUG) {
    try { logger.log('info', `yt-dlp spawn [${reason || 'unknown'}/${priority}] ${cmd.args.filter((a) => !/^--(no-config|no-warnings|no-playlist)$/.test(a)).join(' ').slice(0, 300)} ${JSON.stringify(ytdlpQueue.stats())}`); } catch (_) {}
  }
  return proc;
}

function executeYtDlp(args, timeoutMs = 25000, opts = {}) {
  const priority = opts.priority || 'normal';
  const queuedAt = Date.now();
  return ytdlpQueue.run(() => {
    const startedAt = Date.now();
    const run = runYtDlpNow(args, timeoutMs, opts, priority);
    // with MURIEL_DEBUG_YTDLP: how long a run waited for its slot and how long it took (#17)
    if (YTDLP_DEBUG) run.then(() => 0, () => 1).then((failed) => { try { logger.log('info', `yt-dlp done [${opts.reason || 'unknown'}/${priority}] waited ${startedAt - queuedAt}ms ran ${Date.now() - startedAt}ms${failed ? ' (failed)' : ''}`); } catch (_) {} });
    return run;
  }, { key: opts.key, priority, cacheMs: opts.cacheMs });
}

function runYtDlpNow(args, timeoutMs, opts, priority) {
  return new Promise((resolve, reject) => {
    const cmd = ytDlpCommand(args);
    const proc = spawnYtDlp(cmd, priority, opts.reason);
    if (opts && typeof opts.onChild === 'function') {
      try { opts.onChild(proc); } catch (_) {}
    }
    let stdout = '';
    let stderr = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let timer = null;
    let timedOut = false;

    if (timeoutMs > 0) {
      // the queue slot is given back once the process has really gone ('close'), not when it is told to
      timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
      }, timeoutMs);
    }

    proc.stdout.on('data', (d) => { stdout += outDecoder.write(d); });
    proc.stderr.on('data', (d) => { stderr += errDecoder.write(d); });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const firstArgs = (args || []).slice(0, 3).join(' ');
        const errSnippet = String(stderr || `code ${code}`).slice(0, 300);
        try { logger.log('error', `yt-dlp failed: ${firstArgs} - ${errSnippet}`); } catch (_) {}
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const firstArgs = (args || []).slice(0, 3).join(' ');
      const errSnippet = String(err && err.message ? err.message : err).slice(0, 300);
      try { logger.log('error', `yt-dlp spawn error: ${firstArgs} - ${errSnippet}`); } catch (_) {}
      reject(err);
    });
  });
}

async function cacheThumbnailToDisk(cleanId, thumbnailUrl) {
  if (!cleanId || !thumbnailUrl || !thumbnailUrl.startsWith('http')) return null;
  const destPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
  if (fs.existsSync(destPath)) return destPath;
  try {
    // the URL comes from the request: never let it point the server at the local network
    const u = new URL(thumbnailUrl);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || await isPrivateHost(u.hostname)) return null;
    const res = await fetchWithTimeout(thumbnailUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 500) {
      await fs.promises.writeFile(destPath, buffer);
      return destPath;
    }
  } catch (e) {}
  return null;
}

// priority: 'play' when the listener is waiting for this song (phones play from the cache), otherwise
// 'background' (caching a song that already plays, or the next one); a background download that failed
// isn't tried again until its backoff has passed
async function downloadTrackToDisk(trackUrl, trackId, platform, meta = {}, priority = 'background', clients = YT_PLAYER_CLIENTS) {
  const cleanId = cleanTrackId(trackId);
  const target = youtubeExtractTarget(trackUrl, trackId, platform);
  trackUrl = target.url;
  if (priority === 'background' && ytdlpQueue.backingOff(`dl:${cleanId}`)) return;
  // a prefetch may already be fetching this song: wait for it instead of reporting it missing
  if (downloadingSet.has(cleanId)) return downloadingPromises.get(cleanId);
  if (await findCachedFile(cleanId)) return;
  if (downloadingSet.has(cleanId)) return downloadingPromises.get(cleanId);
  downloadingSet.add(cleanId);

  const tempPrefix = `${cleanId}.temp.`;
  const tempPath = path.join(CACHE_DIR, `${cleanId}.temp.opus`);
  // the iOS extractor keeps the original container (m4a/mp3), so let it pick the extension
  const outTemplate = STREAM_VIA_CACHE ? path.join(CACHE_DIR, `${tempPrefix}%(ext)s`) : tempPath;

  const args = [
    '--no-config',
    '--no-playlist',
    '--no-warnings',
    '-x',
    '--audio-format', 'opus',
    '--audio-quality', '128K',
    '-o', outTemplate
  ];

  if (target.youtube) args.push('--extractor-args', clients);

  args.push('--', trackUrl);

  if (meta.thumbnail) {
    cacheThumbnailToDisk(cleanId, meta.thumbnail).catch(() => {});
  }

  let cmd;
  try { cmd = ytDlpCommand(args); } catch (e) { downloadingSet.delete(cleanId); try { logger.error('Download command error: ' + (meta.title || trackId), e); } catch (_) {} return; }

  const findTemp = () => {
    if (fs.existsSync(tempPath)) return tempPath;
    try {
      const name = fs.readdirSync(CACHE_DIR).find((f) => f.startsWith(tempPrefix));
      return name ? path.join(CACHE_DIR, name) : null;
    } catch (e) { return null; }
  };

  // until it gets a slot, a skip (phones) cancels the queued download instead of a process
  let cancelled = false;
  let forbidden = false;
  const placeholder = { kill() { cancelled = true; } };
  downloadProcs.set(cleanId, placeholder);
  // the computer already has the URL the song plays from: ffmpeg copies that instead of a second yt-dlp
  // extraction (#17); only when it fails (expired, 403) does yt-dlp run
  const copyFromStream = async () => {
    if (STREAM_VIA_CACHE || cancelled || !meta.streamUrl || !isSafeMediaUrl(meta.streamUrl)) return false;
    const started = Date.now();
    const done = await copyStreamToCache(resolveBinary('ffmpeg'), meta.streamUrl, tempPath, {
      onChild: (proc) => { if (priority !== 'play') lowerPriority(proc.pid); downloadProcs.set(cleanId, proc); },
    }).catch(() => false);
    if (downloadProcs.get(cleanId) !== placeholder) downloadProcs.set(cleanId, placeholder);
    if (YTDLP_DEBUG) { try { logger.log('info', `cache-copy ${cleanId} ${done ? 'ok' : 'failed'} in ${Date.now() - started}ms`); } catch (_) {} }
    if (!done) return false;
    try {
      const stat = await fs.promises.stat(tempPath);
      await fs.promises.rename(tempPath, path.join(CACHE_DIR, `${cleanId}.opus`));
      saveTrackMetadata(cleanId, { id: trackId, title: meta.title || '', artist: meta.artist || '', duration: meta.duration || 0, thumbnail: meta.thumbnail || '', platform: platform || 'youtube', fileSize: stat.size });
    } catch (e) { return false; }
    if (downloadProcs.get(cleanId) === placeholder) downloadProcs.delete(cleanId);
    return true;
  };
  const job = ytdlpQueue.run(() => copyFromStream().then((copied) => (copied ? undefined : new Promise((resolve, reject) => {
    if (cancelled) { if (downloadProcs.get(cleanId) === placeholder) downloadProcs.delete(cleanId); return resolve(); }
    const proc = spawnYtDlp(cmd, priority, 'cache-download');
    downloadProcs.set(cleanId, proc);
    // yt-dlp's reason ("ERROR: ...") goes into the log, so a shared error log says why a song failed
    let errText = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    proc.on('close', async (code) => {
      if (downloadProcs.get(cleanId) === proc) downloadProcs.delete(cleanId);
      const found = findTemp();
      if (code === 0 && found) {
        try {
          const stat = await fs.promises.stat(found);
          if (stat.size > 60000) {
            const outputPath = path.join(CACHE_DIR, `${cleanId}${path.extname(found)}`);
            await fs.promises.rename(found, outputPath);
            saveTrackMetadata(cleanId, {
              id: trackId,
              title: meta.title || '',
              artist: meta.artist || '',
              duration: meta.duration || 0,
              thumbnail: meta.thumbnail || '',
              platform: platform || 'youtube',
              fileSize: stat.size
            });
          } else {
            try { await fs.promises.unlink(found); } catch (e) {}
          }
        } catch (e) {}
      } else {
        const reason = (errText.match(/ERROR:[^\n]*/g) || []).pop();
        try { logger.error('Download failure: ' + (meta.title || trackId) + ' (exit code ' + code + ')' + (reason ? ': ' + reason.slice(0, 300) : '')); } catch (_) {}
        if (found) try { await fs.promises.unlink(found); } catch (e) {}
        forbidden = /HTTP Error 403/i.test(errText);
        // a killed (skipped) download isn't a failure of the song
        if (code !== null) return reject(new Error('download failed'));
      }
      resolve();
    });

    proc.on('error', (err) => {
      try { logger.error('Download spawn error: ' + (meta.title || trackId), err); } catch (_) {}
      reject(err);
    });
  }))), { key: `dl:${cleanId}`, priority }).catch(() => {}).finally(() => { downloadingSet.delete(cleanId); downloadingPromises.delete(cleanId); })
    // YouTube refused the media of these clients: one more go with a different set before giving up
    .then(() => (forbidden && target.youtube && clients !== YT_RETRY_CLIENTS
      ? downloadTrackToDisk(trackUrl, trackId, platform, meta, priority, YT_RETRY_CLIENTS) : undefined));
  downloadingPromises.set(cleanId, job);
  return job;
}

// priority 'normal' for the song that plays next (the app asks near the end of the current one, and it
// should be ready in time), 'background' for guesses such as the top search result
async function prefetchTrack(trackUrl, trackId, platform, meta = null, priority = 'background') {
  let cleanId = cleanTrackId(trackId);
  if (!cleanId && trackUrl && trackUrl.includes('v=')) {
    cleanId = cleanTrackId(trackUrl.split('v=')[1].split('&')[0]);
  }
  const cacheKey = (cleanId || trackUrl || '').toLowerCase();
  if (!cacheKey || prefetchingSet.size > 2) return;
  const isCached = (cleanId && await findCachedFile(cleanId)) || streamUrlCache.has(cacheKey) || (cleanId && streamUrlCache.has(cleanId));
  if (isCached || prefetchingSet.has(cacheKey)) return;
  if (STREAM_VIA_CACHE) {
    // only pre-download songs the app is about to play (it sends their metadata); skip speculative
    // search-result prefetches, which would cost a whole download on mobile data
    if (!cleanId || !meta || !meta.title) return;
    if (platform === 'youtube' && (!trackUrl || !trackUrl.startsWith('http'))) trackUrl = `https://www.youtube.com/watch?v=${cleanId}`;
    prefetchingSet.add(cacheKey);
    try { await downloadTrackToDisk(trackUrl, cleanId, platform, meta, priority); } finally { prefetchingSet.delete(cacheKey); }
    return;
  }
  prefetchingSet.add(cacheKey);

  try {
    const target = youtubeExtractTarget(trackUrl, cleanId, platform);
    trackUrl = target.url;
    if (!isSafeMediaUrl(trackUrl)) return;
    const args = ['--no-config', ...streamSource.LOOKUP_PRINT_ARGS, '--no-warnings', '--no-playlist', '--prefer-free-formats', '-f', 'bestaudio/best'];
    if (target.youtube) args.push('--extractor-args', YT_PLAYER_CLIENTS);
    args.push('--', trackUrl);

    // the same lookup (same arguments and key) as /api/stream-info: if the song is started meanwhile, it waits for this run
    const raw = await executeYtDlp(args, 18000, { key: `g:${trackUrl}`, priority, reason: 'prefetch' });
    const found = streamSource.parseLookup(raw);
    const streamUrl = found.url;
    rememberStreamHeaders(streamUrl, found.headers);

    if (streamUrl) {
      const isHls = streamUrl.includes('.m3u8');
      const data = {
        success: true,
        isLocal: false,
        streamUrl: streamUrl,
        isHls: isHls,
        proxyUrl: withToken(`http://127.0.0.1:${PORT}/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`)
      };
      streamUrlCache.set(cacheKey, { timestamp: Date.now(), data });
      if (cleanId && cleanId !== cacheKey) {
        streamUrlCache.set(cleanId, { timestamp: Date.now(), data });
      }
      trimCache(streamUrlCache, 300);
    }
  } catch (e) {
  } finally {
    prefetchingSet.delete(cacheKey);
  }
}

const YTM_SONGS_PARAMS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
// The "Videos" filter. Where YouTube Music has no song catalogue (it is licensed per country) the Songs
// filter answers "No results" for every query; the official music videos are the next best thing.
const YTM_VIDEOS_PARAMS = 'EgWKAQIQAWoMEAUQEBAEEBUQChAR';
const YTM_ARTISTS_PARAMS = 'EgWKAQIgAWoMEA4QChADEAQQCRAF';
const YTM_CLIENT_VERSION = '1.20250101.01.00';
let ytmFailUntil = 0;
let ytmFailCount = 0;

function ytmSearchRequest(query, params = YTM_SONGS_PARAMS) {
  return ytmRequest('search', { query, params });
}

// one YouTube Music innertube call: 'search', 'browse' (artist pages, playlists) or 'next' (who a video is by)
function ytmRequest(endpoint, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: YTM_CLIENT_VERSION, hl: 'en', gl: 'US' } },
      ...payload
    });
    const req = https.request({
      hostname: 'music.youtube.com',
      path: `/youtubei/v1/${endpoint}?prettyPrint=false`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try { logger.log('warn', `ytmusic ${endpoint} status ${res.statusCode}`); } catch (_) {}
          return reject(new Error(`ytmusic status ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) {
          try { logger.log('warn', `ytmusic ${endpoint} parse error: ${e.message}`); } catch (_) {}
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      try { logger.log('warn', `ytmusic ${endpoint} timeout`); } catch (_) {}
      req.destroy(new Error('ytmusic timeout'));
    });
    req.on('error', (err) => {
      try { logger.log('warn', `ytmusic ${endpoint} error: ${err.message}`); } catch (_) {}
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function parseYtmDuration(text) {
  if (!text || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return 0;
  return text.trim().split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

function parseYtmSongs(json) {
  const out = [];
  const tabs = (json && json.contents && json.contents.tabbedSearchResultsRenderer && json.contents.tabbedSearchResultsRenderer.tabs) || [];
  const sections = (tabs[0] && tabs[0].tabRenderer && tabs[0].tabRenderer.content && tabs[0].tabRenderer.content.sectionListRenderer && tabs[0].tabRenderer.content.sectionListRenderer.contents) || [];
  for (const section of sections) {
    const items = (section && section.musicShelfRenderer && section.musicShelfRenderer.contents) || [];
    for (const wrap of items) {
      const r = wrap && wrap.musicResponsiveListItemRenderer;
      if (!r) continue;
      const cols = r.flexColumns || [];
      const runsOf = (i) => (cols[i] && cols[i].musicResponsiveListItemFlexColumnRenderer && cols[i].musicResponsiveListItemFlexColumnRenderer.text && cols[i].musicResponsiveListItemFlexColumnRenderer.text.runs) || [];
      const overlay = r.overlay && r.overlay.musicItemThumbnailOverlayRenderer && r.overlay.musicItemThumbnailOverlayRenderer.content && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
      const videoId = (r.playlistItemData && r.playlistItemData.videoId) || (overlay && overlay.playNavigationEndpoint && overlay.playNavigationEndpoint.watchEndpoint && overlay.playNavigationEndpoint.watchEndpoint.videoId);
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue;

      const title = runsOf(0).map((x) => x.text).join('').trim();
      const segments = [];
      let cur = [];
      for (const run of runsOf(1)) {
        if (run.text === ' • ') { segments.push(cur.join('').trim()); cur = []; } else cur.push(run.text);
      }
      segments.push(cur.join('').trim());
      const clean = segments.filter((s) => s && !/^(song|video)$/i.test(s));
      let duration = 0;
      if (clean.length && parseYtmDuration(clean[clean.length - 1])) duration = parseYtmDuration(clean.pop());
      const artist = (clean[0] || '').replace(/\s*-\s*Topic$/i, '').trim();
      // the artist's channel: other artists can have the same name
      const artistRun = ytmArtist.artistRuns(runsOf(1))[0];
      const album = clean[1] || '';

      const thumbs = (r.thumbnail && r.thumbnail.musicThumbnailRenderer && r.thumbnail.musicThumbnailRenderer.thumbnail && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || [];
      let thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      thumbnail = thumbnail.replace(/=w\d+-h\d+[^&]*$/, '=w544-h544');

      if (!title || (duration && duration < 30)) continue;
      const isExplicit = ytmArtist.explicitBadge(r) || libraryPages.isExplicitText(title);
      out.push({ id: videoId, title, artist: artist || 'Unknown Artist', artistId: artistRun && artistRun.id, album, duration, thumbnail, ...(isExplicit ? { isExplicit: true } : {}) });
    }
  }
  return out;
}

// Songs first; music videos when the songs search comes back empty
async function searchYtmSongs(query) {
  const songs = parseYtmSongs(await ytmSearchRequest(query));
  if (songs.length) return songs;
  const videos = parseYtmSongs(await ytmSearchRequest(query, YTM_VIDEOS_PARAMS));
  // a video row reads "Artist • 1.2B views • 4:08": the middle part is not an album
  return videos.map((v) => (/\bviews?$/i.test(v.album) ? { ...v, album: '' } : v));
}

async function searchYtmTracks(query, limit = 16) {
  const cacheKey = `ytm_vibe:${limit}:${String(query || '').trim().toLowerCase()}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }
  try {
    const songs = (await searchYtmSongs(query)).slice(0, limit);
    const tracks = songs.map(s => {
      ytArtistCache.set(s.id, s.artist);
      trimCache(ytArtistCache, 2000);
      return {
        id: s.id,
        title: s.title,
        artist: s.artist,
        artistId: s.artistId,
        duration: s.duration || 180,
        thumbnail: s.thumbnail || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${s.id}`,
        platform: 'youtube',
        ...(s.isExplicit ? { isExplicit: true } : {})
      };
    });
    if (tracks.length > 0) {
      cacheSearchResult(cacheKey, tracks);
    }
    return tracks;
  } catch (e) {
    try {
      const dy = await directYoutubeSearch(query, true);
      return (dy || []).slice(0, limit).map(t => ({
        ...t,
        platform: 'youtube'
      }));
    } catch (_) {
      return [];
    }
  }
}

async function handleSearch(req, res, query, platform = 'youtube', limit = 20) {
  const cacheKey = `${platform}:${query}:${limit}`;
  while (true) {
    const cached = searchCache.get(cacheKey);
    if (cached === undefined) break;
    if (cached?.promise instanceof Promise) {
      const outcome = await cached.promise;
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(outcome.body));
    }
    if (searchCache.has(cacheKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(cached));
    }
  }

  let resolveSearchOutcome;
  const searchOutcome = new Promise(resolve => { resolveSearchOutcome = resolve; });
  const cacheEntry = { promise: searchOutcome };
  searchCache.set(cacheKey, cacheEntry);
  let responseOutcome = null;
  const sendResponse = (status, body) => {
    responseOutcome = { status, body };
    resolveSearchOutcome(responseOutcome);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  };
  try {
  if (platform === 'youtube') {
    try {
      const directTracks = await directYoutubeSearch(query);
      if (directTracks && directTracks.length > 0) {
        const result = { success: true, tracks: directTracks.slice(0, limit) };
        cacheSearchResult(cacheKey, result);

        setTimeout(() => {
          if (directTracks[0] && directTracks[0].url) {
            prefetchTrack(directTracks[0].url, directTracks[0].id, 'youtube').catch(() => {});
          }
        }, 100);

        return sendResponse(200, result);
      }
    } catch (e) {}
  }

  if (platform === 'ytmusic') {
    if (Date.now() >= ytmFailUntil) {
      try {
        const songs = (await searchYtmSongs(query)).slice(0, limit);
        if (songs.length > 0) {
          ytmFailCount = 0;
          const entries = await Promise.all(songs.map(async (s) => {
            ytArtistCache.set(s.id, s.artist);
            trimCache(ytArtistCache, 2000);
            const isCached = await findCachedFile(s.id);
            return { id: s.id, title: s.title, artist: s.artist, artistId: s.artistId, duration: s.duration, thumbnail: s.thumbnail, url: `https://www.youtube.com/watch?v=${s.id}`, platform: 'youtube', isCached: !!isCached, ...(s.isExplicit ? { isExplicit: true } : {}) };
          }));
          const result = { success: true, tracks: entries };
          cacheSearchResult(cacheKey, result);
          setTimeout(() => {
            if (entries[0] && entries[0].url) prefetchTrack(entries[0].url, entries[0].id, 'youtube').catch(() => {});
          }, 60);
          return sendResponse(200, result);
        } else {
          ytmFailCount++;
          if (ytmFailCount >= 3) {
            ytmFailUntil = Date.now() + 5 * 60 * 1000;
            try { logger.log('warn', 'ytmusic circuit breaker tripped (3 failures), backing off 5m'); } catch (_) {}
          }
        }
      } catch (e) {
        ytmFailCount++;
        if (ytmFailCount >= 3) {
          ytmFailUntil = Date.now() + 5 * 60 * 1000;
          try { logger.log('warn', 'ytmusic circuit breaker tripped (3 failures), backing off 5m'); } catch (_) {}
        }
      }
    }

    try {
      const args = ['--flat-playlist', '--playlist-end', String(limit), '-J', `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`];
      const raw = await executeYtDlp(args, 25000, { priority: 'play', reason: 'search-ytmusic' });
      const data = JSON.parse(raw);
      const rawEntries = (data.entries || []).filter((item) => item && /^[\w-]{11}$/.test(String(item.id || '')) && item.live_status !== 'is_live' && !(item.duration && (item.duration < 30 || item.duration > 1200)) && !/\b(advert(isement)?|sponsored|ad)\b|реклама/i.test(item.title || '')).slice(0, limit);

      function extractArtist(item) {
        let a = '';
        if (Array.isArray(item.artists) && item.artists.length > 0) a = item.artists.join(', ');
        else if (item.artist) a = item.artist;
        else if (item.creator) a = item.creator;
        else if (item.channel) a = item.channel;
        else if (item.uploader) a = item.uploader;
        return a ? a.replace(/\s*-\s*Topic$/i, '').trim() : '';
      }

      const toFetch = [];
      for (let i = 0; i < Math.min(20, rawEntries.length); i++) {
        const item = rawEntries[i];
        const flatA = extractArtist(item);
        if (flatA) {
          item._artist = flatA;
        } else if (ytArtistCache.has(item.id)) {
          item._artist = ytArtistCache.get(item.id);
        } else {
          toFetch.push(item);
        }
      }

      if (toFetch.length > 0) {
        let fIdx = 0;
        const fetchWorker = async () => {
          while (fIdx < toFetch.length) {
            const item = toFetch[fIdx++];
            try {
              // only the metadata is needed: skipping the player JS keeps the JS runtime from starting
              const out = await executeYtDlp([
                '--skip-download',
                '--no-playlist',
                '--ignore-no-formats-error',
                '--extractor-args',
                'youtube:player_skip=js',
                '--print',
                '%(artist,artists.0,channel,uploader)s',
                `https://www.youtube.com/watch?v=${item.id}`
              // 'normal', not 'play': up to 20 of these per search must not hold up a song the listener clicks (#17)
              ], 10000, { priority: 'normal', key: `artist:${item.id}`, reason: 'search-artist' });
              const lines = (out || '').split('\n').map(s => s.trim()).filter(s => s && s !== 'NA');
              if (lines.length > 0) {
                const val = lines[0].replace(/\s*-\s*Topic$/i, '').trim();
                if (val) {
                  item._artist = val;
                  ytArtistCache.set(item.id, val);
                  trimCache(ytArtistCache, 2000);
                }
              }
            } catch (e) {}
          }
        };
        const workers = Array.from({ length: Math.min(5, toFetch.length) }, () => fetchWorker());
        await Promise.all(workers);
      }

      const entries = await Promise.all(rawEntries.map(async (item) => {
        let thumbnail = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
        if (item.thumbnails && item.thumbnails.length > 0) {
          thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
        } else if (item.thumbnail) {
          thumbnail = item.thumbnail;
        }
        let titleVal = item.title || 'untitled';
        let artistVal = item._artist || ytArtistCache.get(item.id) || extractArtist(item) || '';
        if (!artistVal && titleVal.includes(' - ')) {
          const parts = titleVal.split(' - ');
          artistVal = parts[0].trim();
          titleVal = parts.slice(1).join(' - ').trim() || titleVal;
        }
        if (!artistVal) artistVal = 'Unknown Artist';
        const isCached = await findCachedFile(item.id);
        return {
          id: String(item.id),
          title: titleVal,
          artist: artistVal,
          artistId: ytmArtist.channelId(item.channel_id),
          duration: item.duration || 0,
          thumbnail: thumbnail,
          url: `https://www.youtube.com/watch?v=${item.id}`,
          platform: 'youtube',
          isCached: !!isCached
        };
      }));
      const result = { success: true, tracks: entries };
      cacheSearchResult(cacheKey, result);
      setTimeout(() => {
        if (entries[0] && entries[0].url) prefetchTrack(entries[0].url, entries[0].id, 'youtube').catch(() => {});
      }, 60);
      return sendResponse(200, result);
    } catch (err) {
      return sendResponse(200, { success: false, tracks: [], error: 'YouTube Music is unavailable' });
    }
  }

  const prefix = platform === 'soundcloud' ? `scsearch${limit}:` : `ytsearch${limit}:`;
  const args = [
    `${prefix}${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--skip-download',
    '--no-warnings',
  ];

  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=android');
  }

  try {
    const data = platform === 'soundcloud'
      ? await soundcloudFlatSearch(query, limit, 'play', 'search')
      : JSON.parse(await executeYtDlp(args, 25000, { priority: 'play', reason: 'search' }));
    let found = data.entries || [];
    if (platform === 'soundcloud') {
      // songs SoundCloud only streams encrypted (DRM) can never play here: leave them out (#13).
      // The phone build's search checked already and marks its results playable.
      const unknown = found.filter((item) => item && item.playable !== true && /^\d+$/.test(String(item.id))).map((item) => String(item.id));
      const ok = unknown.length ? await soundcloudPlayableIds(unknown) : null;
      if (ok) found = found.filter((item) => !item || !unknown.includes(String(item.id)) || ok.has(String(item.id)));
    }
    const entries = await Promise.all(found.map(async (item) => {
      let thumbnail = '';
      if (item.thumbnails && item.thumbnails.length > 0) {
        thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
      } else if (item.thumbnail) {
        thumbnail = item.thumbnail;
      }

      const cleanTitle = (item.title || 'untitled');
      const cleanArtist = (item.uploader || item.channel || item.artist || 'unknown artist');

      let trackUrl = item.webpage_url || item.url;
      if (platform === 'youtube' && !trackUrl) {
        trackUrl = `https://www.youtube.com/watch?v=${item.id}`;
      }

      const isCached = await findCachedFile(item.id);

      return {
        id: String(item.id || Math.random().toString(36).substring(2)),
                                                               title: cleanTitle,
                                                               artist: cleanArtist,
                                                               artistId: platform === 'youtube' ? ytmArtist.channelId(item.channel_id) : undefined,
                                                               duration: item.duration || 0,
                                                               thumbnail: thumbnail,
                                                               url: trackUrl,
                                                               platform: platform,
                                                               isCached: !!isCached
      };
    }));

    const result = { success: true, tracks: entries };
    cacheSearchResult(cacheKey, result);

    setTimeout(() => {
      if (entries[0] && entries[0].url) prefetchTrack(entries[0].url, entries[0].id, platform).catch(() => {});
    }, 60);

    return sendResponse(200, result);
  } catch (err) {
    return sendResponse(500, { success: false, error: err.message });
  }
  } finally {
    if (!responseOutcome) {
      const outcome = { status: 500, body: { success: false, error: 'Search failed' } };
      responseOutcome = outcome;
      resolveSearchOutcome(outcome);
    }
    if (searchCache.get(cacheKey) === cacheEntry) {
      searchCache.delete(cacheKey);
    }
  }
}

async function handleVibeRecommendations(req, res, payload) {
  const historyTracks = Array.isArray(payload?.history) ? payload.history : [];
  const favoriteTracks = Array.isArray(payload?.favorites) ? payload.favorites : [];
  const platform = 'youtube';
  const limit = Math.max(4, Math.min(parseInt(payload?.limit || '10', 10) || 10, 16));
  const clientProfile = payload?.clientProfile || null;
  const extra = {
    seeds: payload?.seeds,
    avoid: payload?.avoid,
    refresh: payload?.refresh
  };

  try {
    const result = await recommendVibeTracks(historyTracks, favoriteTracks, platform, limit, clientProfile, extra);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

// Song radio (#28): "Start radio" on one song, or on a few picked together. Each seed's own candidates (YouTube
// Music's radio, Last.fm's similar songs, Deezer), mixed evenly across the seeds (recommend-core.js mixRadio),
// leaving out the seeds, what this radio already queued, and blocked artists and songs. Unlike My Wave it does not
// care what was heard before: a radio is about the songs it was started from.
async function songRadioTracks(seeds, { limit = 25, exclude = {}, blocks = {} } = {}) {
  const seedList = (Array.isArray(seeds) ? seeds : []).filter((s) => s && (s.title || s.id)).slice(0, 5).map((s) => ({
    artist: String(s.artist || ''), title: String(s.title || ''), id: String(s.id || ''), platform: s.platform || 'youtube', weight: 1,
  }));
  if (!seedList.length) return [];
  const keyOf = (t) => getTrackNormalizedKey(t.artist, t.title);
  const exKeys = new Set((Array.isArray(exclude.keys) ? exclude.keys : []).filter((k) => typeof k === 'string'));
  const exIds = new Set((Array.isArray(exclude.ids) ? exclude.ids : []).map((x) => String(x || '').replace(/^(yt_|youtube_)/, '')).filter(Boolean));
  for (const s of seedList) {
    const k = keyOf(s);
    if (k) exKeys.add(k);
    const v = seedVideoId(s);
    if (v) exIds.add(v);
  }
  const blockArtists = (Array.isArray(blocks.artists) ? blocks.artists : []).filter((a) => typeof a === 'string');
  const blockSongs = (Array.isArray(blocks.songs) ? blocks.songs : []).filter((x) => x && typeof x === 'object');
  const blockSet = { artists: blockArtists, songs: blockSongs };
  const perSeed = await Promise.all(seedList.map((seed) => gatherCandidates([seed]).catch(() => [])));
  const filtered = perSeed.map((l) => recommendCore.dropUnwanted(l, { blocks: blockSet, keyOf }));
  const mixed = recommendCore.mixRadio(filtered, { limit: limit * 2, exclude: { keys: exKeys, ids: exIds }, keyOf, perArtist: seedList.length > 1 ? 3 : 2 });
  // found on YouTube a few at a time; the order of the mix is kept
  const resolved = new Array(mixed.length).fill(null);
  let next = 0;
  let found = 0;
  const worker = async () => {
    while (next < mixed.length && found < limit) {
      const i = next++;
      try {
        const t = await resolveCandidate(mixed[i]);
        if (t) { resolved[i] = t; found++; }
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, mixed.length) }, worker));
  const tracks = resolved.filter(Boolean).map((t) => {
    if (t.platform !== 'youtube') return t;
    const named = recommendCore.cleanVideoTitle(t.title, t.artist);
    return named.title === t.title && named.artist === t.artist ? t : { ...t, title: named.title, artist: named.artist };
  });
  return recommendCore.dropUnwanted(tracks, { blocks: blockSet, recentKeys: exKeys, recentIds: exIds, keyOf }).slice(0, limit);
}

async function handleSongRadio(req, res, payload) {
  const limit = Math.max(5, Math.min(parseInt(payload?.limit || '25', 10) || 25, 40));
  try {
    const tracks = await songRadioTracks(payload?.seeds, { limit, exclude: payload?.exclude || {}, blocks: payload?.blocks || {} });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, tracks }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

// shown to the listener as is: by now every other upload and SoundCloud were tried too
const STREAM_FAILED = "Couldn't play this song. Try another version from search";

// YouTube refuses some uploads outright ("This video is not available": blocked in the listener's country,
// taken down, age-gated). The same song is usually up several more times, so before giving up (or falling back
// to SoundCloud) the stream lookup tries up to two other uploads of about the same length.
// SoundCloud, for a song YouTube won't give us. For big-label songs its top search result is often a
// 30-second preview (SoundCloud Go+): that was played as the whole song and stopped at 0:29. Only a full
// upload of about the same length counts, and remixes / sped-up versions only when the song is one.
const VERSION_WORDS = /\b(remix|sped[ -]?up|slowed|nightcore|reverb|8d|bass[ -]?boost(ed)?|cover|flip|mashup|instrumental|karaoke|loop)\b/i;
async function soundcloudFallback(title, artist, duration) {
  const query = `${artist || ''} ${title || ''}`.trim();
  if (!query) return null;
  const want = Number(duration) || 0;
  const wantsVersion = VERSION_WORDS.test(title || '');
  const found = await searchSoundcloud(query, 8, 'play').catch(() => []);
  const pick = (found || []).find((t) => t && t.url
    && t.duration > 31 // previews are exactly 30 s
    && (!want || Math.abs(t.duration - want) <= Math.max(12, want * 0.08))
    && (wantsVersion || !VERSION_WORDS.test(t.title || '')));
  return pick ? pick.url : null;
}

async function alternativeUploads(cleanId, title, artist, duration) {
  const query = `${artist || ''} ${title || ''}`.trim();
  if (!query) return [];
  const want = Number(duration) || 0;
  const found = await directYoutubeSearch(query).catch(() => []);
  return (found || [])
    .filter((t) => t && t.id && t.id !== cleanId && (!want || !t.duration || Math.abs(t.duration - want) <= Math.max(15, want * 0.12)))
    .slice(0, 2)
    .map((t) => `https://www.youtube.com/watch?v=${t.id}`);
}

// fresh: the app could not play the URL it got last time (or the lookup failed): skip the remembered URL
async function handleStreamInfo(req, res, trackUrl, trackId, platform = 'youtube', title = '', artist = '', duration = 0, thumbnail = '', fresh = false) {
  let cleanId = cleanTrackId(trackId);
  if (!cleanId && trackUrl && trackUrl.includes('v=')) {
    cleanId = cleanTrackId(trackUrl.split('v=')[1].split('&')[0]);
  }
  const meta = { title, artist, duration, thumbnail };

  const [cachedFile, downloadedName] = await Promise.all([
    cleanId ? findCachedFile(cleanId) : Promise.resolve(null),
    (title || artist) ? findDownloadedFile(title, artist) : Promise.resolve(null)
  ]);

  if (cachedFile) {
    const data = {
      success: true,
      isLocal: true,
      streamUrl: withToken(`http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}`)
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  if (downloadedName) {
    const data = {
      success: true,
      isLocal: true,
      isDownload: true,
      streamUrl: withToken(`http://127.0.0.1:${PORT}/api/downloaded-track?name=${encodeURIComponent(downloadedName)}`)
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  const cacheKey = (cleanId || trackUrl || `${artist}_${title}`).toLowerCase();
  if (cacheKey && (streamUrlCache.has(cacheKey) || (cleanId && streamUrlCache.has(cleanId)))) {
    const cached = streamUrlCache.get(cacheKey) || (cleanId ? streamUrlCache.get(cleanId) : null);
    let joined = null;
    if (cached?.promise) {
      // someone else wants this song too: a skip by the first requester must not cancel the download
      cached.waiters = (cached.waiters || 0) + 1;
      joined = await cached.promise;
      if (joined.success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(joined));
      }
      // that lookup failed (or was cancelled): this request looks the song up itself instead of passing
      // the failure on, the way pressing Retry would
    }
    if (joined || fresh) {
      for (const k of [cacheKey, cleanId]) if (k && streamUrlCache.get(k) && !streamUrlCache.get(k).promise) streamUrlCache.delete(k);
    } else if (cached && (Date.now() - cached.timestamp < 1800000)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (cleanId) setTimeout(() => downloadTrackToDisk(trackUrl, cleanId, platform, { ...meta, streamUrl: cached.data && cached.data.streamUrl }), 10000);
      return res.end(JSON.stringify(cached.data));
    }
  }

  let resolveLookup;
  const lookupPromise = new Promise(resolve => { resolveLookup = resolve; });
  const inFlightEntry = { promise: lookupPromise };
  if (cacheKey) streamUrlCache.set(cacheKey, inFlightEntry);

  try {
  const ytTarget = youtubeExtractTarget(trackUrl, cleanId, platform);
  trackUrl = ytTarget.url;

  if (STREAM_VIA_CACHE) {
    // the app gave up on this song (the listener skipped on): stop downloading it, and don't start fallbacks
    let gone = false;
    req.on('close', () => {
      if (res.writableEnded || inFlightEntry.waiters) return;
      gone = true;
      const proc = downloadProcs.get(cleanId);
      if (proc) { try { proc.kill(); } catch (e) {} }
    });
    await downloadTrackToDisk(trackUrl, cleanId, platform, meta, 'play');
    if (gone) { resolveLookup({ success: false, error: 'cancelled' }); if (cacheKey && streamUrlCache.get(cacheKey) === inFlightEntry) streamUrlCache.delete(cacheKey); return; }
    // any song that won't play (SoundCloud and YouTube Music included) tries other YouTube uploads of it
    if (!await findCachedFile(cleanId) && platform !== 'local' && (title || artist)) {
      for (const alt of await alternativeUploads(cleanId, title, artist, duration)) {
        try { logger.log('warn', `stream: ${cleanId} unavailable, trying another upload ${alt}`); } catch (_) {}
        await downloadTrackToDisk(alt, cleanId, 'youtube', meta, 'play');
        if (await findCachedFile(cleanId)) break;
      }
    }
    if (!await findCachedFile(cleanId) && (title || artist)) {
      // same SoundCloud fallback as the streaming path below
      const sc = await soundcloudFallback(title, artist, duration);
      if (sc) await downloadTrackToDisk(sc, cleanId, 'soundcloud', meta, 'play');
    }
    // settle the in-flight entry so concurrent lookups for this track don't wait forever,
    // and drop it so later prefetches don't mistake it for a cached stream URL
    const outcome = await findCachedFile(cleanId)
      ? { success: true, isLocal: true, streamUrl: withToken(`http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}`) }
      : { success: false, error: STREAM_FAILED };
    resolveLookup(outcome);
    if (cacheKey && streamUrlCache.get(cacheKey) === inFlightEntry) streamUrlCache.delete(cacheKey);
    res.writeHead(outcome.success ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome));
  }

  let streamUrl = null;

  if (isSafeMediaUrl(trackUrl)) {
    try {
      const args = ['--no-config', ...streamSource.LOOKUP_PRINT_ARGS, '--no-warnings', '--no-playlist', '--prefer-free-formats', '-f', 'bestaudio/best'];
      if (ytTarget.youtube) args.push('--extractor-args', YT_PLAYER_CLIENTS);
      args.push('--', trackUrl);
      const raw = await executeYtDlp(args, 25000, { key: `g:${trackUrl}`, priority: 'play', reason: 'stream' });
      const found = streamSource.parseLookup(raw);
      if (found.url) { streamUrl = found.url; rememberStreamHeaders(found.url, found.headers); }
    } catch (e) {
      try { logger.error('Stream resolve primary error: ' + (title || trackUrl), e); } catch (_) {}
    }
  }

  if (!streamUrl && platform !== 'local' && (title || artist)) {
    for (const alt of await alternativeUploads(cleanId, title, artist, duration)) {
      try {
        const raw = await executeYtDlp(['--no-config', ...streamSource.LOOKUP_PRINT_ARGS, '--no-warnings', '--no-playlist', '--prefer-free-formats', '-f', 'bestaudio/best', '--extractor-args', 'youtube:player_client=default,android', '--', alt], 18000, { key: `g:${alt}`, priority: 'play', reason: 'stream-alternative' });
        const found = streamSource.parseLookup(raw);
        streamUrl = found.url;
        rememberStreamHeaders(found.url, found.headers);
        if (streamUrl) break;
      } catch (e) {
        try { logger.error('Stream resolve alternative error: ' + alt, e); } catch (_) {}
      }
    }
  }

  if (!streamUrl && (title || artist)) {
    try {
      const sc = await soundcloudFallback(title, artist, duration);
      if (!sc) throw new Error('no full-length SoundCloud upload');
      const scArgs = ['--no-config', '-g', '--no-warnings', '--no-playlist', '--prefer-free-formats', '-f', 'bestaudio/best', '--', sc];
      const scRaw = await executeYtDlp(scArgs, 15000, { key: `g:${sc}`, priority: 'play', reason: 'stream-soundcloud' });
      const scLines = scRaw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
      if (scLines.length > 0) streamUrl = scLines[0];
    } catch (e) {
      try { logger.error('Stream resolve fallback error: ' + (title || trackUrl), e); } catch (_) {}
    }
  }

  if (!streamUrl) {
    try { logger.error('Stream resolve failed: ' + (title || trackUrl)); } catch (_) {}
    const failure = { success: false, error: STREAM_FAILED };
    resolveLookup(failure);
    if (cacheKey && streamUrlCache.get(cacheKey) === inFlightEntry) {
      streamUrlCache.delete(cacheKey);
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(failure));
  }

  const isHls = streamUrl.includes('.m3u8');
  const data = {
    success: true,
    isLocal: false,
    streamUrl: streamUrl,
    isHls: isHls,
    proxyUrl: withToken(`http://127.0.0.1:${PORT}/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`)
  };

  resolveLookup(data);
  if (cacheKey) streamUrlCache.set(cacheKey, { timestamp: Date.now(), data });
  if (cleanId && cleanId !== cacheKey) streamUrlCache.set(cleanId, { timestamp: Date.now(), data });
  trimCache(streamUrlCache, 300);
  if (cleanId) setTimeout(() => downloadTrackToDisk(trackUrl, cleanId, platform, { ...meta, streamUrl }), 10000);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
  } catch (error) {
    const failure = { success: false, error: error.message };
    resolveLookup(failure);
    if (cacheKey && streamUrlCache.get(cacheKey) === inFlightEntry) {
      streamUrlCache.delete(cacheKey);
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

const artistInFlight = new Map();
const videoArtists = new Map();

// Several artists can share a name. With the artist's channel id (tracks from YouTube / YouTube Music carry it)
// or the video a track plays, the page is the one of that artist; with only a name it's the best-known namesake.
async function fetchArtistInfo(artistName, artistId = '', videoId = '') {
  const cleanName = (artistName || '').replace(/ - Topic|VEVO|Official|Records/gi, '').trim();
  const id = await resolveArtistId(cleanName, artistId, videoId);
  const cacheKey = id ? `id:${id}` : cleanName.toLowerCase();
  if (artistCache.has(cacheKey)) return artistCache.get(cacheKey);
  // the same artist page requested again while its lookup runs shares that lookup
  if (artistInFlight.has(cacheKey)) return artistInFlight.get(cacheKey);
  const lookup = (id ? lookupYtmArtist(id, cleanName, cacheKey) : lookupArtistInfo(cleanName, cacheKey)).finally(() => artistInFlight.delete(cacheKey));
  artistInFlight.set(cacheKey, lookup);
  return lookup;
}

// Tracks saved before they kept `artistId`: the artist YouTube Music credits the video to, if it has that name
async function resolveArtistId(cleanName, artistId, videoId) {
  if (ytmArtist.channelId(artistId)) return artistId;
  if (!ytmArtist.VIDEO_ID.test(videoId || '')) return '';
  if (!videoArtists.has(videoId)) {
    const credits = ytmRequest('next', { videoId, isAudioOnly: true }, 4000)
      .then((json) => ytmArtist.parseWatchArtists(json, videoId))
      .catch(() => { videoArtists.delete(videoId); return []; });
    videoArtists.set(videoId, credits);
    trimCache(videoArtists, 500);
  }
  const hit = ytmArtist.pickArtist(await videoArtists.get(videoId), cleanName);
  return hit ? hit.id : '';
}

// the artist page from the artist's YouTube Music channel; the page by name when that can't be reached
async function lookupYtmArtist(id, cleanName, cacheKey) {
  let page = null;
  try { page = ytmArtist.parseArtistPage(await ytmRequest('browse', { browseId: id }, 5000), id); } catch (e) {}
  if (!page) return fetchArtistInfo(cleanName);

  let songs = page.songs;
  if (page.playlist) {
    try {
      const all = ytmArtist.parseSongRows(await ytmRequest('browse', { browseId: page.playlist }, 4000));
      if (all.length) songs = all;
    } catch (e) {}
  }
  // channels without a song catalogue (an uploader, or a country where YouTube Music has no songs) have videos
  const seen = new Set();
  const tracks = [...songs, ...(songs.length < 10 ? page.videos : [])]
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .slice(0, 35)
    .map((t) => ({ ...t, isCached: false }));

  const result = {
    id,
    ids: page.ids,
    name: page.name,
    bio: page.bio,
    avatar: page.avatar || (tracks[0] ? tracks[0].thumbnail : ''),
    banner: page.banner || page.avatar || '',
    fans: page.fans || 0,
    fansText: page.fansText || '',
    isVerified: page.isVerified,
    tracks,
    releases: page.releases
  };
  artistCache.set(cacheKey, result);
  trimCache(artistCache, 100);
  return result;
}

// other artists with the same name, for the chooser on the artist page
async function handleArtistMatches(req, res, parsedUrl) {
  const name = (parsedUrl.query.name || '').trim();
  const cacheKey = `artist-matches:${ytmArtist.nameKey(name)}`;
  let artists = getAlbumCache(cacheKey);
  if (!artists && name) {
    try {
      const found = ytmArtist.parseArtistResults(await ytmRequest('search', { query: name, params: YTM_ARTISTS_PARAMS }, 5000));
      artists = found.filter((a) => ytmArtist.nameKey(a.name) === ytmArtist.nameKey(name)).slice(0, 8);
      setAlbumCache(cacheKey, artists);
    } catch (e) {}
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ success: true, artists: artists || [] }));
}

async function lookupArtistInfo(cleanName, cacheKey) {
  let bio = '';
  let avatar = '';
  let isVerified = false;
  let fans = 0;
  let tracks = [];
  let resolvedName = cleanName;

  try {
    const dzUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(cleanName)}`;
    const dzData = await httpsJson(dzUrl, 4000);

    if (dzData && dzData.data && dzData.data.length > 0) {
      // Deezer's first hit for "Queen" is "Queen(Ares)": the best-known artist of exactly that name first
      const sameName = dzData.data.filter((a) => a && ytmArtist.nameKey(a.name) === ytmArtist.nameKey(cleanName));
      const topArtist = sameName.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || dzData.data[0];
      if (topArtist.name) resolvedName = topArtist.name;
      avatar = topArtist.picture_xl || topArtist.picture_big || topArtist.picture_medium || '';
      isVerified = (topArtist.nb_fan || 0) > 30000;
      fans = topArtist.nb_fan || 0;

      if (topArtist.tracklist) {
        const tlistData = await httpsJson(topArtist.tracklist, 4000);

        if (tlistData && Array.isArray(tlistData.data)) {
          for (const item of tlistData.data) {
            const dur = item.duration || 180;
            if (dur >= 50 && dur <= 450 && !isSpamOrUnofficial(item.title, dur)) {
              tracks.push({
                id: `dz_${item.id}`,
                title: (item.title || 'untitled'),
                          artist: (item.artist?.name || cleanName),
                          duration: dur,
                          thumbnail: item.album?.cover_medium || item.album?.cover_big || avatar,
                          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanName + ' - ' + item.title + ' official audio')}`,
                          searchQuery: `${cleanName} - ${item.title} official audio`,
                          platform: 'youtube',
                          isCached: false,
                          ...(item.explicit_lyrics || libraryPages.isExplicitText(item.title) ? { isExplicit: true } : {})
              });
            }
          }
        }
      }
    }
  } catch (e) {}

  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanName)}`;
    const wikiData = await httpsJson(wikiUrl, 3500, 'devsize/2.0');

    // not a list of everything called that ("Queen most commonly refers to...")
    // and about this name at all, not a page the title lookup landed on that never mentions it
    const extLower = String(wikiData && wikiData.extract || '').toLowerCase();
    const nameLower = cleanName.toLowerCase();
    const aboutName = extLower.includes(nameLower) || nameLower.split(/\s+/).some(w => w.length >= 3 && extLower.includes(w));
    if (wikiData && wikiData.extract && wikiData.type !== 'disambiguation' && aboutName) {
      bio = wikiData.extract;
      if (!avatar && wikiData.originalimage?.source) {
        avatar = wikiData.originalimage.source;
      }
    }
  } catch (e) {}

  if (tracks.length === 0) {
    try {
      const ytOfficialTracks = await directYoutubeSearch(`${cleanName} official audio`, true);
      tracks = (ytOfficialTracks || []).filter(t => !isSpamOrUnofficial(t.title, t.duration)).slice(0, 25);
    } catch (e) {}
  }

  const result = {
    name: resolvedName,
    bio: (bio || '').trim(),
    avatar: avatar || (tracks[0] ? tracks[0].thumbnail : ''),
    banner: avatar || (tracks[0] ? tracks[0].thumbnail : ''),
    fans,
    isVerified: isVerified,
    tracks: tracks.slice(0, 35)
  };

  // an empty page usually means the lookups failed (offline): don't keep that until the app restarts
  if (result.tracks.length || result.bio) {
    artistCache.set(cacheKey, result);
    trimCache(artistCache, 100);
  }
  return result;
}

async function handleLocalTrack(req, res, trackId) {
  const cleanId = cleanTrackId(trackId);
  const filePath = await findCachedFile(cleanId);

  if (!filePath) {
    res.writeHead(404);
    return res.end('File not found in local cache');
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.opus': 'audio/ogg; codecs=opus',
      '.webm': 'audio/webm',
      '.m4a': 'audio/mp4',
      '.mp3': 'audio/mpeg',
      '.aac': 'audio/aac'
    };
    const contentType = mimeTypes[ext] || 'audio/mpeg';
    sendFileWithRange(req, res, filePath, fileSize, contentType);
  } catch (e) {
    res.writeHead(500);
    res.end('Error reading local file');
  }
}

const LIBRARY_MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm'
};

async function handleLibraryFile(req, res, trackId) {
  const item = hasOwn(libraryIndex, trackId) ? libraryIndex[trackId] : null;
  if (!item || !item.file) {
    res.writeHead(404);
    return res.end('File not found in library');
  }

  const filePath = path.join(LIBRARY_DIR, item.file);
  try {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = LIBRARY_MIME_TYPES[ext] || 'audio/mpeg';
    sendFileWithRange(req, res, filePath, fileSize, contentType);
  } catch (e) {
    res.writeHead(404);
    res.end('File not found in library');
  }
}

async function handleDownloadedTrack(req, res, name) {
  const safeName = path.basename(String(name || ''));
  const ext = path.extname(safeName).toLowerCase();
  const dir = getDownloadsDir();
  const filePath = path.join(dir, safeName);

  if (!safeName || !AUDIO_EXTENSIONS.has(ext) || path.dirname(filePath) !== dir) {
    res.writeHead(404);
    return res.end('File not found in downloads');
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;

    const contentType = LIBRARY_MIME_TYPES[ext] || 'audio/mpeg';
    sendFileWithRange(req, res, filePath, fileSize, contentType);
  } catch (e) {
    res.writeHead(404);
    res.end('File not found in downloads');
  }
}

function forgetStreamUrl(streamUrl) {
  for (const [key, entry] of streamUrlCache) {
    if (entry && entry.data && entry.data.streamUrl === streamUrl) streamUrlCache.delete(key);
  }
}

async function handleAudioProxy(req, res, targetUrl) {
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing url');
  }

  try {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      res.writeHead(400);
      return res.end('Invalid url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.writeHead(400);
      return res.end('Unsupported protocol');
    }
    // media only: a page that got hold of this route shouldn't be able to POST through it
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }
    // the headers yt-dlp resolved this URL with (#17): YouTube serves an android/tv client's stream only
    // to a request that looks like that client, not to Chromium's own User-Agent
    const ytHeaders = streamHeaders.get(targetUrl) || null;
    const headers = streamSource.upstreamHeaders(req.headers, ytHeaders);
    const host = (() => { try { return parsed.host; } catch (_) { return '?'; } })();
    let clientGone = false;
    let proxyReq = null;
    res.on('close', () => {
      // the player drops a request on every seek; without this the upstream download keeps its
      // connection open until the 60s idle timeout
      if (res.writableFinished) return;
      clientGone = true;
      try { if (proxyReq) proxyReq.destroy(); } catch (e) {}
    });
    req.on('error', () => { try { if (proxyReq) proxyReq.destroy(); } catch (e) {} });

    const fail = (code, text) => {
      if (clientGone) return;
      if (!res.headersSent) { res.writeHead(code); res.end(text); } else { try { res.destroy(); } catch (err) {} }
    };

    // googlevideo answers some requests with a redirect to another rr server; follow it (each hop is
    // checked like the first) instead of handing the audio element a redirect to a host it then fetches
    // with its own headers
    const fetchHop = async (hopUrl, hops) => {
      let hopParsed;
      try { hopParsed = new URL(hopUrl); } catch (e) { return fail(502, 'Bad redirect'); }
      if (hopParsed.protocol !== 'http:' && hopParsed.protocol !== 'https:') return fail(502, 'Bad redirect');
      const target = await publicAddressOf(hopParsed.hostname);
      if (!target) return fail(403, 'Blocked target');
      if (clientGone) return;
      const client = hopParsed.protocol === 'https:' ? https : http;
      proxyReq = client.request(hopUrl, {
        // connect to the address checked above instead of resolving the name a second time
        lookup: (hostname, opts, cb) => (opts && opts.all ? cb(null, [target]) : cb(null, target.address, target.family)),
        method: req.method,
        headers: { ...headers, host: hopParsed.host }
      }, (proxyRes) => {
        const status = proxyRes.statusCode;
        if (res.writableEnded || clientGone) { proxyRes.destroy(); return; }
        if ([301, 302, 303, 307, 308].includes(status) && proxyRes.headers.location && hops < 5) {
          proxyRes.resume();
          let next;
          try { next = new URL(proxyRes.headers.location, hopUrl).toString(); } catch (e) { return fail(502, 'Bad redirect'); }
          fetchHop(next, hops + 1).catch(() => fail(500, 'Proxy failed'));
          return;
        }
        // what the stream answered, for #17-style reports: refusals always, everything with MURIEL_DEBUG(_YTDLP)
        if (status >= 400 || AUDIO_PROXY_DEBUG) {
          try { logger.log(status >= 400 ? 'warn' : 'info', `audio-proxy ${req.method} ${host}${hops ? ` (+${hops} redirect)` : ''} -> HTTP ${status} ${proxyRes.headers['content-type'] || '-'} len=${proxyRes.headers['content-length'] || '-'} range=${headers.range || '-'} ytHeaders=${ytHeaders ? 'yes' : 'no'}`); } catch (_) {}
        }
        // a media URL YouTube now refuses must not be handed out again from the lookup cache: the next
        // play (or a source switch) resolves the song afresh instead of reusing the dead link (#18)
        if (status === 403 || status === 410) forgetStreamUrl(targetUrl);
        // the audio element loads with crossorigin="anonymous": googlevideo's own CORS answer (for youtube.com)
        // must not replace ours, or the element refuses the stream it just got
        res.writeHead(status, streamSource.downstreamHeaders(proxyRes.headers));
        proxyRes.on('error', () => { try { res.destroy(); } catch (e) {} });
        proxyRes.pipe(res);
      });
      proxyReq.setTimeout(60000, () => { proxyReq.destroy(new Error('Proxy timeout')); });
      proxyReq.on('error', (e) => {
        try { logger.log('warn', `audio-proxy ${host}: ${e && e.message}`); } catch (_) {}
        fail(502, 'Proxy error');
      });
      proxyReq.end();
    };
    await fetchHop(targetUrl, 0);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Proxy failed');
    }
  }
}

function defaultDownloadsDir() {
  try { return require('electron').app.getPath('downloads'); } catch (e) { return path.join(os.homedir(), 'Downloads'); }
}

function getDownloadsDir() {
  const dir = resolveDownloadDir() || defaultDownloadsDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }
  return dir;
}

function sanitizeFilename(str) {
  return (str || 'track')
  .replace(/[<>:"/\\|?*]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.opus', '.wav', '.ogg', '.oga', '.aac', '.webm', '.weba']);

let downloadsIndex = null;
let downloadsIndexBuiltAt = 0;
const DOWNLOADS_INDEX_TTL = 15000;

async function buildDownloadsIndex() {
  const dir = getDownloadsDir();
  const map = new Map();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      const base = entry.name.slice(0, entry.name.length - ext.length).toLowerCase();
      if (base) map.set(base, entry.name);
    }
  } catch (e) {}
  downloadsIndex = map;
  downloadsIndexBuiltAt = Date.now();
  return map;
}

async function findDownloadedFile(title, artist) {
  if (!title && !artist) return null;
  if (!downloadsIndex || Date.now() - downloadsIndexBuiltAt > DOWNLOADS_INDEX_TTL) {
    await buildDownloadsIndex();
  }
  const key = `${sanitizeFilename(artist || 'unknown artist')} - ${sanitizeFilename(title || 'untitled')}`.toLowerCase();
  return downloadsIndex.get(key) || null;
}

async function cleanupDownloadArtifacts(dir, beforeSet, baseName, videoId, chosenExt, keepSuccessFile) {
  try {
    const afterFiles = await fs.promises.readdir(dir);
    const trashExts = new Set(['.webp', '.webm', '.part', '.ytdl', '.temp', '.jpg', '.jpeg', '.png', '.json', '.vtt', '.m4a', '.opus', '.mp4']);
    const chosenExtWithDot = '.' + chosenExt.toLowerCase();

    for (const f of afterFiles) {
      if (beforeSet.has(f)) continue;

      const fileExt = path.extname(f).toLowerCase();
      const belongs = f.startsWith(baseName) || (videoId && f.includes(videoId));
      if (!belongs) continue;

      if (keepSuccessFile && f === `${baseName}${chosenExtWithDot}`) {
        continue;
      }

      if (trashExts.has(fileExt) || !keepSuccessFile) {
        if (fileExt === chosenExtWithDot && keepSuccessFile) {
          continue;
        }
        try {
          await fs.promises.unlink(path.join(dir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// ---- cover art for local library tracks: embedded picture first, then iTunes ----
const localCoverQueued = new Set();
const localCoverQueue = [];
let localCoverWorking = false;
let lastOnlineCoverLookup = 0;

function localCoverPath(id) {
  return path.join(THUMBNAILS_DIR, `localcover_${id}.jpg`);
}

function extractEmbeddedCover(src, dest) {
  return new Promise((resolve) => {
    const ffmpegBin = resolveBinary('ffmpeg');
    if (!ffmpegBin || !fs.existsSync(src)) return resolve(false);
    const tmp = `${dest}.tmp.jpg`;
    let proc;
    try {
      proc = spawn(ffmpegBin, ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(600,iw)':-2", tmp], { windowsHide: true });
    } catch (e) { return resolve(false); }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 20000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 500) {
          fs.renameSync(tmp, dest);
          return resolve(true);
        }
        fs.rmSync(tmp, { force: true });
      } catch (_) {}
      resolve(false);
    });
  });
}

async function fetchOnlineCover(item, dest) {
  try {
    const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const title = (item.title || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();
    if (!title) return false;
    const artist = item.artist && !/^unknown artist$/i.test(item.artist) ? item.artist : '';
    const term = `${artist} ${title}`.trim();
    const data = await fetchItunesJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5${itunesCountryParam()}`);
    const results = (data && Array.isArray(data.results)) ? data.results : [];
    const hit = results.find(r => r && r.artworkUrl100 && norm(r.trackName).includes(norm(title)) && (!artist || norm(r.artistName).includes(norm(artist)) || norm(artist).includes(norm(r.artistName))));
    if (!hit) return false;
    const res = await fetchWithTimeout(hit.artworkUrl100.replace('100x100', '600x600'));
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false;
    await fs.promises.writeFile(dest, buf);
    return true;
  } catch (e) {
    return false;
  }
}

// ---- /api/image-proxy: the last cover a picture tries (app.js trackArtCandidates, computers only) ----
// From Riff 43: the picture fetched here and kept on disk, so a cover host that is blocked or down (i.ytimg.com
// in some countries) costs one try; when it gives nothing, the song's cover from iTunes by artist and title.
// Public hosts only (the same check as every other fetch the server makes for the page), at most 8 MB.
const IMAGE_PROXY_MAX = 8 * 1024 * 1024;
const imageHostFails = new Map(); // hostname -> retry after (ms)
const imageCoverMisses = new Map(); // artist + title -> no iTunes cover, ask again after (ms)

function imageContentType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return '';
}

async function fetchProxiedImage(target) {
  let u;
  try { u = new URL(target); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if ((imageHostFails.get(u.hostname) || 0) > Date.now()) return null;
  try {
    if (!(await publicAddressOf(u.hostname))) return null;
    const r = await fetchWithTimeout(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' } }, 6000);
    if (r.url && r.url !== u.href) {
      const final = new URL(r.url);
      if (!(await publicAddressOf(final.hostname))) return null;
    }
    if (!r.ok) return null;
    if (Number(r.headers.get('content-length')) > IMAGE_PROXY_MAX) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length >= 500 && buf.length <= IMAGE_PROXY_MAX && imageContentType(buf) ? buf : null;
  } catch (e) {
    imageHostFails.set(u.hostname, Date.now() + 10 * 60 * 1000);
    trimCache(imageHostFails, 200);
    return null;
  }
}

async function handleImageProxy(req, res, parsedUrl) {
  const target = String(parsedUrl.query.url || '');
  const artist = String(parsedUrl.query.artist || '').slice(0, 200);
  const title = String(parsedUrl.query.title || '').slice(0, 300);
  if ((target && !/^https?:\/\//i.test(target)) || target.length > 2048 || (!target && !title)) { res.writeHead(400); return res.end(); }
  let buffer = null;
  if (target) {
    const cachePath = path.join(THUMBNAILS_DIR, `proxy-${crypto.createHash('sha1').update(target).digest('hex')}.img`);
    try { buffer = await fs.promises.readFile(cachePath); } catch (e) {}
    if (buffer) return sendImage(res, buffer);
    buffer = await fetchProxiedImage(target);
    if (buffer) fs.promises.writeFile(cachePath, buffer).catch(() => {});
  }
  if (!buffer && title) {
    const coverKey = crypto.createHash('sha1').update(`${artist}\u0000${title}`.toLowerCase()).digest('hex').slice(0, 16);
    const coverPath = path.join(THUMBNAILS_DIR, `cover-${coverKey}.jpg`);
    try { buffer = await fs.promises.readFile(coverPath); } catch (e) {
      if ((imageCoverMisses.get(coverKey) || 0) < Date.now()) {
        if (await fetchOnlineCover({ title, artist }, coverPath)) {
          try { buffer = await fs.promises.readFile(coverPath); } catch (_) {}
        } else {
          imageCoverMisses.set(coverKey, Date.now() + 60 * 60 * 1000);
          trimCache(imageCoverMisses, 500);
        }
      }
    }
  }
  if (!buffer) { res.writeHead(404); return res.end(); }
  return sendImage(res, buffer);
}

function sendImage(res, buffer) {
  res.writeHead(200, { 'Content-Type': imageContentType(buffer) || 'image/jpeg', 'Cache-Control': 'private, max-age=31536000' });
  return res.end(buffer);
}

async function processLocalCovers() {
  if (localCoverWorking) return;
  localCoverWorking = true;
  try {
    while (localCoverQueue.length) {
      const id = localCoverQueue.shift();
      const item = libraryIndex[id];
      if (!item) continue;
      const dest = localCoverPath(id);
      if (fs.existsSync(dest)) continue;
      let ok = await extractEmbeddedCover(path.join(LIBRARY_DIR, item.file), dest);
      if (!ok) {
        // iTunes allows only a few lookups per minute, so space them out
        const wait = 4000 - (Date.now() - lastOnlineCoverLookup);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastOnlineCoverLookup = Date.now();
        ok = await fetchOnlineCover(item, dest);
      }
    }
  } finally {
    localCoverWorking = false;
  }
}

function queueLocalCovers(ids) {
  for (const id of ids) {
    if (localCoverQueued.has(id) || fs.existsSync(localCoverPath(id))) continue;
    localCoverQueued.add(id);
    localCoverQueue.push(id);
  }
  if (localCoverQueue.length) processLocalCovers().catch(() => {});
}

function handleLocalCover(req, res, parsedUrl) {
  const id = String(parsedUrl.query.id || '');
  const file = /^[\w-]{1,64}$/.test(id) && hasOwn(libraryIndex, id) ? localCoverPath(id) : '';
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
  // a read error (file gone since the exists check) must end the response, not crash the process
  streamFileToResponse(fs.createReadStream(file), res);
}

async function handleDownload(req, res, trackUrl, title, artist, format = 'mp3', quality = '0', startParam = null, endParam = null, raw = false, trackId = null, streamUrlParam = null) {
  if (!trackUrl && (!title || !artist)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'missing track information' }));
  }

  let start = null;
  if (startParam !== null && startParam !== undefined && startParam !== '') {
    const n = typeof startParam === 'number' ? startParam : parseFloat(startParam);
    if (!isNaN(n)) start = Math.max(0, n);
  }
  let end = null;
  if (endParam !== null && endParam !== undefined && endParam !== '') {
    const n = typeof endParam === 'number' ? endParam : parseFloat(endParam);
    if (!isNaN(n)) end = Math.max(0, n);
  }

  const trimArgs = [];
  if (start !== null || end !== null) {
    const s = start !== null ? start : 0;
    trimArgs.push('--postprocessor-args', 'ffmpeg:-ss ' + s + (end ? ' -to ' + end : ''));
  }

  const isRaw = Boolean(raw);
  const downloadsDir = getDownloadsDir();
  const tmpDir = path.join(downloadsDir, '.tmp');
  if (isRaw && !fs.existsSync(tmpDir)) {
    try { await fs.promises.mkdir(tmpDir, { recursive: true }); } catch (_) {}
  }

  const cleanTitle = sanitizeFilename(title || 'untitled');
  const cleanArtist = sanitizeFilename(artist || 'unknown artist');
  const validFormats = ['mp3', 'm4a', 'flac', 'opus', 'wav', 'ogg'];
  const safeFormat = String(format || '').toLowerCase();
  const ext = isRaw ? 'wav' : (validFormats.includes(safeFormat) ? safeFormat : 'mp3');
  const safeQuality = /^\d+$/.test(String(quality)) ? String(quality) : '0';
  const tempName = isRaw ? ('raw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.wav') : null;
  const outFilename = isRaw ? tempName : `${cleanArtist} - ${cleanTitle}.${ext}`;
  const outPath = isRaw ? path.join(tmpDir, tempName) : path.join(downloadsDir, outFilename);
  // a % in a title would be read by yt-dlp as a template field: %% writes a plain %
  const tplSafe = (x) => String(x).replace(/%/g, '%%');
  const tempTemplate = isRaw ? path.join(tmpDir, tempName.replace(/\.wav$/, '.%(ext)s')) : path.join(downloadsDir, `${tplSafe(cleanArtist)} - ${tplSafe(cleanTitle)}.%(ext)s`);

  let targetUrl = trackUrl;
  if (!isSafeMediaUrl(targetUrl) || targetUrl.includes('deezer.com')) {
    targetUrl = `ytsearch1:${cleanArtist} ${cleanTitle} official audio`;
  }

  let cleanId = cleanTrackId(trackId);
  if (!cleanId && targetUrl) {
    const vidMatch = String(targetUrl).match(/(?:v=|\/embed\/|\/watch\/|youtu\.be\/|\/v\/)([a-zA-Z0-9_-]{11})/);
    if (vidMatch) cleanId = cleanTrackId(vidMatch[1]);
  }

  const downloadKey = !isRaw ? JSON.stringify([cleanId || targetUrl, cleanArtist, cleanTitle, ext, safeQuality, start, end]) : null;
  if (downloadKey && downloadInFlight.has(downloadKey)) {
    const outcome = await downloadInFlight.get(downloadKey);
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome.body));
  }

  let resolveDownload;
  const downloadPromise = downloadKey ? new Promise(resolve => { resolveDownload = resolve; }) : null;
  if (downloadKey) downloadInFlight.set(downloadKey, downloadPromise);
  let downloadOutcome = null;
  const sendDownloadResponse = (status, body) => {
    downloadOutcome = { status, body };
    if (resolveDownload) resolveDownload(downloadOutcome);
    if (!res.writableEnded) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  };

  try {
  // Phones have no ffmpeg: fetch the song the way playback does (into the cache) and copy that file into
  // Downloads under its real extension. Before, the response named a .mp3 while an .aac was written, cached
  // songs were downloaded again, and a cancelled download kept running next to its retry.
  if (STREAM_VIA_CACHE && !isRaw) {
    const cacheId = cleanId || cleanTrackId(`dl_${crypto.createHash('sha1').update(`${cleanArtist}|${cleanTitle}`).digest('hex').slice(0, 12)}`);
    if (!await findCachedFile(cacheId)) await downloadTrackToDisk(targetUrl, cacheId, 'youtube', { title, artist });
    const cached = await findCachedFile(cacheId);
    if (!cached) return sendDownloadResponse(500, { success: false, error: STREAM_FAILED });
    const savedName = `${cleanArtist} - ${cleanTitle}${path.extname(cached)}`;
    await fs.promises.mkdir(downloadsDir, { recursive: true });
    await fs.promises.copyFile(cached, path.join(downloadsDir, savedName));
    downloadsIndex = null;
    return sendDownloadResponse(200, { success: true, filename: savedName, directory: downloadsDir });
  }
  const cachedFile = cleanId ? await findCachedFile(cleanId) : null;
  if (cachedFile) {
    const ffmpegBin = resolveBinary('ffmpeg');
    if (ffmpegBin) {
      const bitrateMap = { '0': '320k', '2': '256k', '4': '192k', '5': '128k' };
      const bitrate = bitrateMap[safeQuality] || '320k';
      const ffmpegArgs = ['-y'];
      if (start !== null) ffmpegArgs.push('-ss', String(start));
      if (end !== null) ffmpegArgs.push('-to', String(end));
      ffmpegArgs.push('-i', cachedFile);
      if (['mp3', 'm4a', 'opus', 'ogg'].includes(ext)) {
        ffmpegArgs.push('-b:a', bitrate);
      }
      ffmpegArgs.push('-metadata', `title=${title || cleanTitle}`);
      ffmpegArgs.push('-metadata', `artist=${artist || cleanArtist}`);
      ffmpegArgs.push(outPath);

      let ffmpegProc = null;
      res.on('close', () => {
        if (!res.writableEnded && ffmpegProc) {
          try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
          try { fs.unlinkSync(outPath); } catch (_) {}
        }
      });

      try {
        await new Promise((resolve, reject) => {
          ffmpegProc = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
          ffmpegProc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
          });
          ffmpegProc.on('error', reject);
        });
        downloadsIndex = null;
        return sendDownloadResponse(200, isRaw ? {
          success: true,
          tempName: tempName
        } : {
          success: true,
          filename: outFilename,
          directory: downloadsDir
        });
      } catch (cachedErr) {
        try { await fs.promises.unlink(outPath); } catch (_) {}
      }
    }
  }

  const targetDir = isRaw ? tmpDir : downloadsDir;
  const beforeFiles = new Set(await fs.promises.readdir(targetDir).catch(() => []));
  let child = null;

  async function cleanupPartial() {
    try {
      const files = await fs.promises.readdir(targetDir);
      const prefix = isRaw ? tempName.replace(/\.wav$/, '') : `${cleanArtist} - ${cleanTitle}.`;
      for (const f of files) {
        if (beforeFiles.has(f)) continue;
        if (!f.startsWith(prefix)) continue;
        const lower = f.toLowerCase();
        if (
          lower.endsWith('.part') ||
          lower.endsWith('.ytdl') ||
          lower.endsWith('.temp') ||
          f === outFilename ||
          !res.writableEnded
        ) {
          try { await fs.promises.unlink(path.join(targetDir, f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  res.on('close', () => {
    if (!res.writableEnded && child) {
      try { child.kill('SIGKILL'); } catch (e) {}
      cleanupPartial();
    }
  });

  const baseName = isRaw ? tempName.replace(/\.wav$/, '') : `${cleanArtist} - ${cleanTitle}`;
  const videoId = cleanId;

  const coverFormats = ['mp3', 'm4a', 'flac', 'opus', 'ogg'];
  const canCarryCover = !isRaw && coverFormats.includes(ext);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '-x',
    '--audio-format', ext,
    '--audio-quality', safeQuality,
    '--embed-metadata',
    '-o', tempTemplate,
    '--extractor-args', 'youtube:player_client=default,android',
  ];
  if (canCarryCover) {
    args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  }
  if (trimArgs.length) {
    args.push(...trimArgs);
  }
  args.push('--', targetUrl);

  try {
    await executeYtDlp(args, 60000, { onChild: c => { child = c; }, reason: 'download' });
    if (!isRaw) {
      await cleanupDownloadArtifacts(downloadsDir, beforeFiles, baseName, videoId, ext, true);
      downloadsIndex = null;
    }
    sendDownloadResponse(200, isRaw ? {
      success: true,
      tempName: tempName
    } : {
      success: true,
      filename: outFilename,
      directory: downloadsDir
    });
  } catch (err) {
    try { logger.error('Download primary failed: ' + (title || trackUrl), err); } catch (_) {}
    if (res.writableEnded) {
      sendDownloadResponse(500, { success: false, error: err.message });
      return;
    }
    try {
      const fallbackArgs = [
        '--no-playlist',
        '--no-warnings',
        '-x',
        '--audio-format', ext,
        '--audio-quality', safeQuality,
        '--embed-metadata',
        '-o', tempTemplate,
      ];
      if (canCarryCover) {
        fallbackArgs.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
      }
      if (trimArgs.length) {
        fallbackArgs.push(...trimArgs);
      }
      fallbackArgs.push('--', targetUrl);

      await executeYtDlp(fallbackArgs, 60000, { onChild: c => { child = c; }, reason: 'download-fallback' });
      if (!isRaw) {
        await cleanupDownloadArtifacts(downloadsDir, beforeFiles, baseName, videoId, ext, true);
        downloadsIndex = null;
      }
      sendDownloadResponse(200, isRaw ? {
        success: true,
        tempName: tempName
      } : {
        success: true,
        filename: outFilename,
        directory: downloadsDir
      });
    } catch (e2) {
      if (!isRaw) {
        await cleanupDownloadArtifacts(downloadsDir, beforeFiles, baseName, videoId, ext, false);
      } else {
        await cleanupPartial();
      }
      try { logger.error('Download failure: ' + (title || trackUrl) + ' (' + (e2.message || err.message) + ')', e2); } catch (_) {}
      sendDownloadResponse(500, { success: false, error: e2.message || err.message });
    }
  }
  } finally {
    if (downloadKey && downloadInFlight.get(downloadKey) === downloadPromise) {
      downloadInFlight.delete(downloadKey);
    }
    if (resolveDownload && !downloadOutcome) {
      resolveDownload({ status: 500, body: { success: false, error: 'Download ended without a result' } });
    }
  }
}

function handleTmpFile(req, res, parsedUrl) {
  const fileName = parsedUrl.query.name || '';
  if (!/^[\w .-]+\.wav$/.test(fileName) || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid file name' }));
  }
  const downloadsDir = getDownloadsDir();
  const filePath = path.join(downloadsDir, '.tmp', fileName);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'File not found' }));
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': stat.size
  });
  streamFileToResponse(fs.createReadStream(filePath), res);
}

async function handleEncode(req, res, parsedUrl) {
  const sourceName = parsedUrl.query.name || '';
  const title = parsedUrl.query.title || 'untitled';
  const artist = parsedUrl.query.artist || 'unknown artist';
  const format = parsedUrl.query.format || 'mp3';
  const quality = parsedUrl.query.quality || '0';

  const validFormats = ['mp3', 'm4a', 'flac', 'opus', 'wav', 'ogg'];
  const safeFormat = String(format || '').toLowerCase();
  const ext = validFormats.includes(safeFormat) ? safeFormat : 'mp3';
  const bitrateMap = {
    '0': '320k',
    '2': '256k',
    '4': '192k',
    '5': '128k',
  };
  const bitrate = bitrateMap[String(quality)] || '320k';

  const downloadsDir = getDownloadsDir();
  const tmpDir = path.join(downloadsDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    try { await fs.promises.mkdir(tmpDir, { recursive: true }); } catch (_) {}
  }
  const cleanTitle = sanitizeFilename(title);
  const cleanArtist = sanitizeFilename(artist);
  const outFilename = `${cleanArtist} - ${cleanTitle}.${ext}`;
  const outPath = path.join(downloadsDir, outFilename);

  const renderTempName = 'render_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.wav';
  const renderTempPath = path.join(tmpDir, renderTempName);

  const MAX_BODY_SIZE = 500 * 1024 * 1024;
  let receivedBytes = 0;
  let aborted = false;

  const fileWriteStream = fs.createWriteStream(renderTempPath);

  try {
    await new Promise((resolve, reject) => {
      req.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BODY_SIZE) {
          aborted = true;
          try { req.destroy(new Error('Payload too large')); } catch (_) {}
          try { fileWriteStream.destroy(); } catch (_) {}
          try { fs.unlinkSync(renderTempPath); } catch (_) {}
          if (!res.writableEnded) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'WAV exceeds 300MB limit' }));
          }
          reject(new Error('Payload too large'));
          return;
        }
        fileWriteStream.write(chunk);
      });
      req.on('end', () => {
        fileWriteStream.end(() => resolve());
      });
      req.on('error', err => {
        try { fs.unlinkSync(renderTempPath); } catch (_) {}
        reject(err);
      });
      fileWriteStream.on('error', err => {
        try { fs.unlinkSync(renderTempPath); } catch (_) {}
        reject(err);
      });
    });
  } catch (readErr) {
    if (aborted) return;
    try { fs.unlinkSync(renderTempPath); } catch (_) {}
    if (!res.writableEnded) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: readErr.message || 'Failed to read audio body' }));
    }
    return;
  }

  const ffmpegBin = resolveBinary('ffmpeg');
  if (!ffmpegBin) {
    try { await fs.promises.unlink(renderTempPath); } catch (_) {}
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'ffmpeg not found' }));
    }
    return;
  }

  let ffmpegProc = null;
  res.on('close', () => {
    if (!res.writableEnded && ffmpegProc) {
      try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
      try { fs.unlinkSync(renderTempPath); } catch (_) {}
      try { fs.unlinkSync(outPath); } catch (_) {}
    }
  });

  const ffmpegArgs = ['-y', '-i', renderTempPath];
  if (['mp3', 'm4a', 'opus', 'ogg'].includes(ext)) {
    ffmpegArgs.push('-b:a', bitrate);
  }
  ffmpegArgs.push('-metadata', `title=${title}`);
  ffmpegArgs.push('-metadata', `artist=${artist}`);
  ffmpegArgs.push(outPath);

  try {
    await new Promise((resolve, reject) => {
      ffmpegProc = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
      ffmpegProc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ffmpegProc.on('error', reject);
    });

    downloadsIndex = null;
    if (!res.writableEnded) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        filename: outFilename,
        directory: downloadsDir
      }));
    }
  } catch (err) {
    try { logger.error('Encode failure: ' + (title || sourceName) + ' (' + err.message + ')', err); } catch (_) {}
    try { await fs.promises.unlink(outPath); } catch (_) {}
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message || 'Encoding failed' }));
    }
  } finally {
    try { await fs.promises.unlink(renderTempPath); } catch (_) {}
    if (sourceName && /^[\w .-]+\.wav$/.test(sourceName)) {
      try { await fs.promises.unlink(path.join(tmpDir, sourceName)); } catch (_) {}
    }
  }
}

const { parseForLyrics, pickBest } = require('./lyrics-match');
const LRCLIB_UA = 'Muriel (https://github.com/cloverscripts/riff-muriel)';

function lrclibJson(pathAndQuery) {
  return new Promise((resolve) => {
    const req = https.get(`https://lrclib.net${pathAndQuery}`, { headers: { 'User-Agent': LRCLIB_UA }, timeout: 5000 }, (res) => {
      let data = '';
      const dec = new StringDecoder('utf8');
      res.on('data', (c) => { data += typeof c === 'string' ? c : dec.write(c); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// YouTube-style titles ("Artist, Feat - Song (Official Video)") are cleaned into what lrclib lists, tried as
// exact lookups first (with the song length when known), then as a search where only a real match counts
async function fetchLyricsDirect(title, artist, duration = 0) {
  const want = parseForLyrics(title, artist);
  const [t0, t1] = want.titles;
  const [a0, a1] = want.artists;
  if (!t0) return null;
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const dur = duration > 0 ? Math.round(duration) : 0;
  const tries = [[t0, a0, dur], [t0, a0, 0], [t0, a1, 0], [t1, a0, 0]].filter(([t, a, d], i) => t && a && (i !== 1 || dur));
  const exact = await Promise.all(tries.map(([t, a, d]) => lrclibJson(`/api/get?${q({ track_name: t, artist_name: a, duration: d })}`)));
  let plain = null;
  for (const hit of exact) {
    if (hit && hit.syncedLyrics) return hit.syncedLyrics;
    if (hit && hit.plainLyrics && !plain) plain = hit.plainLyrics;
  }
  const primary = want.artists.find((a) => !/[,&]/.test(a)) || a0 || '';
  const searches = await Promise.all([
    lrclibJson(`/api/search?${q({ track_name: t0, artist_name: primary })}`),
    lrclibJson(`/api/search?${q({ q: `${primary} ${t0}`.trim() })}`),
  ]);
  // last resort: the title alone; pickBest still wants the artist or the length to match
  if (!plain && !searches.some((list) => pickBest(list, want, dur))) searches.push(await lrclibJson(`/api/search?${q({ track_name: t0 })}`));
  for (const list of searches) {
    const best = pickBest(list, want, dur);
    if (best && best.syncedLyrics) return best.syncedLyrics;
    if (best && best.plainLyrics && !plain) plain = best.plainLyrics;
  }
  return plain;
}

// ---------- Riff 43: Genius (plain lyrics) and NetEase (word timings) ----------
const lyricsSources = require('./lyrics-sources');
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function lyricsPageText(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, timeout: timeoutMs }, (res) => {
      let data = '';
      const dec = new StringDecoder('utf8');
      res.on('data', (c) => { data += typeof c === 'string' ? c : dec.write(c); if (data.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const lyricsPageJson = async (url, headers) => { const t = await lyricsPageText(url, headers); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };

// the song's page on Genius, found by its cleaned-up title and artist; only a real title match counts
async function fetchGeniusLyrics(title, artist) {
  const want = parseForLyrics(title, artist);
  const t0 = want.titles[0];
  const a0 = want.artists.find((a) => !/[,&]/.test(a)) || want.artists[0] || '';
  if (!t0) return null;
  const json = await lyricsPageJson(`https://genius.com/api/search/song?q=${encodeURIComponent(`${t0} ${a0}`.trim())}`);
  const sections = (json && json.response && json.response.sections) || [];
  const hits = sections.flatMap((s) => (s && s.hits) || []);
  const url = lyricsSources.pickGeniusHit(hits, t0, want.artists.join(', '));
  if (!url) return null;
  const html = await lyricsPageText(url);
  const text = html ? lyricsSources.extractGeniusLyrics(html) : '';
  return text || null;
}

// NetEase's word-timed lyrics for karaoke: [{ start, end, text, words: [{ text, start, end }] }] or null
const NETEASE_HEADERS = { Referer: 'https://music.163.com/' };
const wordsCache = new Map();
async function fetchNetEaseWords(title, artist, duration = 0) {
  const want = parseForLyrics(title, artist);
  const t0 = want.titles[0];
  const a0 = want.artists.find((a) => !/[,&]/.test(a)) || want.artists[0] || '';
  if (!t0) return null;
  const key = `${t0}\u0000${a0}\u0000${Math.round(duration || 0)}`;
  const hit = wordsCache.get(key);
  if (hit && (!hit.expires || Date.now() < hit.expires)) return hit.lines;
  let lines = null;
  const search = await lyricsPageJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(`${t0} ${a0}`.trim())}&type=1&limit=8`, NETEASE_HEADERS);
  const songs = (search && search.result && search.result.songs) || [];
  const id = lyricsSources.pickNetEaseSong(songs, t0, want.artists.join(', '), duration);
  if (id) {
    const lyr = await lyricsPageJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1&yv=1`, NETEASE_HEADERS);
    const parsed = lyr && lyr.yrc && lyr.yrc.lyric ? lyricsSources.parseYrc(lyr.yrc.lyric) : [];
    if (parsed.length) lines = parsed;
  }
  // nothing found looks the same as a network hiccup: ask again after 10 minutes
  wordsCache.set(key, lines ? { lines } : { lines: null, expires: Date.now() + 10 * 60 * 1000 });
  trimCache(wordsCache, 200);
  return lines;
}

const crypto = require('crypto');

const SERVER_TOKEN = crypto.randomBytes(24).toString('hex');

const TOKEN_PROTECTED_ROUTES = new Set([
  '/api/state',
  '/api/translate',
  '/api/i18n-batch',
  '/api/vibe',
  '/api/radio',
  '/api/search',
  '/api/artist',
  '/api/lyrics',
  '/api/download',
  '/api/spotify-import',
  '/api/spotify-auth-start',
  '/api/spotify-status',
  '/api/spotify-library',
  '/api/spotify-logout',
  '/api/prefetch',
  '/api/check-cache',
  '/api/stream-info',
  '/api/track-analysis',
  '/api/tools-status',
  '/api/tools-install',
  '/api/library',
  '/api/library-add',
  '/api/library-update',
  '/api/library-remove',
  '/api/offline-library',
  '/api/offline-delete',
  '/api/clear-offline-library',
  '/api/save-custom-lyrics',
  '/api/encode',
  '/api/apple-import',
  '/api/playlist-import',
  '/api/yandex-import'
]);

// Every route needs the token: any web page the user visits can send requests to 127.0.0.1, so a route without
// it was usable by any site (an open proxy into the home network, reading Downloads, what's playing).
// Only the Spotify login redirect (it comes from the browser) and the CLI's lyrics feed go without; the feed
// refuses any request a web page makes (those carry an Origin header).
const PUBLIC_ROUTES = new Set(['/api/spotify-callback', '/api/lyrics-stream']);
const routeNeedsToken = (pathname) => pathname.startsWith('/api/') && !PUBLIC_ROUTES.has(pathname);
// <audio>/<img> can't send headers, so the media URLs the server hands out carry the token as ?t=
const withToken = (u) => `${u}${u.includes('?') ? '&' : '?'}t=${encodeURIComponent(SERVER_TOKEN)}`;

function getServerToken() {
  return SERVER_TOKEN;
}

function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  const expected = Buffer.from(SERVER_TOKEN);
  const given = Buffer.from(provided);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(given, expected);
  } catch (e) {
    return false;
  }
}

function legacyCustomLyricsPath(title, artist) {
  const safeName = `${(artist || 'unknown').replace(/[^\w\s-]/g, '_')}_${(title || 'untitled').replace(/[^\w\s-]/g, '_')}.lrc`.toLowerCase().replace(/\s+/g, '_');
  return path.join(CUSTOM_LYRICS_DIR, safeName);
}

function legacyFetchedLyricsPath(title, artist) {
  const cleanTitle = (title || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const cleanArtist = (artist || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return path.join(LYRICS_DIR, `${cleanArtist}___${cleanTitle}.lrc`);
}

function lyricsKey(title, artist) {
  return crypto.createHash('sha1').update(`${(artist || '').trim().toLowerCase()}\u0000${(title || '').trim().toLowerCase()}`).digest('hex').slice(0, 16);
}

function getCustomLyricsPath(title, artist) {
  return path.join(CUSTOM_LYRICS_DIR, lyricsKey(title, artist) + '.lrc');
}

function getFetchedLyricsPath(title, artist, source = 'lrclib') {
  return path.join(LYRICS_DIR, lyricsKey(title, artist) + (source === 'genius' ? '_genius' : '') + '.lrc');
}

async function handleLyrics(req, res, title, artist, allowOnline = true, duration = 0, source = 'lrclib') {
  // Settings → Lyrics source picks which site is asked first; the other one is the fallback
  const order = source === 'genius' ? ['genius', 'lrclib'] : ['lrclib', 'genius'];
  const cacheKey = order[0] === 'genius' ? `${artist}:${title}:genius` : `${artist}:${title}`;
  let cached = lyricsCache.get(cacheKey);
  if (cached && cached.expires && Date.now() > cached.expires) {
    lyricsCache.delete(cacheKey);
    cached = undefined;
  }
  if (cached?.promise) {
    const outcome = await cached.promise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome));
  }
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, lyrics: cached.text, isCustom: cached.isCustom || false }));
  }

  let resolveLyrics;
  const lyricsPromise = new Promise(resolve => { resolveLyrics = resolve; });
  const inFlightEntry = { promise: lyricsPromise };
  lyricsCache.set(cacheKey, inFlightEntry);
  let outcome = null;
  const sendLyrics = (lyrics, isCustom = false) => {
    outcome = { success: true, lyrics, isCustom };
    resolveLyrics(outcome);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome));
  };

  try {
  let customPath = getCustomLyricsPath(title, artist);
  if (!fs.existsSync(customPath) && /^[\x00-\x7F]*$/.test((title || '') + (artist || ''))) {
    const legacyPath = legacyCustomLyricsPath(title, artist);
    if (fs.existsSync(legacyPath)) {
      customPath = legacyPath;
    }
  }

  if (fs.existsSync(customPath)) {
    try {
      const customLyrics = await fs.promises.readFile(customPath, 'utf-8');
      if (lyricsCache.get(cacheKey) === inFlightEntry) {
        lyricsCache.set(cacheKey, { text: customLyrics, isCustom: true });
      }
      return sendLyrics(customLyrics, true);
    } catch (e) {}
  }

  // each site's lyrics are saved in their own file; the preferred site (saved or asked) comes first, then the other
  let rawLyrics = null;
  for (const backend of order) {
    let fetchedLyricsPath = getFetchedLyricsPath(title, artist, backend);
    if (backend === 'lrclib' && !fs.existsSync(fetchedLyricsPath) && /^[\x00-\x7F]*$/.test((title || '') + (artist || ''))) {
      const legacyFetched = legacyFetchedLyricsPath(title, artist);
      if (fs.existsSync(legacyFetched)) {
        fetchedLyricsPath = legacyFetched;
      }
    }

    if (fs.existsSync(fetchedLyricsPath)) {
      try {
        const diskLyrics = await fs.promises.readFile(fetchedLyricsPath, 'utf-8');
        if (lyricsCache.get(cacheKey) === inFlightEntry) {
          lyricsCache.set(cacheKey, { text: diskLyrics, isCustom: false });
        }
        return sendLyrics(diskLyrics);
      } catch (e) {}
    }

    if (!allowOnline) continue;

    try {
      rawLyrics = backend === 'genius' ? await fetchGeniusLyrics(title, artist) : await fetchLyricsDirect(title, artist, duration);
    } catch (err) {
      rawLyrics = null;
    }
    if (rawLyrics && rawLyrics.trim().length > 0) {
      try {
        await fs.promises.writeFile(fetchedLyricsPath, rawLyrics, 'utf-8');
      } catch (e) {}
      break;
    }
  }

  if (!allowOnline) {
    return sendLyrics('');
  }

  if (lyricsCache.get(cacheKey) === inFlightEntry) {
    // "nothing found" is also what a network hiccup looks like: look again after 10 minutes
    // instead of showing no lyrics for this song until the app restarts
    lyricsCache.set(cacheKey, rawLyrics ? { text: rawLyrics, isCustom: false } : { text: rawLyrics, isCustom: false, expires: Date.now() + 10 * 60 * 1000 });
  }
  return sendLyrics(rawLyrics);
  } finally {
    if (!outcome) {
      outcome = { success: true, lyrics: '', isCustom: false };
      resolveLyrics(outcome);
    }
    if (lyricsCache.get(cacheKey) === inFlightEntry) {
      lyricsCache.delete(cacheKey);
    }
    trimCache(lyricsCache, 300);
  }
}

async function handleSaveCustomLyrics(req, res, title, artist) {
  let body = '';
  req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
  req.on('end', async () => {
    try {
      const { lyrics } = JSON.parse(body);
      if (typeof lyrics !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No lyrics provided' }));
      }

      const customPath = getCustomLyricsPath(title, artist);
      await fs.promises.writeFile(customPath, lyrics, 'utf-8');

      const cacheKey = `${artist}:${title}`;
      lyricsCache.delete(cacheKey);
      lyricsCache.delete(`${cacheKey}:genius`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

const SPOTIFY_PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const SPOTIFY_FETCH_PLAYLIST_HASH = '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a';

function pathfinderRequest(accessToken, variables) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      variables,
      operationName: 'fetchPlaylist',
      extensions: { persistedQuery: { version: 1, sha256Hash: SPOTIFY_FETCH_PLAYLIST_HASH } }
    });
    const req = https.request(SPOTIFY_PATHFINDER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://open.spotify.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    }, (r) => {
      try { logger.log(r.statusCode === 200 ? 'warn' : 'error', `api-partner.spotify.com status ${r.statusCode}`); } catch (_) {}
      let b = '';
      r.on('error', reject);
      r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`Pathfinder status ${r.statusCode}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Invalid pathfinder response')); }
      });
    });
    req.on('error', (err) => {
      try { logger.log('error', `api-partner.spotify.com error: ${err.message}`); } catch (_) {}
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      try { logger.log('error', 'api-partner.spotify.com timeout'); } catch (_) {}
      reject(new Error('Pathfinder request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

async function fetchFullSpotifyPlaylist(playlistId, accessToken) {
  const uri = `spotify:playlist:${playlistId}`;
  const first = await pathfinderRequest(accessToken, { uri, offset: 0, limit: 100, enableWatchFeedEntrypoint: true });
  const content = first?.data?.playlistV2?.content;
  if (!content || !Array.isArray(content.items)) return null;
  const total = content.totalCount || content.items.length;
  const items = content.items.slice();
  let offset = items.length;
  let guard = 0;
  while (offset < total && guard++ < 100) {
    const page = await pathfinderRequest(accessToken, { uri, offset, limit: 100, enableWatchFeedEntrypoint: true });
    const pageItems = page?.data?.playlistV2?.content?.items;
    if (!Array.isArray(pageItems) || pageItems.length === 0) throw new Error('Incomplete Pathfinder playlist');
    items.push(...pageItems);
    offset += pageItems.length;
  }
  if (offset < total) throw new Error('Incomplete Pathfinder playlist');
  const tracks = items.map(it => {
    const t = it?.itemV2?.data || it?.item?.data || {};
    const artists = (t.albumOfTrack?.artists?.items || []).map(a => a.profile?.name).filter(Boolean);
    const durationMs = t.trackDuration?.totalMilliseconds || t.duration?.totalMilliseconds || t.duration_ms;
    const duration = typeof durationMs === 'number' ? Math.round(durationMs / 1000) : 0;
    return { title: (t.name || '').trim(), artist: artists.join(', '), duration };
  }).filter(t => t.title);
  return { tracks, total };
}

async function trySpotifyWebApi(playlistId) {
  loadSpotifyAuth();
  if (!spotifyAuth.token && !spotifyAuth.refreshToken) return null;
  try {
    const resp = await spotifyGetWithRetry(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`);
    if (resp.status >= 200 && resp.status < 300) {
      const d = JSON.parse(resp.body);
      const name = d.name || 'Spotify Playlist';
      const cover = (d.images && Array.isArray(d.images) && d.images[0] && d.images[0].url) ? d.images[0].url : '';
      const playlistItems = d.items || d.tracks;
      if (!Array.isArray(playlistItems?.items)) return null;
      let items = playlistItems.items.slice();
      let nextUrl = playlistItems?.next;
      let guard = 0;
      while (nextUrl && guard++ < 100) {
        const nextResp = await spotifyGetWithRetry(nextUrl);
        if (nextResp.status < 200 || nextResp.status >= 300) return null;
        const nextData = JSON.parse(nextResp.body);
        if (!Array.isArray(nextData.items) || !nextData.items.length) return null;
        items.push(...nextData.items);
        nextUrl = nextData.next;
      }
      if (nextUrl || (Number.isInteger(playlistItems.total) && items.length < playlistItems.total)) return null;
      const tracks = items.map(it => {
        const t = it?.item || it?.track || it || {};
        return {
          title: t.name || '',
          artist: Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : '',
          duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined
        };
      }).filter(t => t.title);
      return { success: true, name, cover, tracks, total: tracks.length };
    }
  } catch (e) {}
  return null;
}

function fetchSpotifyEmbed(playlistId, ua) {
  return new Promise((resolve, reject) => {
    const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
    const req = https.get(embedUrl, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/json',
        'Referer': 'https://open.spotify.com/'
      },
      timeout: 10000
    }, (res) => {
      try { logger.log(res.statusCode === 200 ? 'warn' : 'error', `open.spotify.com status ${res.statusCode}`); } catch (_) {}
      let body = '';
      res.on('error', reject);
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => {
      try { logger.log('error', `open.spotify.com error: ${err.message}`); } catch (_) {}
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      try { logger.log('error', 'open.spotify.com timeout'); } catch (_) {}
      reject(new Error('timeout'));
    });
  });
}

async function handleSpotifyImport(req, res, inputUrl) {
  const m = (inputUrl || '').match(/^(?:(?:https:\/\/)?open\.spotify\.com\/(?:embed\/)?playlist\/|spotify:playlist:)([a-zA-Z0-9]{22})(?:[/?#]|$)/);
  if (!m) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_error', error: 'Invalid Spotify playlist URL' }));
  }
  const playlistId = m[1];
  const apiResult = await trySpotifyWebApi(playlistId);
  if (apiResult && apiResult.tracks.length) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiResult));
  }
  const primaryUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const retryUa = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';

  let embedRes;
  try {
    embedRes = await fetchSpotifyEmbed(playlistId, primaryUa);
    if (embedRes.status === 403 || embedRes.status === 429) {
      await new Promise(r => setTimeout(r, 800));
      embedRes = await fetchSpotifyEmbed(playlistId, retryUa);
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_error', error: 'Network error connecting to Spotify' }));
  }

  if (embedRes.status === 404) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_not_found', error: 'Playlist not found' }));
  }
  if (embedRes.status === 403) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_forbidden', error: 'Spotify refused request (403)' }));
  }
  if (embedRes.status === 429) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_rate_limited', error: 'Spotify rate limited (429)' }));
  }
  if (embedRes.status !== 200) {
    res.writeHead(embedRes.status || 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, code: 'spotify_error', error: `Spotify returned status ${embedRes.status}` }));
  }

  try {
    const body = embedRes.body;
    const nextDataMatch = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) {
      const isPriv = /private/i.test(body);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, code: isPriv ? 'spotify_forbidden' : 'spotify_error', error: isPriv ? 'Private playlist' : 'Could not parse playlist' }));
    }

    const data = JSON.parse(nextDataMatch[1]);
    const pageProps = data?.props?.pageProps;
    if (pageProps?.status === 404) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, code: 'spotify_not_found', error: 'Playlist not found' }));
    }

    const entity = pageProps?.state?.data?.entity;
    const name = entity?.name || pageProps?.title || 'Spotify Playlist';
    const ogMatch = body.match(/<meta\s+(?:property|name)=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i);
    let cover = (entity?.images && Array.isArray(entity.images) && entity.images[0]?.url) ||
                (entity?.coverArt?.sources && Array.isArray(entity.coverArt.sources) && entity.coverArt.sources[0]?.url) ||
                entity?.image ||
                pageProps?.metadata?.image ||
                (ogMatch ? ogMatch[1] : '') ||
                '';

    let tracks = [];
    let limited = false;
    const accessToken = pageProps?.state?.settings?.session?.accessToken;
    let total = 0;
    if (accessToken) {
      try {
        const full = await fetchFullSpotifyPlaylist(playlistId, accessToken);
        if (full && full.tracks && full.tracks.length) {
          tracks = full.tracks;
          total = full.tracks.length;
        } else {
          limited = true;
          try { logger.log('warn', 'Spotify pathfinder non-200 or empty, falling back to embed trackList'); } catch (_) {}
        }
      } catch (e) {
        limited = true;
        try { logger.log('warn', `Spotify pathfinder error: ${e.message}, falling back to embed trackList`); } catch (_) {}
      }
    } else {
      limited = true;
    }

    if (!tracks.length) {
      if (Array.isArray(entity?.trackList) && entity.trackList.length > 0) {
        tracks = entity.trackList.slice(0, 100).map(t => {
          const duration = typeof t.duration === 'number' ? Math.round(t.duration / 1000) : (typeof t.duration_ms === 'number' ? Math.round(t.duration_ms / 1000) : 0);
          return {
            title: (t.title || t.name || '').trim(),
            artist: (t.subtitle || t.artist || '').trim(),
            duration
          };
        }).filter(t => t.title);
      }
      if (!tracks.length) {
        const seen = new Set();
        function walk(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const item of node) walk(item); return; }
          const uri = typeof node.uri === 'string' ? node.uri : '';
          const title = node.title || node.name;
          const subtitle = node.subtitle || node.artist || (Array.isArray(node.artists) ? node.artists.map(a => typeof a === 'string' ? a : (a.name || a.profile?.name)).filter(Boolean).join(', ') : (node.albumOfTrack?.artists?.items || []).map(a => a.profile?.name).filter(Boolean).join(', '));
          const duration = node.duration?.totalMilliseconds || node.trackDuration?.totalMilliseconds || node.duration_ms || (typeof node.duration === 'number' ? node.duration : 0);
          if (title && typeof title === 'string' && (subtitle || uri.startsWith('spotify:track:')) && (uri.startsWith('spotify:track:') || node.entityType === 'track' || duration)) {
            const key = `${title}__${subtitle || ''}`;
            if (!seen.has(key)) {
              seen.add(key);
              const durSec = typeof duration === 'number' ? (duration > 1000 ? Math.round(duration / 1000) : Math.round(duration)) : 0;
              tracks.push({ title: title.trim(), artist: typeof subtitle === 'string' ? subtitle.trim() : '', duration: durSec });
            }
            return;
          }
          for (const k of Object.keys(node)) walk(node[k]);
        }
        walk(data);
        tracks = tracks.slice(0, 100);
      }
    }

    if (!total) {
      total = entity?.totalCount || (Array.isArray(entity?.trackList) ? entity.trackList.length : 0) || tracks.length;
    }

    if (!tracks.length) {
      const isPriv = /private/i.test(body) || /private/i.test(JSON.stringify(pageProps || {}));
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, code: isPriv ? 'spotify_forbidden' : 'spotify_error', error: isPriv ? 'Private playlist' : 'Could not read tracks' }));
    }

    if (limited && (!Array.isArray(entity?.trackList) || !Number.isInteger(entity.totalCount) || entity.totalCount > entity.trackList.length || entity.trackList.length > 100)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, code: 'spotify_incomplete', error: 'Spotify exposed only part of this playlist. Connect your account or use Export files.' }));
    }
    const hasMore = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, name, cover, tracks, hasMore, total, limited }));
  } catch (err) {
    try { logger.log('error', `Spotify import failed: ${err.message}`); } catch (_) {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, code: 'spotify_error', error: 'Internal server error' }));
  }
}

function fetchHtmlWithRedirects(targetUrl, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function fetchUrl(currentUrl) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (e) { return reject(e); }
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain the redirect body so its socket is released
          if (++redirects > maxRedirects) {
            return reject(new Error('Too many redirects'));
          }
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, currentUrl).toString(); } catch (e) { return reject(e); }
          return fetchUrl(nextUrl);
        }
        let body = '';
        res.on('error', reject);
        res.on('data', c => body += c);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    }
    fetchUrl(targetUrl);
  });
}

async function handleAppleImport(req, res, inputUrl) {
  // only real Apple Music pages: the playlist branch fetches this URL, and a pattern that matched anywhere
  // in the string let a link like http://127.0.0.1/...music.apple.com/pl.x make Muriel fetch local addresses
  let host = '';
  inputUrl = String(inputUrl || '').trim();
  if (inputUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(inputUrl)) inputUrl = `https://${inputUrl}`; // pasted without https://
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') host = parsed.hostname.toLowerCase();
  } catch (e) {}
  if (host !== 'music.apple.com' && host !== 'itunes.apple.com') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Not an Apple Music link' }));
  }
  const albumMatch = (inputUrl || '').match(/music\.apple\.com\/(?:[a-z]{2}\/)?album\/(?:[^/]+\/)?(\d+)/i);
  if (albumMatch) {
    try {
      const data = await fetchItunesJson(`https://itunes.apple.com/lookup?id=${albumMatch[1]}&entity=song`);
      const results = (data && Array.isArray(data.results)) ? data.results : [];
      const albumItem = results.find(r => r && r.wrapperType === 'collection');
      if (albumItem) {
        const tracks = results
          .filter(r => r && r.wrapperType === 'track')
          .map(item => ({
            title: item.trackName || '',
            artist: item.artistName || albumItem.artistName || '',
            duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 0
          }));
        if (tracks.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            name: albumItem.collectionName || 'Album',
            cover: (albumItem.artworkUrl100 || '').replace('100x100', '600x600'),
            tracks
          }));
        }
      }
    } catch (_) {}
  }

  const m = (inputUrl || '').match(/music\.apple\.com\/.*?(pl\.(?:u-)?[a-zA-Z0-9_-]+)/i);
  if (!m) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid Apple Music playlist URL' }));
  }

  try {
    const fetched = await fetchHtmlWithRedirects(inputUrl, 5, 15000);
    const { statusCode, body } = fetched;

    if (statusCode === 404) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'not_found', status: 404 }));
    }
    if (statusCode === 429) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'rate_limit', status: 429 }));
    }
    if (statusCode === 401 || statusCode === 403) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'private', status: 403 }));
    }

    let parsedData = null;
    const serverDataMatch = body.match(/<script\s+type=["']application\/json["']\s+id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (serverDataMatch) {
      try { parsedData = JSON.parse(serverDataMatch[1]); } catch (e) {}
    }
    if (!parsedData) {
      const ldMatch = body.match(/<script\s+id=["']schema:music-playlist["']\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try { parsedData = JSON.parse(ldMatch[1]); } catch (e) {}
      }
    }

    if (!parsedData) {
      const isPriv = /private|sign\s*in|login/i.test(body);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: isPriv ? 'private' : 'restricted', status: 403 }));
    }

    const tracks = [];
    const seen = new Set();
    let plTitle = '';
    let plCover = '';
    let totalCount = 0;

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      if (!plTitle) {
        if (node.contentDescriptor?.kind === 'playlist' || node.type === 'playlists' || node.type === 'playlist') {
          plTitle = node.title || node.name || node.attributes?.name || '';
          if (node.artwork?.dictionary?.url) plCover = node.artwork.dictionary.url;
          else if (node.artwork?.url) plCover = node.artwork.url;
        } else if (node['@type'] === 'MusicPlaylist') {
          plTitle = node.name || '';
        }
      }

      if (!totalCount && typeof node.trackCount === 'number') {
        totalCount = node.trackCount;
      }

      const title = (typeof node.title === 'string' ? node.title : (typeof node.name === 'string' && (node['@type'] === 'MusicRecording' || node.type === 'songs') ? node.name : '')).trim();
      const artist = (typeof node.artistName === 'string' ? node.artistName : (typeof node.artist === 'string' ? node.artist : (typeof node.byArtist?.name === 'string' ? node.byArtist.name : ''))).trim();
      const durRaw = node.durationInMillis || node.duration || node.duration_ms;
      let duration;
      if (typeof durRaw === 'number') {
        duration = durRaw > 1000 ? Math.round(durRaw / 1000) : Math.round(durRaw);
      } else if (typeof durRaw === 'string' && durRaw.startsWith('PT')) {
        const mDur = durRaw.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        if (mDur) duration = (parseInt(mDur[1] || '0', 10) * 60) + parseInt(mDur[2] || '0', 10);
      }

      if (title && artist && (node.contentDescriptor?.kind === 'song' || node.contentDescriptor?.kind === 'music-video' || node.type === 'songs' || node.type === 'song' || node.type === 'library-songs' || node['@type'] === 'MusicRecording' || duration || node.audioTraits)) {
        const key = `${title.toLowerCase()}___${artist.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ title, artist, duration });
        }
        return;
      }

      for (const k of Object.keys(node)) {
        walk(node[k]);
      }
    }

    walk(parsedData);

    if (!plTitle) {
      const ogMatch = body.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
      if (ogMatch) {
        plTitle = ogMatch[1].replace(/\s*on Apple Music\s*$/i, '').trim();
      } else {
        const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
        if (titleMatch) {
          plTitle = titleMatch[1].replace(/\s*-\s*Playlist\s*-\s*Apple Music\s*$/i, '').replace(/^[^\w\s]+/, '').trim();
        }
      }
    }

    if (plCover && typeof plCover === 'string' && plCover.includes('{w}x{h}bb.{f}')) {
      plCover = plCover.replace('{w}x{h}bb.{f}', '600x600bb.jpg');
    }

    if (!tracks.length) {
      const isPriv = /private|sign\s*in|login/i.test(body) || !tracks.length;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: isPriv ? 'private' : 'restricted', status: 403 }));
    }

    const total = totalCount || tracks.length;
    const hasMore = total > tracks.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, name: plTitle || 'Apple Music Playlist', cover: plCover, tracks, hasMore, total }));
  } catch (err) {
    try { logger.error('Apple import failed: ' + inputUrl, err); } catch (_) {}
    const isNet = err.message === 'timeout' || /fetch|network|dns|econnrefused|etimedout/i.test(err.message || '');
    res.writeHead(isNet ? 504 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: isNet ? 'network' : 'unknown', status: isNet ? 504 : 500 }));
  }
}

// A SoundCloud link as the api resolves it: share links (on.soundcloud.com/…) are followed, the mobile site's
// m.soundcloud.com becomes soundcloud.com, and share tracking (?si=…&utm_…) is dropped. Secret links keep
// their token, which is part of the path.
async function soundcloudCanonicalUrl(link) {
  let u = new URL(String(link).trim());
  if (u.hostname === 'on.soundcloud.com') {
    const r = await fetchWithTimeout(u.href, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
    if (!r.url || /^https?:\/\/on\.soundcloud\.com/.test(r.url)) throw new Error('SoundCloud short link could not be opened');
    u = new URL(r.url);
  }
  if (/(^|\.)soundcloud\.com$/.test(u.hostname)) u.hostname = 'soundcloud.com';
  return `https://soundcloud.com${u.pathname.replace(/\/+$/, '')}`;
}

async function soundcloudApi(pathAndQuery) {
  for (const fresh of [false, true]) {
    if (fresh) scClientIdCache = { id: '', at: 0 };
    const cid = await soundcloudClientId();
    const r = await fetchWithTimeout(`https://api-v2.soundcloud.com${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}client_id=${cid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000);
    if (r.status === 401 || r.status === 403) continue; // client_id rotated
    if (!r.ok) throw new Error(`SoundCloud ${r.status}`);
    return r.json();
  }
  throw new Error('SoundCloud refused the request');
}

// A SoundCloud set or track link → { name, cover, tracks } in the order of the set
async function soundcloudImport(link) {
  const obj = await soundcloudApi(`/resolve?url=${encodeURIComponent(await soundcloudCanonicalUrl(link))}`);
  const list = obj.kind === 'track' ? [obj] : (Array.isArray(obj.tracks) ? obj.tracks.slice(0, 5000) : []);
  // long sets only carry full data for their first few tracks; the rest is fetched by id
  const full = new Map(list.filter((t) => t && t.title).map((t) => [t.id, t]));
  const missing = list.filter((t) => t && !t.title).map((t) => t.id);
  for (let i = 0; i < missing.length; i += 50) {
    const items = await soundcloudApi(`/tracks?ids=${missing.slice(i, i + 50).join(',')}`).catch(() => []);
    if (Array.isArray(items)) items.forEach((t) => full.set(t.id, t));
  }
  const tracks = list.map((t) => t && full.get(t.id)).filter(Boolean).map((t) => ({
    id: String(t.id),
    title: t.title || 'untitled',
    artist: (t.user && (t.user.username || t.user.name)) || 'unknown artist',
    duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    thumbnail: t.artwork_url || (t.user && t.user.avatar_url) || '',
    url: t.permalink_url || '',
    platform: 'soundcloud',
    isCached: false
  }));
  return { name: obj.title || 'SoundCloud Playlist', cover: obj.artwork_url || (tracks[0] && tracks[0].thumbnail) || '', tracks };
}

async function handlePlaylistImport(req, res, inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unsupported link' }));
  }

  const host = (parsed.hostname || '').toLowerCase();
  const isSoundCloud = host === 'soundcloud.com' || host === 'www.soundcloud.com' || host.endsWith('.soundcloud.com');
  const isYouTube = host === 'youtube.com' || host === 'music.youtube.com' || host === 'www.youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');

  if (!isSoundCloud && !isYouTube) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unsupported link' }));
  }

  const platform = isSoundCloud ? 'soundcloud' : (host === 'music.youtube.com' ? 'ytmusic' : 'youtube');

  if (isSoundCloud) {
    // SoundCloud's own api: share links (on.soundcloud.com) and sets with songs SoundCloud only streams
    // encrypted both work here, where yt-dlp gives up on the whole set at the first DRM-only song (#13)
    try {
      const pl = await soundcloudImport(inputUrl);
      if (pl && pl.tracks.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ...pl }));
      }
    } catch (e) {
      try { logger.log('warn', `SoundCloud import via api failed, trying yt-dlp: ${e && e.message}`); } catch (_) {}
    }
  }
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--playlist-end',
    '5000'
  ];
  if (platform === 'youtube') {
    args.unshift('--flat-playlist');
    args.push('--extractor-args', 'youtube:player_client=android');
  }
  args.push(inputUrl);

  try {
    let raw = await executeYtDlp(args, 60000, { reason: 'import' });
    let data = JSON.parse(raw);
    let entries = Array.isArray(data.entries) ? data.entries : [data];

    if (entries.length > 0 && !entries[0].title && args.includes('--flat-playlist')) {
      const deepArgs = args.filter(a => a !== '--flat-playlist');
      const deepRaw = await executeYtDlp(deepArgs, 60000, { reason: 'import-deep' });
      data = JSON.parse(deepRaw);
      entries = Array.isArray(data.entries) ? data.entries : [data];
    }

    const tracks = [];

    for (const item of entries) {
      if (!item || !item.id) continue;
      if (item.title === '[Private video]' || item.title === '[Deleted video]') continue;

      const trackUrl = platform === 'youtube'
        ? `https://www.youtube.com/watch?v=${item.id}`
        : (item.webpage_url || item.url);
      if (!trackUrl) continue;

      let titleVal = (item.title || item.track || item.fulltitle || item.name || '').trim();
      let artistVal = (item.artist || (Array.isArray(item.artists) ? item.artists.join(', ') : '') || item.creator || item.channel || item.uploader || item.album_artist || '').trim();
      if (artistVal) artistVal = artistVal.replace(/\s*-\s*Topic$/i, '').trim();

      if (titleVal.includes(' - ')) {
        const parts = titleVal.split(' - ');
        if (!artistVal || artistVal.toLowerCase() === 'unknown artist' || artistVal.toLowerCase() === 'various artists') {
          artistVal = parts[0].trim();
          titleVal = parts.slice(1).join(' - ').trim() || titleVal;
        } else if (parts[0].trim().toLowerCase() === artistVal.toLowerCase()) {
          titleVal = parts.slice(1).join(' - ').trim() || titleVal;
        }
      }
      if (!titleVal) titleVal = 'untitled';
      if (!artistVal) artistVal = 'unknown artist';

      let thumbnail = '';
      if (platform === 'youtube') {
        thumbnail = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
      } else {
        if (Array.isArray(item.thumbnails) && item.thumbnails.length > 0) {
          const t = item.thumbnails.find(x => x.id === 't500x500' || x.id === 'large' || x.id === 'crop' || x.id === 'original') || item.thumbnails[item.thumbnails.length - 1];
          thumbnail = (t && t.url) ? t.url : '';
        }
        if (!thumbnail) thumbnail = item.thumbnail || item.artwork_url || item.avatar_url || '';
      }

      tracks.push({
        id: String(item.id),
        title: titleVal,
        artist: artistVal,
        duration: Math.round(item.duration || 0),
        thumbnail,
        url: trackUrl,
        platform,
        isCached: false
      });
    }

    if (!tracks.length) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'No tracks found' }));
    }

    let cover = '';
    if (Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
      const last = data.thumbnails[data.thumbnails.length - 1];
      cover = (last && last.url) ? last.url : (typeof last === 'string' ? last : '');
    }
    if (!cover && data.thumbnail) {
      cover = typeof data.thumbnail === 'string' ? data.thumbnail : (data.thumbnail.url || '');
    }
    if (!cover && tracks.length === 1 && tracks[0] && tracks[0].thumbnail) {
      cover = tracks[0].thumbnail;
    }
    if (!cover) cover = '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, name: data.title || 'Imported playlist', cover, tracks }));
  } catch (err) {
    try { logger.error('Playlist import failed: ' + inputUrl, err); } catch (_) {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

const SPOTIFY_SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
let spotifyAuth = { verifier: '', state: '', clientId: '', token: '', refreshToken: '', expiresAt: 0 };
let spotifyAuthError = '';
let spotifyAuthLoaded = false;
// shortcut: refreshes are serialized per process; coordinate through shared storage if concurrent app instances need the same Spotify session.
let spotifyRefreshPromise = null;
const spotifyAuthPath = path.join(DATA_DIR, 'spotify-auth.enc');
const spotifySafeStorage = process.versions.electron ? require('electron').safeStorage : null;

function canStoreSpotifyAuth() {
  return spotifySafeStorage?.isEncryptionAvailable() &&
    (process.platform !== 'linux' || typeof spotifySafeStorage.getSelectedStorageBackend !== 'function' ||
      spotifySafeStorage.getSelectedStorageBackend() !== 'basic_text');
}

function loadSpotifyAuth() {
  if (spotifyAuthLoaded) return;
  if (!canStoreSpotifyAuth()) return;
  spotifyAuthLoaded = true;
  try {
    const saved = JSON.parse(spotifySafeStorage.decryptString(fs.readFileSync(spotifyAuthPath)));
    if (/^[a-f0-9]{32}$/i.test(saved.clientId) && typeof saved.refreshToken === 'string' && saved.refreshToken) {
      spotifyAuth = { ...spotifyAuth, clientId: saved.clientId, refreshToken: saved.refreshToken };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') spotifyAuthError = 'Stored Spotify login could not be read. Please connect again.';
  }
}

function saveSpotifyAuth() {
  if (!canStoreSpotifyAuth()) return false;
  const tmp = `${spotifyAuthPath}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, spotifySafeStorage.encryptString(JSON.stringify({ clientId: spotifyAuth.clientId, refreshToken: spotifyAuth.refreshToken })), { mode: 0o600 });
    fs.renameSync(tmp, spotifyAuthPath);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return false;
  }
}

function clearStoredSpotifyAuth() {
  fs.rmSync(spotifyAuthPath, { force: true });
}

function getSpotifyRedirectUri() {
  const a = server.address();
  const port = (a && typeof a === 'object' && a.port) ? a.port : PORT;
  return `http://127.0.0.1:${port}/api/spotify-callback`;
}

function requestSpotifyToken(params) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(params).toString();

    const req = https.request('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    }, (resp) => {
      let body = '';
      resp.on('error', reject);
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: resp.statusCode, data });
        } catch (e) {
          resolve({ status: resp.statusCode, error: e });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Token exchange timed out')); });
    req.write(postData);
    req.end();
  });
}

async function getSpotifyAccessToken(forceRefresh = false) {
  loadSpotifyAuth();
  if (!forceRefresh && spotifyAuth.token && (!spotifyAuth.expiresAt || Date.now() < spotifyAuth.expiresAt - 60000)) return spotifyAuth.token;
  if (!spotifyAuth.refreshToken) throw new Error('Spotify session expired. Connect your account again.');
  if (!spotifyRefreshPromise) {
    spotifyRefreshPromise = (async () => {
      const session = spotifyAuth;
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await requestSpotifyToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId });
        } catch (err) {
          result = undefined;
          if (attempt === 2) throw err;
        }
        if (result && result.status !== 429 && result.status < 500) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      }
      if (spotifyAuth !== session) throw new Error('Spotify session changed. Try again.');
      if (result.data?.error === 'invalid_grant') {
        spotifyAuth.token = '';
        spotifyAuth.refreshToken = '';
        spotifyAuth.expiresAt = 0;
        clearStoredSpotifyAuth();
        throw new Error('Spotify login expired. Connect your account again.');
      }
      if (result.status !== 200 || typeof result.data?.access_token !== 'string' || !result.data.access_token || !Number.isFinite(result.data.expires_in) || result.data.expires_in <= 0) {
        throw new Error(`Spotify token refresh failed (HTTP ${result.status}). Try again later.`);
      }
      spotifyAuth.token = result.data.access_token;
      spotifyAuth.expiresAt = Date.now() + result.data.expires_in * 1000;
      spotifyAuthError = '';
      if (typeof result.data.refresh_token === 'string' && result.data.refresh_token) {
        spotifyAuth.refreshToken = result.data.refresh_token;
        if (!saveSpotifyAuth()) spotifyAuthError = 'Spotify login could not be saved securely; reconnect after restarting Muriel.';
      }
      return spotifyAuth.token;
    })().finally(() => { spotifyRefreshPromise = null; });
  }
  return spotifyRefreshPromise;
}

function spotifyApiGet(requestUrl, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(requestUrl);
    if (u.protocol !== 'https:' || u.hostname !== 'api.spotify.com') return reject(new Error('Invalid Spotify API URL'));
    const req = https.get(u, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    }, (resp) => {
      let body = '';
      resp.on('error', reject);
      resp.on('data', c => body += c);
      resp.on('end', () => {
        resolve({ status: resp.statusCode, headers: resp.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Spotify API timed out')); });
  });
}

async function spotifyGetWithRetry(requestUrl) {
  let token = await getSpotifyAccessToken();
  let resp = await spotifyApiGet(requestUrl, token);
  if (resp.status === 401 && spotifyAuth.refreshToken) {
    token = await getSpotifyAccessToken(true);
    resp = await spotifyApiGet(requestUrl, token);
  }
  for (let attempt = 0; resp.status === 429 && attempt < 3; attempt++) {
    const retryAfter = spotifyRetryAfterSeconds(resp);
    if (retryAfter > 30) return resp;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    resp = await spotifyApiGet(requestUrl, token);
  }
  return resp;
}

function spotifyRetryAfterSeconds(resp) {
  const raw = resp.headers?.['retry-after'];
  const seconds = Number(raw);
  if (raw !== undefined && Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : 1;
}

function spotifyApiFailure(resp, endpoint) {
  let detail = '';
  try {
    const error = JSON.parse(resp.body).error;
    detail = typeof error === 'string' ? error : (error?.message || '');
  } catch (e) {}
  const failure = new Error(resp.status === 429
    ? 'Spotify rate limited the request. Try again later.'
    : `Spotify ${endpoint} returned HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
  failure.status = resp.status;
  return failure;
}

async function handleSpotifyLibrary(req, res, query) {
  loadSpotifyAuth();
  if (!spotifyAuth.token && !spotifyAuth.refreshToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
  }

  const wantLikes = query.likes === '1' || query.likes === 'true';
  const wantPlaylists = query.playlists === '1' || query.playlists === 'true';

  let likes = [];
  let playlists = [];
  const skippedPlaylists = [];

  try {
    if (wantLikes) {
      let nextUrl = 'https://api.spotify.com/v1/me/tracks?limit=50';
      while (nextUrl && likes.length < 5000) {
        const resp = await spotifyGetWithRetry(nextUrl);
        if (resp.status < 200 || resp.status >= 300) throw spotifyApiFailure(resp, 'saved tracks');
        const data = JSON.parse(resp.body);
        if (!Array.isArray(data.items)) throw new Error('Invalid Spotify saved tracks response');
        const items = data.items;
        for (const it of items) {
          const t = it?.item || it?.track;
          if (!t || t.is_local || t.type === 'episode') continue;
          const artist = (Array.isArray(t.artists) && t.artists[0]?.name) || '';
          const title = t.name || '';
          const duration = t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined;
          if (title) likes.push({ title, artist, duration });
          if (likes.length >= 5000) break;
        }
        nextUrl = data.next || null;
      }
    }

    if (wantPlaylists) {
      let userPlaylists = [];
      let plNext = 'https://api.spotify.com/v1/me/playlists?limit=50';
      while (plNext) {
        const resp = await spotifyGetWithRetry(plNext);
        if (resp.status < 200 || resp.status >= 300) throw spotifyApiFailure(resp, 'playlists');
        const data = JSON.parse(resp.body);
        if (!Array.isArray(data.items)) throw new Error('Invalid Spotify playlists response');
        const items = data.items;
        for (const pl of items) {
          if (pl && pl.id && pl.name) {
            userPlaylists.push({ id: pl.id, name: pl.name });
          }
        }
        plNext = data.next || null;
      }

      playlistLoop: for (const pl of userPlaylists) {
        const plTracks = [];
        let itemUrl = `https://api.spotify.com/v1/playlists/${encodeURIComponent(pl.id)}/items?limit=50`;
        let resp = await spotifyGetWithRetry(itemUrl);
        if (resp.status === 404 || resp.status === 400) {
          itemUrl = `https://api.spotify.com/v1/playlists/${encodeURIComponent(pl.id)}/tracks?limit=50`;
          resp = await spotifyGetWithRetry(itemUrl);
        }

        if (resp.status === 403) {
          skippedPlaylists.push({ name: pl.name, error: spotifyApiFailure(resp, `playlist items (${pl.name})`).message });
          continue;
        }
        if (resp.status < 200 || resp.status >= 300) throw spotifyApiFailure(resp, `playlist items (${pl.name})`);

        const pageData = JSON.parse(resp.body);
        if (!Array.isArray(pageData.items)) throw new Error(`Invalid Spotify playlist items (${pl.name}) response`);
        const pageItems = pageData.items;
        for (const it of pageItems) {
          const t = it?.item || it?.track;
          if (!t || t.is_local || t.type === 'episode') continue;
          const artist = (Array.isArray(t.artists) && t.artists[0]?.name) || '';
          const title = t.name || '';
          const duration = t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined;
          if (title) plTracks.push({ title, artist, duration });
        }
        let trackNext = pageData.next || null;
        while (trackNext) {
          const nextResp = await spotifyGetWithRetry(trackNext);
          if (nextResp.status === 403) {
            skippedPlaylists.push({ name: pl.name, error: spotifyApiFailure(nextResp, `playlist items (${pl.name})`).message });
            continue playlistLoop;
          }
          if (nextResp.status < 200 || nextResp.status >= 300) throw spotifyApiFailure(nextResp, `playlist items (${pl.name})`);
          const nextData = JSON.parse(nextResp.body);
          if (!Array.isArray(nextData.items)) throw new Error(`Invalid Spotify playlist items (${pl.name}) response`);
          const nextItems = nextData.items;
          for (const it of nextItems) {
            const t = it?.item || it?.track;
            if (!t || t.is_local || t.type === 'episode') continue;
            const artist = (Array.isArray(t.artists) && t.artists[0]?.name) || '';
            const title = t.name || '';
            const duration = t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined;
            if (title) plTracks.push({ title, artist, duration });
          }
          trackNext = nextData.next || null;
        }
        playlists.push({ name: pl.name, tracks: plTracks });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, partial: skippedPlaylists.length > 0, likes, playlists, skippedPlaylists }));
  } catch (err) {
    res.writeHead(err.status === 403 ? 403 : err.status === 429 ? 429 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

function callTranslate(text, to) {
  return new Promise((resolve) => {
    const clients = ['dict-chrome-ex', 'gtx'];
    let idx = 0;
    function tryNext() {
      if (idx >= clients.length) return resolve(null);
      const c = clients[idx++];
      // a timeout destroys the request, which fires 'error' too: move on once per attempt, not twice
      let done = false;
      const next = () => { if (!done) { done = true; tryNext(); } };
      const u = `https://translate.googleapis.com/translate_a/single?client=${c}&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
      const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
        let b = '';
        res.on('error', next);
        res.on('data', chunk => b += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) return next();
          try {
            const data = JSON.parse(b);
            if (data && Array.isArray(data[0])) {
              const joined = data[0].map(s => s[0]).join('').split('\n');
              done = true;
              return resolve(joined);
            }
          } catch (e) {}
          next();
        });
      });
      req.on('error', next);
      req.on('timeout', () => { req.destroy(); next(); });
    }
    tryNext();
  });
}

async function handleTranslate(req, res, lines, to = 'en') {
  if (!Array.isArray(lines) || lines.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, translations: [] }));
  }

  const chunks = [];
  let curChunk = [];
  let curLen = 0;
  for (const line of lines) {
    if (curChunk.length > 0 && curLen + line.length + 1 > 1800) {
      chunks.push(curChunk);
      curChunk = [];
      curLen = 0;
    }
    curChunk.push(line);
    curLen += line.length + 1;
  }
  if (curChunk.length > 0) chunks.push(curChunk);

  const allTranslations = [];
  for (const chunk of chunks) {
    const joined = chunk.join('\n');
    let chunkTrans = await callTranslate(joined, to);
    if (!chunkTrans) {
      // no answer at all: going line by line would wait up to 16s per line (minutes for one song)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Translation service unavailable' }));
    }
    if (chunkTrans.length !== chunk.length) {
      // the lines came back merged or split: translate them one at a time, until the service stops answering
      chunkTrans = [];
      let reachable = true;
      for (const line of chunk) {
        if (!line.trim() || !reachable) {
          chunkTrans.push(line.trim() ? line : '');
          continue;
        }
        const single = await callTranslate(line, to);
        if (!single) reachable = false;
        chunkTrans.push((single && single[0]) ? single[0] : line);
      }
    }
    allTranslations.push(...chunkTrans);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, translations: allTranslations }));
}


// ---- UI language (Settings → Interface → Language, i18n.js) ----
// The app sends the English strings it shows (its own words only: never titles, names or anything from the
// library) and gets them back translated by the same service as the lyrics (callTranslate). Every answer is kept
// per language in <data>/i18n/<lang>.json (phones: the app's storage, through the fs shim) and in memory here, so
// a string is translated once per device. English never leaves the device.
const I18N_DIR = path.join(DATA_DIR, 'i18n');
const I18N_LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const I18N_MAX_TEXTS = 400; // per request
const I18N_MAX_LEN = 500; // per string
const I18N_MAX_ENTRIES = 20000; // per language
const i18nDicts = new Map(); // lang -> { dict, size }
const i18nInFlight = new Map(); // lang + '\n' + text -> Promise, so two requests never translate the same string twice

function i18nDict(lang) {
  let d = i18nDicts.get(lang);
  if (d) return d;
  const dict = Object.create(null);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      // an answer the service sent garbled (U+FFFD where letters were) is dropped and asked for again (from Riff 43.1)
      for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && v && !v.includes('\uFFFD')) dict[k] = v;
    }
  } catch (e) {}
  d = { dict, size: Object.keys(dict).length };
  i18nDicts.set(lang, d);
  return d;
}

function i18nSave(lang) {
  try {
    fs.mkdirSync(I18N_DIR, { recursive: true });
    fs.writeFileSync(path.join(I18N_DIR, `${lang}.json`), JSON.stringify(i18nDicts.get(lang).dict));
  } catch (e) {
    logger.warn(`[i18n] could not save ${lang}: ${e.message}`);
  }
}

// Many strings per request, joined by newlines like the lyrics. When the lines don't come back one for one, each
// half is tried on its own (down to single strings), so one odd string doesn't cost a request per string.
// Resolves { out: a translation or null per string, missed: the strings never tried because the service stopped answering }.
async function i18nTranslate(texts, lang) {
  const out = new Array(texts.length).fill(null);
  const tried = new Array(texts.length).fill(false);
  let reachable = true;
  const clean = (s, src) => {
    const v = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
    return v && v.length <= src.length * 4 + 60 && !v.includes('\uFFFD') ? v : null;
  };
  async function run(idx) {
    if (!reachable || !idx.length) return;
    const lines = idx.map((i) => texts[i]);
    const got = await callTranslate(lines.join('\n'), lang);
    if (!got) { reachable = false; return; }
    if (got.length === lines.length) { idx.forEach((i, k) => { out[i] = clean(got[k], texts[i]); tried[i] = true; }); return; }
    if (idx.length === 1) { out[idx[0]] = clean(got.join(' '), texts[idx[0]]); tried[idx[0]] = true; return; }
    const mid = idx.length >> 1;
    await run(idx.slice(0, mid));
    await run(idx.slice(mid));
  }
  // the strings in groups of up to 1500 characters (as indexes), three groups at a time
  const groups = [];
  let cur = [], len = 0;
  texts.forEach((s, i) => {
    if (cur.length && len + s.length + 1 > 1500) { groups.push(cur); cur = []; len = 0; }
    cur.push(i);
    len += s.length + 1;
  });
  if (cur.length) groups.push(cur);
  let next = 0;
  const worker = async () => { while (reachable && next < groups.length) await run(groups[next++]); };
  await Promise.all([worker(), worker(), worker()]);
  return { out, missed: new Set(texts.filter((_, i) => !tried[i])) };
}

// { target, texts: [...] } -> { success, translations: [string|null], complete }; null: not translated, show the
// English. complete is false when the service didn't answer for some of them (worth asking again later); a string it
// answered with nothing usable stays null without that.
async function handleI18nBatch(target, rawTexts) {
  const lang = String(target || '');
  if (!I18N_LANG_RE.test(lang)) return { status: 400, body: { success: false, error: 'bad language' } };
  const texts = (Array.isArray(rawTexts) ? rawTexts : []).slice(0, I18N_MAX_TEXTS)
    .map((s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''))
    .map((s) => (s && s.length <= I18N_MAX_LEN ? s : ''));
  if (lang === 'en') return { status: 200, body: { success: true, translations: texts.map((s) => s || null), complete: true } };
  const d = i18nDict(lang);
  const waits = new Set();
  const need = [];
  for (const s of new Set(texts)) {
    if (!s || s in d.dict) continue;
    const key = `${lang}\n${s}`;
    if (i18nInFlight.has(key)) waits.add(i18nInFlight.get(key));
    else need.push(s);
  }
  if (need.length) {
    const job = i18nTranslate(need, lang).then(({ out, missed }) => {
      let added = 0;
      out.forEach((tr, i) => {
        if (!tr || need[i] in d.dict || d.size >= I18N_MAX_ENTRIES) return;
        d.dict[need[i]] = tr;
        d.size++;
        added++;
      });
      if (added) i18nSave(lang);
      return missed;
    }).catch((e) => { logger.warn(`[i18n] ${e.message}`); return new Set(need); }).finally(() => {
      for (const s of need) i18nInFlight.delete(`${lang}\n${s}`);
    });
    for (const s of need) i18nInFlight.set(`${lang}\n${s}`, job);
    waits.add(job);
  }
  const missed = new Set();
  for (const m of await Promise.all(waits)) for (const s of m || []) missed.add(s);
  const translations = texts.map((s) => (s && s in d.dict ? d.dict[s] : null));
  return { status: 200, body: { success: true, translations, complete: !texts.some((s) => s && !(s in d.dict) && missed.has(s)) } };
}

// everything this device translated into `target` before: the app loads it in one go at start
function i18nAll(target) {
  const lang = String(target || '');
  if (!I18N_LANG_RE.test(lang)) return { status: 400, body: { success: false, error: 'bad language' } };
  return { status: 200, body: { success: true, translations: lang === 'en' ? {} : i18nDict(lang).dict } };
}

// ---- Discover: genre + similar-artist recommendations from listening history ----
// iTunes gives each artist's genre, Deezer gives related artists, their top tracks and per-genre charts.
// Deezer tracks are played by YouTube search (searchQuery), same as the artist pages.
const ITUNES_TO_DEEZER_GENRE = {
  'pop': 132, 'hip-hop/rap': 116, 'rap': 116, 'rock': 152, 'dance': 113, 'r&b/soul': 165, 'alternative': 85,
  'electronic': 106, 'metal': 464, 'hard rock': 464, 'singer/songwriter': 466, 'folk': 466, 'reggae': 144, 'jazz': 129,
  'country': 84, 'classical': 98, 'soundtrack': 173, 'latin': 197, 'k-pop': 16, 'j-pop': 16, 'blues': 153, 'soul': 169,
  'house': 113, 'techno': 106, 'indie pop': 85, 'german pop': 459, 'german hip hop': 116,
};
const discoverCache = new Map();
const discoverInFlight = new Map();

function setDiscoverCache(key, data) {
  discoverCache.delete(key);
  if (discoverCache.size >= 50) discoverCache.delete(discoverCache.keys().next().value);
  discoverCache.set(key, { at: Date.now(), data });
}

function httpsJson(target, timeout = 5000, userAgent = 'Mozilla/5.0') {
  return new Promise((resolve) => {
    https.get(target, { headers: { 'User-Agent': userAgent }, timeout }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
      r.on('error', () => resolve(null));
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function deezerTrackToTrack(t) {
  const artist = (t.artist && t.artist.name) || '';
  return {
    id: `dz_${t.id}`, title: t.title_short || t.title || 'untitled', artist, duration: t.duration || 0,
    thumbnail: (t.album && (t.album.cover_big || t.album.cover_medium)) || '',
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${artist} - ${t.title} official audio`)}`,
    searchQuery: `${artist} - ${t.title} official audio`, platform: 'youtube', isCached: false,
  };
}

async function buildDiscover(historyTracks, favoriteTracks) {
  const counts = new Map();
  const add = (t, w) => {
    const name = String((t && t.artist) || '').replace(/\s*-\s*Topic$/i, '').split(/,|&| feat\.| ft\./i)[0].trim();
    if (!name || /unknown artist/i.test(name)) return;
    const k = name.toLowerCase();
    counts.set(k, { name: (counts.get(k) || {}).name || name, score: ((counts.get(k) || {}).score || 0) + w });
  };
  favoriteTracks.forEach((t) => add(t, 3));
  historyTracks.slice(0, 60).forEach((t, i) => add(t, 1 + (60 - i) / 60));
  const topArtists = [...counts.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  const known = new Set([...counts.keys()]);

  const key = topArtists.map((a) => a.name.toLowerCase()).join('|') || 'none';
  const hit = discoverCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  // one build is dozens of iTunes/Deezer calls: a second request while it runs shares it
  if (discoverInFlight.has(key)) return discoverInFlight.get(key);
  const job = fetchDiscover(key, topArtists, known).finally(() => discoverInFlight.delete(key));
  discoverInFlight.set(key, job);
  return job;
}

async function fetchDiscover(key, topArtists, known) {
  const sections = [];
  if (!topArtists.length) {
    const [chart, artists] = await Promise.all([httpsJson('https://api.deezer.com/chart/0/tracks?limit=20'), httpsJson('https://api.deezer.com/chart/0/artists?limit=12')]);
    if (artists && artists.data) sections.push({ type: 'artists', title: 'Popular artists', items: artists.data.map((a) => ({ name: a.name, picture: a.picture_big || a.picture_medium })) });
    if (chart && chart.data) sections.push({ type: 'tracks', title: 'Top songs right now', tracks: chart.data.map(deezerTrackToTrack) });
    const data = { genres: [], sections };
    setDiscoverCache(key, data);
    return data;
  }

  const lookups = await Promise.all(topArtists.map(async (a) => {
    const [it, dz] = await Promise.all([
      httpsJson(`https://itunes.apple.com/search?term=${encodeURIComponent(a.name)}&entity=musicArtist&limit=1`),
      httpsJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=1`),
    ]);
    return { ...a, genre: it && it.results && it.results[0] && it.results[0].primaryGenreName, dz: dz && dz.data && dz.data[0] };
  }));

  const genreScore = new Map();
  lookups.forEach((l) => { if (l.genre) genreScore.set(l.genre, (genreScore.get(l.genre) || 0) + l.score); });
  const genres = [...genreScore.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);

  const related = new Map();
  await Promise.all(lookups.slice(0, 3).filter((l) => l.dz).map(async (l) => {
    const r = await httpsJson(`https://api.deezer.com/artist/${l.dz.id}/related?limit=10`);
    (r && r.data || []).forEach((a) => {
      const k = a.name.toLowerCase();
      if (known.has(k) || related.has(k)) return;
      related.set(k, { name: a.name, picture: a.picture_big || a.picture_medium, id: a.id, because: l.name });
    });
  }));
  const similar = [...related.values()].slice(0, 14);
  if (similar.length) sections.push({ type: 'artists', title: `Because you listen to ${lookups[0].name}`, items: similar });

  const picks = [];
  await Promise.all(similar.slice(0, 8).map(async (a) => {
    const top = await httpsJson(`https://api.deezer.com/artist/${a.id}/top?limit=2`);
    (top && top.data || []).forEach((t) => picks.push(deezerTrackToTrack(t)));
  }));
  if (picks.length) sections.push({ type: 'tracks', title: 'New for you', tracks: picks.sort(() => Math.random() - 0.5).slice(0, 14) });

  for (const g of genres.slice(0, 2)) {
    const gid = ITUNES_TO_DEEZER_GENRE[g.toLowerCase()];
    if (!gid) continue;
    const chart = await httpsJson(`https://api.deezer.com/chart/${gid}/tracks?limit=15`);
    if (chart && chart.data && chart.data.length) sections.push({ type: 'tracks', title: `Top ${g}`, genre: g, tracks: chart.data.map(deezerTrackToTrack) });
  }

  const data = { genres, topArtists: lookups.map((l) => ({ name: l.name, genre: l.genre || '', picture: l.dz ? (l.dz.picture_big || l.dz.picture_medium) : '' })), sections };
  setDiscoverCache(key, data);
  return data;
}

const albumCache = new Map();

function getAlbumCache(key) {
  const entry = albumCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    albumCache.delete(key);
    return null;
  }
  return entry.data;
}

function setAlbumCache(key, data) {
  if (albumCache.has(key)) {
    albumCache.delete(key);
  } else if (albumCache.size >= 100) {
    const oldestKey = albumCache.keys().next().value;
    albumCache.delete(oldestKey);
  }
  albumCache.set(key, { data, expires: Date.now() + 15 * 60 * 1000 });
}

// iTunes serves a different catalog per storefront; use the user's region when known.
function itunesCountryCode() {
  try {
    const code = process.versions.electron ? require('electron').app.getLocaleCountryCode() : '';
    return /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : '';
  } catch (e) {
    return '';
  }
}

function itunesCountryParam() {
  const code = itunesCountryCode();
  return code ? `&country=${code.toUpperCase()}` : '';
}

function fetchItunesJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.on('error', reject);
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', err => reject(err));
  });
}

async function handleAlbumSearch(req, res, parsedUrl) {
  const q = (parsedUrl.query.q || '').trim();

  if (!q) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, albums: [] }));
  }

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getAlbumCache(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cached));
  }

  const inFlight = albumCache.get(cacheKey);
  if (inFlight?.promise) {
    const outcome = await inFlight.promise;
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome.body));
  }

  let resolveSearch;
  const searchPromise = new Promise(resolve => { resolveSearch = resolve; });
  const inFlightEntry = { promise: searchPromise };
  albumCache.set(cacheKey, inFlightEntry);
  let outcome = null;
  const sendResponse = (status, body) => {
    outcome = { status, body };
    resolveSearch(outcome);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  };

  try {
    const albumUrlMatch = q.match(/music\.apple\.com\/(?:[a-z]{2}\/)?album\/(?:[^/]+\/)?(\d+)/i);
    if (albumUrlMatch) {
      const data = await fetchItunesJson(`https://itunes.apple.com/lookup?id=${albumUrlMatch[1]}&entity=album${itunesCountryParam()}`);
      const results = (data && Array.isArray(data.results)) ? data.results : [];
      const item = results.find(r => r && r.wrapperType === 'collection');
      if (item) {
        const responseData = {
          success: true,
          albums: [{
            id: String(item.collectionId),
            title: item.collectionName || '',
            artist: item.artistName || '',
            year: item.releaseDate ? item.releaseDate.slice(0, 4) : '',
            trackCount: item.trackCount || 0,
            cover: (item.artworkUrl100 || '').replace('100x100', '600x600')
          }]
        };
        setAlbumCache(cacheKey, responseData);
        return sendResponse(200, responseData);
      }
    }

    const cleanQ = q.replace(/\s+-\s+/g, ' ').replace(/\bby\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const urls = [
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&media=music&limit=25${itunesCountryParam()}`,
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=25${itunesCountryParam()}`
    ];
    if (cleanQ && cleanQ.toLowerCase() !== q.toLowerCase()) {
      urls.push(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanQ)}&entity=album&media=music&limit=25${itunesCountryParam()}`);
      urls.push(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanQ)}&media=music&limit=25${itunesCountryParam()}`);
    }

    const responses = await Promise.all(urls.map(u => fetchItunesJson(u).catch(() => null)));
    // every lookup failed (offline, iTunes down): report it instead of caching "no albums" for 15 minutes
    if (responses.every(data => !data)) {
      return sendResponse(502, { success: false, error: 'Album service unavailable' });
    }
    const results = [];
    for (const data of responses) {
      if (data && Array.isArray(data.results)) {
        results.push(...data.results);
      }
    }

    const albums = [];
    const seen = new Set();
    const normalize = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

    for (const item of results) {
      if (!item || item.collectionId == null) continue;
      const name = item.collectionName || '';
      if (/\s-\s*Single$/i.test(name)) continue;
      const trackCount = item.trackCount || 0;
      if (trackCount < 4 && !/\s-\s*EP$/i.test(name)) continue;

      const normKey = `${normalize(name)}:${normalize(item.artistName)}`;
      if (seen.has(normKey)) continue;
      seen.add(normKey);

      albums.push({
        id: String(item.collectionId),
        title: name,
        artist: item.artistName || '',
        year: item.releaseDate ? item.releaseDate.slice(0, 4) : '',
        trackCount: trackCount,
        cover: (item.artworkUrl100 || '').replace('100x100', '600x600')
      });
    }

    const words = cleanQ.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
    const scoreAlbum = (album) => {
      const title = (album.title || '').toLowerCase();
      const artist = (album.artist || '').toLowerCase();
      const full = title + ' ' + artist;
      let score = 0;
      for (const w of words) {
        if (title.includes(w)) score += 15;
        else if (artist.includes(w)) score += 10;
      }
      if (title === cleanQ.toLowerCase() || full === cleanQ.toLowerCase()) score += 50;
      else if (full.includes(cleanQ.toLowerCase()) || cleanQ.toLowerCase().includes(title)) score += 25;
      return score;
    };

    albums.sort((a, b) => scoreAlbum(b) - scoreAlbum(a));
    const responseData = { success: true, albums: albums.slice(0, 12) };
    setAlbumCache(cacheKey, responseData);
    return sendResponse(200, responseData);
  } catch (err) {
    return sendResponse(502, { success: false, error: 'Album service unavailable' });
  } finally {
    if (!outcome) {
      outcome = { status: 502, body: { success: false, error: 'Album service unavailable' } };
      resolveSearch(outcome);
    }
    if (albumCache.get(cacheKey) === inFlightEntry) {
      albumCache.delete(cacheKey);
    }
  }
}

async function handleArtistAlbums(req, res, parsedUrl) {
  const name = (parsedUrl.query.name || '').trim();
  if (!name) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, albums: [] }));
  }
  const artistId = await resolveArtistId(name, parsedUrl.query.id || '', parsedUrl.query.video || '');
  const cacheKey = `artist-albums:${artistId || name.toLowerCase()}`;
  const cached = getAlbumCache(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cached));
  }
  try {
    const normalize = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const target = normalize(name);
    const artistSearch = await fetchItunesJson(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=10${itunesCountryParam()}`);
    const artists = (artistSearch && Array.isArray(artistSearch.results)) ? artistSearch.results : [];
    const lookupAlbums = async (ids) => {
      const lookup = await fetchItunesJson(`https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=album&limit=200${itunesCountryParam()}`);
      return (lookup && Array.isArray(lookup.results)) ? lookup.results : [];
    };
    // iTunes has namesakes too: for an artist known by its YouTube Music page, only the one that released its songs
    const page = artistId ? await fetchArtistInfo(name, artistId) : null;
    let releases = null;
    if (page && page.releases) {
      const known = [...page.releases, ...page.tracks.map(t => t.title)];
      const namesakes = known.length ? artists.filter(a => normalize(a.artistName) === target && a.artistId != null) : [];
      // one lookup for all of them: it lists each artist followed by its releases
      const byArtist = new Map();
      let current = null;
      for (const r of namesakes.length ? await lookupAlbums(namesakes.map(a => a.artistId)) : []) {
        if (r && r.wrapperType === 'artist') byArtist.set(current = r.artistId, []);
        else if (r && r.wrapperType === 'collection' && byArtist.has(current)) byArtist.get(current).push(r);
      }
      let bestShared = 0;
      for (const list of byArtist.values()) {
        const shared = ytmArtist.sharedTitles(known, list.map(r => r.collectionName));
        if (shared > bestShared) { bestShared = shared; releases = list; }
      }
      // none of them: this artist isn't on iTunes, and a namesake's albums would be wrong
      releases = releases || [];
    }
    const albums = [];
    const seen = new Set();
    const addAlbum = (item) => {
      if (!item || item.collectionId == null) return;
      const title = item.collectionName || '';
      if (/\s-\s*Single$/i.test(title)) return;
      const normKey = normalize(title.replace(/\(.*?\)|\[.*?\]/g, ''));
      if (seen.has(normKey)) return;
      seen.add(normKey);
      albums.push({
        id: String(item.collectionId),
        title,
        artist: item.artistName || name,
        year: item.releaseDate ? item.releaseDate.slice(0, 4) : '',
        trackCount: item.trackCount || 0,
        cover: (item.artworkUrl100 || '').replace('100x100', '600x600'),
        date: item.releaseDate || ''
      });
    };
    if (releases) {
      releases.forEach(addAlbum);
    } else {
      const best = artists.find(a => normalize(a.artistName) === target) || artists.find(a => normalize(a.artistName).includes(target) || target.includes(normalize(a.artistName))) || artists[0];
      if (best && best.artistId != null) (await lookupAlbums([best.artistId])).filter(r => r && r.wrapperType === 'collection').forEach(addAlbum);
      if (albums.length === 0) {
        const fallback = await fetchItunesJson(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=album&attribute=artistTerm&limit=200${itunesCountryParam()}`);
        const items = (fallback && Array.isArray(fallback.results)) ? fallback.results : [];
        items.filter(r => r && normalize(r.artistName).includes(target)).forEach(addAlbum);
      }
    }
    albums.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const responseData = { success: true, albums };
    setAlbumCache(cacheKey, responseData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(responseData));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Album service unavailable' }));
  }
}

// An album's songs: by its iTunes id (Muriel's albums come from iTunes), by its Deezer id (source=deezer), and by
// title and artist when the id finds nothing (a saved album synced from a phone in another country, where iTunes
// gives the album another id). Also at /api/album and /api/album-tracks.
function itunesAlbumTracks(results, albumItem) {
  return results
    .filter(r => r && r.wrapperType === 'track' && (!albumItem || r.collectionId === albumItem.collectionId))
    .map(item => {
      const t = {
        no: item.trackNumber || 1,
        disc: item.discNumber || 1,
        title: item.trackName || '',
        artist: item.artistName || '',
        durationMs: item.trackTimeMillis || 0
      };
      if (item.trackExplicitness === 'explicit' || libraryPages.isExplicitText(item.trackName)) t.isExplicit = true;
      return t;
    })
    .sort((a, b) => (a.disc - b.disc) || (a.no - b.no));
}

async function lookupItunesAlbum(id) {
  const data = await fetchItunesJson(`https://itunes.apple.com/lookup?id=${id}&entity=song${itunesCountryParam()}`);
  const results = (data && Array.isArray(data.results)) ? data.results : [];
  const albumItem = results.find(r => r && r.wrapperType === 'collection');
  if (!albumItem) return null;
  const album = {
    id: String(albumItem.collectionId),
    title: albumItem.collectionName || '',
    artist: albumItem.artistName || '',
    year: albumItem.releaseDate ? albumItem.releaseDate.slice(0, 4) : '',
    trackCount: albumItem.trackCount || 0,
    cover: (albumItem.artworkUrl100 || '').replace('100x100', '600x600')
  };
  return { album, tracks: itunesAlbumTracks(results, albumItem) };
}

async function lookupDeezerAlbum(id) {
  const data = await httpsJson(`https://api.deezer.com/album/${id}`, 6000);
  const items = (data && data.tracks && Array.isArray(data.tracks.data)) ? data.tracks.data : [];
  if (!data || data.error || !items.length) return null;
  const artist = (data.artist && data.artist.name) || '';
  const album = {
    id: String(data.id || id),
    title: data.title || '',
    artist,
    year: data.release_date ? String(data.release_date).slice(0, 4) : '',
    trackCount: data.nb_tracks || items.length,
    cover: data.cover_xl || data.cover_big || data.cover_medium || '',
    source: 'deezer'
  };
  const tracks = items.map((item, idx) => {
    const t = {
      no: item.track_position || idx + 1,
      disc: item.disk_number || 1,
      title: item.title || '',
      artist: (item.artist && item.artist.name) || artist,
      durationMs: (Number(item.duration) || 0) * 1000
    };
    if (item.explicit_lyrics || item.explicit_content_lyrics === 1 || libraryPages.isExplicitText(item.title)) t.isExplicit = true;
    return t;
  }).sort((a, b) => (a.disc - b.disc) || (a.no - b.no));
  return { album, tracks };
}

async function findItunesAlbum(title, artist) {
  const data = await fetchItunesJson(`https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`.trim())}&entity=album&limit=25${itunesCountryParam()}`);
  const results = (data && Array.isArray(data.results)) ? data.results : [];
  const hit = results.find(r => r && r.collectionId != null && ytmArtist.sharedTitles([title], [r.collectionName]) > 0
    && (!artist || ytmArtist.nameKey(r.artistName) === ytmArtist.nameKey(artist)));
  return hit ? lookupItunesAlbum(String(hit.collectionId)) : null;
}

async function handleAlbumTracks(req, res, parsedUrl) {
  const id = (parsedUrl.query.id || '').trim();
  const title = (parsedUrl.query.title || '').trim();
  const artist = (parsedUrl.query.artist || '').trim();
  const source = parsedUrl.query.source === 'deezer' ? 'deezer' : 'itunes';
  if ((id && !/^\d+$/.test(id)) || (!id && !title)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid album id' }));
  }

  const cacheKey = id ? `tracks:${source === 'deezer' ? 'dz:' : ''}${id}` : `tracks:${ytmArtist.nameKey(artist)}:${ytmArtist.nameKey(title)}`;
  const cached = getAlbumCache(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cached));
  }

  const inFlight = albumCache.get(cacheKey);
  if (inFlight?.promise) {
    const outcome = await inFlight.promise;
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome.body));
  }

  let resolveLookup;
  const lookupPromise = new Promise(resolve => { resolveLookup = resolve; });
  const inFlightEntry = { promise: lookupPromise };
  albumCache.set(cacheKey, inFlightEntry);
  let outcome = null;
  const sendResponse = (status, body) => {
    outcome = { status, body };
    resolveLookup(outcome);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  };

  try {
    let found = null;
    let failed = false;
    const attempt = async (fn) => {
      if (found && found.tracks.length) return;
      try { found = (await fn()) || found; } catch (e) { failed = true; }
    };
    if (id) await attempt(() => (source === 'deezer' ? lookupDeezerAlbum(id) : lookupItunesAlbum(id)));
    if (title) await attempt(() => findItunesAlbum(title, artist));
    if (!found || !found.tracks.length) {
      return failed && !found
        ? sendResponse(502, { success: false, error: 'Album service unavailable' })
        : sendResponse(404, { success: false, error: 'Album not found' });
    }
    const responseData = { success: true, album: found.album, tracks: found.tracks };
    setAlbumCache(cacheKey, responseData);
    return sendResponse(200, responseData);
  } catch (err) {
    return sendResponse(502, { success: false, error: 'Album service unavailable' });
  } finally {
    if (!outcome) {
      outcome = { status: 502, body: { success: false, error: 'Album service unavailable' } };
      resolveLookup(outcome);
    }
    if (albumCache.get(cacheKey) === inFlightEntry) {
      albumCache.delete(cacheKey);
    }
  }
}

// ---- Trending now (the Spotify-style home): Apple Music's most played songs in your country, or else Deezer's
// chart. Played by YouTube search (searchQuery), like the Deezer songs of Discover.
let trendingCache = { at: 0, tracks: [] };
const TRENDING_TTL = 2 * 3600 * 1000;

function parseAppleTopSongs(json) {
  const results = (json && json.feed && Array.isArray(json.feed.results)) ? json.feed.results : [];
  return results.map((r) => {
    const title = (r && r.name) || '';
    const artist = (r && r.artistName) || '';
    if (!title || !artist) return null;
    const query = `${artist} - ${title} official audio`;
    const t = {
      id: `am_${r.id || title}`, title, artist, duration: 0,
      thumbnail: String(r.artworkUrl100 || '').replace(/\/\d+x\d+bb\./i, '/600x600bb.'),
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      searchQuery: query, platform: 'youtube', isCached: false
    };
    // Apple spells it "Explict"
    if (/^explic/i.test(r.contentAdvisoryRating || '') || libraryPages.isExplicitText(title)) t.isExplicit = true;
    return t;
  }).filter(Boolean);
}

async function handleTrending(req, res) {
  if (trendingCache.tracks.length && Date.now() - trendingCache.at < TRENDING_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, tracks: trendingCache.tracks }));
  }
  // the computer's region; on phones (no Electron) the language's region: "de-AT" is at
  const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
  const region = itunesCountryCode() || ((/-([A-Za-z]{2})$/.exec(lang) || [])[1] || 'us').toLowerCase();
  let tracks = parseAppleTopSongs(await httpsJson(`https://rss.marketingtools.apple.com/api/v2/${region}/music/most-played/25/songs.json`, 6000));
  if (!tracks.length) {
    const chart = await httpsJson('https://api.deezer.com/chart/0/tracks?limit=24', 6000);
    tracks = ((chart && Array.isArray(chart.data)) ? chart.data : []).filter(t => t && t.title && t.artist).map((t) => {
      const track = deezerTrackToTrack(t);
      if (t.explicit_lyrics || t.explicit_content_lyrics === 1) track.isExplicit = true;
      return track;
    });
  }
  if (tracks.length) trendingCache = { at: Date.now(), tracks };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ success: tracks.length > 0, tracks }));
}

let hotPicksCache = { data: null, expires: 0 };

async function handleHotPicks(req, res, parsedUrl) {
  const limit = Math.max(1, Math.min(25, parseInt(parsedUrl.query.limit || '12', 10) || 12));

  if (hotPicksCache.promise) {
    const outcome = await hotPicksCache.promise;
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outcome.body.success ? {
      success: true,
      title: outcome.body.title,
      tracks: outcome.body.tracks.slice(0, limit)
    } : outcome.body));
  }

  if (hotPicksCache.data && Date.now() < hotPicksCache.expires) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      title: hotPicksCache.data.title,
      tracks: hotPicksCache.data.tracks.slice(0, limit)
    }));
  }

  let resolveLookup;
  const lookupPromise = new Promise(resolve => { resolveLookup = resolve; });
  hotPicksCache = { data: null, expires: 0, promise: lookupPromise };
  let outcome = null;
  const sendResponse = (status, body) => {
    outcome = { status, body };
    resolveLookup(outcome);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  };

  try {
    const data = await fetchItunesJson('https://api.deezer.com/chart/0/tracks?limit=40');
    const rawItems = (data && Array.isArray(data.data)) ? data.data : [];
    const candidates = rawItems
      .filter(item => item && item.title && item.artist && item.artist.name)
      .map(item => ({ artist: item.artist.name, title: item.title, isExplicit: !!(item.explicit_lyrics || item.explicit_content_lyrics === 1) }));
    if (candidates.length === 0) {
      return sendResponse(200, { success: false });
    }

    const resolvedTracks = [];
    const seenIds = new Set();
    let cIdx = 0;

    const worker = async () => {
      while (cIdx < candidates.length && resolvedTracks.length < 12) {
        const c = candidates[cIdx++];
        if (!c) break;
        try {
          const track = await resolveCandidate(c);
          if (track && !seenIds.has(track.id)) {
            if (c.isExplicit) track.isExplicit = true;
            seenIds.add(track.id);
            if (resolvedTracks.length < 12) {
              resolvedTracks.push(track);
            }
          }
        } catch (_) {}
      }
    };

    await Promise.all([worker(), worker(), worker(), worker()]);

    if (resolvedTracks.length === 0) {
      return sendResponse(200, { success: false });
    }

    const title = 'Hot picks ' + new Date().getFullYear();
    hotPicksCache = {
      data: { title, tracks: resolvedTracks },
      expires: Date.now() + 60 * 60 * 1000
    };

    return sendResponse(200, {
      success: true,
      title,
      tracks: resolvedTracks
    });
  } catch (err) {
    return sendResponse(200, { success: false });
  } finally {
    if (!outcome) {
      outcome = { status: 200, body: { success: false } };
      resolveLookup(outcome);
    }
    if (hotPicksCache.promise === lookupPromise) {
      hotPicksCache = { data: null, expires: 0 };
    }
  }
}

// ---------- Last.fm scrobbling ----------
// Every profile can connect its own Last.fm account (the page sends the open profile's id). The session key, and a
// custom API key pair if one was entered, stay here and never go back to the page. They are kept like the Spotify
// login: encrypted with the system keychain on desktop (lastfm-auth.enc); on phones in the app's private WebView
// storage (bridge.js), not under /data, which the Files app shows. Without a keychain (Linux without a secret
// service) they last until Muriel closes. The password typed for the direct sign-in goes to Last.fm once and is
// not kept. Nothing here logs a key, token or password.
// The default key pair is upstream Riff's Last.fm application (published in its source). Muriel can register its
// own at last.fm/api/account/create and put it here; people can also enter their own pair in the Last.fm dialog.
const LASTFM_API_KEY = '4b4f73bda181868353f9b438604adf52';
const LASTFM_API_SECRET = '716cc0a784bb62835de5bd674e65eb57';
const LASTFM_KEY_RE = /^[a-f0-9]{32}$/i;
const LASTFM_PROFILE_RE = /^(?:default|[a-z0-9]{4,16})$/;
const lastfmAuthPath = path.join(DATA_DIR, 'lastfm-auth.enc');
let lastfmAccounts = null; // { [profileId]: { sk, user, key?, secret? } }
let lastfmStoreError = '';
const lastfmPending = new Map(); // profileId -> { token, pair, at }: a browser sign-in waiting for approval

function lastfmVault() {
  if (typeof globalThis.__murielVault === 'function') return globalThis.__murielVault('lastfm');
  if (!canStoreSpotifyAuth()) return null;
  return {
    read: () => JSON.parse(spotifySafeStorage.decryptString(fs.readFileSync(lastfmAuthPath))),
    write: (value) => {
      const tmp = `${lastfmAuthPath}.tmp`;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      try {
        fs.writeFileSync(tmp, spotifySafeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
        fs.renameSync(tmp, lastfmAuthPath);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        throw e;
      }
    },
  };
}

function lastfmCleanAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.sk !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(a.sk)) return null;
  const out = { sk: a.sk, user: String(a.user || '').slice(0, 64) };
  if (LASTFM_KEY_RE.test(a.key || '') && LASTFM_KEY_RE.test(a.secret || '')) { out.key = a.key; out.secret = a.secret; }
  return out;
}

function lastfmLoad() {
  if (lastfmAccounts) return lastfmAccounts;
  lastfmAccounts = {};
  let saved = null;
  try {
    const vault = lastfmVault();
    saved = vault ? vault.read() : null;
  } catch (e) {
    if (e && e.code !== 'ENOENT') lastfmStoreError = 'The saved Last.fm login could not be read. Please connect again.';
  }
  if (saved && typeof saved === 'object') {
    for (const [id, a] of Object.entries(saved)) {
      const clean = LASTFM_PROFILE_RE.test(id) ? lastfmCleanAccount(a) : null;
      if (clean) lastfmAccounts[id] = clean;
    }
  }
  return lastfmAccounts;
}

// true when the logins reached secure storage
function lastfmSave() {
  const vault = lastfmVault();
  if (!vault) return false;
  try {
    vault.write(lastfmAccounts || {});
    lastfmStoreError = '';
    return true;
  } catch (e) {
    lastfmStoreError = 'The Last.fm login could not be saved securely; connect again after restarting Muriel.';
    return false;
  }
}

function lastfmSign(params, secret) {
  let raw = '';
  for (const k of Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort()) raw += k + String(params[k]);
  return crypto.createHash('md5').update(raw + secret, 'utf8').digest('hex');
}

// one signed call to the Last.fm API; resolves to its JSON answer, or { error, message } when it can't be reached
function lastfmCall(params, pair, method = 'POST') {
  const key = (pair && pair.key) || LASTFM_API_KEY;
  const secret = (pair && pair.secret) || LASTFM_API_SECRET;
  const full = { ...params, api_key: key };
  full.api_sig = lastfmSign(full, secret);
  full.format = 'json';
  const body = new URLSearchParams(full).toString();
  const isGet = method === 'GET';
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.request({
      hostname: 'ws.audioscrobbler.com',
      path: isGet ? `/2.0/?${body}` : '/2.0/',
      method,
      headers: isGet ? { 'User-Agent': 'Muriel' } : { 'User-Agent': 'Muriel', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (resp) => {
      let raw = '';
      resp.on('data', (c) => { raw += c; if (raw.length > 1e6) { raw = ''; resp.destroy(); } });
      resp.on('error', () => done({ error: -1, message: "Can't reach Last.fm" }));
      resp.on('end', () => { try { done(JSON.parse(raw)); } catch (_) { done({ error: -1, message: 'Last.fm sent an answer Muriel could not read' }); } });
    });
    req.on('error', () => done({ error: -1, message: "Can't reach Last.fm" }));
    req.on('timeout', () => { req.destroy(); done({ error: -1, message: 'Last.fm did not answer in time' }); });
    if (!isGet) req.write(body);
    req.end();
  });
}

function lastfmPairFrom(body) {
  const key = String(body.apiKey || '').trim();
  const secret = String(body.apiSecret || '').trim();
  if (!key && !secret) return { pair: null };
  if (!LASTFM_KEY_RE.test(key) || !LASTFM_KEY_RE.test(secret)) return { error: 'An API key and its shared secret are 32 letters and digits each' };
  return { pair: { key, secret } };
}

const lastfmText = (v, n = 512) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, n);
const lastfmMessage = (r) => lastfmText(r && r.message, 200) || 'Last.fm refused the request';

function lastfmStatus(profile) {
  const a = lastfmLoad()[profile];
  return { connected: !!a, username: a ? a.user : '', saved: !!a && !!lastfmVault(), error: lastfmStoreError };
}

function lastfmConnect(profile, session, pair) {
  const account = lastfmCleanAccount({ sk: session && session.key, user: session && session.name, ...(pair || {}) });
  if (!account) return null;
  lastfmLoad()[profile] = account;
  const saved = lastfmSave();
  return { success: true, username: account.user, saved, error: saved ? '' : lastfmStoreError || 'Connected until Muriel closes: this system has no secure place to keep the login.' };
}

// a scrobble or now-playing update: the song as the page cleaned it (lastfm-core.js), checked again here
function lastfmSongParams(body, n) {
  const artist = lastfmText(body.artist);
  const track = lastfmText(body.track);
  if (!artist || !track) return null;
  const sfx = n === undefined ? '' : `[${n}]`;
  const p = { [`artist${sfx}`]: artist, [`track${sfx}`]: track };
  const album = lastfmText(body.album);
  if (album) p[`album${sfx}`] = album;
  const duration = Math.round(Number(body.duration) || 0);
  if (duration > 0 && duration < 86400) p[`duration${sfx}`] = String(duration);
  return p;
}

async function lastfmRoute(route, body) {
  const profile = String(body.profile || '');
  if (!LASTFM_PROFILE_RE.test(profile)) return { status: 400, data: { success: false, error: 'Unknown profile' } };

  if (route === 'status') {
    // logins of profiles deleted since are forgotten
    if (Array.isArray(body.profiles) && body.profiles.length && body.profiles.includes(profile)) {
      const keep = new Set(body.profiles.map(String));
      const all = lastfmLoad();
      let changed = false;
      for (const id of Object.keys(all)) if (!keep.has(id)) { delete all[id]; changed = true; }
      if (changed) lastfmSave();
    }
    return { status: 200, data: { success: true, ...lastfmStatus(profile) } };
  }

  if (route === 'logout') {
    lastfmPending.delete(profile);
    const all = lastfmLoad();
    if (all[profile]) { delete all[profile]; lastfmSave(); }
    return { status: 200, data: { success: true } };
  }

  // browser sign-in, step 1: a token for the approval page (the token stays here)
  if (route === 'token') {
    const { pair, error } = lastfmPairFrom(body);
    if (error) return { status: 400, data: { success: false, error } };
    const r = await lastfmCall({ method: 'auth.getToken' }, pair, 'GET');
    if (!r || typeof r.token !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(r.token)) return { status: 502, data: { success: false, error: lastfmMessage(r) } };
    lastfmPending.set(profile, { token: r.token, pair, at: Date.now() });
    const key = (pair && pair.key) || LASTFM_API_KEY;
    return { status: 200, data: { success: true, authUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(key)}&token=${encodeURIComponent(r.token)}` } };
  }

  // step 2, polled: has the person approved it yet?
  if (route === 'session') {
    const p = lastfmPending.get(profile);
    if (!p || Date.now() - p.at > 60 * 60 * 1000) { lastfmPending.delete(profile); return { status: 200, data: { success: false, expired: true, error: 'The sign-in expired. Start again.' } }; }
    const r = await lastfmCall({ method: 'auth.getSession', token: p.token }, p.pair, 'GET');
    if (r && r.session && r.session.key) {
      lastfmPending.delete(profile);
      const done = lastfmConnect(profile, r.session, p.pair);
      return done ? { status: 200, data: done } : { status: 502, data: { success: false, error: 'Last.fm sent an unusable session' } };
    }
    // 14: not approved yet; 15/4: token expired or invalid
    if (r && (r.error === 15 || r.error === 4)) { lastfmPending.delete(profile); return { status: 200, data: { success: false, expired: true, error: 'The sign-in expired. Start again.' } }; }
    return { status: 200, data: { success: false, pending: r && r.error === 14, error: r && r.error === 14 ? '' : lastfmMessage(r) } };
  }

  // direct sign-in with username and password (works on phones too, no browser round trip)
  if (route === 'mobile-session') {
    const { pair, error } = lastfmPairFrom(body);
    if (error) return { status: 400, data: { success: false, error } };
    const username = lastfmText(body.username, 64);
    const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
    if (!username || !password) return { status: 400, data: { success: false, error: 'Enter your Last.fm username and password' } };
    const r = await lastfmCall({ method: 'auth.getMobileSession', username, password }, pair, 'POST');
    if (r && r.session && r.session.key) {
      const done = lastfmConnect(profile, r.session, pair);
      return done ? { status: 200, data: done } : { status: 502, data: { success: false, error: 'Last.fm sent an unusable session' } };
    }
    // 4: Last.fm's "Authentication Failed - You do not have permissions..." means a wrong username or password
    return { status: 200, data: { success: false, error: r && r.error === 4 ? 'Wrong Last.fm username or password' : lastfmMessage(r) } };
  }

  if (route === 'now-playing' || route === 'scrobble') {
    const account = lastfmLoad()[profile];
    if (!account) return { status: 200, data: { success: false, code: 'not_connected' } };
    const isScrobble = route === 'scrobble';
    const song = lastfmSongParams(body, isScrobble ? 0 : undefined);
    if (!song) return { status: 400, data: { success: false, error: 'Missing artist or title' } };
    const params = { method: isScrobble ? 'track.scrobble' : 'track.updateNowPlaying', sk: account.sk, ...song };
    if (isScrobble) {
      // Last.fm takes scrobbles up to two weeks old
      const now = Math.floor(Date.now() / 1000);
      const ts = Math.floor(Number(body.timestamp) || 0);
      params['timestamp[0]'] = String(ts > now - 14 * 86400 && ts <= now + 60 ? ts : now);
    }
    const r = await lastfmCall(params, account.key ? { key: account.key, secret: account.secret } : null, 'POST');
    // 9: the session was revoked on last.fm; signing in again is the only way back
    if (r && r.error === 9) { delete lastfmLoad()[profile]; lastfmSave(); return { status: 200, data: { success: false, code: 'reauth', error: 'Last.fm signed Muriel out. Connect again.' } }; }
    if (!r || r.error) return { status: 200, data: { success: false, retry: !r || r.error === -1 || r.error === 11 || r.error === 16 || r.error === 29, error: lastfmMessage(r) } };
    const accepted = isScrobble ? Number(r.scrobbles && r.scrobbles['@attr'] && r.scrobbles['@attr'].accepted) || 0 : 1;
    return { status: 200, data: { success: true, accepted } };
  }

  return { status: 404, data: { success: false, error: 'not found' } };
}

function handleLastFmRoute(req, res, pathname) {
  const reply = (status, data) => { if (res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.method !== 'POST') return reply(405, { success: false, error: 'POST only' });
  let raw = '';
  req.on('data', (chunk) => {
    if (res.writableEnded) return;
    raw += chunk;
    if (raw.length > 64 * 1024) { raw = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); reply(413, { success: false, error: 'payload too large' }); req.resume(); }
  });
  req.on('end', () => {
    const body = safeJsonParse(raw, null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { success: false, error: 'bad request' });
    lastfmRoute(pathname.slice('/api/lastfm/'.length), body)
      .then(({ status, data }) => reply(status, data))
      .catch(() => reply(500, { success: false, error: 'Last.fm request failed' }));
  });
}

// ---------- Yandex Music import ----------
// Reads a public playlist, an album or a song through Yandex Music's API: title, artist and length of each song.
// app.js then finds each song on YouTube, like a Spotify import.
// music.yandex.ru/users/<owner>/playlists/<kind>, a shared /playlists/<uuid> (with or without "lk."),
// /album/<id>, /album/<id>/track/<id> or /track/<id>
const YANDEX_HEADERS = { 'User-Agent': 'Yandex-Music-API', 'X-Yandex-Music-Client': 'YandexMusicAndroid/24023231', 'Accept': 'application/json' };

function parseYandexLink(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/^(?:www\.)?music\.yandex\.(?:ru|com|by|kz|uz|com\.tr)$/i.test(u.hostname)) return null;
  const users = u.pathname.match(/^\/users\/([A-Za-z0-9._-]{1,64})\/playlists\/(\d{1,12})\/?$/);
  if (users) return { kind: 'playlist', path: `/users/${encodeURIComponent(users[1])}/playlists/${users[2]}` };
  const shared = u.pathname.match(/^\/playlists\/((?:lk\.)?[a-f0-9-]{8,64})\/?$/i);
  if (shared) return { kind: 'playlist', path: `/playlist/${encodeURIComponent(shared[1])}` };
  const albumTrack = u.pathname.match(/^\/album\/(\d{1,12})\/track\/(\d{1,12})\/?$/);
  if (albumTrack) return { kind: 'track', ids: [`${albumTrack[2]}:${albumTrack[1]}`] };
  const track = u.pathname.match(/^\/track\/(\d{1,12})\/?$/);
  if (track) return { kind: 'track', ids: [track[1]] };
  const album = u.pathname.match(/^\/album\/(\d{1,12})\/?$/);
  if (album) return { kind: 'album', id: album[1] };
  return null;
}

function yandexCover(uri) {
  const s = String(uri || '').trim();
  if (!s) return '';
  const full = /^https:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(full.replace('%%', '400x400'));
    return u.protocol === 'https:' && /(?:^|\.)yandex\.net$|(?:^|\.)yandex\.ru$/i.test(u.hostname) ? u.href : '';
  } catch (e) { return ''; }
}

function yandexTrack(t) {
  if (!t || typeof t !== 'object') return null;
  let title = lastfmText(t.title, 300);
  if (!title) return null;
  // "Song (Live)", "Song (Remix)": Yandex keeps the version apart
  const version = lastfmText(t.version, 100);
  if (version && !title.toLowerCase().includes(version.toLowerCase())) title = `${title} (${version})`.slice(0, 300);
  const artist = Array.isArray(t.artists) ? t.artists.map((a) => a && lastfmText(a.name, 120)).filter(Boolean).join(', ') : lastfmText(t.artist, 300);
  const ms = Number(t.durationMs);
  const duration = ms > 0 ? Math.round(ms / 1000) : Math.max(0, Math.round(Number(t.duration) || 0));
  return { title, artist: artist.slice(0, 300), duration: duration < 86400 ? duration : 0 };
}

function yandexTracks(result) {
  const list = Array.isArray(result && result.tracks) ? result.tracks : [];
  const out = [];
  for (const item of list.slice(0, 10000)) {
    const t = yandexTrack(item && item.track ? item.track : item);
    if (t) out.push(t);
  }
  return out;
}

// A playlist's songs can come back as bare ids ({ id, albumId }); /tracks gives their details, 100 at a time
function yandexMissingIds(result) {
  const list = Array.isArray(result && result.tracks) ? result.tracks : [];
  const ids = [];
  for (const item of list.slice(0, 10000)) {
    if (!item || typeof item !== 'object' || (item.track && item.track.title) || item.title) continue;
    const id = String(item.id != null ? item.id : '');
    if (!/^\d{1,12}$/.test(id)) continue;
    const albumId = String(item.albumId != null ? item.albumId : '');
    ids.push(/^\d{1,12}$/.test(albumId) ? `${id}:${albumId}` : id);
  }
  return ids;
}

async function fetchYandexTracksByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length && i < 3000; i += 100) {
    const response = await fetchWithTimeout('https://api.music.yandex.net/tracks', {
      method: 'POST',
      headers: { ...YANDEX_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `track-ids=${encodeURIComponent(ids.slice(i, i + 100).join(','))}`
    }, 20000);
    if (!response.ok) { try { logger.log('warn', `Yandex import: /tracks answered ${response.status}`); } catch (_) {} continue; }
    const text = await response.text();
    if (text.length > 20e6) break;
    const data = safeJsonParse(text, null);
    for (const t of (data && Array.isArray(data.result) ? data.result : [])) {
      const track = yandexTrack(t);
      if (track) out.push(track);
    }
  }
  return out;
}

// A shared link (/playlists/lk.<uuid>) is read by its uuid. Yandex's API may list such a playlist's songs only
// as ids unless asked for whole tracks, and may know it with or without the "lk." prefix, so the forms are
// tried in turn; each answer that isn't a playlist is logged, so a shared error log says what Yandex said.
function yandexApiPaths(apiPath) {
  const m = apiPath.match(/^\/playlist\/(.+)$/);
  if (!m) return [apiPath];
  const uuid = decodeURIComponent(m[1]);
  const bare = uuid.replace(/^lk\./i, '');
  const paths = [`/playlist/${encodeURIComponent(uuid)}?richTracks=true`, `/playlist/${encodeURIComponent(uuid)}`];
  if (bare !== uuid) paths.push(`/playlist/${encodeURIComponent(bare)}?richTracks=true`);
  return paths;
}

async function handleYandexImport(req, res, inputUrl) {
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const link = parseYandexLink(inputUrl);
  if (!link) return reply(400, { success: false, error: 'unsupported link: not a Yandex Music playlist, album or song link', status: 404 });
  let lastStatus = 0;
  let empty = false;
  try {
    if (link.kind === 'track') {
      const tracks = await fetchYandexTracksByIds(link.ids);
      if (!tracks.length) return reply(404, { success: false, error: 'not found', status: 404 });
      return reply(200, { success: true, name: tracks[0].title, cover: '', tracks });
    }
    const paths = link.kind === 'album' ? [`/albums/${link.id}/with-tracks`] : yandexApiPaths(link.path);
    for (const p of paths) {
      const response = await fetchWithTimeout(`https://api.music.yandex.net${p}`, { headers: YANDEX_HEADERS }, 20000);
      if (!response.ok) {
        lastStatus = response.status;
        try { logger.log('warn', `Yandex import: ${p.split('?')[0]} answered ${response.status}`); } catch (_) {}
        continue;
      }
      const text = await response.text();
      if (text.length > 20e6) return reply(502, { success: false, error: 'Yandex Music sent too much data' });
      const data = safeJsonParse(text, null);
      const r = data && data.result && typeof data.result === 'object' ? data.result : (data || {});
      // an album lists its songs per disc (volumes)
      const source = link.kind === 'album' ? { tracks: (Array.isArray(r.volumes) ? r.volumes : []).filter(Array.isArray).flat() } : r;
      let tracks = yandexTracks(source);
      const missing = yandexMissingIds(source);
      if (missing.length) tracks = tracks.concat(await fetchYandexTracksByIds(missing));
      if (!tracks.length) {
        empty = true;
        try { logger.log('warn', `Yandex import: ${p.split('?')[0]} had no readable songs`); } catch (_) {}
        continue;
      }
      const cover = yandexCover(r.ogImage) || yandexCover(r.coverUri) || yandexCover(r.cover && (r.cover.uri || (Array.isArray(r.cover.itemsUri) && r.cover.itemsUri[0]))) || (typeof r.cover === 'string' ? yandexCover(r.cover) : '');
      const fallbackName = link.kind === 'album' ? 'Yandex Music album' : 'Yandex Music playlist';
      return reply(200, { success: true, name: lastfmText(r.title || r.name, 200) || fallbackName, cover, tracks });
    }
    // 451: Yandex Music doesn't serve the country the request comes from
    if (lastStatus === 451) return reply(451, { success: false, code: 'yandex_region', error: 'Yandex Music is not available here', status: 451 });
    if (lastStatus === 401 || lastStatus === 403) return reply(403, { success: false, code: 'yandex_private', error: 'private', status: 403 });
    if (empty || lastStatus === 404 || !lastStatus) return reply(404, { success: false, error: 'not found: the playlist is empty or private', status: 404 });
    return reply(502, { success: false, code: 'yandex_failed', error: `Yandex Music answered ${lastStatus}`, status: lastStatus });
  } catch (err) {
    const msg = String((err && err.message) || '');
    const isNet = /timeout|abort|fetch|network|dns|econn|etimedout/i.test(msg) || (err && err.name === 'TimeoutError');
    return reply(isNet ? 504 : 500, { success: false, error: isNet ? 'network' : 'unknown', status: isNet ? 504 : 500 });
  }
}

// a throw inside a route must not become an unhandled rejection that leaves the request hanging
const guardHandler = (handler) => (req, res) => {
  Promise.resolve().then(() => handler(req, res)).catch((e) => {
    try { logger.error('Request handler error: ' + (req.url || '').split('?')[0], e); } catch (_) {}
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'internal error' }));
    } catch (_) {}
  });
};

const server = http.createServer(guardHandler(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  const requestOrigin = req.headers.origin;
  if (requestOrigin && requestOrigin !== 'null') {
    let originAllowed = false;
    try {
      const originUrl = new URL(requestOrigin);
      originAllowed = originUrl.protocol === 'file:' || originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost' || originUrl.hostname === '::1';
    } catch (e) {
      originAllowed = false;
    }
    if (!originAllowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'forbidden' }));
    }
  }

  const hostName = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostName && hostName !== '127.0.0.1' && hostName !== 'localhost' && hostName !== '::1') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'forbidden' }));
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  // a repeated parameter (?id=a&id=b) arrives as an array, which every route would choke on; keep the last
  // value like the phone build's url shim does
  for (const key of Object.keys(parsedUrl.query)) {
    const value = parsedUrl.query[key];
    if (Array.isArray(value)) parsedUrl.query[key] = value[value.length - 1];
  }

  if ((TOKEN_PROTECTED_ROUTES.has(parsedUrl.pathname) || routeNeedsToken(parsedUrl.pathname)) && !tokenMatches(req.headers['x-muriel-token']) && !tokenMatches(parsedUrl.query.t)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'forbidden' }));
  }
  if (parsedUrl.pathname === '/api/lyrics-stream' && req.headers.origin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'forbidden' }));
  }

  if (parsedUrl.pathname === '/api/audio-output-info' && req.method === 'GET') {
    const info = await getSystemAudioOutputInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(info));
  }

  if (parsedUrl.pathname === '/api/translate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      const payload = safeJsonParse(body, {});
      const raw = payload.texts || payload.lines || [];
      // a null or number among the lines used to throw outside any handler and leave the request hanging
      const texts = Array.isArray(raw) ? raw.map((t) => (typeof t === 'string' ? t : t == null ? '' : String(t))) : [];
      const targetLang = typeof (payload.targetLang || payload.to) === 'string' ? (payload.targetLang || payload.to) : 'en';
      handleTranslate(req, res, texts, targetLang).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/api/i18n-batch') {
    const reply = (r) => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body)); };
    if (req.method === 'GET') return reply(i18nAll(parsedUrl.query.target));
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      const payload = safeJsonParse(body, {}) || {};
      handleI18nBatch(payload.target || payload.targetLang || payload.to, payload.texts).then(reply, (e) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        currentAppState = state;
        broadcastSSE(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/lyrics-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify(currentAppState)}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (parsedUrl.pathname === '/api/download') {
    const trackUrl = parsedUrl.query.url || '';
    const trackId = parsedUrl.query.id || '';
    const streamUrl = parsedUrl.query.streamUrl || '';
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const format = parsedUrl.query.format || 'mp3';
    const quality = parsedUrl.query.quality || '0';
    const raw = parsedUrl.query.raw === '1' || parsedUrl.query.raw === 'true';
    let start = null;
    if (parsedUrl.query.start !== undefined && parsedUrl.query.start !== '') {
      const n = parseFloat(parsedUrl.query.start);
      if (!isNaN(n)) start = Math.max(0, n);
    }
    let end = null;
    if (parsedUrl.query.end !== undefined && parsedUrl.query.end !== '') {
      const n = parseFloat(parsedUrl.query.end);
      if (!isNaN(n)) end = Math.max(0, n);
    }
    return handleDownload(req, res, trackUrl, title, artist, format, quality, start, end, raw, trackId, streamUrl);
  }

  if (parsedUrl.pathname === '/api/tmp-file') {
    return handleTmpFile(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/encode' && req.method === 'POST') {
    return handleEncode(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/spotify-import') {
    const spotifyUrl = parsedUrl.query.url || '';
    return handleSpotifyImport(req, res, spotifyUrl);
  }

  if (parsedUrl.pathname === '/api/apple-import') {
    const appleUrl = parsedUrl.query.url || '';
    return handleAppleImport(req, res, appleUrl);
  }

  if (parsedUrl.pathname === '/api/playlist-import') {
    const playlistUrl = parsedUrl.query.url || '';
    return handlePlaylistImport(req, res, playlistUrl);
  }

  if (parsedUrl.pathname === '/api/yandex-import') {
    return handleYandexImport(req, res, parsedUrl.query.url || '');
  }

  if (parsedUrl.pathname.startsWith('/api/lastfm/')) {
    return handleLastFmRoute(req, res, parsedUrl.pathname);
  }

  if (parsedUrl.pathname === '/api/albums/search') {
    return handleAlbumSearch(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/artist-albums') {
    return handleArtistAlbums(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/albums/tracks' || parsedUrl.pathname === '/api/album' || parsedUrl.pathname === '/api/album-tracks') {
    return handleAlbumTracks(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/trending') {
    return handleTrending(req, res);
  }

  if (parsedUrl.pathname === '/api/hot') {
    return handleHotPicks(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/spotify-auth-start') {
    loadSpotifyAuth();
    spotifyAuthLoaded = true;
    const clientId = parsedUrl.query.clientId || '';
    if (!/^[a-f0-9]{32}$/i.test(clientId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Invalid Client ID' }));
    }
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    spotifyAuth = { verifier, state, clientId, token: '', refreshToken: '', expiresAt: 0 };
    spotifyAuthError = '';
    const redirectUri = getSpotifyRedirectUri();
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(SPOTIFY_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge_method=S256&code_challenge=${encodeURIComponent(challenge)}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, url: authUrl, redirectUri }));
  }

  if (parsedUrl.pathname === '/api/spotify-callback') {
    const code = parsedUrl.query.code;
    const state = parsedUrl.query.state;
    const errParam = parsedUrl.query.error;
    if (!spotifyAuth.state || !state || state !== spotifyAuth.state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body><p>Invalid Spotify login session.</p></body></html>');
    }
    if (errParam || !code) {
      spotifyAuthError = errParam === 'access_denied' ? 'Spotify authorization was denied.' : 'Spotify login failed. Check the Client ID, allowed account and redirect URI.';
      spotifyAuth.state = '';
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body><p>Spotify login failed. Return to Muriel for details.</p></body></html>');
    }
    const redirectUri = getSpotifyRedirectUri();
    try {
      const session = spotifyAuth;
      const tokenResult = await requestSpotifyToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: spotifyAuth.clientId, code_verifier: spotifyAuth.verifier });
      if (spotifyAuth !== session) {
        res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><body><p>Spotify login session changed. Return to Muriel and try again.</p></body></html>');
      }
      spotifyAuth.state = '';
      if (tokenResult.status >= 200 && tokenResult.status < 300 && typeof tokenResult.data?.access_token === 'string' && tokenResult.data.access_token) {
        spotifyAuth.token = tokenResult.data.access_token;
        spotifyAuth.refreshToken = typeof tokenResult.data.refresh_token === 'string' ? tokenResult.data.refresh_token : '';
        spotifyAuth.expiresAt = Date.now() + (Number.isFinite(tokenResult.data.expires_in) && tokenResult.data.expires_in > 0 ? tokenResult.data.expires_in : 3600) * 1000;
        if (!spotifyAuth.refreshToken) spotifyAuthError = 'Spotify did not provide a refresh token; reconnect when this session expires.';
        else if (!saveSpotifyAuth()) spotifyAuthError = 'Spotify login could not be saved securely; reconnect after restarting Muriel.';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><body><p>Muriel is connected to Spotify. You can close this tab.</p></body></html>');
      } else {
        const reason = tokenResult.data?.error_description || tokenResult.data?.error || `HTTP ${tokenResult.status}`;
        spotifyAuthError = `Spotify token exchange failed: ${reason}`;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><body><p>Spotify login failed. Return to Muriel for details.</p></body></html>');
      }
    } catch (err) {
      spotifyAuth.state = '';
      spotifyAuthError = `Could not reach Spotify: ${err.message}`;
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body><p>Spotify login failed. Return to Muriel for details.</p></body></html>');
    }
  }

  if (parsedUrl.pathname === '/api/spotify-status') {
    loadSpotifyAuth();
    if (spotifyAuth.refreshToken) {
      try { await getSpotifyAccessToken(); }
      catch (e) { spotifyAuthError = e.message; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ connected: Boolean(spotifyAuth.token && (!spotifyAuth.expiresAt || Date.now() < spotifyAuth.expiresAt)), error: spotifyAuthError }));
  }

  if (parsedUrl.pathname === '/api/spotify-logout') {
    try { clearStoredSpotifyAuth(); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Could not remove saved Spotify login' }));
    }
    spotifyAuth = { verifier: '', state: '', clientId: '', token: '', refreshToken: '', expiresAt: 0 };
    spotifyAuthError = '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/spotify-library') {
    return handleSpotifyLibrary(req, res, parsedUrl.query);
  }

  if (parsedUrl.pathname === '/api/search') {
    const q = parsedUrl.query.q || '';
    const platform = parsedUrl.query.platform || 'youtube';
    const limit = Math.max(1, Math.min(50, parseInt(parsedUrl.query.limit || '20', 10) || 20));
    return handleSearch(req, res, q, platform, limit);
  }

  if (parsedUrl.pathname === '/api/vibe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      const payload = safeJsonParse(body, {});
      handleVibeRecommendations(req, res, payload);
    });
    return;
  }

  if (parsedUrl.pathname === '/api/radio' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => handleSongRadio(req, res, safeJsonParse(body, {})));
    return;
  }

  if (parsedUrl.pathname === '/api/discover' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', async () => {
      const payload = safeJsonParse(body, {});
      try {
        const data = await buildDiscover(Array.isArray(payload.history) ? payload.history : [], Array.isArray(payload.favorites) ? payload.favorites : []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...data }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/artist') {
    const name = parsedUrl.query.name || '';
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Missing artist name' }));
    }
    const info = await fetchArtistInfo(name, parsedUrl.query.id || '', parsedUrl.query.video || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, artist: info }));
  }

  if (parsedUrl.pathname === '/api/artist-matches') {
    return handleArtistMatches(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/prefetch') {
    const trackUrl = parsedUrl.query.url || '';
    const trackId = parsedUrl.query.id || '';
    const platform = parsedUrl.query.platform || 'youtube';
    const q = parsedUrl.query;
    prefetchTrack(trackUrl, trackId, platform, q.title ? { title: q.title, artist: q.artist || '', duration: Number(q.duration) || 0, thumbnail: q.thumbnail || '' } : null, q.next === '1' ? 'normal' : 'background');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // which songs of a list are on this device already (a downloaded file, or the offline cache): the album
  // page's Download button (#19) skips them and says so
  if (parsedUrl.pathname === '/api/downloaded-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', async () => {
      const payload = safeJsonParse(body, {});
      const tracks = (Array.isArray(payload.tracks) ? payload.tracks : []).slice(0, 500);
      try {
        const downloaded = await Promise.all(tracks.map(async (t) => {
          if (!t || typeof t !== 'object') return false;
          const title = typeof t.title === 'string' ? t.title : '';
          const artist = typeof t.artist === 'string' ? t.artist : '';
          if ((title || artist) && await findDownloadedFile(title, artist)) return true;
          const id = cleanTrackId(typeof t.id === 'string' ? t.id : '');
          return !!(id && await findCachedFile(id));
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, downloaded }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/check-cache') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const cachedFile = await findCachedFile(cleanId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      cached: !!cachedFile, 
      streamUrl: cachedFile ? withToken(`http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}`) : null 
    }));
  }

  if (parsedUrl.pathname === '/api/tools-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(require('./tools').toolsStatus()));
  }

  if (parsedUrl.pathname === '/api/tools-install') {
    require('./tools').ensureTools().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ started: true }));
  }

  if (parsedUrl.pathname === '/api/stream-info') {
    const trackUrl = parsedUrl.query.url || '';
    const trackId = parsedUrl.query.id || '';
    const platform = parsedUrl.query.platform || 'youtube';
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const duration = parsedUrl.query.duration || 0;
    const thumbnail = parsedUrl.query.thumbnail || '';
    return handleStreamInfo(req, res, trackUrl, trackId, platform, title, artist, duration, thumbnail, parsedUrl.query.fresh === '1');
  }

  if (parsedUrl.pathname === '/api/local-track') {
    const trackId = parsedUrl.query.id || '';
    return handleLocalTrack(req, res, trackId);
  }

  if (parsedUrl.pathname === '/api/downloaded-track') {
    const name = parsedUrl.query.name || '';
    return handleDownloadedTrack(req, res, name);
  }

  if (parsedUrl.pathname === '/api/library-add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const items = Array.isArray(payload.items) ? payload.items : [];
        const fileRegex = /^local_[a-f0-9]{12}\.[a-z0-9]+$/;
        let addedCount = 0;
        for (const item of items) {
          // "__proto__" as a key would replace the index's prototype instead of adding a track
          if (!item || typeof item.id !== 'string' || !item.id || item.id === '__proto__' || typeof item.file !== 'string') continue;
          if (!fileRegex.test(item.file)) continue;
          const fullPath = path.join(LIBRARY_DIR, item.file);
          if (!fs.existsSync(fullPath)) continue;

          let rawName = String(item.name || '').trim();
          let cleanName = rawName.replace(/^\d+(?:[.\s-]+)\s*/, '').trim() || rawName || 'Untitled';

          const dashIdx = cleanName.indexOf(' - ');
          let artist = 'Unknown artist';
          let title = cleanName;
          if (dashIdx !== -1) {
            artist = cleanName.slice(0, dashIdx).trim() || 'Unknown artist';
            title = cleanName.slice(dashIdx + 3).trim() || cleanName;
          }

          libraryIndex[item.id] = {
            id: item.id,
            file: item.file,
            ext: item.ext || path.extname(item.file).slice(1).toLowerCase(),
            title: title,
            artist: artist,
            duration: 0,
            addedAt: Date.now()
          };
          addedCount++;
        }
        saveLibraryIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: addedCount }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/library-update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { id, duration } = payload;
        // own keys only: id "__proto__" used to write `duration` onto Object.prototype for the whole process
        if (typeof id === 'string' && hasOwn(libraryIndex, id) && typeof duration === 'number' && !isNaN(duration)) {
          libraryIndex[id].duration = duration;
          saveLibraryIndex();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/library') {
    const items = Object.values(libraryIndex).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    queueLocalCovers(items.map(item => item.id));
    const list = items.map(item => ({
        id: item.id,
        platform: 'local',
        title: item.title,
        artist: item.artist,
        duration: Number(item.duration) || 0,
        thumbnail: fs.existsSync(localCoverPath(item.id)) ? withToken(`http://127.0.0.1:${PORT}/api/local-cover?id=${encodeURIComponent(item.id)}`) : ''
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  if (parsedUrl.pathname === '/api/local-cover') {
    return handleLocalCover(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/library-file') {
    const trackId = parsedUrl.query.id || '';
    return handleLibraryFile(req, res, trackId);
  }

  if (parsedUrl.pathname === '/api/library-remove' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = payload.id || parsedUrl.query.id || '';
        if (typeof id === 'string' && hasOwn(libraryIndex, id)) {
          const item = libraryIndex[id];
          if (item.file) {
            const fullPath = path.join(LIBRARY_DIR, item.file);
            try {
              if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            } catch (e) {}
          }
          delete libraryIndex[id];
          saveLibraryIndex();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/image-proxy') {
    return handleImageProxy(req, res, parsedUrl);
  }

  if (parsedUrl.pathname === '/api/local-thumbnail') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const thumbPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
    if (fs.existsSync(thumbPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' });
      return streamFileToResponse(fs.createReadStream(thumbPath), res);
    }
    res.writeHead(404);
    return res.end('Thumbnail not cached');
  }

  if (parsedUrl.pathname === '/api/offline-library') {
    const tracks = [];
    let totalBytes = 0;
    try {
      const files = await fs.promises.readdir(CACHE_DIR);
      const audioExtRegex = /\.(opus|webm|m4a|mp3|aac)$/i;
      for (const file of files) {
        if (audioExtRegex.test(file) && !file.includes('.temp.')) {
          const cleanId = file.replace(audioExtRegex, '');
          const stat = await fs.promises.stat(path.join(CACHE_DIR, file));
          totalBytes += stat.size;
          const meta = trackMetadataIndex[cleanId] || {};
          tracks.push({
            id: meta.id || cleanId,
            cleanId: cleanId,
            title: meta.title || cleanId,
            artist: meta.artist || 'Unknown artist',
            duration: meta.duration || 0,
            thumbnail: meta.thumbnail || '',
            localThumbnail: fs.existsSync(path.join(THUMBNAILS_DIR, `${cleanId}.jpg`)) ? withToken(`http://127.0.0.1:${PORT}/api/local-thumbnail?id=${cleanId}`) : (meta.thumbnail || ''),
            platform: meta.platform || 'youtube',
            fileSize: stat.size,
            lastPlayed: meta.lastPlayed || stat.mtimeMs,
            analysis: meta.analysis || null
          });
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, count: tracks.length, totalBytes, tracks }));
  }

  if (parsedUrl.pathname === '/api/track-analysis') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { if (res.writableEnded) return; body += chunk; if (body.length > MAX_BODY_BYTES) { body = ''; req.removeAllListeners('data'); req.removeAllListeners('end'); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'payload too large' })); req.resume(); } });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const cleanId = cleanTrackId(payload.id || '');
          if (cleanId && payload.analysis) {
            saveTrackMetadata(cleanId, { analysis: payload.analysis });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    const cleanId = cleanTrackId(parsedUrl.query.id || '');
    const meta = trackMetadataIndex[cleanId] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, analysis: meta.analysis || null }));
  }

  if (parsedUrl.pathname === '/api/offline-delete' && req.method === 'POST') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const audioPath = await findCachedFile(cleanId);
    const thumbPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
    try { if (audioPath && fs.existsSync(audioPath)) await fs.promises.unlink(audioPath); } catch (e) {}
    try { if (fs.existsSync(thumbPath)) await fs.promises.unlink(thumbPath); } catch (e) {}
    delete trackMetadataIndex[cleanId];
    try { writeJsonFile(METADATA_PATH, trackMetadataIndex); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/clear-offline-library' && req.method === 'POST') {
    try {
      const files = await fs.promises.readdir(CACHE_DIR);
      const audioExtRegex = /\.(opus|webm|m4a|mp3|aac)$/i;
      for (const file of files) {
        if (audioExtRegex.test(file)) {
          try { await fs.promises.unlink(path.join(CACHE_DIR, file)); } catch (e) {}
        }
      }
      const thumbFiles = await fs.promises.readdir(THUMBNAILS_DIR);
      for (const file of thumbFiles) {
        try { await fs.promises.unlink(path.join(THUMBNAILS_DIR, file)); } catch (e) {}
      }
      trackMetadataIndex = {};
      try { writeJsonFile(METADATA_PATH, trackMetadataIndex); } catch (e) {}
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/audio-proxy') {
    const targetUrl = parsedUrl.query.url || '';
    return handleAudioProxy(req, res, targetUrl);
  }

  if (parsedUrl.pathname === '/api/save-custom-lyrics' && req.method === 'POST') {
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    return handleSaveCustomLyrics(req, res, title, artist);
  }

  if (parsedUrl.pathname === '/api/lyrics') {
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const allowOnline = parsedUrl.query.online !== '0';
    const duration = Number(parsedUrl.query.duration) || 0;
    const source = parsedUrl.query.source === 'genius' ? 'genius' : 'lrclib';
    return handleLyrics(req, res, title, artist, allowOnline, duration, source);
  }

  // word timings for karaoke (Settings → Word-by-word source), lined up with the lyrics by app.js
  if (parsedUrl.pathname === '/api/lyrics-words') {
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const duration = Number(parsedUrl.query.duration) || 0;
    let lines = null;
    try { lines = await fetchNetEaseWords(title, artist, duration); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: !!(lines && lines.length), lines: lines || [] }));
  }

  res.writeHead(404);
  res.end('Not found');
}));

function startServer(port = PORT) {
  if (server.listening) {
    const address = server.address();
    return Promise.resolve(address && typeof address === 'object' ? address.port : port);
  }
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = address && typeof address === 'object' ? address.port : port;
      console.log(`devsize internal server running on http://127.0.0.1:${bound}`);
      require('./tools').updateYtDlpIfManaged().catch(() => {});
      resolve(bound);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1', () => {
          const p = server.address().port;
          console.log(`devsize internal server running on fallback port http://127.0.0.1:${p}`);
          require('./tools').updateYtDlpIfManaged().catch(() => {});
          resolve(p);
        });
      } else {
        reject(err);
      }
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

module.exports = { startServer, stopServer, PORT, getServerToken };

if (require.main === module) {
  startServer();
}
