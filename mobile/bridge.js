// Runs Muriel's own server.js inside the iOS app and makes app.js think it is talking to the
// desktop backend on 127.0.0.1. Loaded before app.js.
const { Capacitor } = require('@capacitor/core');
const store = require('./shims/store');
const http = require('./shims/http');
const fs = require('./shims/fs');
const { enforceCacheLimit } = require('./cache-limit');
const electronAPI = require('./electron-api');

// ---- error log ("Fehlerlog teilen" in Settings): last 300 warnings/errors, kept across restarts ----
const LOG_KEY = 'muriel_debug_log';
const logLines = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; } })();
let logSaveTimer = null;
function murielLog(level, msg) {
  logLines.push(`${new Date().toISOString()} ${level.toUpperCase()} ${String(msg).slice(0, 500)}`);
  if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => { try { localStorage.setItem(LOG_KEY, JSON.stringify(logLines)); } catch (e) {} }, 500);
}
for (const level of ['warn', 'error']) {
  const orig = console[level].bind(console);
  // a cyclic object made JSON.stringify throw, which turned every such log call into an exception
  const str = (a) => { if (a && a.stack) return a.stack; if (typeof a !== 'object') return String(a); try { return JSON.stringify(a); } catch (e) { return String(a); } };
  console[level] = (...args) => { murielLog(level, args.map(str).join(' ')); orig(...args); };
}
window.addEventListener('error', (e) => murielLog('error', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => murielLog('error', `unhandled: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));
// for mobile-ui.js (a plain script): trim the song cache right after the limit is lowered
window.MurielCache = { enforceLimit: () => enforceCacheLimit() };
window.MurielLog = {
  add: murielLog,
  text: () => [`Muriel ${navigator.userAgent}`, `platform: ${Capacitor.getPlatform()}`, ...logLines].join('\n'),
  clear: () => { logLines.length = 0; try { localStorage.removeItem(LOG_KEY); } catch (e) {} },
};

const PORT = 38472;
const BASE = `http://127.0.0.1:${PORT}/`;
const MIME = { '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const mimeOf = (p) => MIME[(p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()];

// ---- outbound HTTP without CORS ----
// In the app, CapacitorHttp has already replaced window.fetch with native networking.
// In a desktop browser (dev harness) requests go through the dev server's /__proxy.
const pageFetch = window.fetch.bind(window);
const plainHeaders = (h) => (h instanceof Headers ? Object.fromEntries(h.entries()) : { ...(h || {}) });
async function toPlain(input, init = {}) {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    // A Request silently drops "forbidden" headers like User-Agent; youtubei.js passes the real
    // ones (its client User-Agent included) in `init`, so those win.
    const body = init.body !== undefined ? init.body : ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().text();
    return [input.url, { method: init.method || input.method, headers: { ...plainHeaders(input.headers), ...plainHeaders(init.headers) }, body, signal: init.signal || input.signal }];
  }
  return [String(input), { ...init, headers: plainHeaders(init.headers) }];
}
// Every outside request gets a deadline. Android's native HTTP has none and iOS waits up to 10 minutes, so one
// stalled request (network switch, captive portal) kept a song "loading" until the app was restarted.
const REQUEST_DEADLINE_MS = 30000;
globalThis.__murielFetch = async (input, init) => {
  const [url, opts] = await toPlain(input, init);
  const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_DEADLINE_MS) : null;
  if (timeout) opts.signal = opts.signal && AbortSignal.any ? AbortSignal.any([opts.signal, timeout]) : (opts.signal || timeout);
  let request;
  if (Capacitor.isNativePlatform()) request = pageFetch(url, opts);
  else {
    const { headers, ...rest } = opts;
    request = pageFetch(`/__proxy?url=${encodeURIComponent(url)}`, { ...rest, headers: { 'x-fwd-headers': JSON.stringify(headers || {}) } });
  }
  // native POSTs ignore the signal, so the deadline is also enforced here
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`request timed out: ${url.slice(0, 80)}`)), REQUEST_DEADLINE_MS + 1000); });
  try { return await Promise.race([request, deadline]); } finally { clearTimeout(timer); }
};

