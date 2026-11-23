const test = require('node:test');
const assert = require('node:assert');
const { parseForLyrics, pickBest } = require('../lyrics-match');

test('YouTube titles become song + artist the way lyrics sites list them', () => {
  const cases = [
    [["PinkPantheress, Ice Spice - Boy’s a liar Pt. 2 (Official Video)", 'Pinkpantheress'], "Boy's a liar Pt. 2", 'PinkPantheress'],
    [['PinkPantheress - Girl Like Me (Official Video)', 'Pinkpantheress'], 'Girl Like Me', 'PinkPantheress'],
    [['Get Lucky (feat. Pharrell Williams)', 'Daft Punk - Topic'], 'Get Lucky', 'Daft Punk'],
    [['Hotline Bling', 'DrakeVEVO'], 'Hotline Bling', 'Drake'],
    [['Hey Jude - Remastered 2015', 'The Beatles'], 'Hey Jude', 'The Beatles'],
    [['Song [Lyrics] | 2024', 'Someone'], 'Song', 'Someone'],
  ];
  for (const [[title, artist], wantTitle, wantArtist] of cases) {
    const p = parseForLyrics(title, artist);
    assert.strictEqual(p.titles[0], wantTitle, title);
    assert.ok(p.artists.includes(wantArtist), `${title}: ${p.artists.join(' / ')}`);
  }
});

test('multiple artists also try the lead artist alone', () => {
  const p = parseForLyrics("Boy's a liar Pt. 2", 'PinkPantheress, Ice Spice');
  assert.deepStrictEqual(p.artists.slice(0, 2), ['PinkPantheress, Ice Spice', 'PinkPantheress']);
});

test('channel names without spaces get a spaced variant', () => {
  assert.ok(parseForLyrics('Blinding Lights', 'TheWeekndVEVO').artists.includes('The Weeknd'));
});

test('keeps meaningful brackets and non-Latin titles', () => {
  assert.strictEqual(parseForLyrics('Song (Remix)', 'A').titles[0], 'Song (Remix)');
  assert.strictEqual(parseForLyrics('Song (Remix)', 'A').titles[1], 'Song');
  assert.strictEqual(parseForLyrics('夜に駆ける', 'YOASOBI').titles[0], '夜に駆ける');
  assert.strictEqual(parseForLyrics('أهواك', 'عبد الحليم حافظ').titles[0], 'أهواك');
});

test('pickBest takes the matching song, not just the first result', () => {
  const want = parseForLyrics("Boy's a liar Pt. 2", 'PinkPantheress');
  const list = [
    { trackName: 'Liar', artistName: 'Someone Else', duration: 180, syncedLyrics: '[00:01.00] wrong' },
    { trackName: "Boy's a liar Pt. 2", artistName: 'PinkPantheress & Ice Spice', duration: 131, syncedLyrics: '[00:00.06] right' },
  ];
  assert.strictEqual(pickBest(list, want, 131).syncedLyrics, '[00:00.06] right');
});

test('pickBest refuses a title match from the wrong artist unless the length matches', () => {
  const want = parseForLyrics('Hello', 'Wrong Artist Channel');
  const list = [{ trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: '[00:01.00] Hello' }];
  assert.strictEqual(pickBest(list, want, 0), null);
  assert.ok(pickBest(list, want, 296));
  assert.strictEqual(pickBest(null, want, 0), null);
  assert.strictEqual(pickBest([{ trackName: 'Hello', artistName: 'Adele', instrumental: true }], parseForLyrics('Hello', 'Adele'), 0), null);
});

test('a same-name song by another artist is not taken for this one (#47)', () => {
  const { pickBest, parseForLyrics } = require('../lyrics-match');
  const want = parseForLyrics('Stay', 'Rihanna');
  const other = { trackName: 'Stay', artistName: 'Zedd', duration: 212, syncedLyrics: '[00:01.00] x' };
  assert.equal(pickBest([other], want, 210), null);
  const mine = { trackName: 'Stay', artistName: 'Rihanna', duration: 240, syncedLyrics: '[00:01.00] y' };
  assert.equal(pickBest([other, mine], want, 240), mine);
});
