// Fast YouTube stream lookup for the computer: one request to YouTube's player API as the visionOS client
// (the route the phone app uses, mobile/extract.js) instead of starting yt-dlp, which takes seconds per
// song. YouTube doesn't hand out every song this way, so the link is checked before it's used and the
// caller falls back to yt-dlp when this returns null.
const https = require('https');

const VOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const VISITOR_MAX_AGE = 30 * 60e3;
const PREFERRED_ITAGS = [251, 140, 250, 249, 139];

function request(url, { method = 'GET', headers = {}, body = null, timeout = 4000, maxBytes = 4 * 1024 * 1024, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout, maxHeaderSize: 128 * 1024 }, (res) => {
      // googlevideo moves a request to another server with a redirect; only https ones are followed
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0 && method === 'GET') {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch (e) { reject(e); return; }
        if (next.protocol !== 'https:') { reject(new Error('insecure redirect')); return; }
        request(next.href, { method, headers, timeout, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let visitor = null;
let visitorAt = 0;
async function visitorId(force) {
  if (visitor && !force && Date.now() - visitorAt < VISITOR_MAX_AGE) return visitor;
  const r = await request('https://www.youtube.com/', { headers: { 'User-Agent': VOS_UA, 'Accept-Language': 'en-US' } });
  visitor = (r.body.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] || null;
  visitorAt = Date.now();
  return visitor;
}

function playerBody(id, v) {
  return JSON.stringify({
    context: { client: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', userAgent: VOS_UA, osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0, visitorData: v || undefined } },
    videoId: id, contentCheckOk: true, racyCheckOk: true,
  });
}

// audio-only formats with a plain link, best first
function pickFormats(player) {
  const formats = ((player && player.streamingData && player.streamingData.adaptiveFormats) || [])
    .filter((f) => f && f.url && /^audio\//.test(f.mimeType || ''));
  const rank = (f) => { const i = PREFERRED_ITAGS.indexOf(f.itag); return i === -1 ? PREFERRED_ITAGS.length : i; };
  return formats.sort((a, b) => rank(a) - rank(b));
}

const videoId = (u) => { const m = String(u || '').match(/(?:v=|youtu\.be\/|\/shorts\/|^)([\w-]{11})(?:[&?#]|$)/); return m ? m[1] : null; };

async function lookup(id) {
  if (!/^[\w-]{11}$/.test(String(id || ''))) return null;
  for (const force of [false, true]) {
    const v = await visitorId(force);
    const headers = { 'User-Agent': VOS_UA, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '101', 'X-Youtube-Client-Version': '1.02', Origin: 'https://www.youtube.com' };
    if (v) headers['X-Goog-Visitor-Id'] = v;
    const r = await request('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers, body: playerBody(id, v) });
    let player = null;
    try { player = JSON.parse(r.body); } catch (_) { return null; }
    const status = player && player.playabilityStatus && player.playabilityStatus.status;
    if (status === 'LOGIN_REQUIRED' && !force) continue;
    if (status !== 'OK') return null;
    // YouTube lists links it then refuses (403) for some songs: check the first one answers before using it
    for (const f of pickFormats(player).slice(0, 2)) {
      try {
        const probe = await request(f.url, { headers: { 'User-Agent': VOS_UA, Range: 'bytes=0-1023' }, timeout: 3000, maxBytes: 4096 });
        if (probe.status === 200 || probe.status === 206) return { url: f.url, headers: { 'User-Agent': VOS_UA }, itag: f.itag };
      } catch (_) {}
    }
    return null;
  }
  return null;
}

module.exports = { lookup, videoId, pickFormats, VOS_UA };