// ---- secrets server.js keeps (the Last.fm logins) ----
// In the WebView's own storage, which only Muriel can read; not under /data, which on iPhone is the Muriel folder
// the Files app shows (and backs up). One entry per device (profiles-core.js lists muriel_secret_ as a device key)
// holding each profile's login, like lastfm-auth.enc on desktop. Never synced, never in an account export.
globalThis.__murielVault = (name) => {
  const key = `muriel_secret_${String(name).replace(/[^a-z0-9_]/gi, '')}`;
  return {
    read() {
      const raw = localStorage.getItem(key);
      if (raw == null) { const e = new Error('nothing saved'); e.code = 'ENOENT'; throw e; }
      return JSON.parse(raw);
    },
    write(value) { localStorage.setItem(key, JSON.stringify(value)); },
  };
};

// ---- the in-app "server" ----
let ready;
let server = null;
async function start() {
  await fs.init();
  server = require('../server.js');
  server.startServer(PORT);
}

function call(url, init = {}) {
  return ready.then(() => http.dispatch({
    url: url.slice(BASE.length - 1),
    method: init.method || 'GET',
    // there's no socket to protect in-app, but server.js checks its CSRF token, so every call carries it
    headers: { ...(init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {})), 'x-muriel-token': server.getServerToken() },
    body: typeof init.body === 'string' ? init.body : '',
    signal: init.signal,
  }));
}
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

const fileUrls = new Map();
async function fileUrlFor(vpath) {
  if (!fileUrls.has(vpath)) {
    await fs._flush(); // a just-written file must reach disk before the WebView reads it
    fileUrls.set(vpath, store.fileUrl(vpath, mimeOf(vpath)));
  }
  return fileUrls.get(vpath);
}

// Turns an app.js URL like http://127.0.0.1:38472/api/local-track?id=x into something the WebView can load.
async function resolveLocalUrl(u) {
  const r = await call(u);
  if (r.file) return fileUrlFor(r.file);
  throw new Error(`no file behind ${u} (${r.status})`);
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input && input.url;
  if (!url || !url.startsWith(BASE)) return pageFetch(input, init);
  const started = Date.now();
  // app.js aborts the previous song's lookup on every skip; that now also stops its download (see http shim)
  if (init.signal && init.signal.aborted) throw abortError();
  let r = await call(url, init);
  if (r.aborted || (init.signal && init.signal.aborted)) throw abortError();
  // loading a song can fail on a passing YouTube/network hiccup; one quiet retry fixes most of them.
  // A slow failure already went through every download route, so repeating it only burns data and battery.
  if (r.status >= 500 && url.includes('/api/stream-info') && Date.now() - started < 6000) {
    murielLog('warn', `stream-info failed (${r.status}), retrying: ${r.body.slice(0, 120)}`);
    await new Promise((res) => setTimeout(res, 1200));
    r = await call(url, init);
  }
  if (r.file) return pageFetch(await fileUrlFor(r.file));
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
};

// <audio src> and <img src> pointing at the local server get swapped for real file URLs.
function patchSrc(proto) {
  const desc = Object.getOwnPropertyDescriptor(proto, 'src');
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() { return this.__murielSrc !== undefined ? this.__murielSrc : desc.get.call(this); },
    set(v) {
      v = String(v);
      if (!v.startsWith(BASE)) { this.__murielSrc = undefined; this.__murielPending = null; desc.set.call(this, v); return; }
      this.__murielSrc = v;
      this.__murielPending = resolveLocalUrl(v)
        .then((real) => { if (this.__murielSrc === v) desc.set.call(this, real); })
        .catch((e) => { console.warn('[muriel]', e.message); if (this.__murielSrc === v) this.dispatchEvent(new Event('error')); });
    },
  });
}
patchSrc(HTMLMediaElement.prototype);
patchSrc(HTMLImageElement.prototype);

