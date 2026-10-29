'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rec = require('../recommend-core');

const sep = { text: ' • ' };
function row(videoId, title, artistRuns, length, extra = {}) {
  return {
    playlistPanelVideoRenderer: {
      videoId,
      title: { runs: [{ text: title }] },
      longBylineText: { runs: [...artistRuns, sep, { text: 'Some Album' }, sep, { text: '2019' }] },
      shortBylineText: { runs: [{ text: artistRuns.map((r) => r.text).join('') }] },
      lengthText: { runs: [{ text: length }] },
      thumbnail: { thumbnails: [{ url: 'small' }, { url: `https://i.ytimg.com/${videoId}/big.jpg` }] },
      ...extra,
    },
  };
}
function watchJson(items) {
  return { contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [
    { tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: { contents: items } } } } } },
  ] } } } } };
}
const channel = (text, id) => ({ text, navigationEndpoint: { browseEndpoint: { browseId: id } } });

test('YouTube Music radio: the songs after the seed, with artist, channel, length and cover', () => {
  const json = watchJson([
    row('SEEDseed123', 'Space Song', [channel('Beach House', 'UCaaaaaaaaaaaaaaaaaaaaaa')], '5:20'),
    row('abcdefghijk', 'Heart-Shaped Box', [channel('Alvvays', 'UCbbbbbbbbbbbbbbbbbbbbbb'), { text: ' & ' }, { text: 'Someone - Topic' }], '3:41'),
    { playlistPanelVideoWrapperRenderer: { primaryRenderer: row('bcdefghijkl', 'Myth', [{ text: 'Beach House - Topic' }], '4:18') } },
    row('abcdefghijk', 'Heart-Shaped Box', [{ text: 'Alvvays' }], '3:41'), // a repeat
    row('cdefghijklm', 'Intro', [{ text: 'X' }], '0:12'), // too short
    row('bad', 'No id', [{ text: 'X' }], '3:00'),
    { automixPreviewVideoRenderer: {} },
  ]);
  const out = rec.parseWatchPlaylist(json, 'SEEDseed123');
  assert.deepStrictEqual(out.map((t) => t.id), ['abcdefghijk', 'bcdefghijkl']);
  assert.strictEqual(out[0].artist, 'Alvvays & Someone');
  assert.strictEqual(out[0].artistId, 'UCbbbbbbbbbbbbbbbbbbbbbb');
  assert.strictEqual(out[0].duration, 221);
  assert.strictEqual(out[0].thumbnail, 'https://i.ytimg.com/abcdefghijk/big.jpg');
  assert.strictEqual(out[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.strictEqual(out[1].artist, 'Beach House');
  assert.strictEqual(out[1].artistId, undefined);
});

test('video titles: the song name without the artist and "(Official Video)", a re-upload credited to the artist it names', () => {
  assert.deepStrictEqual(rec.cleanVideoTitle('Radiohead - No Surprises (Official Video) [4K Remaster]', 'Radiohead'),
    { title: 'No Surprises', artist: 'Radiohead', renamed: false });
  assert.deepStrictEqual(rec.cleanVideoTitle('Cigarettes After Sex - Cry', 'Koala Kontrol'),
    { title: 'Cry', artist: 'Cigarettes After Sex', renamed: true });
  assert.deepStrictEqual(rec.cleanVideoTitle('Oasis - Wonderwall (Official Video)', 'OasisVEVO'),
    { title: 'Wonderwall', artist: 'Oasis', renamed: true });
  assert.strictEqual(rec.cleanVideoTitle('In The End [Official HD Music Video] - Linkin Park', 'Linkin Park').title, 'In The End');
  assert.deepStrictEqual(rec.cleanVideoTitle('Pixies - Pixies - Where Is My Mind? (Official Lyric Video)', 'Pixies'),
    { title: 'Where Is My Mind?', artist: 'Pixies', renamed: false });
  assert.strictEqual(rec.cleanVideoTitle('Song', 'Beach House - Topic').artist, 'Beach House');
  assert.deepStrictEqual(rec.cleanVideoTitle('Space Song', 'Beach House'), { title: 'Space Song', artist: 'Beach House', renamed: false });
  const out = rec.parseWatchPlaylist(watchJson([
    row('abcdefghijk', 'Cigarettes After Sex - Cry', [channel('Koala Kontrol', 'UCbbbbbbbbbbbbbbbbbbbbbb')], '4:10'),
    row('bcdefghijkl', 'Grace Documentary Pt. 2', [{ text: 'Jeff Buckley' }], '9:10'),
  ]), '');
  assert.deepStrictEqual(out.map((t) => [t.artist, t.title, t.artistId]), [['Cigarettes After Sex', 'Cry', undefined]]);
});

test('YouTube Music radio: anything unexpected is an empty list', () => {
  assert.deepStrictEqual(rec.parseWatchPlaylist(null), []);
  assert.deepStrictEqual(rec.parseWatchPlaylist({ contents: {} }), []);
  assert.deepStrictEqual(rec.parseWatchPlaylist(watchJson(null)), []);
});

test('Last.fm similar tracks, artists and top tracks', () => {
  const similar = rec.parseSimilarTracks({ similartracks: { track: [
    { name: 'No Surprises', match: 1.0, duration: 269, artist: { name: 'Radiohead' } },
    { name: 'Karma Police', match: '0.42', artist: { name: 'Radiohead' } },
    { name: '', artist: { name: 'Nobody' } },
  ] } });
  assert.deepStrictEqual(similar, [
    { title: 'No Surprises', artist: 'Radiohead', match: 1, duration: 269 },
    { title: 'Karma Police', artist: 'Radiohead', match: 0.42, duration: 0 },
  ]);
  // one result comes as an object, an error as { error }
  assert.strictEqual(rec.parseSimilarTracks({ similartracks: { track: { name: 'A', artist: { name: 'B' }, match: '2' } } })[0].match, 1);
  assert.deepStrictEqual(rec.parseSimilarTracks({ error: 6, message: 'Track not found' }), []);
  assert.deepStrictEqual(rec.parseSimilarArtists({ similarartists: { artist: [{ name: 'Alvvays', match: '1' }, { name: 'Wild Nothing', match: '0.8' }] } }),
    [{ name: 'Alvvays', match: 1 }, { name: 'Wild Nothing', match: 0.8 }]);
  assert.deepStrictEqual(rec.parseTopTracks({ toptracks: { track: [{ name: 'Archie, Marry Me', artist: { name: 'Alvvays' } }, { name: 'Dreams Tonite' }] } }, 'Alvvays'),
    [{ title: 'Archie, Marry Me', artist: 'Alvvays' }, { title: 'Dreams Tonite', artist: 'Alvvays' }]);
});

test('dropUnwanted keeps out blocked artists (and their collaborations), blocked songs, recent songs and repeats', () => {
  const tracks = [
    { id: '1', title: 'Bohemian Rhapsody', artist: 'Queen' },
    { id: '2', title: 'Under Pressure', artist: 'Queen & David Bowie' },
    { id: '3', title: 'Heroes', artist: 'David Bowie' },
    { id: '4', title: 'Starman', artist: 'David Bowie' },
    { id: '5', title: 'Space Oddity', artist: 'David Bowie' },
    { id: '6', title: 'Heroes', artist: 'David Bowie' }, // same song again
    { id: '3', title: 'Heroes (live)', artist: 'David Bowie' }, // same id again
    { id: '7', title: 'Changes', artist: 'David Bowie' },
    null,
  ];
  const out = rec.dropUnwanted(tracks, {
    blocks: { artists: ['Queen'], songs: [{ id: '', title: 'Starman', artist: 'David Bowie' }] },
    recentKeys: ['david bowie::space oddity'],
    recentIds: new Set(['7']),
    keyOf: (t) => `${t.artist.toLowerCase()}::${t.title.toLowerCase()}`,
  });
  assert.deepStrictEqual(out.map((t) => t.id), ['3']);
});

test('dropUnwanted without blocks or recent songs only removes repeats', () => {
  const tracks = [{ id: 'a', title: 'X', artist: 'Y' }, { id: 'b', title: 'x', artist: 'y' }, { id: 'c', title: 'Z', artist: 'Y' }];
  assert.deepStrictEqual(rec.dropUnwanted(tracks).map((t) => t.id), ['a', 'c']);
  assert.deepStrictEqual(rec.dropUnwanted(null), []);
});
