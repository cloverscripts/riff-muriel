'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LIBRARY_SORT_MODES, librarySortMode, sortLibrary } = require('../track-sort');

const albums = [
  { id: '1', title: 'Zebra', artist: 'Beach House', year: '2010' },
  { id: '2', title: 'abbey Road', artist: 'The Beatles', year: '1969' },
  { id: '3', title: 'Currents', artist: 'Tame Impala', year: '2015' },
  { id: '4', title: 'Blonde', artist: 'beach house', year: '' },
];
const ids = (l) => l.map((x) => x.id);

test('custom keeps the stored order and does not change the input', () => {
  const copy = albums.slice();
  assert.deepStrictEqual(ids(sortLibrary('albums', albums, 'custom')), ['1', '2', '3', '4']);
  sortLibrary('albums', albums, 'title-asc');
  assert.deepStrictEqual(albums, copy);
});

test('unknown modes and kinds fall back to custom', () => {
  assert.strictEqual(librarySortMode('albums', 'bogus'), 'custom');
  assert.strictEqual(librarySortMode('nope', 'title-asc'), 'custom');
  assert.strictEqual(librarySortMode('artists', null), 'custom');
  assert.deepStrictEqual(ids(sortLibrary('albums', albums, 'plays-desc')), ['1', '2', '3', '4']);
  assert.deepStrictEqual(sortLibrary('albums', null, 'title-asc'), []);
});

test('albums by title and by artist, case-insensitive', () => {
  assert.deepStrictEqual(ids(sortLibrary('albums', albums, 'title-asc')), ['2', '4', '3', '1']);
  // same artist: by title
  assert.deepStrictEqual(ids(sortLibrary('albums', albums, 'artist-asc')), ['4', '1', '3', '2']);
});

test('albums by year, newest first, unknown years last', () => {
  assert.deepStrictEqual(ids(sortLibrary('albums', albums, 'year-desc')), ['3', '1', '2', '4']);
});

test('playlists by name and by size', () => {
  const pls = [
    { id: 'a', name: 'road trip', tracks: [1, 2] },
    { id: 'b', name: 'Chill', tracks: [1, 2, 3] },
    { id: 'c', name: 'Workout', tracks: [] },
  ];
  assert.deepStrictEqual(ids(sortLibrary('playlists', pls, 'name-asc')), ['b', 'a', 'c']);
  assert.deepStrictEqual(ids(sortLibrary('playlists', pls, 'name-desc')), ['c', 'a', 'b']);
  assert.deepStrictEqual(ids(sortLibrary('playlists', pls, 'size-desc')), ['b', 'a', 'c']);
});

test('artists by name and by play count (ties by name)', () => {
  const artists = [{ id: 'x', name: 'Muse' }, { id: 'y', name: 'ABBA' }, { id: 'z', name: 'Coldplay' }];
  const plays = { Muse: 3, ABBA: 0, Coldplay: 3 };
  assert.deepStrictEqual(ids(sortLibrary('artists', artists, 'name-asc')), ['y', 'z', 'x']);
  assert.deepStrictEqual(ids(sortLibrary('artists', artists, 'plays-desc', { plays: (a) => plays[a.name] })), ['z', 'x', 'y']);
});

test('every view has a custom order first', () => {
  for (const modes of Object.values(LIBRARY_SORT_MODES)) assert.strictEqual(modes[0], 'custom');
});