// app.js unloads a song with removeAttribute('src'); forget the local URL too, or `audio.src` keeps reporting
// the old song (so play/pause thought one was loaded) and a late file lookup could load it back in
const realRemoveAttribute = Element.prototype.removeAttribute;
Element.prototype.removeAttribute = function (name) {
  if (this.__murielSrc !== undefined && String(name).toLowerCase() === 'src') { this.__murielSrc = undefined; this.__murielPending = null; }
  return realRemoveAttribute.call(this, name);
};

const realPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  return this.__murielPending ? this.__murielPending.then(() => realPlay.call(this)) : realPlay.call(this);
};

// <img src="..."> written as HTML strings never hit the setter above.
new MutationObserver((muts) => {
  for (const m of muts) {
    const nodes = m.type === 'attributes' ? [m.target] : [...m.addedNodes].flatMap((n) => (n.querySelectorAll ? [n, ...n.querySelectorAll('img')] : []));
    for (const n of nodes) {
      if (n.tagName === 'IMG' && n.__murielSrc === undefined) {
        const raw = n.getAttribute('src') || '';
        if (raw.startsWith(BASE)) n.src = raw;
      }
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

// Android hardware back: close whatever is on top instead of quitting the app.
// On Home it backgrounds the app (music keeps playing) rather than closing it.
if (Capacitor.getPlatform() === 'android') {
  // YouTube songs download as Opus (WebM) instead of AAC (shims/child_process.js)
  globalThis.__murielPlaysOpus = true;
  const { App } = require('@capacitor/app');
  const visible = (el) => el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  App.addListener('backButton', () => {
    if (window.MurielEncore && document.querySelector('.encore')) { window.MurielEncore.close(); return; }
    const modal = [...document.querySelectorAll('.modal-backdrop')].reverse().find((m) => visible(m) && m.classList.contains('visible'));
    if (modal) {
      const closeBtn = modal.querySelector('[id^="btn-close"], [id^="btn-cancel"], .modal-close');
      if (closeBtn) closeBtn.click(); else modal.click();
      return;
    }
    const tv = document.getElementById('tv-karaoke');
    if (visible(tv)) { document.getElementById('btn-close-tv-karaoke').click(); return; }
    const drawer = document.getElementById('rail-drawer');
    if (visible(drawer)) { document.getElementById('btn-close-rail-drawer').click(); return; }
    if (document.body.classList.contains('np-open')) { document.getElementById('btn-close-right-panel').click(); return; }
    // Settings: out of the search, then out of the open category back to the list of categories
    if (window.MurielSettingsBack && window.MurielSettingsBack()) return;
    const home = document.getElementById('nav-discover');
    if (home && !home.classList.contains('active')) { home.click(); return; }
    App.minimizeApp();
  });
}

// muriel://link?code=… (the QR code in Settings → Sync, scanned with the camera) opens the app; sync.js links it
{
  const { App } = require('@capacitor/app');
  const deliver = (url) => {
    if (!url || !/^muriel:/i.test(url)) return;
    const go = () => window.dispatchEvent(new CustomEvent('muriel:deeplink', { detail: url }));
    if (window.MurielSync) go(); else window.addEventListener('muriel:ready', () => setTimeout(go, 300), { once: true });
  };
  App.addListener('appUrlOpen', (e) => deliver(e && e.url));
  App.getLaunchUrl().then((r) => deliver(r && r.url)).catch(() => {});
}

ready = start();
window.electronAPI = electronAPI({ ready, port: PORT, fs, fileUrlFor });
require('./live-activity')();
require('./media-controls')();
require('./background-audio')();
require('./audio-interruption')();
document.documentElement.classList.add('is-mobile');
