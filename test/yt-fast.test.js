const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ytFast = require('../yt-fast');

test('fast lookup picks plain-link audio formats, Opus first', () => {
  const player = { streamingData: { adaptiveFormats: [
    { itag: 137, mimeType: 'video/mp4', url: 'v' },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: 'a140' },
    { itag: 251, mimeType: 'audio/webm; codecs="opus"', url: 'a251' },
    { itag: 250, mimeType: 'audio/webm; codecs="opus"', signatureCipher: 's=...' },
  ] } };
  assert.deepEqual(ytFast.pickFormats(player).map((f) => f.itag), [251, 140]);
  assert.deepEqual(ytFast.pickFormats(null), []);
});

test('video ids come from links and bare ids only', () => {
  assert.equal(ytFast.videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
  assert.equal(ytFast.videoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(ytFast.videoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(ytFast.videoId('soundcloud:123'), null);
});

test('song start and next-song lookups try the fast way before yt-dlp', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/await fastYouTubeStream\(/g) || []).length, 2);
  assert.ok(server.indexOf('await fastYouTubeStream(trackUrl, cleanId);') < server.indexOf("reason: 'stream' }"));
});
