'use strict';
// #17: how Muriel hands a YouTube media URL to the desktop audio element. yt-dlp resolves the URL with a
// player client (android, tv, ...) and YouTube serves it only to requests that look like that client;
// Chromium fetching it with its own User-Agent/Origin gets a refusal the <audio> element reports as
// "MEDIA_ELEMENT_ERROR: Format error" (code 4). The same yt-dlp run also prints the request headers it
// would use (one process, no extra spawn), and the local audio proxy fetches the stream with them.

// yt-dlp arguments that print the media URL(s), then the request headers as one JSON line
const LOOKUP_PRINT_ARGS = ['--print', 'urls', '--print', '%(http_headers)j'];

function parseLookup(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const url = lines.find((l) => l.startsWith('http')) || null;
  let headers = null;
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    try {
      const h = JSON.parse(l);
      if (h && typeof h === 'object' && !Array.isArray(h)) { headers = h; break; }
    } catch (_) {}
  }
  return { url, headers };
}

// headers for the upstream request: Range (and the rest) from the player, yt-dlp's User-Agent etc. win
// over the browser's. Cookies and anything else from the renderer never go upstream.
const YT_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'sec-fetch-mode', 'referer', 'origin']);
function upstreamHeaders(reqHeaders, ytHeaders) {
  const out = {};
  const from = reqHeaders || {};
  for (const key of ['range', 'accept', 'accept-language', 'user-agent']) {
    if (from[key] !== undefined) out[key] = from[key];
  }
  if (ytHeaders) {
    for (const [k, v] of Object.entries(ytHeaders)) {
      const key = k.toLowerCase();
      if (YT_HEADERS.has(key) && typeof v === 'string') out[key] = v;
    }
  }
  return out;
}

// upstream response headers passed to the audio element, without the upstream's CORS and cookie headers
// (the local server answers CORS itself)
function downstreamHeaders(upstream) {
  const out = {};
  for (const [k, v] of Object.entries(upstream || {})) {
    const key = k.toLowerCase();
    if (key.startsWith('access-control-') || key === 'set-cookie' || key === 'alt-svc' || key === 'connection' || key === 'keep-alive') continue;
    out[key] = v;
  }
  out['access-control-allow-origin'] = '*';
  return out;
}

function isGoogleVideoUrl(u) {
  try { const h = new URL(u).hostname; return h === 'googlevideo.com' || h.endsWith('.googlevideo.com'); } catch (_) { return false; }
}

// the src the audio element gets for a /api/stream-info answer: YouTube streams go through the local
// proxy on desktop; phones (which play downloaded files) and HLS keep the URL they were given
function pickStreamSrc(data, isMobile) {
  if (!data || !data.streamUrl) return null;
  if (!isMobile && !data.isHls && !data.isLocal && data.proxyUrl && isGoogleVideoUrl(data.streamUrl)) return data.proxyUrl;
  return data.streamUrl;
}

const api = { LOOKUP_PRINT_ARGS, parseLookup, upstreamHeaders, downstreamHeaders, isGoogleVideoUrl, pickStreamSrc };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
