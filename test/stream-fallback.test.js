'use strict';

// When YouTube refuses the upload a song points at ("This video is not available"), the stream lookup plays
// another upload of the same song instead of failing. yt-dlp is a fake script and YouTube search a canned page.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { PassThrough } = require('node:stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-fallback-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');

// fake yt-dlp: the original upload is blocked, the other upload of the same song works, SoundCloud has nothing
const calls = path.join(tmp, 'yt-dlp-calls.txt');
const fake = path.join(tmp, 'yt-dlp');
fs.writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${calls}"
for last; do :; done
case "$last" in
  *BLOCKEDblk1*) echo "ERROR: [youtube] BLOCKEDblk1: This video is not available" >&2; exit 1 ;;
  *OTHERupld01*) echo "https://rr1.googlevideo.com/videoplayback?id=OTHERupld01"; exit 0 ;;
  *) echo "ERROR: no results" >&2; exit 1 ;;
esac
`);
fs.chmodSync(fake, 0o755);
process.env.MURIEL_YTDLP = fake;
process.env.MURIEL_FFMPEG = fake;

// YouTube search for "Daft Punk Get Lucky": the blocked upload itself, a 10-minute extended mix, the other upload
const video = (id, title, length) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: 'Daft Punk' }] }, lengthText: { simpleText: length } } });
const searchPage = `<html><script>var ytInitialData = ${JSON.stringify({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
  video('BLOCKEDblk1', 'Get Lucky (Official Audio)', '4:08'),
  video('EXTENDmix01', 'Get Lucky (Extended Mix)', '10:12'),
  video('OTHERupld01', 'Daft Punk - Get Lucky', '4:09'),
] } }] } } } } })};</script></html>`;
https.get = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; }
  const res = new PassThrough();
  res.statusCode = String(target).includes('youtube.com/results') ? 200 : 404;
  res.headers = {};
  const req = new PassThrough();
  req.setTimeout = () => req;
  process.nextTick(() => { cb(res); res.end(res.statusCode === 200 ? searchPage : ''); });
  return req;
};
// the fast YouTube lookup (yt-fast.js) posts to YouTube's player API: offline, so songs go through yt-dlp
https.request = () => {
  const req = new PassThrough();
  req.end = () => { process.nextTick(() => req.emit('error', new Error('offline'))); return req; };
  return req;
};

const { startServer, stopServer, getServerToken } = require('../server');
let port;
before(async () => { port = await startServer(0); });
after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(route) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { 'x-muriel-token': getServerToken() } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', (error) => resolve({ error }));
  });
}

test('a blocked upload is replaced by another upload of the same song', { skip: process.platform === 'win32' }, async () => {
  const q = new URLSearchParams({ id: 'BLOCKEDblk1', url: 'https://www.youtube.com/watch?v=BLOCKEDblk1', platform: 'youtube', title: 'Get Lucky', artist: 'Daft Punk', duration: '248' });
  const r = await get(`/api/stream-info?${q}`);
  assert.equal(r.status, 200, r.body);
  assert.ok(r.body.includes('OTHERupld01'), r.body);
  const asked = fs.readFileSync(calls, 'utf-8');
  // never the 10-minute version: it isn't the same recording
  assert.ok(!asked.includes('EXTENDmix01'), asked);
});
