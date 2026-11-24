'use strict';

// mobile/state-mirror.js: the phone keeps a copy of localStorage (playlists & co.) on disk and puts it back
// when localStorage came back older after the phone died.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function load() {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === './shims/store') return { isNative: () => false };
    return origLoad.call(this, request, ...rest);
  };
  const file = path.join(__dirname, '../mobile/state-mirror.js');
  delete require.cache[file];
  try { return require(file)._test; } finally { Module._load = origLoad; }
}

const rawOf = (obj) => {
  const m = new Map(Object.entries(obj));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), keys: () => [...m.keys()], m };
};

test('the copy leaves out logins, the debug log and its own bookkeeping', () => {
  const { snapshot } = load();
  const raw = rawOf({ devsize_playlists: '[1]', 'muriel_p:abcd:devsize_playlists': '[2]', muriel_secret_lastfm: 'x', muriel_debug_log: '[]', muriel_state_seq: '4' });
  assert.deepStrictEqual(snapshot(raw), { devsize_playlists: '[1]', 'muriel_p:abcd:devsize_playlists': '[2]' });
});

test('a copy newer than localStorage is put back; an older or equal one is not', () => {
  const { pickRestore } = load();
  const copies = [{ seq: 9, keys: {} }, { seq: 8, keys: {} }];
  assert.strictEqual(pickRestore(copies, null).seq, 9); // localStorage wiped
  assert.strictEqual(pickRestore(copies, '7').seq, 9); // lost the last saves
  assert.strictEqual(pickRestore(copies, '9'), null);
  assert.strictEqual(pickRestore([], null), null); // first launch with this version
});

test('restoring brings back every key, drops ones made since, keeps logins', () => {
  const { restore } = load();
  const raw = rawOf({ devsize_playlists: '[]', devsize_new: 'x', muriel_secret_lastfm: 'keep' });
  restore(raw, { seq: 5, keys: { devsize_playlists: '[{"name":"Gym"}]', devsize_favorites: '[1]' } });
  assert.deepStrictEqual(Object.fromEntries(raw.m), {
    devsize_playlists: '[{"name":"Gym"}]', devsize_favorites: '[1]', muriel_secret_lastfm: 'keep', muriel_state_seq: '5',
  });
});
