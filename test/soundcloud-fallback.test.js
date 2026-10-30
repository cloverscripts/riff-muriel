'use strict';

// A song YouTube refuses falls back to SoundCloud. Its top result for big-label songs is often a 30-second
// preview, which used to play as the whole song and stop at 0:29.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-scfallback-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');
const fakeYtDlp = path.join(tmp, 'yt-dlp');
fs.writeFileSync(fakeYtDlp, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.MURIEL_YTDLP = fakeYtDlp;

// a cached 30-second preview from before (a sixth of a 199 s song) and a real song of the same length
const tracks = path.join(tmp, 'data', 'tracks');
fs.mkdirSync(tracks, { recursive: true });
fs.writeFileSync(path.join(tracks, 'preview00001.mp3'), Buffer.alloc(480000));
fs.writeFileSync(path.join(tracks, 'fullsong0001.mp3'), Buffer.alloc(3200000));
fs.writeFileSync(path.join(tmp, 'data', 'metadata.json'), JSON.stringify({
  preview00001: { title: "God's Plan", artist: 'Drake', duration: '199', platform: 'soundcloud', fileSize: 480000 },
  fullsong0001: { title: 'Other', artist: 'Someone', duration: '199', platform: 'soundcloud', fileSize: 3200000 },
}));

// fake yt-dlp: YouTube refuses everything; SoundCloud search finds a preview, a remix and the real song
const ytCalls = [];
childProcess.spawn = (bin, args) => {
  ytCalls.push(args);
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  setImmediate(() => {
    const search = args.find((a) => /^scsearch\d+:/.test(a));
    const target = args[args.length - 1];
    if (search) {
      p.stdout.emit('data', JSON.stringify({ entries: [
        { id: '1', title: "God's Plan", uploader: 'Drake', duration: 30, webpage_url: 'https://soundcloud.com/drake/gods-plan' },
        { id: '2', title: "God's Plan (Remix)", uploader: 'dj', duration: 201, webpage_url: 'https://soundcloud.com/dj/gods-plan-remix' },
        { id: '3', title: "Drake - God's Plan (10 hour loop)", uploader: 'x', duration: 600, webpage_url: 'https://soundcloud.com/x/loop' },
        // the label's own upload: streamed only encrypted (DRM), so it can never play (#13)
        { id: '5', title: "God's Plan", uploader: 'Drake', duration: 199, webpage_url: 'https://soundcloud.com/drake/gods-plan-drm' },
        { id: '4', title: "God's Plan - Drake", uploader: 'fan', duration: 199, webpage_url: 'https://soundcloud.com/fan/gods-plan-drake' },
      ] }));
      return p.emit('close', 0);
    }
    if (args.includes('-g') && /soundcloud\.com/.test(target) && !/broken/.test(target)) {
      p.stdout.emit('data', `https://cf-media.sndcdn.com/${target.split('/').pop()}.128.mp3\n`);
      return p.emit('close', 0);
    }
    if ((args.includes('-g') || args.includes('urls')) && /watch\?v=raeDawn0001/.test(target)) {
      p.stdout.emit('data', 'https://rr1.googlevideo.com/videoplayback?id=raeDawn0001\n');
      return p.emit('close', 0);
    }
    p.stderr.emit('data', 'ERROR: Video unavailable');
    p.emit('close', 1);
  });
  return p;
};
// no internet: YouTube page searches fail at once, except the result pages a test sets up
const ytPages = {};
const ytPage = (videoId, title, owner, length) => `<script>var ytInitialData = ${JSON.stringify({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ videoRenderer: { videoId, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: owner }] }, lengthText: { simpleText: length } } }] } }] } } } } })};</script>`;
https.get = (url, opts, cb) => {
  const r = new EventEmitter();
  r.destroy = () => {};
  const q = (String(url).match(/search_query=([^&]+)/) || [])[1];
  const page = q && ytPages[decodeURIComponent(q)];
  setImmediate(() => {
    if (!page) return r.emit('error', new Error('offline'));
    const res = new EventEmitter();
    (typeof opts === 'function' ? opts : cb)(res);
    res.emit('data', Buffer.from(page));
    res.emit('end');
  });
  return r;
};

const scResolved = [];
// SoundCloud's api, asked which search results can play: track 5 is DRM-only; everything else is offline
const scTracks = (ids) => ids.map((id) => ({ id: Number(id), policy: 'MONETIZE', media: { transcodings: id === '5'
  ? [{ format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4' } }, { format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4' } }]
  : [{ format: { protocol: 'hls', mime_type: 'audio/mp4' } }] } }));
