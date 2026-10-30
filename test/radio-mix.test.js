'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mixRadio } = require('../recommend-core');

const t = (artist, title, match = 0.5, id = '') => ({ artist, title, match, ...(id ? { id } : {}) });

test('mixRadio takes one song from each seed in turn, best first', () => {
  const a = [t('A1', 'x', 0.2), t('A2', 'y', 0.9)];
  const b = [t('B1', 'p', 0.8), t('B2', 'q', 0.1)];
  const out = mixRadio([a, b], { limit: 10 });
  assert.deepStrictEqual(out.map((s) => s.artist), ['A2', 'B1', 'A1', 'B2']);
});

test('mixRadio keeps going with the other seeds when one runs out', () => {
  const out = mixRadio([[t('A', '1')], [t('B', '1'), t('C', '1'), t('D', '1')]], { limit: 10 });
  assert.strictEqual(out.length, 4);
});

test('mixRadio drops repeats across seeds, by key and by id', () => {
  const out = mixRadio([
    [t('Radiohead', 'No Surprises', 0.9, 'aaaaaaaaaaa'), t('X', 'one', 0.5, 'bbbbbbbbbbb')],
    [t('radiohead', 'No surprises!', 0.9), t('Other', 'renamed', 0.4, 'bbbbbbbbbbb')],
  ], { limit: 10 });
  // seed 2's copy of "No Surprises" is skipped, so its next song (id bbb) comes in and seed 1's bbb is a repeat
  assert.deepStrictEqual(out.map((s) => s.title), ['No Surprises', 'renamed']);
});

test('mixRadio leaves out excluded songs (the seeds, what the radio already queued)', () => {
  const out = mixRadio([[t('A', 'seed', 1, 'sssssssssss'), t('B', 'two', 0.5), t('C', 'three', 0.4)]], {
    limit: 10, exclude: { ids: ['sssssssssss'], keys: [] },
  });
  assert.deepStrictEqual(out.map((s) => s.title), ['two', 'three']);
  const keyed = mixRadio([[t('B', 'two'), t('C', 'three')]], { exclude: { keys: new Set(['b::two']) } });
  assert.deepStrictEqual(keyed.map((s) => s.title), ['three']);
});

test('mixRadio caps songs per artist and the total', () => {
  const many = Array.from({ length: 10 }, (_, i) => t('Same & Guest', `s${i}`, 1 - i / 20));
  assert.strictEqual(mixRadio([many], { perArtist: 3 }).length, 3);
  const spread = Array.from({ length: 40 }, (_, i) => t(`Artist ${i}`, 'song'));
  assert.strictEqual(mixRadio([spread], { limit: 25 }).length, 25);
  assert.deepStrictEqual(mixRadio([], {}), []);
  assert.deepStrictEqual(mixRadio([null, [null, { artist: 'x' }]], {}), []);
});
