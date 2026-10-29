// Android "now playing" controls: the notification, lock screen, quick-settings media player and headset
// buttons. Android's WebView doesn't turn navigator.mediaSession into system controls the way iOS does,
// so the song and play state go to a native media session (android/.../MediaControlsPlugin.java) and its
// buttons come back here.
const { Capacitor, registerPlugin } = require('@capacitor/core');

module.exports = function mediaControls() {
  if (Capacitor.getPlatform() !== 'android') return;
  const plugin = registerPlugin('MurielMedia');
  const core = () => window.MurielCore;
  let pending = 0;
  // The song in the island at the top of the screen (Android 16+, a "Live Update" beside the playback notification;
  // see MediaControlsPlugin). 'on' / 'off' once picked in Settings; until then the phone's default: on for vivo,
  // whose Origin Island won't take Muriel's playback notification itself.
  const ISLAND = 'muriel_android_island';
  const islandMode = () => { const v = localStorage.getItem(ISLAND); return v === 'on' || v === 'off' ? v : 'auto'; };

  function send() {
    pending = 0;
    const c = core();
    const t = c && c.state.currentTrack;
    const a = c && c.audio;
    if (!t || !a) return;
    let art = '';
    try { art = (c.thumb && c.thumb(t)) || t.thumbnail || ''; } catch (e) { art = t.thumbnail || ''; }
    const duration = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Number(t.duration) || 0;
    plugin.update({
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      artwork: /^https:\/\//.test(art) ? art : '',
      duration,
      position: Math.min(a.currentTime || 0, duration || Infinity),
      playing: !!c.state.isPlaying,
      // between two songs nothing plays, but Muriel still has to stay in the foreground (see MediaControlsPlugin)
      loading: !c.state.isPlaying && !!c.state.trackLoading,
      rate: a.playbackRate || 1,
      shuffle: !!c.state.isShuffle,
      repeat: c.state.repeatMode || (c.state.isRepeat ? 'one' : 'off'), // 'off', 'all' or 'one'
      island: islandMode(),
    }).catch(() => {});
  }
  // several events arrive together on a song change; send once
  const update = () => { if (!pending) pending = setTimeout(send, 80); };

  // For the island row in Settings (mobile-ui.js). status(): { supported (Android 16+), vendor ('vivo', 'oplus',
  // 'xiaomi', 'samsung', 'honor' or 'other'), defaultOn, notifications (allowed), promoted (the phone's switch for
  // live updates) }. allow(): asks for notifications or opens that switch, whichever is missing; resolves with status.
  const ask = (method, ...args) => Promise.resolve().then(() => plugin[method](...args)).then((s) => s || {}).catch(() => ({}));
  const island = window.MurielIsland = {
    status: () => ask('islandStatus'),
    enabled: (status) => (islandMode() === 'auto' ? !!(status && status.defaultOn) : islandMode() === 'on'),
    setEnabled: (on) => { localStorage.setItem(ISLAND, on ? 'on' : 'off'); update(); },
    allow: (opts) => ask('allowIsland', opts),
    // back from the phone's settings: a switch turned on there shows the island right away
    refresh: () => update(),
  };

  // Some phones stop apps in the background to save battery, music or not. For the "Play in the background"
  // row in Settings (mobile-ui.js), and asked once by itself when the first song starts.
  const background = window.MurielBackground = {
    allowed: () => plugin.backgroundStatus().then((r) => !!(r && r.unrestricted)).catch(() => true),
    // resolves with the answer once the system dialog is closed
    allow: () => plugin.allowBackground().then((r) => !!(r && r.unrestricted)).catch(() => false),
  };
  const ASKED = 'muriel_bg_asked';
  // Android 13+ shows an app's notifications only once it asked for them; many phones hide the playback notification
  // too, and then there is no play button after a game or a call took the music (#25). The island needs them as
  // well. Asked once, after the battery question (the key is older than this: phones asked for the island aren't
  // asked again). Before Android 13 notifications are on unless turned off, and then this does nothing.
  const NOTIFY_ASKED = 'muriel_island_asked';
  const askNotificationsOnce = () => island.status().then((s) => {
    if (s.notifications !== false || localStorage.getItem(NOTIFY_ASKED) || document.hidden) return;
    localStorage.setItem(NOTIFY_ASKED, '1');
    return island.allow({ settings: false });
  });
  const askOnce = () => {
    const first = localStorage.getItem(ASKED) || document.hidden ? Promise.resolve()
      : (localStorage.setItem(ASKED, '1'), background.allowed().then((ok) => { if (!ok) return background.allow(); }));
    first.then(askNotificationsOnce).catch(() => {});
  };

  function hook() {
    const c = core();
    if (!c || !c.audio) return;
    window.addEventListener('muriel:track', update);
    window.addEventListener('muriel:loading', update);
    window.addEventListener('muriel:modes', update);
    ['playing', 'pause', 'seeked', 'ratechange', 'durationchange', 'ended'].forEach((ev) => c.audio.addEventListener(ev, update));
    c.audio.addEventListener('playing', askOnce, { once: true });
    plugin.addListener('action', ({ action, position } = {}) => {
      const st = core().state;
      if (action === 'play') { if (!st.isPlaying) core().togglePlay(); }
      else if (action === 'pause') { if (st.isPlaying) core().togglePlay(); }
      else if (action === 'next') core().next();
      else if (action === 'prev') core().prev();
      else if (action === 'seek' && Number.isFinite(position)) core().seek(position);
      else if (action === 'shuffle') core().toggleShuffle();
      else if (action === 'repeat') core().toggleRepeat();
      // the native side already counts play / next / previous as playing; if nothing started, it hears so
      update();
    });
  }
  if (window.MurielCore) hook(); else window.addEventListener('muriel:ready', hook, { once: true });
};
