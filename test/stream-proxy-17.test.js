'use strict';

// #17: YouTube streams failed on the first click with "MEDIA_ELEMENT_ERROR: Format error" while the URL
// was fine for curl; the replay worked only because the song had been downloaded to the cache meanwhile.
// Desktop now plays googlevideo streams through the local proxy with yt-dlp's own request headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ss = require('../stream-source');

test('lookup prints the URL and the headers in one yt-dlp run', () => {
  assert.deepEqual(ss.LOOKUP_PRINT_ARGS, ['--print', 'urls', '--print', '%(http_headers)j']);
  const raw = 'https://rr3---sn-x.googlevideo.com/videoplayback?a=1\n{"User-Agent": "com.google.android.youtube/19", "Accept": "*/*"}\n';
  const out = ss.parseLookup(raw);
  assert.equal(out.url, 'https://rr3---sn-x.googlevideo.com/videoplayback?a=1');
  assert.equal(out.headers['User-Agent'], 'com.google.android.youtube/19');
  assert.deepEqual(ss.parseLookup('https://a/b\nNA\n'), { url: 'https://a/b', headers: null });
  assert.deepEqual(ss.parseLookup(''), { url: null, headers: null });
});

test('upstream request: yt-dlp headers win, Range passes through, no cookies', () => {
  const h = ss.upstreamHeaders(
    { range: 'bytes=0-', 'user-agent': 'Chrome', cookie: 'x=1', origin: 'null', accept: 'audio/*' },
    { 'User-Agent': 'android-ua', Accept: '*/*', 'Sec-Fetch-Mode': 'navigate', Cookie: 'no' }
  );
  assert.deepEqual(h, { range: 'bytes=0-', 'user-agent': 'android-ua', accept: '*/*', 'sec-fetch-mode': 'navigate' });
  assert.deepEqual(ss.upstreamHeaders({ 'user-agent': 'Chrome' }, null), { 'user-agent': 'Chrome' });
});

test('downstream response drops the upstream CORS headers and allows the page', () => {
  const h = ss.downstreamHeaders({ 'content-type': 'audio/webm', 'access-control-allow-origin': 'https://www.youtube.com', 'set-cookie': 'a', 'content-range': 'bytes 0-1/2' });
  assert.deepEqual(h, { 'content-type': 'audio/webm', 'content-range': 'bytes 0-1/2', 'access-control-allow-origin': '*' });
});

test('desktop proxies googlevideo, phones and other sources keep the direct URL', () => {
  const yt = { streamUrl: 'https://rr1---sn-a.googlevideo.com/videoplayback?x', proxyUrl: 'http://127.0.0.1:1/api/audio-proxy?url=x' };
  assert.equal(ss.pickStreamSrc(yt, false), yt.proxyUrl);
  assert.equal(ss.pickStreamSrc(yt, true), yt.streamUrl);
  assert.equal(ss.pickStreamSrc({ ...yt, isHls: true }, false), yt.streamUrl);
  const sc = { streamUrl: 'https://cf-media.sndcdn.com/a.mp3', proxyUrl: 'p' };
  assert.equal(ss.pickStreamSrc(sc, false), sc.streamUrl);
  assert.equal(ss.isGoogleVideoUrl('https://evilgooglevideo.com/x'), false);
});

test('app.js uses the same proxy rule and falls back to the proxy before a fresh lookup', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /el\.nativeAudio\.src = src;/);
  const handler = app.slice(app.indexOf("addEventListener('error', () => {", app.indexOf('function retryFresh(')));
  assert.ok(handler.indexOf('tryProxyFallback(') >= 0 && handler.indexOf('tryProxyFallback(') < handler.indexOf('retryFresh('));
});

test('server lookups record the headers and the proxy uses them', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/rememberStreamHeaders\(/g) || []).length, 4);
  assert.match(server, /streamHeaders\.get\(targetUrl\)/);
  assert.doesNotMatch(server, /'-g', '--no-warnings', '--no-playlist', '--prefer-free-formats', '-f', 'bestaudio\/best'\];\n\s+if \((ytTarget|target)\.youtube\)/);
});
