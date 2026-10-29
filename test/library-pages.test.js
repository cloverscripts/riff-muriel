'use strict';

// Saved albums, followed artists (several can share a name), Daily Mixes and their thumbs up / down, the [E] badge.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../library-pages');

const SMALL = 'UCsmallsmallsmallsmall01';
const SMALL_CHANNEL = 'UCsmallofficialchannel01';
const FAMOUS = 'UCfamousfamousfamous0001';

test('saving an album puts it first, saving it again removes it', () => {
  const nevermind = { id: '111', title: 'Nevermind', artist: 'Nirvana', cover: 'c.jpg', year: '1991', trackCount: 12, _tracks: [] };
  let r = L.toggleSavedAlbum([], nevermind, 5);
  assert.equal(r.saved, true);
  assert.deepEqual(r.list, [{ id: '111', title: 'Nevermind', artist: 'Nirvana', cover: 'c.jpg', type: 'Album', year: '1991', trackCount: 12, savedAt: 5 }]);
  r = L.toggleSavedAlbum(r.list, { id: '222', title: 'In Utero', artist: 'Nirvana' }, 6);
  assert.deepEqual(r.list.map((a) => a.title), ['In Utero', 'Nevermind']);
  r = L.toggleSavedAlbum(r.list, nevermind);
  assert.equal(r.saved, false);
  assert.deepEqual(r.list.map((a) => a.title), ['In Utero']);
});

test('an album is the same album by id, or by title and artist (another country, another id)', () => {
  const saved = [{ id: '111', title: 'Nevermind', artist: 'Nirvana' }];
  assert.equal(L.isAlbumSaved(saved, { id: '111' }), true);
  assert.equal(L.isAlbumSaved(saved, { id: '999', title: 'NEVERMIND', artist: 'nirvana' }), true);
  assert.equal(L.isAlbumSaved(saved, { id: '999', title: 'Nevermind', artist: 'Someone Else' }), false);
  assert.equal(L.isAlbumSaved(saved, { id: '333', title: '' }), false);
  assert.equal(L.isAlbumSaved(null, { id: '111' }), false);
});

test('following tells same-named artists apart by their channel', () => {
  let r = L.toggleFollowArtist([], { name: 'NobodyKnows', id: SMALL, ids: [SMALL, SMALL_CHANNEL], avatar: 'a.jpg', fans: 1200 }, 7);
  assert.equal(r.followed, true);
  assert.deepEqual(r.list, [{ name: 'NobodyKnows', avatar: 'a.jpg', fans: 1200, followedAt: 7, id: SMALL }]);
  const followed = r.list;
  // the same artist, reached through its other channel
  assert.equal(L.isArtistFollowed(followed, { name: 'NobodyKnows', id: SMALL_CHANNEL, ids: [SMALL_CHANNEL, SMALL] }), true);
  // the famous namesake is not followed
  assert.equal(L.isArtistFollowed(followed, { name: 'NobodyKnows', id: FAMOUS, ids: [FAMOUS] }), false);
  // a page opened by name only can't tell: it goes by the name
  assert.equal(L.isArtistFollowed(followed, { name: 'NOBODYKNOWS - Topic' }), true);
  // following the famous one too keeps both
  r = L.toggleFollowArtist(followed, { name: 'NobodyKnows', id: FAMOUS, ids: [FAMOUS] }, 8);
  assert.equal(r.list.length, 2);
  // unfollowing one leaves the other
  r = L.toggleFollowArtist(r.list, { name: 'NobodyKnows', id: SMALL_CHANNEL, ids: [SMALL_CHANNEL, SMALL] });
  assert.equal(r.followed, false);
  assert.deepEqual(r.list.map((e) => e.id), [FAMOUS]);
  // no name, nothing to follow
  assert.deepEqual(L.toggleFollowArtist([], { name: '  ' }), { list: [], followed: false });
});

