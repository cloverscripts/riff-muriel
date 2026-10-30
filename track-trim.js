// "Trim best part" (Riff 43, in the Download dialog): keep only part of a song. The kept part is saved per song and
// playback skips the rest (on phones too: it is only seeking, no ffmpeg). On computers the same start and end also
// fill the download's trim fields. The waveform drawn behind the handles comes from the song's own audio when it
// is on the device, otherwise a stand-in shape. No DOM here: app.js draws it, test/track-trim.test.js runs this.
(function () {
  const MIN_KEEP = 1; // seconds a trim has to keep
  const round1 = (v) => Math.round(v * 10) / 10;

  // what to save for a start/end pick on a song of `duration` seconds: null when it keeps (almost) everything
  function normalizeTrim(start, end, duration) {
    const dur = Number(duration) > 0 ? Number(duration) : 0;
    let s = Math.max(0, Number(start) || 0);
    let e = Number(end) > 0 ? Number(end) : dur;
    if (dur) { s = Math.min(s, dur); e = Math.min(e, dur); }
    if (!(e > s + MIN_KEEP)) return null;
    if (s <= 0.15 && (!dur || e >= dur - 0.25)) return null;
    return { start: round1(s), end: round1(e) };
  }

  // a saved trim is usable when it keeps a real stretch of the song
  const isActive = (trim) => !!trim && Number.isFinite(trim.end) && trim.end > (trim.start || 0) + 1.5;

  // during playback at `time`: 'start' (seek to the trim start), 'end' (the kept part is over) or null
  function trimAction(trim, time) {
    if (!isActive(trim) || !Number.isFinite(time)) return null;
    if (trim.start > 0 && time < trim.start - 0.25) return 'start';
    if (time >= trim.end) return 'end';
    return null;
  }

  // Crossfade setting (#22): the song fades out over its last `fade` seconds while it keeps playing up to
  // `end` (its real end, or the trim end); the next song starts on 'ended'. Seconds the fade takes from `time`
  // at playback `rate`, or 0 when it isn't time yet (or the song is too short / already over).
  function endFadeSeconds(time, end, fade, rate) {
    if (!(fade > 0) || !(end > fade * 2) || !Number.isFinite(time) || time < end - fade || time >= end) return 0;
    return (end - time) / (rate > 0 ? rate : 1);
  }

  // Crossfade with overlap (#29): the second (in song time) at which the next song starts while this one plays
  // its last `fade` seconds on a second player, fading out up to `end`; null when the song is too short for it
  function crossfadePoint(end, fade) {
    return fade > 0 && Number.isFinite(end) && end > fade * 2 ? end - fade : null;
  }

  // what to do at playback `time`: 'prepare' (open the second player at the point, `lead` seconds ahead),
  // 'start' (hand over now), or null
  function crossfadeStep(time, end, fade, rate, lead = 4) {
    const point = crossfadePoint(end, fade);
    if (point === null || !Number.isFinite(time) || time >= end) return null;
    if (time >= point) return 'start';
    if (time >= point - lead * (rate > 0 ? rate : 1)) return 'prepare';
    return null;
  }

  // equal-power curves for progress p (0..1) through the fade: the two together keep the loudness steady
  const fadeOutGain = (p) => Math.cos(Math.min(1, Math.max(0, Number(p) || 0)) * Math.PI / 2);
  const fadeInGain = (p) => Math.sin(Math.min(1, Math.max(0, Number(p) || 0)) * Math.PI / 2);

  // "1:05.3"
  function formatPreciseTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const tenths = Math.floor(sec * 10 + 1e-6);
    const m = Math.floor(tenths / 600);
    const s = Math.floor((tenths % 600) / 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${tenths % 10}`;
  }

  // `bars` heights (0.12..1) from decoded samples: the loudest sample in each slice, scaled to the loudest slice
  function wavePeaks(samples, bars) {
    const out = new Array(bars).fill(0.3);
    const n = samples ? samples.length : 0;
    if (!n || !bars) return out;
    const block = Math.max(1, Math.floor(n / bars));
    const step = Math.max(1, Math.floor(block / 256)); // a few hundred reads per bar are plenty
    let max = 0.001;
    for (let b = 0; b < bars; b++) {
      let peak = 0;
      const from = b * block;
      const to = Math.min(n, from + block);
      for (let j = from; j < to; j += step) { const v = Math.abs(samples[j]); if (v > peak) peak = v; }
      out[b] = peak;
      if (peak > max) max = peak;
    }
    for (let b = 0; b < bars; b++) out[b] = Math.max(0.12, Math.min(1, out[b] / max));
    return out;
  }

  // a song-shaped stand-in until (or instead of) the real waveform: the same song always gets the same shape
  function placeholderPeaks(key, bars) {
    let seed = 0;
    const k = String(key || '');
    for (let i = 0; i < k.length; i++) seed = ((seed << 5) - seed + k.charCodeAt(i)) | 0;
    seed = Math.abs(seed) % 233280;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const out = new Array(bars);
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      const env = Math.sin(t * Math.PI) * 0.45 + 0.35 + 0.15 * Math.sin(t * Math.PI * 4.2) + 0.1 * Math.sin(t * Math.PI * 7.8);
      out[i] = Math.round(Math.max(0.12, Math.min(0.96, env * (rnd() * 0.45 + 0.15) * 1.25)) * 100) / 100;
    }
    return out;
  }

  const api = { normalizeTrim, isActive, trimAction, endFadeSeconds, crossfadePoint, crossfadeStep, fadeOutGain, fadeInGain,formatPreciseTime, wavePeaks, placeholderPeaks, MIN_KEEP };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MurielTrim = api;
})();
