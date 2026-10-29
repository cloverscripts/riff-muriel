'use strict';

// Yandex Music playlist import (server.js) and the YouTube library reader behind the Google login
// (google-library.js), both against canned answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function get(port, route, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: token ? { 'X-Muriel-Token': token } : {} }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let data; try { data = JSON.parse(raw); } catch (_) { data = raw; } resolve({ status: res.statusCode, data }); });
    }).on('error', reject);
  });
}

test('Yandex Music: public playlists are read, anything else is refused before a request goes out', async () => {
  const oldFetch = globalThis.fetch;
  const asked = [];
  const trackIds = [];
  let server;
  try {
    globalThis.fetch = async (url, opts) => {
      asked.push(String(url));
      const u = new URL(url);
      if (u.pathname === '/users/someone/playlists/3') {
        return new Response(JSON.stringify({ result: { title: 'Yandex mix', ogImage: 'avatars.yandex.net/get-music-content/x/%%', tracks: [
          { track: { title: 'Кино', artists: [{ name: 'Виктор Цой' }], durationMs: 245000 } },
          { track: { title: '<b>Two</b>', artists: [{ name: 'A' }, { name: 'B' }], durationMs: 61000 } },
          { track: { title: '' } },
          null,
        ] } }), { status: 200 });
      }
      if (u.pathname === '/playlist/lk.0123abcd-0000-1111-2222-333344445555') return new Response(JSON.stringify({ result: { title: 'Shared', cover: { uri: 'https://evil.example/x.png' }, tracks: [{ title: 'S', artist: 'X', duration: 100 }] } }), { status: 200 });
      // a shared playlist Yandex only knows by its bare uuid, and lists as bare ids unless asked for whole tracks
      if (u.pathname === '/playlist/aaaa1111-0000-1111-2222-333344445555') {
        const rich = u.searchParams.get('richTracks') === 'true';
        return new Response(JSON.stringify({ result: { title: 'Bare', tracks: rich ? [{ track: { title: 'B', artists: [{ name: 'Y' }], durationMs: 90000 } }] : [{ id: 1, albumId: 2 }] } }), { status: 200 });
      }
      if (u.pathname === '/albums/77/with-tracks') return new Response(JSON.stringify({ result: { title: 'Album', coverUri: 'avatars.yandex.net/a/%%', volumes: [[{ title: 'One', version: 'Live', artists: [{ name: 'Z' }], durationMs: 100000 }], [{ title: 'Two', artists: [{ name: 'Z' }], durationMs: 50000 }]] } }), { status: 200 });
      if (u.pathname === '/users/ids/playlists/5') return new Response(JSON.stringify({ result: { title: 'Ids', tracks: [{ id: 11, albumId: 22 }, { id: 'x;y' }] } }), { status: 200 });
      if (u.pathname === '/tracks') {
        trackIds.push(String(opts && opts.body));
        return new Response(JSON.stringify({ result: [{ id: 11, title: 'Found', artists: [{ name: 'Q' }], durationMs: 70000 }] }), { status: 200 });
      }
      if (/^\/playlist\/(?:lk\.)?bbbb/.test(u.pathname)) return new Response('{}', { status: 451 });
      if (u.pathname === '/users/locked/playlists/1') return new Response('{}', { status: 403 });
      return new Response('{}', { status: 404 });
    };
    delete require.cache[require.resolve('../server')];
    server = require('../server');
    const port = await server.startServer(0);
    const token = server.getServerToken();
    const q = (u) => `/api/yandex-import?url=${encodeURIComponent(u)}`;

    assert.equal((await get(port, q('https://music.yandex.ru/users/someone/playlists/3'))).status, 403, 'needs the token');
    const ok = await get(port, q('https://music.yandex.ru/users/someone/playlists/3'), token);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.name, 'Yandex mix');
    assert.equal(ok.data.cover, 'https://avatars.yandex.net/get-music-content/x/400x400');
    assert.deepEqual(ok.data.tracks, [{ title: 'Кино', artist: 'Виктор Цой', duration: 245 }, { title: '<b>Two</b>', artist: 'A, B', duration: 61 }]);
    const shared = await get(port, q('https://music.yandex.com/playlists/lk.0123abcd-0000-1111-2222-333344445555'), token);
    assert.equal(shared.data.cover, '', 'pictures only from Yandex');
    assert.equal(shared.data.tracks[0].artist, 'X');

    const before = asked.length;
    for (const bad of ['https://music.yandex.ru/users/..%2F..%2Fadmin/playlists/3', 'https://evil.example/users/a/playlists/1', 'https://music.yandex.ru.evil.example/users/a/playlists/1', 'javascript:alert(1)', 'https://music.yandex.ru/artist/123', 'https://music.yandex.ru/album/12x']) {
      const r = await get(port, q(bad), token);
      assert.equal(r.status, 400, bad);
      assert.equal(r.data.success, false);
    }
    assert.equal(asked.length, before, 'nothing was fetched for a bad link');
    assert.equal((await get(port, q('https://music.yandex.ru/users/someone/playlists/9'), token)).status, 404);

    // the forms of a shared link are tried in turn: here the bare uuid, asked for whole tracks
    const bare = await get(port, q('https://music.yandex.ru/playlists/lk.aaaa1111-0000-1111-2222-333344445555'), token);
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.data.tracks, [{ title: 'B', artist: 'Y', duration: 90 }]);
    // albums (every disc), single songs, and playlist songs listed only by id
    const album = await get(port, q('https://music.yandex.ru/album/77'), token);
    assert.equal(album.status, 200);
    assert.equal(album.data.name, 'Album');
    assert.equal(album.data.cover, 'https://avatars.yandex.net/a/400x400');
    assert.deepEqual(album.data.tracks, [{ title: 'One (Live)', artist: 'Z', duration: 100 }, { title: 'Two', artist: 'Z', duration: 50 }]);
    const song = await get(port, q('https://music.yandex.ru/album/22/track/11'), token);
    assert.equal(song.status, 200);
    assert.deepEqual(song.data.tracks, [{ title: 'Found', artist: 'Q', duration: 70 }]);
    assert.equal(trackIds.pop(), 'track-ids=11%3A22');
    const ids = await get(port, q('https://music.yandex.ru/users/ids/playlists/5'), token);
    assert.equal(ids.status, 200);
    assert.deepEqual(ids.data.tracks, [{ title: 'Found', artist: 'Q', duration: 70 }]);
    assert.equal(trackIds.pop(), 'track-ids=11%3A22', 'only well-formed ids are asked for');
    // why it failed reaches the dialog as Yandex's reason, not a Spotify message
    const region = await get(port, q('https://music.yandex.ru/playlists/lk.bbbb1111-0000-1111-2222-333344445555'), token);
    assert.equal(region.status, 451);
    assert.equal(region.data.code, 'yandex_region');
    const locked = await get(port, q('https://music.yandex.ru/users/locked/playlists/1'), token);
    assert.equal(locked.status, 403);
    assert.equal(locked.data.code, 'yandex_private');
  } finally {
    if (server) await server.stopServer();
    delete require.cache[require.resolve('../server')];
    globalThis.fetch = oldFetch;
  }
});

