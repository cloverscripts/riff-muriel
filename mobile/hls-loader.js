// hls.js on phones: playlists and segments are fetched with native HTTP (globalThis.__murielFetch), like every
// other outside request in the app. The WebView's own XHR would be refused by googlevideo (no CORS, and YouTube
// only serves the visionOS stream to its own User-Agent), and the audio would reach Web Audio cross-origin.
// server.js answers a tapped song with such a playlist (mobile/shims/platform.js liveStream), so it plays
// within a second or two instead of after the whole file has downloaded.

// the request headers a stream wants, by site ("googlevideo.com"): its playlist and segments share them
const bySite = new Map();
const siteOf = (url) => { try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch (e) { return ''; } };
globalThis.__murielHlsHeaders = {
  remember(url, headers) { if (siteOf(url)) bySite.set(siteOf(url), { ...(headers || {}) }); },
  for: (url) => bySite.get(siteOf(url)) || {},
};

function newStats() {
  return {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
  };
}

class NativeLoader {
  constructor() { this.stats = newStats(); this.context = null; this.ac = null; this.timer = null; }

  destroy() { this.abortInternal(); }

  abortInternal() {
    clearTimeout(this.timer);
    if (this.ac) { this.ac.abort(); this.ac = null; }
  }

  abort() {
    this.abortInternal();
    this.stats.aborted = true;
    if (this.callbacks && this.callbacks.onAbort) this.callbacks.onAbort(this.stats, this.context, null);
  }

  load(context, config, callbacks) {
    this.context = context;
    this.callbacks = callbacks;
    const stats = (this.stats = newStats());
    stats.loading.start = performance.now();
    const ac = (this.ac = new AbortController());
    const headers = { ...globalThis.__murielHlsHeaders.for(context.url) };
    if (context.rangeEnd) headers.Range = `bytes=${context.rangeStart}-${context.rangeEnd - 1}`;
    const timeout = (config && (config.loadPolicy ? config.loadPolicy.maxLoadTimeMs : config.timeout)) || 20000;
    this.timer = setTimeout(() => {
      if (this.ac !== ac) return;
      this.abortInternal();
      callbacks.onTimeout(stats, context, null);
    }, timeout);
    const binary = context.responseType === 'arraybuffer';
    globalThis.__murielFetch(context.url, { headers, signal: ac.signal })
      .then(async (r) => {
        if (this.ac !== ac) return;
        if (!r.ok) {
          this.abortInternal();
          callbacks.onError({ code: r.status, text: r.statusText || `HTTP ${r.status}` }, context, null, stats);
          return;
        }
        const data = binary ? await r.arrayBuffer() : await r.text();
        if (this.ac !== ac) return;
        clearTimeout(this.timer);
        this.ac = null;
        const size = binary ? data.byteLength : data.length;
        stats.loading.first = stats.loading.first || performance.now();
        stats.loading.end = performance.now();
        stats.loaded = stats.total = size;
        stats.chunkCount = 1;
        callbacks.onSuccess({ url: r.url || context.url, data, code: r.status }, stats, context, null);
      })
      .catch((e) => {
        if (this.ac !== ac) return; // aborted or timed out: already reported
        this.abortInternal();
        callbacks.onError({ code: 0, text: (e && e.message) || 'network error' }, context, null, stats);
      });
  }

  getCacheAge() { return null; }
  getResponseHeader() { return null; }
}

// app.js makes a new Hls() per song; DefaultConfig.loader is what each one fetches with
function install() {
  const Hls = window.Hls;
  if (!Hls || !Hls.DefaultConfig || Hls.DefaultConfig.loader === NativeLoader) return !!Hls;
  Hls.DefaultConfig.loader = NativeLoader;
  return true;
}

module.exports = () => { if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true }); };
module.exports.NativeLoader = NativeLoader;