test('an artist followed by name learns its channel and picture from its page', () => {
  const followed = [{ name: 'Nirvana', avatar: '', fans: 0, followedAt: 1 }, { name: 'Other', avatar: 'o.jpg', fans: 3, followedAt: 2 }];
  const r = L.refreshFollowed(followed, { name: 'Nirvana', id: 'UCnirvananirvananirvana1', avatar: 'n.jpg', fans: 900 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.list[0], { name: 'Nirvana', avatar: 'n.jpg', fans: 900, followedAt: 1, id: 'UCnirvananirvananirvana1' });
  assert.equal(r.list[1], followed[1]);
  // nothing new: nothing changes
  const again = L.refreshFollowed(r.list, { name: 'Nirvana', id: 'UCnirvananirvananirvana1', avatar: 'n.jpg', fans: 900 });
  assert.equal(again.changed, false);
  assert.equal(again.list[0], r.list[0]);
});

test('Daily Mixes spread the artists you play most over the mixes', () => {
  const seeds = [];
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((artist, i) => {
    seeds.push({ artist, title: `${artist}1`, weight: 10 - i }, { artist, title: `${artist}2`, weight: 9 - i }, { artist, title: `${artist}3`, weight: 1 });
  });
  const mixes = L.planMixes(seeds, { day: '2026-10-25' });
  assert.deepEqual(mixes.map((m) => [m.id, m.title, m.artists]), [
    ['daily-mix-2026-10-25-1', 'Daily Mix 1', ['A', 'D']],
    ['daily-mix-2026-10-25-2', 'Daily Mix 2', ['B', 'E']],
    ['daily-mix-2026-10-25-3', 'Daily Mix 3', ['C', 'F']],
  ]);
  // each artist brings its two songs you play most
  assert.deepEqual(mixes[0].seeds.map((s) => s.title), ['A1', 'A2', 'D1', 'D2']);
  // too few artists for mixes
  assert.deepEqual(L.planMixes(seeds.filter((s) => 'ABC'.includes(s.artist))), []);
  assert.deepEqual(L.planMixes(null), []);
  assert.match(L.localDay(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('a thumbs down avoids what the mix brought in, never the artists it was built from', () => {
  const mix = { id: 'daily-mix-2026-10-25-1', artists: ['A', 'D'], tracks: [{ id: 'v1', title: 'New Song', artist: 'Stranger' }, { id: 'v2', title: 'A Classic', artist: 'A' }] };
  let fb = L.rateMix(null, mix, false);
  assert.deepEqual(fb.dislikedArtists, ['Stranger']);
  assert.deepEqual(fb.dislikedTracks.map((t) => t.id), ['v1', 'v2']);
  assert.equal(L.isMixRated(fb, mix.id), true);
  assert.equal(L.isMixRated(fb, 'daily-mix-2026-10-26-1'), false);
  assert.deepEqual(L.feedbackAvoid(fb).artists, ['Stranger']);
  assert.ok(L.feedbackAvoid(fb).keys.includes('v1'));
  // changing your mind: a thumbs up moves them to the liked side, the mix's own artists too
  fb = L.rateMix(fb, mix, true);
  assert.deepEqual(fb.dislikedArtists, []);
  assert.deepEqual(fb.dislikedTracks, []);
  assert.deepEqual(fb.likedArtists, ['A', 'D', 'Stranger']);
  assert.deepEqual(fb.likedTracks.map((t) => t.id), ['v1', 'v2']);
  assert.equal(fb.ratingsByMix[mix.id], 'like');
  // rating twice adds nothing twice
  assert.equal(L.rateMix(fb, mix, true).likedTracks.length, 2);
  // a broken stored value reads as empty
  assert.deepEqual(L.cleanFeedback('nonsense'), { likedArtists: [], dislikedArtists: [], likedTracks: [], dislikedTracks: [], ratingsByMix: {} });
});

test('the explicit badge: flagged by the service, or marked in the title', () => {
  assert.equal(L.isTrackExplicit({ title: 'Song', isExplicit: true }), true);
  assert.equal(L.isTrackExplicit({ title: 'Song', explicit_lyrics: true }), true);
  assert.equal(L.isTrackExplicit({ title: 'Song (Explicit)' }), true);
  assert.equal(L.isTrackExplicit({ title: 'Song [E]' }), true);
  assert.equal(L.isTrackExplicit({ title: 'Song', album: 'Album [18+]' }), true);
  assert.equal(L.isTrackExplicit({ title: 'Песня (без цензуры)' }), true);
  // a song called "Dirty" or with an E in it is not
  assert.equal(L.isTrackExplicit({ title: 'Dirty Diana' }), false);
  assert.equal(L.isTrackExplicit({ title: 'Eleanor Rigby (Remastered)' }), false);
  assert.equal(L.isTrackExplicit(null), false);
});

test('blocked artists and songs: names, featured artists, the same song from another upload', () => {
  const blocks = { artists: ['Queen'], songs: [{ id: 'abc', title: 'Song!', artist: 'A' }] };
  assert.equal(L.isTrackBlocked(blocks, { title: 'Under Pressure', artist: 'Queen & David Bowie' }), true);
  assert.equal(L.isTrackBlocked(blocks, { title: 'x', artist: 'Queen - Topic' }), true);
  assert.equal(L.isTrackBlocked(blocks, { title: 'x', artist: 'Queensrÿche' }), false, 'a name, not a prefix');
  assert.equal(L.isTrackBlocked(blocks, { id: 'abc', title: 'other' }), true, 'by id');
  assert.equal(L.isTrackBlocked(blocks, { id: 'zzz', title: 'song', artist: 'a' }), true, 'by title and artist');
  assert.equal(L.isTrackBlocked(blocks, { id: 'zzz', title: 'Song', artist: 'B' }), false, 'same title, another artist');
  assert.equal(L.isTrackBlocked({ artists: [], songs: [] }, { title: 'x', artist: 'Queen' }), false);
  assert.equal(L.isTrackBlocked(null, { title: 'x' }), false);

  let r = L.toggleBlockedArtist(['Queen'], 'queen');
  assert.deepEqual(r, { list: [], blocked: false }, 'blocking again unblocks, whatever the case');
  r = L.toggleBlockedArtist([], '  ');
  assert.equal(r.blocked, false, 'no name, nothing blocked');
  r = L.toggleBlockedSong([], { id: 7, title: 'T', artist: 'A', thumbnail: 'x' });
  assert.deepEqual(r, { list: [{ id: '7', title: 'T', artist: 'A' }], blocked: true }, 'only what is needed to match is kept');
  assert.equal(L.toggleBlockedSong(r.list, { id: 'other', title: 't', artist: 'a' }).blocked, false);
});