test('YouTube library: songs and playlists are picked out of youtubei answers and checked', () => {
  const G = require('../google-library.js')._test;
  const runs = (t) => ({ runs: [{ text: t }] });
  const ytm = { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [
    { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'dQw4w9WgXcQ' }, flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: runs('Never Gonna') } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Rick Astley' }, { text: ' • ' }, { text: 'Album' }] } } }], fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: runs('3:33') } }], thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/a=w60' }, { url: 'https://lh3.googleusercontent.com/a=w120' }] } } } } },
    { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'bad id!' }, flexColumns: [] } },
    { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'dQw4w9WgXcQ' }, flexColumns: [] } },
  ], continuations: [{ nextContinuationData: { continuation: 'NEXT' } }] } }] } } } }] } } };
  const out = [];
  G.tracksIn(ytm, out, new Set());
  assert.equal(out.length, 1, 'bad and repeated ids are skipped');
  assert.deepEqual(G.toTrack(out[0]), { id: 'dQw4w9WgXcQ', title: 'Never Gonna', artist: 'Rick Astley', duration: 213, thumbnail: 'https://lh3.googleusercontent.com/a=w120', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platform: 'youtube' });
  assert.equal(G.continuationOf(ytm), 'NEXT');

  const web = { items: [{ playlistVideoRenderer: { videoId: 'abcdefghijk', title: runs('Web song'), shortBylineText: runs('Channel'), lengthSeconds: '75', thumbnail: { thumbnails: [{ url: 'javascript:alert(1)' }] } } }] };
  const out2 = [];
  G.tracksIn(web, out2, new Set());
  assert.deepEqual(G.toTrack(out2[0]).thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', 'only https pictures');
  assert.equal(out2[0].duration, 75);

  const lists = { grid: [
    { musicTwoRowItemRenderer: { title: runs('My list'), navigationEndpoint: { browseEndpoint: { browseId: 'VLPLabc123' } } } },
    { musicTwoRowItemRenderer: { title: runs('An album'), navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_xyz' } } } },
    { gridPlaylistRenderer: { playlistId: 'PLweb456', title: runs('Web list') } },
    { lockupViewModel: { contentId: 'PLnew789', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'New layout' } } } } },
    { lockupViewModel: { contentId: 'abcdefghijk', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } },
  ] };
  const pls = [];
  G.playlistsIn(lists, pls, new Set());
  assert.deepEqual(pls.map((p) => [p.id, p.name]), [['VLPLabc123', 'My list'], ['PLweb456', 'Web list'], ['PLnew789', 'New layout']]);
});
