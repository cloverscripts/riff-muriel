// What the system's "now playing" controls are told (lock screen, Control Center, the iPhone widget), and when
// to start again after another app's sound interrupted Muriel (issue #26). No DOM here: app.js and
// mobile/audio-interruption.js use it, test/now-playing.test.js runs it.
(function () {
  // navigator.mediaSession.setPositionState() for an <audio> element: null when the song has no length yet
  // (setPositionState throws on a NaN / 0 duration, or a position past the end). The rate is the element's own,
  // so a sped-up or slowed song's progress bar keeps pace with what is heard.
  function positionState(audio, fallbackDuration) {
    const fb = Number(fallbackDuration);
    const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (Number.isFinite(fb) && fb > 0 ? fb : 0);
    if (!(duration > 0)) return null;
    let position = audio && Number.isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : 0;
    if (position > duration) position = duration;
    const playbackRate = audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1;
    return { duration, position, playbackRate };
  }

  // how long after the last sound a pause still counts as the interruption's (iOS pauses the element itself,
  // usually just before telling the app)
  const INTERRUPT_GRACE_MS = 3000;

  // was Muriel playing when another app took the sound? Not when the listener had paused it themselves.
  function wasPlayingAtInterruption({ paused, ended, pausedByUser, lastPlayingAt, now }) {
    if (pausedByUser || ended) return false;
    if (!paused) return true;
    return Number(lastPlayingAt) > 0 && Number(now) - Number(lastPlayingAt) <= INTERRUPT_GRACE_MS;
  }

  // the interruption is over: start again (as Spotify does) when iOS says so, it was playing before, and
  // nobody pressed pause meanwhile
  function resumeAfterInterruption({ wasPlaying, shouldResume, pausedByUser, paused, ended, hasTrack }) {
    return !!(wasPlaying && shouldResume && !pausedByUser && paused && !ended && hasTrack);
  }

  const api = { positionState, wasPlayingAtInterruption, resumeAfterInterruption, INTERRUPT_GRACE_MS };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MurielNowPlaying = api;
})();
