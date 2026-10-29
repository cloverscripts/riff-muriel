const test = require('node:test');
const assert = require('node:assert');
const N = require('../now-playing');

test('positionState: uses the element rate and clamps the position', () => {
  assert.deepStrictEqual(N.positionState({ duration: 200, currentTime: 50, playbackRate: 1.25 }), { duration: 200, position: 50, playbackRate: 1.25 });
  assert.deepStrictEqual(N.positionState({ duration: 200, currentTime: 250, playbackRate: 0.8 }), { duration: 200, position: 200, playbackRate: 0.8 });
});

test('positionState: falls back to the track length, never NaN or rate 0', () => {
  assert.deepStrictEqual(N.positionState({ duration: NaN, currentTime: NaN, playbackRate: 0 }, 180), { duration: 180, position: 0, playbackRate: 1 });
  assert.strictEqual(N.positionState({ duration: Infinity, currentTime: 3, playbackRate: 1 }, 0), null);
  assert.strictEqual(N.positionState(null, undefined), null);
});

test('wasPlayingAtInterruption', () => {
  assert.strictEqual(N.wasPlayingAtInterruption({ paused: false, ended: false, pausedByUser: false, lastPlayingAt: 0, now: 10 }), true);
  // iOS paused the element just before the app heard about it
  assert.strictEqual(N.wasPlayingAtInterruption({ paused: true, ended: false, pausedByUser: false, lastPlayingAt: 9000, now: 10000 }), true);
  assert.strictEqual(N.wasPlayingAtInterruption({ paused: true, ended: false, pausedByUser: false, lastPlayingAt: 1000, now: 10000 }), false);
  assert.strictEqual(N.wasPlayingAtInterruption({ paused: true, ended: false, pausedByUser: true, lastPlayingAt: 9900, now: 10000 }), false);
  assert.strictEqual(N.wasPlayingAtInterruption({ paused: true, ended: true, pausedByUser: false, lastPlayingAt: 9900, now: 10000 }), false);
});

test('resumeAfterInterruption', () => {
  const base = { wasPlaying: true, shouldResume: true, pausedByUser: false, paused: true, ended: false, hasTrack: true };
  assert.strictEqual(N.resumeAfterInterruption(base), true);
  for (const k of ['wasPlaying', 'shouldResume', 'hasTrack']) assert.strictEqual(N.resumeAfterInterruption({ ...base, [k]: false }), false, k);
  for (const k of ['pausedByUser', 'ended']) assert.strictEqual(N.resumeAfterInterruption({ ...base, [k]: true }), false, k);
  assert.strictEqual(N.resumeAfterInterruption({ ...base, paused: false }), false);
});