globalThis.fetch = async (input) => {
  const url = String(input);
  const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
  if (url === 'https://soundcloud.com/') return ok('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>');
  if (url === 'https://a-v2.sndcdn.com/assets/app.js') return ok('x={client_id:"abcdefghijklmnopqrstuvwxyz123456"}');
  const ids = (url.match(/^https:\/\/api-v2\.soundcloud\.com\/tracks\?ids=([\d,]+)/) || [])[1];
  if (ids) return ok(JSON.stringify(scTracks(ids.split(',')).map((t) => ({ ...t, title: `Song ${t.id}`, user: { username: 'dj' }, duration: 200000, permalink_url: `https://soundcloud.com/dj/song-${t.id}` }))));
  // a share link from the SoundCloud app redirects to the set, with tracking parameters
  if (url === 'https://on.soundcloud.com/AbC123') return { ...ok(''), url: 'https://soundcloud.com/dj/sets/mix?ref=clipboard&si=F237&utm_source=clipboard' };
  const asked = (url.match(/^https:\/\/api-v2\.soundcloud\.com\/resolve\?url=([^&]+)/) || [])[1];
  if (asked) {
    scResolved.push(decodeURIComponent(asked));
    if (decodeURIComponent(asked) !== 'https://soundcloud.com/dj/sets/mix') return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    // only the first track comes with full data; the DRM-only one (5) is kept, it falls back to YouTube when played
    return ok(JSON.stringify({ kind: 'playlist', title: 'Mix', artwork_url: '', tracks: [{ id: 7, title: 'First', user: { username: 'dj' }, duration: 100000, permalink_url: 'https://soundcloud.com/dj/first' }, { id: 5 }, { id: 6 }] }));
  }
  throw new Error('offline');
};

const { startServer, stopServer, getServerToken } = require('../server');
let port;
before(async () => { port = await startServer(0); });
after(async () => { await stopServer(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-muriel-token': getServerToken() } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('previews cached as whole songs are dropped at start, real songs stay', () => {
  assert.equal(fs.existsSync(path.join(tracks, 'preview00001.mp3')), false);
  assert.equal(fs.existsSync(path.join(tracks, 'fullsong0001.mp3')), true);
  const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'metadata.json'), 'utf8'));
  assert.deepEqual(Object.keys(meta), ['fullsong0001']);
});

test('the SoundCloud fallback skips previews, remixes and other lengths', async () => {
  const r = await get(`/api/stream-info?url=${encodeURIComponent('https://www.youtube.com/watch?v=xpVfcZ0ZcFM')}&id=xpVfcZ0ZcFM&platform=youtube&title=${encodeURIComponent("God's Plan")}&artist=Drake&duration=199`);
  const data = JSON.parse(r.body);
  assert.equal(data.success, true);
  assert.equal(data.streamUrl, 'https://cf-media.sndcdn.com/gods-plan-drake.128.mp3');
  // never the preview
  assert.ok(!ytCalls.some((a) => a.includes('https://soundcloud.com/drake/gods-plan')));
  // nor the DRM-only upload, though it matches best
  assert.ok(!ytCalls.some((a) => a.includes('https://soundcloud.com/drake/gods-plan-drm')));
});

test('no full-length upload: the song fails instead of playing 30 seconds', async () => {
  const r = await get(`/api/stream-info?url=${encodeURIComponent('https://www.youtube.com/watch?v=aaaaaaaaaaa')}&id=aaaaaaaaaaa&platform=youtube&title=${encodeURIComponent("God's Plan")}&artist=Drake&duration=420`);
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.body).success, false);
});

test('a SoundCloud song that won\'t play falls back to the same song on YouTube', async () => {
  ytPages['Viktor Vaughn Rae Dawn'] = ytPage('raeDawn0001', 'Viktor Vaughn - Rae Dawn', 'Viktor Vaughn - Topic', '3:20');
  const r = await get(`/api/stream-info?url=${encodeURIComponent('https://soundcloud.com/someone/broken-rae-dawn')}&id=987654&platform=soundcloud&title=${encodeURIComponent('Rae Dawn')}&artist=${encodeURIComponent('Viktor Vaughn')}&duration=200`);
  const data = JSON.parse(r.body);
  assert.equal(data.success, true);
  assert.equal(data.streamUrl, 'https://rr1.googlevideo.com/videoplayback?id=raeDawn0001');
});

// #13: links shared from the SoundCloud app (on.soundcloud.com) and the mobile site answered "SoundCloud 404",
// and yt-dlp gave up on a whole set when one of its songs is DRM-only
test('SoundCloud share links and mobile-site links import, in the order of the set', async () => {
  for (const link of ['https://on.soundcloud.com/AbC123', 'https://m.soundcloud.com/dj/sets/mix?si=abc&utm_medium=text']) {
    const r = await get(`/api/playlist-import?url=${encodeURIComponent(link)}`);
    const data = JSON.parse(r.body);
    assert.equal(data.success, true, link);
    assert.equal(data.name, 'Mix');
    assert.deepEqual(data.tracks.map((t) => t.id), ['7', '5', '6']);
    assert.equal(data.tracks[2].title, 'Song 6');
  }
  assert.deepEqual([...new Set(scResolved)], ['https://soundcloud.com/dj/sets/mix']);
});
