(() => {
  try {
    if (typeof window === 'undefined' || window.__riffFetchPatched) return;
    const api = window.electronAPI;
    const token = api && api.serverToken;
    if (!token) return;
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!origFetch) return;
    window.__riffFetchPatched = true;
    window.fetch = function (input, init) {
      try {
        const raw = typeof input === 'string' ? input : (input && input.url) || '';
        if (raw.startsWith('http://127.0.0.1:') && new URL(raw).pathname.startsWith('/api/')) {
          const opts = Object.assign({}, init || {});
          const headers = new Headers(opts.headers || (input && input.headers) || undefined);
          headers.set('X-Muriel-Token', token);
          opts.headers = headers;
          return origFetch(input, opts);
        }
      } catch (e) {}
      return origFetch(input, init);
    };
  } catch (e) {}
})();

// localStorage (~5 MB) holds favorites, playlists, history, the queue and Encore. When it was full, every
// setItem threw: a song tap failed before the stream was even requested and new favorites vanished on restart.
// Free what can be rebuilt (the phone debug log, old Encore days) and retry; if it still doesn't fit, report
// it once a minute instead of throwing into whatever the app was doing.
(() => {
  try {
    const orig = Storage.prototype.setItem;
    let reportedAt = 0;
    Storage.prototype.setItem = function setItem(key, value) {
      try { return orig.call(this, key, value); } catch (e) {
        if (!e || (e.name !== 'QuotaExceededError' && e.code !== 22 && e.code !== 1014)) throw e;
        try { if (key !== 'muriel_debug_log') this.removeItem('muriel_debug_log'); } catch (_) {}
        try { if (key !== 'muriel_i18n_snap') this.removeItem('muriel_i18n_snap'); } catch (_) {}
        try { if (window.MurielEncore && window.MurielEncore.compact) window.MurielEncore.compact(90); } catch (_) {}
        try { return orig.call(this, key, value); } catch (e2) {
          if (Date.now() - reportedAt > 60000) { reportedAt = Date.now(); window.dispatchEvent(new CustomEvent('muriel:storage-full', { detail: key })); }
        }
      }
    };
  } catch (e) {}
})();

(() => {
  let lastErrLogReset = Date.now();
  let errLogCount = 0;
  function reportError(level, message, stack) {
    if (!window.electronAPI || typeof window.electronAPI.logError !== 'function') return;
    const now = Date.now();
    if (now - lastErrLogReset > 60000) {
      lastErrLogReset = now;
      errLogCount = 0;
    }
    if (errLogCount < 20) {
      errLogCount++;
      window.electronAPI.logError(level, message, stack);
    }
  }
  window.__riffLogError = reportError;
  window.addEventListener('error', (e) => {
    reportError('ERROR', e.message || String(e), e.error ? e.error.stack : null);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = (reason && reason.message) ? reason.message : String(reason);
    const stack = (reason && reason.stack) ? reason.stack : null;
    reportError('ERROR', msg, stack);
  });
})();

// Riff 43 splash: Muriel's star draws itself while the app starts (computers only; phones show their own launch
// screen). styles.css also fades it out on its own after a few seconds, so a startup error can't leave it up.
(function murielSplash() {
  const splash = document.getElementById('splash');
  const host = document.getElementById('splash-logo');
  if (!splash || !host) return;
  const perf = /^(1|true)$/.test(localStorage.getItem('muriel_perf_mode') || '');
  const reduced = localStorage.getItem('muriel_adv_reduce_motion') === 'true' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (document.documentElement.classList.contains('is-mobile') || perf || reduced) { splash.remove(); return; }
  const finish = () => {
    if (!splash.isConnected || splash.classList.contains('hide')) return;
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 480);
  };
  const safety = setTimeout(finish, 1850);
  try {
    const paths = Array.from(host.querySelectorAll('path'));
    const lengths = paths.map((p) => {
      const len = typeof p.getTotalLength === 'function' ? p.getTotalLength() : 2000;
      Object.assign(p.style, { fillOpacity: '0', stroke: 'var(--md-sys-color-primary, #D0BCFF)', strokeWidth: '14px', strokeLinejoin: 'round', strokeDasharray: String(len), strokeDashoffset: String(len) });
      return len;
    });
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / 1150);
      const draw = ease(Math.min(1, p / 0.72));
      const fill = p < 0.5 ? 0 : ease((p - 0.5) / 0.5);
      host.style.transform = `scale(${(1.28 - 0.28 * ease(p)).toFixed(3)})`;
      paths.forEach((el, i) => {
        el.style.strokeDashoffset = (lengths[i] * (1 - draw)).toFixed(1);
        el.style.fillOpacity = fill.toFixed(3);
        el.style.strokeOpacity = (1 - fill * 0.65).toFixed(3);
      });
      if (p < 1) requestAnimationFrame(tick);
      else { clearTimeout(safety); finish(); }
    };
    requestAnimationFrame(tick);
  } catch (e) {
    clearTimeout(safety);
    finish();
  }
})();

document.addEventListener('DOMContentLoaded', async () => {
  try { localStorage.removeItem('muriel_stats'); } catch (e) {}

  const THUMB_FALLBACK = "if(window.murielArtNext){window.murielArtNext(this)}else if(this.dataset.full&&this.src!==this.dataset.full){this.src=this.dataset.full}else{this.style.visibility='hidden'}";

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const LiquidMotion = {
    setAnchor(element, triggerEl, axis = 'x') {
      if (!element) return;
      if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const parentRect = element.parentElement ? element.parentElement.getBoundingClientRect() : { top: 0, left: 0 };
        if (axis === 'x') {
          const anchorY = (rect.top + rect.height / 2) - parentRect.top;
          element.style.setProperty('--liquid-anchor-y', `${anchorY}px`);
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = `0px ${anchorY}px`;
        } else {
          const anchorX = (rect.left + rect.width / 2) - parentRect.left;
          element.style.setProperty('--liquid-anchor-x', `${anchorX}px`);
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = `${anchorX}px 0px`;
        }
      } else {
        if (axis === 'x') {
          element.style.setProperty('--liquid-anchor-y', '50%');
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = '0px 50%';
        } else {
          element.style.setProperty('--liquid-anchor-x', '50%');
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = '50% 0px';
        }
      }
    },
    open(element, triggerEl, axis = 'x', onDone) {
      if (!element) return;
      this.setAnchor(element, triggerEl, axis);
      element.classList.remove('liquid-closing');
      element.classList.add('liquid-surface', `liquid-${axis}`, 'liquid-open');
      if (onDone) setTimeout(onDone, 480);
    },
    close(element, onDone) {
      if (!element) return;
      element.classList.add('liquid-closing');
      element.classList.remove('liquid-open');
      setTimeout(() => {
        element.classList.remove('liquid-closing', 'liquid-open');
        if (onDone) onDone();
      }, 300);
    }
  };
  window.LiquidMotion = LiquidMotion;


  function injectM3Shapes() {
    const defs = document.getElementById('m3-dynamic-defs');
    if (!defs) return;

    const formulas = {
      'm3-cookie-4': (a) => 40 + 6 * Math.cos(4 * a),
                          'm3-diamond-puffy': (a) => 36 + 10 * Math.cos(4 * a),
                          'm3-flower': (a) => 28 + 18 * Math.abs(Math.cos(4 * a)),
                          'm3-poly-6': (a) => {
                            let t = a % (2 * Math.PI / 6);
                            if (t < 0) t += 2 * Math.PI / 6;
                            return 36 / Math.cos(t - Math.PI / 6);
                          },
                          'm3-leaf-4': (a) => 40 + 6 * Math.cos(4 * a)
    };

    let html = '';
    for (const [id, formula] of Object.entries(formulas)) {
      let path = '';
      const res = 120;
      for (let i = 0; i <= res; i++) {
        const angle = (i / res) * 2 * Math.PI;
        const r = formula(angle);
        const x = 0.5 + (r * Math.cos(angle)) / 100;
        const y = 0.5 + (r * Math.sin(angle)) / 100;
        path += `${i === 0 ? 'M' : 'L'} ${x.toFixed(4)},${y.toFixed(4)} `;
      }
      path += 'Z';
      html += `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><path d="${path}" /></clipPath>`;
    }
    defs.insertAdjacentHTML('beforeend', html);
  }
  injectM3Shapes();

  // UI language (i18n.js): T('English') now, Tf('{0} songs', n) with values that are never translated,
  // Tm(...) for a toast or I18N.text(el, ...) that keep up when the translation comes in or the language changes.
  // Only literal strings go in: anything from the library or typed by someone goes into the {0} slots.
  const I18N = window.MurielI18n || { T: (s) => s, Tf: (s, ...a) => String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] != null ? String(a[i]) : '')), lang: 'en', text: (el, s, ...a) => { if (el) el.textContent = String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] != null ? String(a[i]) : '')); }, ready: () => Promise.resolve(), connect() {}, setLang: async () => true, refresh() {} };
  if (!I18N.Tm) I18N.Tm = (s, ...a) => ({ i18n: String(s), args: a, toString() { return I18N.Tf(this.i18n, ...this.args); } });
  const T = (s) => I18N.T(s);
  const Tf = (s, ...args) => I18N.Tf(s, ...args);
  const Tm = (s, ...args) => I18N.Tm(s, ...args);
  // what upstream Riff (and plugins written for it) call
  window.t = T;
  window.applyI18n = (lang) => I18N.setLang(lang);
  // shown often but not on the page until then (a song's menu, everyday messages): asked for along with the page
  if (I18N.known) I18N.known(['Play next', 'Add to queue', 'Add to playlist…', 'Add to favorites', 'Remove from favorites', 'Go to artist',
    'Download…', 'Remove from playlist', 'Playing next', 'Added to queue', 'Already in the queue', 'Added to "{0}"', 'Already in "{0}"',
    'Added {0} tracks to "{1}"', 'Playlist deleted', 'Link copied{0}', 'Removed from library', 'Could not play this song. Try again or skip.',
    'Offline: connect to the internet to search new tracks', 'No matching tracks. Try a different search', 'Search for "{0}"', 'Actions',
    'Playlists', 'Favorites', 'In playlists', 'Queue', 'History', 'Library', 'Online', 'Discover', 'View', 'Audio', 'Your stats',
    'Repeat: playlist', 'Repeat: this song', 'Start radio', 'Radio · {0}', 'Radio · {0} and {1} more', 'Sleep timer: {0} min', 'Sleep timer: end of track']);

  const toastQueue = [];
  const MAX_QUEUED_TOASTS = 10;
  let isToastActive = false;

  // message: a string as it is (it is not translated: it may hold a song title), or Tm('...', ...) to translate
  function showToast(message, type = 'info', duration = null) {
    if (!message) return;
    if (toastQueue.length >= MAX_QUEUED_TOASTS) {
      toastQueue.shift();
    }
    toastQueue.push({ message, type, duration });
    if (!isToastActive) {
      // a message in another language waits a moment for its words, instead of showing up in English
      if (message && message.i18n && I18N.lang !== 'en') {
        isToastActive = true;
        I18N.ready(message.i18n).then(processToastQueue);
      } else {
        processToastQueue();
      }
    }
  }

  function processToastQueue() {
    if (toastQueue.length === 0) {
      isToastActive = false;
      return;
    }
    isToastActive = true;
    const container = document.getElementById('toast-container');
    if (!container) {
      toastQueue.length = 0;
      isToastActive = false;
      return;
    }
    const { message, type, duration } = toastQueue.shift();

    const toast = document.createElement('div');
    toast.className = `muriel-toast ${type}${duration ? ' wide' : ''}`;

    let iconSvg = '';
    if (type === 'error') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="14"/><line x1="12" y1="19" x2="12.01" y2="19"/></svg>';
    } else if (type === 'success') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    }

    const cleanMessage = String(message).charAt(0).toUpperCase() + String(message).slice(1);

    toast.innerHTML = `
      ${iconSvg ? `<span class="toast-icon">${iconSvg}</span>` : ''}
      <span class="toast-text">${escapeHtml(cleanMessage)}</span>
    `;
    if (message && message.i18n) I18N.text(toast.querySelector('.toast-text'), message);

    container.appendChild(toast);

    let dismissed = false;
    let timer = null;
    let remaining = duration || 3500;
    let startTimestamp = Date.now();

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      toast.classList.add('leaving');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        toast.remove();
        processToastQueue();
      };
      toast.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 320);
    };

    const startTimer = (dur) => {
      startTimestamp = Date.now();
      timer = setTimeout(dismiss, dur);
    };

    toast.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
      remaining -= (Date.now() - startTimestamp);
      if (remaining < 500) remaining = 500;
    });

    toast.addEventListener('mouseleave', () => {
      if (!dismissed) {
        startTimer(remaining);
      }
    });

    toast.addEventListener('click', dismiss);

    startTimer(remaining);
  }

  if (localStorage.getItem('muriel_scale_rebased_v2') !== '1') {
    localStorage.setItem('muriel_scale_rebased_v2', '1');
    if (localStorage.getItem('devsize_ui_scale') === '90') {
      localStorage.removeItem('devsize_ui_scale');
    }
    if (localStorage.getItem('muriel_font_scale') === '95') {
      localStorage.removeItem('muriel_font_scale');
    }
  }

  const savedScale = parseFloat(localStorage.getItem('devsize_ui_scale') || '100');
  applyScale(savedScale);

  function applyScale(scalePercent) {
    const factor = (scalePercent / 100) * 0.90;
    document.documentElement.style.setProperty('--app-scale', factor.toString());
    if (window.electronAPI && window.electronAPI.setZoomFactor) {
      window.electronAPI.setZoomFactor(factor);
    } else {
      document.body.style.zoom = factor;
    }
  }

  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  function openModal(elModal) {
    if (!elModal) return;
    if (elModal._closeTimer) { clearTimeout(elModal._closeTimer); elModal._closeTimer = null; }
    elModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elModal.classList.add('visible');
      });
    });
  }

  function closeModal(elModal) {
    if (!elModal) return;
    elModal.classList.remove('visible');
    if (elModal._closeTimer) clearTimeout(elModal._closeTimer);
    elModal._closeTimer = setTimeout(() => {
      elModal._closeTimer = null;
      elModal.classList.add('hidden');
    }, 200);
  }

  const defaultPresets = [
    { id: 'p_default', name: 'default', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_speedup', name: 'speed up (orig pitch)', settings: { speed: 1.35, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_speedup_pitch', name: 'speed up (tape pitch)', settings: { speed: 1.0, speedPitch: 1.30, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_slowed', name: 'slowed + reverb', settings: { speed: 1.0, speedPitch: 0.82, pitch: 0, reverb: 65, distortion: 0, volume: 1.0, echo: 15, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_nightcore', name: 'nightcore', settings: { speed: 1.0, speedPitch: 1.25, pitch: 0, reverb: 20, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'p_distortion', name: 'distortion hard', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 75, volume: 1.25, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }
  ];

  const defaultVfx = {
    ambientGlow: true,
    bassPulse: false,
    vinylSpin: false,
    soundwaveRings: false,
    borderGlow: false,
    particles: false,
    backdropBlur: false,
    crt: false,
    grain: false,
    lyricsSpotlight: false
  };

  function normalizePreset(p) {
    if (!p) return null;
    const s = p.settings || p.values || {};
    const eq = s.eq || {};
    return {
      id: p.id,
      name: p.name || 'preset',
      settings: {
        speed: typeof s.speed === 'number' ? s.speed : 1.0,
        speedPitch: typeof s.speedPitch === 'number' ? s.speedPitch : 1.0,
        pitch: typeof s.pitch === 'number' ? s.pitch : (typeof s.pitchSemitones === 'number' ? s.pitchSemitones : 0),
                          reverb: typeof s.reverb === 'number' ? s.reverb : 0,
                          distortion: typeof s.distortion === 'number' ? s.distortion : 0,
                          volume: typeof s.volume === 'number' ? s.volume : (typeof s.gain === 'number' ? s.gain : 1.0),
                          echo: typeof s.echo === 'number' ? s.echo : 0,
                          eq: {
                            low: typeof eq.low === 'number' ? eq.low : 0,
                            mid: typeof eq.mid === 'number' ? eq.mid : 0,
                            high: typeof eq.high === 'number' ? eq.high : 0
                          },
                          eqBands: Array.isArray(s.eqBands) && s.eqBands.length === 10 ? s.eqBands.map(v => typeof v === 'number' ? v : 0) : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      }
    };
  }

  function safeJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeArray(key) {
    const value = safeJson(key, []);
    return Array.isArray(value) ? value : [];
  }

  const rawCustomPresets = safeArray('devsize_custom_presets');
  const normalizedCustomPresets = rawCustomPresets.map(normalizePreset).filter(Boolean);

  const savedVolumeRaw = parseFloat(localStorage.getItem('muriel_volume'));
  const savedVolume = Number.isFinite(savedVolumeRaw) ? Math.max(0, Math.min(1, savedVolumeRaw)) : 0.85;

  const DEFAULT_AUDIO_SETTINGS = { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const DEFAULT_HQ_SETTINGS = { engine: 'hqmusic-3', preset: 'studio', vocal: 0, air: 0, bass: 0 };
  // on unless switched off: speed, pitch and effects reset every launch was mistaken for a bug (issue #5)
  let soundPersistenceEnabled = localStorage.getItem('muriel_persist_sound_settings') !== '0';

  function loadSoundSettings() {
    if (!soundPersistenceEnabled) {
      return {
        audioSettings: { ...DEFAULT_AUDIO_SETTINGS, eq: { ...DEFAULT_AUDIO_SETTINGS.eq }, eqBands: [...DEFAULT_AUDIO_SETTINGS.eqBands] },
        hqEnabled: false,
        hqSettings: { ...DEFAULT_HQ_SETTINGS }
      };
    }
    const savedAudio = safeJson('muriel_audio_settings', null);
    const savedHq = safeJson('muriel_hq_settings', null);
    const audioObj = savedAudio && typeof savedAudio === 'object' ? savedAudio : {};
    const hqObj = savedHq && typeof savedHq === 'object' ? savedHq : {};
    return {
      audioSettings: {
        ...DEFAULT_AUDIO_SETTINGS,
        ...audioObj,
        eq: { ...DEFAULT_AUDIO_SETTINGS.eq, ...(audioObj.eq && typeof audioObj.eq === 'object' ? audioObj.eq : {}) },
        eqBands: Array.isArray(audioObj.eqBands) && audioObj.eqBands.length === 10 ? audioObj.eqBands.map(v => typeof v === 'number' ? v : 0) : [...DEFAULT_AUDIO_SETTINGS.eqBands]
      },
      hqEnabled: localStorage.getItem('muriel_hq_enabled') === '1',
      hqSettings: { ...DEFAULT_HQ_SETTINGS, ...hqObj }
    };
  }

  const savedSound = loadSoundSettings();

  const SF_FONT_STACK = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif`;

  function ensureSfFontLoaded() {
    if (!document.getElementById('font-sf-pro')) {
      const link = document.createElement('link');
      link.id = 'font-sf-pro';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.cdnfonts.com/css/sf-pro-display';
      document.head.appendChild(link);
    }
  }

  function applyFont(font) {
    const f = (typeof font === 'string' && font) ? font : (localStorage.getItem('muriel_font') || 'google');
    if (typeof state !== 'undefined' && state) {
      state.riffFont = f;
    }
    if (f === 'sf') {
      ensureSfFontLoaded();
      document.documentElement.style.setProperty('--font-family', SF_FONT_STACK);
    } else if (f === 'system') {
      document.documentElement.style.setProperty('--font-family', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    } else {
      document.documentElement.style.removeProperty('--font-family');
    }
    const fontOptGoogle = document.getElementById('font-opt-google');
    const fontOptSf = document.getElementById('font-opt-sf');
    const fontOptSystem = document.getElementById('font-opt-system');
    if (fontOptGoogle) fontOptGoogle.classList.toggle('active', f === 'google');
    if (fontOptSf) fontOptSf.classList.toggle('active', f === 'sf');
    if (fontOptSystem) fontOptSystem.classList.toggle('active', f === 'system');
  }

  const state = {
    platform: localStorage.getItem('muriel_platform') || 'youtube',
    currentView: 'discover',
    previousView: 'discover',
    currentPlaylistId: null,
    currentArtistData: null,
    searchQuery: '',
    searchResults: [],
    queue: [],
    queueIndex: -1,
    queueHistory: [],
    currentTrack: null,
    currentTrackContext: null,
    currentTrackIndexInContext: -1,
    isPlaying: false,
    isMuted: localStorage.getItem('muriel_muted') === '1',
    volume: savedVolume,
    // repeat: 'off', 'all' (the queue starts over) or 'one' (the song plays again); isRepeat means 'one'
    repeatMode: ({ '1': 'one', all: 'all' })[localStorage.getItem('muriel_repeat')] || 'off',
    isRepeat: localStorage.getItem('muriel_repeat') === '1',
    isShuffle: localStorage.getItem('muriel_shuffle') === '1',
    isAutoRemix: false,
    myWaveActive: false,
    _isNaturalEnding: false,
    _skipRecordedFor: null,
    isRightPanelOpen: false,
    drawerTab: 'now',
    lyricsMode: 'line',
    uiScale: savedScale,
    activePresetId: soundPersistenceEnabled ? (localStorage.getItem('muriel_active_preset') || 'p_default') : 'p_default',
    themeMode: localStorage.getItem('muriel_theme_mode') || 'dark',
    paletteStyle: localStorage.getItem('muriel_palette_style') || 'classic',
    meshBrightness: parseInt(localStorage.getItem('muriel_mesh_brightness') || '100', 10),
    themeAccent: localStorage.getItem('muriel_theme_accent') || '#6750A4',
    themeIntensity: parseInt(localStorage.getItem('muriel_theme_intensity') || '0'),
    themeBrightness: parseInt(localStorage.getItem('muriel_theme_brightness') || '50'),
    trEnabled: localStorage.getItem('muriel_tr_enabled') === 'true',
    trLang: localStorage.getItem('muriel_tr_lang') || 'en',
    trAuto: localStorage.getItem('muriel_tr_auto') === 'true',
    trActive: false,
    currentTranslations: null,
    isTvKaraokeOpen: false,
                          audioSettings: savedSound.audioSettings,
                          hqEnabled: savedSound.hqEnabled,
                          hqSettings: savedSound.hqSettings,
                          vfx: { ...defaultVfx, ...safeJson('devsize_vfx', {}), bassPulse: false, particles: false, soundwaveRings: false, borderGlow: false, backdropBlur: false, crt: false, grain: false, lyricsSpotlight: false },
                          favorites: safeArray('devsize_favorites'),
                          history: safeArray('devsize_history'),
                          playlists: safeArray('devsize_playlists'),
                          customPresets: normalizedCustomPresets,
                          localTracks: [],
                          syncedLyrics: [],
                          glitchTimes: [],
                          lastGlitchedIndex: -1,
                          isGlitching: false,
                          isWindowVisible: true,
                          loadToken: 0,
                          currentAbortController: null,
                          presetToRenameId: null,
                          serverPort: 38472,
                          lastBroadcastStateKey: null,
                          syncTimeout: null,
                          scrubberDragTargetTime: undefined,
                          riffFont: localStorage.getItem('muriel_font') || 'google'
  };

  function migrateAddedAt() {
    // the same song favourited from several places (album row, player bar, search) was kept once per source (#10)
    const favorites = backfillAddedAt(dedupeFavoriteTracks(state.favorites), true);
    if (favorites !== state.favorites) {
      state.favorites = favorites;
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
    }
    let playlistsChanged = false;
    for (const pl of state.playlists) {
      if (!pl || !Array.isArray(pl.tracks)) continue;
      const tracks = backfillAddedAt(pl.tracks, false);
      if (tracks !== pl.tracks) {
        pl.tracks = tracks;
        playlistsChanged = true;
      }
    }
    if (playlistsChanged) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
  }

  migrateAddedAt();

  applyFont(state.riffFont);

  if (window.electronAPI && window.electronAPI.getServerPort) {
    try {
      state.serverPort = await window.electronAPI.getServerPort();
    } catch (e) {
      console.warn('Failed to get server port:', e);
    }
  }

  // other languages: what this device translated before, then whatever is still missing (English: nothing)
  I18N.connect(`http://127.0.0.1:${state.serverPort}`);

  checkToolsStatus(true);

  function sendStateToServer(currentWordText = '', wordIndex = -1, lineIndex = -1) {
    if (!state.currentTrack) return;
    fetch(`http://127.0.0.1:${state.serverPort}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: state.currentTrack.title,
        artist: state.currentTrack.artist,
        isPlaying: state.isPlaying,
        word: currentWordText,
        wordIndex: wordIndex,
        lineIndex: lineIndex
      })
    }).catch(() => {});
  }

  function getMediaArtwork(thumb) {
    if (!thumb || typeof thumb !== 'string') return [];
    const trimmed = thumb.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('data:')) {
      return [];
    }
    let type = 'image/jpeg';
    if (trimmed.startsWith('data:image/png') || /\.png(\?|$)/i.test(trimmed)) type = 'image/png';
    else if (trimmed.startsWith('data:image/webp') || /\.webp(\?|$)/i.test(trimmed)) type = 'image/webp';
    else if (trimmed.startsWith('data:image/gif') || /\.gif(\?|$)/i.test(trimmed)) type = 'image/gif';
    return [
      { src: trimmed, sizes: '96x96', type },
      { src: trimmed, sizes: '128x128', type },
      { src: trimmed, sizes: '192x192', type },
      { src: trimmed, sizes: '256x256', type },
      { src: trimmed, sizes: '512x512', type }
    ];
  }

  function updateMediaPositionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    try {
      const audio = (state.secondaryAudio && !state.secondaryAudio.paused) ? state.secondaryAudio : el.nativeAudio;
      const pos = window.MurielNowPlaying.positionState(audio, state.currentTrack && state.currentTrack.duration);
      if (pos) navigator.mediaSession.setPositionState(pos);
      else navigator.mediaSession.setPositionState();
    } catch (_) {}
  }

  let discordPresenceClearTimer = null;
  // off unless turned on in Settings (it tells everyone on Discord what you're listening to)
  const discordPresenceOn = () => localStorage.getItem('muriel_discord_presence') === 'true';
  function updateDiscordPresence() {
    const api = window.electronAPI;
    if (!api) return;
    if (!discordPresenceOn()) return;
    if (!state.currentTrack) {
      if (discordPresenceClearTimer) clearTimeout(discordPresenceClearTimer);
      discordPresenceClearTimer = setTimeout(() => {
        discordPresenceClearTimer = null;
        if (!state.currentTrack && api.discordPresenceClear) api.discordPresenceClear();
      }, 1500);
      return;
    }
    if (discordPresenceClearTimer) {
      clearTimeout(discordPresenceClearTimer);
      discordPresenceClearTimer = null;
    }
    if (!api.discordPresenceUpdate) return;

    const track = state.currentTrack;
    const audio = (state.secondaryAudio && !state.secondaryAudio.paused) ? state.secondaryAudio : el.nativeAudio;
    const duration = Number(track.duration) > 0
      ? Number(track.duration)
      : (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    const position = audio && Number.isFinite(audio.currentTime) && audio.currentTime >= 0
      ? audio.currentTime
      : 0;
    const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || '';
    const isRemoteUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value) && !value.includes('127.0.0.1');
    const link = typeof track.url === 'string' && /^https:\/\//i.test(track.url) ? track.url : '';
    api.discordPresenceUpdate({
      title: track.title || 'Unknown Track',
      artist: track.artist || 'Unknown Artist',
      duration,
      position,
      isPlaying: !!state.isPlaying,
      thumbnail: isRemoteUrl(thumb) ? thumb : '',
      url: link
    });
  }

  function updateMediaSession() {
    updateDiscordPresence();
    if (!('mediaSession' in navigator)) return;
    if (state.currentTrack) {
      const rawTitle = (typeof state.currentTrack.title === 'string' ? state.currentTrack.title.trim() : '');
      const rawArtist = (typeof state.currentTrack.artist === 'string' ? state.currentTrack.artist.trim() : '');
      const rawAlbum = (typeof state.currentTrack.album === 'string' ? state.currentTrack.album.trim() : '');
      const title = rawTitle || 'Unknown track';
      const artist = rawArtist || 'Unknown artist';
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : '') || state.currentTrack.thumbnail || '';
      const artwork = getMediaArtwork(thumb);
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album: rawAlbum,
        artwork
      });
      updateMediaPositionState();
    } else {
      navigator.mediaSession.metadata = null;
    }
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }

  const MEDIA_GROUP = { toggle: 'pp', play: 'pp', pause: 'pp', next: 'next', prev: 'prev', stop: 'stop' };
  let lastMedia = { g: '', t: 0 };
  let hasNotifiedMediaKeysActive = false;
  function handleMediaCommand(cmd, src) {
    const g = MEDIA_GROUP[cmd];
    if (!g) return;
    const now = performance.now();
    if (lastMedia.g === g && now - lastMedia.t < 350) return;
    lastMedia = { g, t: now };
    if (cmd === 'toggle') togglePlayPause();
    // togglePlayPause also handles a restored session that has no audio loaded yet (lock screen / headset play)
    else if (cmd === 'play') { if (!state.isPlaying) togglePlayPause(); }
    else if (cmd === 'pause') { if (state.isPlaying) pauseSmooth(); }
    else if (cmd === 'next') playNext();
    else if (cmd === 'prev') playPrev();
    else if (cmd === 'stop') { if (state.isPlaying) pauseSmooth(); }
  }

  // Lock screen / Control Center / headset buttons. iOS forgets these whenever one song is unloaded for the
  // next, and with none registered it shows its own ±15 s skip buttons instead of previous / next (the
  // "songs act like podcasts" report), so they are registered again every time a song starts.
  const mediaActions = {
    play: () => handleMediaCommand('play', 'session'),
    pause: () => handleMediaCommand('pause', 'session'),
    previoustrack: () => handleMediaCommand('prev', 'session'),
    nexttrack: () => handleMediaCommand('next', 'session'),
    stop: () => handleMediaCommand('stop', 'session'),
    seekto: (details) => {
      if (details.seekTime !== undefined && details.seekTime !== null) {
        const audio = (state.secondaryAudio && !state.secondaryAudio.paused) ? state.secondaryAudio : el.nativeAudio;
        if (audio) audio.currentTime = details.seekTime;
        if (typeof updateSyncedLyricsHighlight === 'function') {
          updateSyncedLyricsHighlight(details.seekTime);
        }
        updateMediaPositionState();
        updateDiscordPresence();
      }
    },
    // skip buttons take the place of previous / next on the iPhone lock screen
    seekbackward: null,
    seekforward: null,
  };
  function registerMediaActions() {
    if (!('mediaSession' in navigator)) return;
    for (const [action, handler] of Object.entries(mediaActions)) {
      // one action the browser doesn't know must not stop the others
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
    }
  }
  registerMediaActions();

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }

  function getAdv(name, defaultVal = true) {
    const val = localStorage.getItem(`muriel_adv_${name}`);
    if (val === null) return defaultVal;
    return val === 'true';
  }

  function setAdv(name, boolVal) {
    localStorage.setItem(`muriel_adv_${name}`, boolVal ? 'true' : 'false');
  }

  // off or on as chosen in Settings; never chosen: the system's "Reduce motion" (from Riff 43.2)
  function systemPrefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function applyReducedMotionSetting() {
    const reduced = getAdv('reduce_motion', systemPrefersReducedMotion());
    document.documentElement.classList.toggle('force-reduced-motion', reduced);
  }

  const PALETTE_STYLES = {
    classic: {
      label: 'Classic',
      secHueShift: 0,
      tertHueShift: 0,
      priSatScale: 1.0,
      surfSatScale: 1.0,
      contSatScale: 1.0
    },
    'tonal-spot': {
      label: 'Tonal spot',
      secHueShift: 0,
      tertHueShift: 60,
      priSatScale: 1.0,
      surfSatScale: 0.8,
      contSatScale: 0.9
    },
    expressive: {
      label: 'Expressive',
      secHueShift: 60,
      tertHueShift: 120,
      priSatScale: 1.25,
      surfSatScale: 1.5,
      contSatScale: 1.3
    },
    vibrant: {
      label: 'Vibrant',
      secHueShift: 0,
      tertHueShift: 60,
      priSatScale: 1.4,
      surfSatScale: 1.2,
      contSatScale: 1.4
    },
    neutral: {
      label: 'Neutral',
      secHueShift: 0,
      tertHueShift: 0,
      priSatScale: 0.35,
      surfSatScale: 0.2,
      contSatScale: 0.25
    }
  };

  // Old Android WebViews (before Chrome 111) have no color-mix(): a color built with it was thrown away and all
  // text came out black. They get the plain color instead (the transparency sliders do nothing there).
  const hasColorMix = !!(window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red 50%, transparent)'));
  const tint = (hex, v) => (hasColorMix ? `color-mix(in srgb, ${hex} var(${v}), transparent)` : hex);
  const SURFACE_TOKENS = new Set([
    '--md-sys-color-background',
    '--md-sys-color-surface',
    '--md-sys-color-surface-dim',
    '--md-sys-color-surface-bright',
    '--md-sys-color-surface-container-lowest',
    '--md-sys-color-surface-container-low',
    '--md-sys-color-surface-container',
    '--md-sys-color-surface-container-high',
    '--md-sys-color-surface-container-highest'
  ]);
  const TEXT_TOKENS = new Set([
    '--md-sys-color-on-surface',
    '--md-sys-color-on-surface-variant'
  ]);

  function generateM3Palette(hexColor, mode, intensity, brightness) {
    if (!hexColor) hexColor = '#6750A4';
    const rgb = hexToRgb(hexColor);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const h = hsl.h;
    const intensityFactor = (typeof intensity === 'number' ? intensity : 100) / 100;
    const root = document.documentElement;
    // Settings → "Apply intensity to background" (Riff 43): surfaces take on the accent as strongly as the
    // intensity slider says, instead of the faint tint they always have
    const tintSurfaces = getAdv('intensity_bg', false);
    const surfSat = (n, factor) => tintSurfaces ? Math.min(85, Math.round((hsl.s || 60) * factor * 2.4)) : Math.round(n * factor);

    const setToken = (prop, val) => {
      if (SURFACE_TOKENS.has(prop)) {
        root.style.setProperty(prop, tint(val, '--ui-alpha'));
        root.style.setProperty(`${prop}-solid`, val);
      } else if (TEXT_TOKENS.has(prop)) {
        root.style.setProperty(prop, tint(val, '--text-alpha'));
        root.style.setProperty(`${prop}-solid`, val);
      } else {
        root.style.setProperty(prop, val);
      }
    };

    const setSurfaceToken = (prop, val) => {
      root.style.setProperty(prop, tint(val, '--ui-alpha'));
      root.style.setProperty(`${prop}-solid`, val);
    };

    const styleKey = state.paletteStyle || 'classic';
    const style = PALETTE_STYLES[styleKey] || PALETTE_STYLES.classic;

    const hSec = (h + style.secHueShift) % 360;
    const hTert = (h + style.tertHueShift) % 360;

    const isMonochrome = intensityFactor < 0.08 || (styleKey === 'neutral' && intensityFactor < 0.05);
    const br = (typeof brightness === 'number' ? brightness : 50) / 100;

    if (mode === 'light') {
      const LB = (v) => Math.max(0, Math.min(100, Math.round(v + (br - 0.5) * 24)));
      if (isMonochrome) {
        setToken('--md-sys-color-primary', '#111111');
        setToken('--md-sys-color-on-primary', '#FFFFFF');
        setSurfaceToken('--md-sys-color-primary-container', hslToHex(0, 0, LB(90)));
        setToken('--md-sys-color-on-primary-container', '#111111');
        setToken('--md-sys-color-secondary', '#444444');
        setSurfaceToken('--md-sys-color-secondary-container', hslToHex(0, 0, LB(90)));
        setToken('--md-sys-color-on-secondary-container', '#111111');
        setToken('--md-sys-color-tertiary', '#444444');
        setSurfaceToken('--md-sys-color-tertiary-container', hslToHex(0, 0, LB(90)));
        setToken('--md-sys-color-background', hslToHex(0, 0, LB(99)));
        setToken('--md-sys-color-surface', hslToHex(0, 0, LB(98)));
        setToken('--md-sys-color-surface-dim', hslToHex(0, 0, LB(87)));
        setToken('--md-sys-color-surface-bright', hslToHex(0, 0, LB(98)));
        setToken('--md-sys-color-surface-container-lowest', hslToHex(0, 0, LB(100)));
        setToken('--md-sys-color-surface-container-low', hslToHex(0, 0, LB(96)));
        setToken('--md-sys-color-surface-container', hslToHex(0, 0, LB(94)));
        setToken('--md-sys-color-surface-container-high', hslToHex(0, 0, LB(92)));
        setToken('--md-sys-color-surface-container-highest', hslToHex(0, 0, LB(90)));
        setToken('--md-sys-color-on-surface', '#111111');
        setToken('--md-sys-color-on-surface-variant', '#444444');
        setToken('--md-sys-color-outline', '#777777');
        setSurfaceToken('--md-sys-color-outline-variant', '#CFCFCF');
        setToken('--md-sys-color-error', '#777777');
        setToken('--md-sys-color-on-error', '#FFFFFF');
      } else {
        const sat = Math.min(100, Math.round(48 * intensityFactor * style.priSatScale));
        const satHi = Math.min(100, Math.round(80 * intensityFactor * style.contSatScale));
        const satMed = Math.min(100, Math.round(55 * intensityFactor * style.priSatScale));
        const satLow = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
        const satLow2 = Math.min(100, Math.round(20 * intensityFactor * style.contSatScale));
        const surfFactor = intensityFactor * style.surfSatScale;

        setToken('--md-sys-color-primary', hslToHex(h, sat, 40));
        setToken('--md-sys-color-on-primary', '#FEFBFF');
        setToken('--md-sys-color-primary-container', hslToHex(h, satHi, LB(90)));
        setToken('--md-sys-color-on-primary-container', hslToHex(h, satMed, 18));
        setToken('--md-sys-color-secondary', hslToHex(hSec, satLow, 45));
        setToken('--md-sys-color-secondary-container', hslToHex(hSec, satLow, LB(90)));
        setToken('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 15));
        setToken('--md-sys-color-tertiary', hslToHex(hTert, satLow, 45));
        setToken('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, LB(90)));
        setToken('--md-sys-color-background', hslToHex(h, surfSat(5, surfFactor), LB(99)));
        setToken('--md-sys-color-surface', hslToHex(h, surfSat(6, surfFactor), LB(98)));
        setToken('--md-sys-color-surface-dim', hslToHex(h, surfSat(5, surfFactor), LB(87)));
        setToken('--md-sys-color-surface-bright', hslToHex(h, surfSat(6, surfFactor), LB(98)));
        setToken('--md-sys-color-surface-container-lowest', hslToHex(h, surfSat(4, surfFactor), LB(100)));
        setToken('--md-sys-color-surface-container-low', hslToHex(h, surfSat(5, surfFactor), LB(96)));
        setToken('--md-sys-color-surface-container', hslToHex(h, surfSat(6, surfFactor), LB(94)));
        setToken('--md-sys-color-surface-container-high', hslToHex(h, surfSat(5, surfFactor), LB(92)));
        setToken('--md-sys-color-surface-container-highest', hslToHex(h, surfSat(5, surfFactor), LB(90)));
        setToken('--md-sys-color-on-surface', '#1C1B1F');
        setToken('--md-sys-color-on-surface-variant', '#49454F');
        setToken('--md-sys-color-outline', '#79747E');
        setToken('--md-sys-color-outline-variant', '#CAC4D0');
      }
    } else {
      if (isMonochrome) {
        const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
        setToken('--md-sys-color-primary', '#FFFFFF');
        setToken('--md-sys-color-on-primary', '#121212');
        setSurfaceToken('--md-sys-color-primary-container', hslToHex(0, 0, B(24)));
        setToken('--md-sys-color-on-primary-container', '#FFFFFF');
        setToken('--md-sys-color-secondary', '#D0D0D0');
        setSurfaceToken('--md-sys-color-secondary-container', hslToHex(0, 0, B(24)));
        setToken('--md-sys-color-on-secondary-container', '#FFFFFF');
        setToken('--md-sys-color-tertiary', '#D0D0D0');
        setSurfaceToken('--md-sys-color-tertiary-container', hslToHex(0, 0, B(24)));
        setToken('--md-sys-color-background', hslToHex(0, 0, B(7)));
        setToken('--md-sys-color-surface', hslToHex(0, 0, B(7)));
        setToken('--md-sys-color-surface-dim', hslToHex(0, 0, B(7)));
        setToken('--md-sys-color-surface-bright', hslToHex(0, 0, B(19)));
        setToken('--md-sys-color-surface-container-lowest', hslToHex(0, 0, B(5)));
        setToken('--md-sys-color-surface-container-low', hslToHex(0, 0, B(10)));
        setToken('--md-sys-color-surface-container', hslToHex(0, 0, B(13)));
        setToken('--md-sys-color-surface-container-high', hslToHex(0, 0, B(16)));
        setToken('--md-sys-color-surface-container-highest', hslToHex(0, 0, B(20)));
        setToken('--md-sys-color-on-surface', '#FFFFFF');
        setToken('--md-sys-color-on-surface-variant', '#CFCFCF');
        setToken('--md-sys-color-outline', '#8A8A8A');
        setSurfaceToken('--md-sys-color-outline-variant', '#3A3A3A');
        setToken('--md-sys-color-error', '#8A8A8A');
        setToken('--md-sys-color-on-error', '#121212');
      } else {
        const sat = Math.min(100, Math.round(60 * intensityFactor * style.priSatScale));
        const satHi = Math.min(100, Math.round(60 * intensityFactor * style.contSatScale));
        const satMed = Math.min(100, Math.round(50 * intensityFactor * style.priSatScale));
        const satLow = Math.min(100, Math.round(15 * intensityFactor * style.contSatScale));
        const satLow2 = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
        const surfFactor = intensityFactor * style.surfSatScale;
        const priHex = hslToHex(h, sat, 75);
        const priRgb = hexToRgb(priHex);
        setToken('--md-sys-color-primary', priHex);
        setToken('--md-sys-color-on-primary', hslToHex(h, satMed, 20));
        setToken('--md-sys-color-primary-container', `rgba(${priRgb.r}, ${priRgb.g}, ${priRgb.b}, 0.18)`);
        setToken('--md-sys-color-on-primary-container', priHex);
        setToken('--md-sys-color-secondary', hslToHex(hSec, satLow2, 75));
        setToken('--md-sys-color-secondary-container', hslToHex(hSec, satLow, 22));
        setToken('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 85));
        setToken('--md-sys-color-tertiary', hslToHex(hTert, satLow2, 75));
        setToken('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, 22));
        const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
        setToken('--md-sys-color-background', hslToHex(h, surfSat(5, surfFactor), B(7)));
        setToken('--md-sys-color-surface', hslToHex(h, surfSat(6, surfFactor), B(8)));
        setToken('--md-sys-color-surface-dim', hslToHex(h, surfSat(5, surfFactor), B(7)));
        setToken('--md-sys-color-surface-bright', hslToHex(h, surfSat(4, surfFactor), B(24)));
        setToken('--md-sys-color-surface-container-lowest', hslToHex(h, surfSat(5, surfFactor), B(5)));
        setToken('--md-sys-color-surface-container-low', hslToHex(h, surfSat(5, surfFactor), B(10)));
        setToken('--md-sys-color-surface-container', hslToHex(h, surfSat(6, surfFactor), B(13)));
        setToken('--md-sys-color-surface-container-high', hslToHex(h, surfSat(5, surfFactor), B(16)));
        setToken('--md-sys-color-surface-container-highest', hslToHex(h, surfSat(5, surfFactor), B(20)));
        setToken('--md-sys-color-on-surface', '#e2e2e9');
        setToken('--md-sys-color-on-surface-variant', '#c4c6d0');
        setToken('--md-sys-color-outline', '#8e9099');
        setToken('--md-sys-color-outline-variant', '#282a33');
      }
    }
  }

  function extractDominantColor(imgSrc) {
    return new Promise((resolve) => {
      if (!imgSrc) return resolve('#6750A4');
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 10;
        canvas.height = 10;
        ctx.drawImage(img, 0, 0, 10, 10);
        const data = ctx.getImageData(0, 0, 10, 10).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i+1]; b += data[i+2];
        }
        const count = data.length / 4;
        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);
        const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        resolve(hex);
      };
      img.onerror = () => resolve('#6750A4');
      img.src = imgSrc;
    });
  }

  let hasDrawnPausedFrame = false;
  let cachedPrimaryColor = '';
  let cachedDimColor = '';
  let animationFrameId = null;
  function refreshCachedThemeColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    cachedPrimaryColor = rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4';
    cachedDimColor = rootStyle.getPropertyValue('--md-sys-color-on-surface').trim() || '#E6E0E9';
    hasDrawnPausedFrame = false;
  }

  const coverAnalysisCache = new Map();
  // drop the oldest entries of an in-memory cache past n, so long sessions don't grow without end
  function capMap(m, n) { while (m.size > n) m.delete(m.keys().next().value); }

  function analyzeCover(imgSrc) {
    return new Promise((resolve) => {
      if (!imgSrc) {
        return resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
      }
      if (coverAnalysisCache.has(imgSrc)) {
        const cached = coverAnalysisCache.get(imgSrc);
        coverAnalysisCache.delete(imgSrc);
        coverAnalysisCache.set(imgSrc, cached);
        return resolve(cached);
      }

      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 48;
          canvas.height = 48;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 48, 48);
          const data = ctx.getImageData(0, 0, 48, 48).data;

          let totalLuminance = 0;
          let nonGraySatSum = 0;
          let nonGraySatCount = 0;

          const bins = Array.from({ length: 24 }, (_, i) => ({
            idx: i,
            centerHue: (i + 0.5) * 15,
            weight: 0,
            rSum: 0,
            gSum: 0,
            bSum: 0,
            count: 0
          }));

          let fallbackR = 0, fallbackG = 0, fallbackB = 0;
          const totalPixels = data.length / 4;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            fallbackR += r;
            fallbackG += g;
            fallbackB += b;

            const rN = r / 255;
            const gN = g / 255;
            const bN = b / 255;

            const lum = 0.2126 * rN + 0.7152 * gN + 0.0722 * bN;
            totalLuminance += lum;

            const max = Math.max(rN, gN, bN);
            const min = Math.min(rN, gN, bN);
            const d = max - min;
            const l = (max + min) / 2;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

            if (s >= 0.15) {
              nonGraySatSum += s;
              nonGraySatCount++;

              if (l >= 0.10 && l <= 0.90) {
                let hDeg = 0;
                if (d > 0) {
                  if (max === rN) {
                    hDeg = ((gN - bN) / d + (gN < bN ? 6 : 0)) * 60;
                  } else if (max === gN) {
                    hDeg = ((bN - rN) / d + 2) * 60;
                  } else {
                    hDeg = ((rN - gN) / d + 4) * 60;
                  }
                }
                const binIdx = Math.min(23, Math.max(0, Math.floor(hDeg / 15)));
                const bin = bins[binIdx];
                bin.weight += s;
                bin.rSum += r;
                bin.gSum += g;
                bin.bSum += b;
                bin.count++;
              }
            }
          }

          const meanLuminance = totalLuminance / totalPixels;
          const meanSaturation = nonGraySatCount > 0 ? (nonGraySatSum / nonGraySatCount) : 0;

          let bestBin = null;
          for (let i = 0; i < 24; i++) {
            if (bins[i].count > 0) {
              if (!bestBin || bins[i].weight > bestBin.weight) {
                bestBin = bins[i];
              }
            }
          }

          let accentHex = '';
          let accentR = 0, accentG = 0, accentB = 0;

          if (bestBin && bestBin.count > 0) {
            accentR = Math.round(bestBin.rSum / bestBin.count);
            accentG = Math.round(bestBin.gSum / bestBin.count);
            accentB = Math.round(bestBin.bSum / bestBin.count);
            accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
          } else {
            accentR = Math.round(fallbackR / totalPixels);
            accentG = Math.round(fallbackG / totalPixels);
            accentB = Math.round(fallbackB / totalPixels);
            accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
          }

          let bestBin2 = null;
          if (bestBin) {
            for (let i = 0; i < 24; i++) {
              if (bins[i].count > 0 && i !== bestBin.idx) {
                const diff = Math.abs(bins[i].centerHue - bestBin.centerHue);
                const dist = Math.min(diff, 360 - diff);
                if (dist >= 60) {
                  if (!bestBin2 || bins[i].weight > bestBin2.weight) {
                    bestBin2 = bins[i];
                  }
                }
              }
            }
          }

          let accent2Hex = '';
          if (bestBin2 && bestBin2.count > 0) {
            const r2 = Math.round(bestBin2.rSum / bestBin2.count);
            const g2 = Math.round(bestBin2.gSum / bestBin2.count);
            const b2 = Math.round(bestBin2.bSum / bestBin2.count);
            accent2Hex = '#' + [r2, g2, b2].map(x => x.toString(16).padStart(2, '0')).join('');
          } else {
            const hslAcc = rgbToHsl(accentR, accentG, accentB);
            const h2 = (hslAcc.h + 40) % 360;
            accent2Hex = hslToHex(h2, hslAcc.s, hslAcc.l);
          }

          const result = {
            accent: accentHex,
            accent2: accent2Hex,
            luminance: meanLuminance,
            saturation: meanSaturation
          };

          if (coverAnalysisCache.size >= 50) {
            const oldestKey = coverAnalysisCache.keys().next().value;
            coverAnalysisCache.delete(oldestKey);
          }
          coverAnalysisCache.set(imgSrc, result);
          resolve(result);
        } catch (err) {
          resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
        }
      };
      img.onerror = () => {
        resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
      };
      img.src = imgSrc;
    });
  }

  let activeMeshLayer = 'a';
  let lastMeshKey = '';
  let lastMeshArgs = null;
  let meshCoverColors = null;

  function mixHex(a, b, t) {
    const c1 = hexToRgb(a);
    const c2 = hexToRgb(b);
    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const bl = Math.round(c1.b + (c2.b - c1.b) * t);
    return '#' + [r, g, bl].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  }

  function colorToHex(c) {
    if (!c) return '#9E9E9E';
    if (typeof c === 'string' && c.startsWith('#')) return c;
    const match = typeof c === 'string' && c.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (match) {
      const r = parseInt(match[1], 10);
      const g = parseInt(match[2], 10);
      const b = parseInt(match[3], 10);
      return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
    }
    return c;
  }

  async function refreshMeshCover() {
    if (!getAdv('mesh_cover_color', false) || !state.currentTrack) {
      meshCoverColors = null;
      return;
    }
    const trackBefore = state.currentTrack;
    const thumbUrl = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail) || '';
    if (!thumbUrl) {
      meshCoverColors = null;
      lastMeshKey = '';
      if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
      return;
    }
    try {
      const [a, b] = await getCoverDominantColors(thumbUrl);
      const currentUrl = (state.currentTrack && (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail)) || '';
      if (!state.currentTrack || (state.currentTrack !== trackBefore && state.currentTrack.id !== trackBefore?.id) || currentUrl !== thumbUrl) return;
      meshCoverColors = [colorToHex(a), colorToHex(b || a)];
      lastMeshKey = '';
      if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
    } catch (_) {}
  }

  let coverBgIdx = 0;
  let activeCoverBgUrl = '';

  function setCoverBg(url) {
    const enabled = getAdv('cover_bg', true);
    const layers = document.querySelectorAll('#cover-bg .cover-bg-layer');
    if (!enabled || !url) {
      activeCoverBgUrl = '';
      document.body.classList.remove('cover-bg-on');
      layers.forEach(l => l.classList.remove('on'));
      return;
    }

    activeCoverBgUrl = url;
    document.body.classList.add('cover-bg-on');

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      if (activeCoverBgUrl !== url) return;
      if (layers.length < 2) return;
      const nextIdx = 1 - coverBgIdx;
      const nextLayer = layers[nextIdx];
      const prevLayer = layers[coverBgIdx];

      nextLayer.style.backgroundImage = `url(${JSON.stringify(url)})`;
      nextLayer.classList.add('on');
      prevLayer.classList.remove('on');
      coverBgIdx = nextIdx;
    };
    img.src = url;
  }

  const fxItems = [];
  function registerFx(el, kind, viewEl) {
    if (!el || fxItems.some(i => i.el === el)) return;
    fxItems.push({ el, kind, view: viewEl || null, home: { parent: el.parentNode, next: el.nextSibling } });
    el.dataset.fx = kind;
  }
  function applyFxClip() {
    const free = document.body.classList.contains('no-clip-fx');
    const root = document.getElementById('fx-root');
    fxItems.forEach(i => {
      if (free) {
        if (root) root.appendChild(i.el);
        i.el.classList.add('fx-free');
      } else {
        if (i.home && i.home.parent) {
          i.home.parent.insertBefore(i.el, i.home.next && i.home.next.parentNode === i.home.parent ? i.home.next : null);
        }
        i.el.classList.remove('fx-free');
      }
    });
    updateFxVisibility();
  }
  function updateFxVisibility() {
    const free = document.body.classList.contains('no-clip-fx');
    fxItems.forEach(i => {
      const isHidden = (free && i.view && !i.view.classList.contains('active'));
      i.el.classList.toggle('fx-hidden', !!isHidden);
      i.el.style.display = '';
    });
  }

  function updateMeshGradient(accentHex, accent2Hex, mode) {
    lastMeshArgs = [accentHex, accent2Hex, mode];
    const meshA = document.getElementById('bg-mesh-a');
    const meshB = document.getElementById('bg-mesh-b');
    if (!meshA || !meshB) return;

    const isEnabled = getAdv('mesh_gradient', false) && (state.meshBrightness > 0);
    if (!isEnabled) {
      meshA.style.opacity = '0';
      meshB.style.opacity = '0';
      lastMeshKey = '';
      return;
    }

    let c1 = accentHex;
    let c2 = accent2Hex;
    const useCover = getAdv('mesh_cover_color', false);
    if (useCover && meshCoverColors) {
      c1 = meshCoverColors[0];
      c2 = meshCoverColors[1];
    }
    const followIntensity = getAdv('mesh_follow_intensity', true);
    if (followIntensity) {
      const k = Math.max(0, Math.min(1, (Number.isFinite(state.themeIntensity) ? state.themeIntensity : 100) / 100));
      c1 = mixHex(c1, '#9E9E9E', 1 - k);
      c2 = mixHex(c2, '#9E9E9E', 1 - k);
    }

    const meshKey = `${c1}_${c2}_${mode}_${state.meshBrightness}_${followIntensity}_${useCover}`;
    if (meshKey === lastMeshKey) return;
    lastMeshKey = meshKey;

    const rgb1 = hexToRgb(c1);
    const rgb2 = hexToRgb(c2);

    const brightnessScale = Math.max(0, Math.min(100, state.meshBrightness)) / 100;
    const a1 = (mode === 'light' ? 0.22 : 0.55) * brightnessScale;
    const a2 = (mode === 'light' ? 0.18 : 0.45) * brightnessScale;

    const accentRgba = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, ${a1})`;
    const accent2Rgba = `rgba(${rgb2.r}, ${rgb2.g}, ${rgb2.b}, ${a2})`;

    const gradient = `linear-gradient(to bottom, transparent 35%, var(--md-sys-color-background) 85%), ` +
      `radial-gradient(ellipse at var(--mesh-p1x, 20%) var(--mesh-p1y, 0%), ${accentRgba} 0%, transparent 70%), ` +
      `radial-gradient(ellipse at var(--mesh-p2x, 85%) var(--mesh-p2y, 5%), ${accent2Rgba} 0%, transparent 65%), ` +
      `var(--md-sys-color-background)`;

    const target = activeMeshLayer === 'a' ? meshB : meshA;
    const current = activeMeshLayer === 'a' ? meshA : meshB;

    target.style.background = gradient;
    target.style.opacity = '1';
    current.style.opacity = '0';

    const previewBg = document.getElementById('mesh-preview-bg');
    if (previewBg) {
      previewBg.style.background = gradient;
    }

    activeMeshLayer = activeMeshLayer === 'a' ? 'b' : 'a';
  }

  let currentEffectiveMode = state.themeMode === 'auto' ? 'dark' : state.themeMode;

  function relLuminance(hex) {
    const c = hexToRgb(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrastRatio(a, b) {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  function computeButtonColors(accentHex, mode) {
    const rgb = hexToRgb(accentHex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const s = hsl.s;
    const dark = mode === 'dark';
    let l = dark ? Math.min(74, Math.max(52, hsl.l)) : Math.min(46, Math.max(32, hsl.l));
    const lumAt = (L) => relLuminance(hslToHex(hsl.h, s, L));
    while (lumAt(l) > 0.42 && l > 26) l -= 1;
    const mid = lumAt(l);
    if (mid > 0.18 && mid < 0.23) {
      while (lumAt(l) > 0.18 && l > 22) l -= 1;
    }
    const bg = hslToHex(hsl.h, s, l);
    const bgLum = relLuminance(bg);
    const darkText = '#1B1B1F';
    const fg = contrastRatio(bgLum, 1) >= contrastRatio(bgLum, relLuminance(darkText)) ? '#FFFFFF' : darkText;
    const hover = hslToHex(hsl.h, s, Math.max(0, Math.min(100, l + (dark ? 5 : -5))));
    return { bg, fg, hover, bgLum };
  }

  function applyButtonAccent(hexColor, mode, mono) {
    const themeAccent = document.documentElement.style.getPropertyValue('--md-sys-color-primary')?.trim() || hexColor || '#6750A4';
    const isMono = mono !== undefined ? mono : (state.themeIntensity < 8);
    const c = isMono ? (mode === 'light' ? { bg: '#111111', fg: '#FFFFFF', hover: '#333333' } : { bg: '#FFFFFF', fg: '#121212', hover: '#E6E6E6' }) : computeButtonColors(themeAccent, mode);
    const root = document.documentElement.style;
    root.setProperty('--btn-primary-bg', c.bg);
    root.setProperty('--btn-primary-fg', c.fg);
    root.setProperty('--btn-primary-hover', c.hover);
  }

  // see-through panels (UI opacity below 100%) read badly on a light theme: go solid while it is light, then back
  let lastEffectiveMode = null;
  function onEffectiveModeChanged(mode) {
    if (lastEffectiveMode === null || !document.getElementById('slider-ui-alpha')) {
      // first paint on a light theme with the default opacity: start solid
      if (mode === 'light' && localStorage.getItem('muriel_ui_alpha') === null && document.getElementById('slider-ui-alpha')) {
        localStorage.setItem('muriel_ui_alpha', '100');
        document.documentElement.style.setProperty('--ui-alpha', '100%');
        document.getElementById('slider-ui-alpha').value = 100;
        localStorage.setItem('muriel_ui_alpha_light_prev', '20');
        localStorage.setItem('muriel_ui_alpha_light_auto', '100');
      }
      lastEffectiveMode = mode;
      return;
    }
    if (lastEffectiveMode !== mode) {
      if (mode === 'light') {
        const now = currentUiAlpha();
        if (now < 100) {
          localStorage.setItem('muriel_ui_alpha_light_prev', String(now));
          localStorage.setItem('muriel_ui_alpha_light_auto', '100');
          setUiAlphaViaSlider(100);
        }
      } else if (lastEffectiveMode === 'light') {
        const auto = localStorage.getItem('muriel_ui_alpha_light_auto'), prev = localStorage.getItem('muriel_ui_alpha_light_prev');
        if (auto !== null && prev !== null && currentUiAlpha() === Number(auto)) setUiAlphaViaSlider(Number(prev));
        localStorage.removeItem('muriel_ui_alpha_light_auto');
        localStorage.removeItem('muriel_ui_alpha_light_prev');
      }
      lastEffectiveMode = mode;
    }
  }

  function applyTheme(hexColor, mode, intensity = state.themeIntensity, brightness = state.themeBrightness, accent2 = null, isAuto = false) {
    currentEffectiveMode = mode;
    generateM3Palette(hexColor, mode, intensity, brightness);
    const themeAccent = document.documentElement.style.getPropertyValue('--md-sys-color-primary')?.trim() || hexColor;
    applyButtonAccent(themeAccent, mode, intensity < 8);
    document.body.classList.toggle('theme-light', mode === 'light');
    document.body.classList.toggle('theme-dark', mode === 'dark');
    document.body.classList.toggle('intensity-zero', state.themeIntensity < 8);
    onEffectiveModeChanged(mode);
    if (el.themeSwatches) {
      el.themeSwatches.forEach(sw => sw.classList.toggle('active', !!(state.themeAccent && sw.dataset.color && sw.dataset.color.toLowerCase() === state.themeAccent.toLowerCase())));
    }
    // not while the picker is open: that reset the picker under the pointer
    if (el.customColorInput && document.activeElement !== el.customColorInput) el.customColorInput.value = hexColor;

    const rgb = hexToRgb(hexColor);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    if (el.sliderHue) el.sliderHue.value = hsl.h;
    if (el.valHue) el.valHue.textContent = hsl.h + '°';

    if (el.sliderIntensity) {
      el.sliderIntensity.disabled = isAuto;
      el.sliderIntensity.value = intensity;
      const parent = el.sliderIntensity.closest('.setting-item');
      if (parent) parent.classList.toggle('is-disabled', isAuto);
    }
    if (el.valIntensity) el.valIntensity.textContent = intensity + '%';

    if (el.sliderBrightness) {
      el.sliderBrightness.disabled = isAuto;
      el.sliderBrightness.value = brightness;
      const parent = el.sliderBrightness.closest('.setting-item');
      if (parent) parent.classList.toggle('is-disabled', isAuto);
    }
    if (el.valBrightness) el.valBrightness.textContent = brightness + '%';

    let resolvedAccent2 = accent2;
    if (!resolvedAccent2) {
      const h2 = (hsl.h + 40) % 360;
      resolvedAccent2 = hslToHex(h2, hsl.s, hsl.l);
    }

    const mono = intensity < 8;
    updateMeshGradient(mono ? '#9E9E9E' : hexColor, mono ? '#757575' : resolvedAccent2, mode);
    refreshCachedThemeColors();
  }

  // Auto-theme palettes touch dozens of CSS vars at once; a root view transition
  // crossfades the whole old/new palette instead of snapping.
  function smoothThemeSwap(fn) {
    if (!document.startViewTransition || document.hidden || document.body.classList.contains('perf') || matchMedia('(prefers-reduced-motion: reduce)').matches) return fn();
    const root = document.documentElement;
    root.classList.add('theme-vt');
    const vt = document.startViewTransition(fn);
    vt.finished.finally(() => root.classList.remove('theme-vt'));
  }

  function updateThemeFromState() {
    if (state.themeMode === 'auto') {
      const coverThumb = (state.currentTrack && (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : state.currentTrack.thumbnail)) || '';
      if (coverThumb) {
        analyzeCover(coverThumb).then(analysis => {
          if (state.themeMode !== 'auto') return;

          const derivedMode = analysis.luminance > 0.58 ? 'light' : 'dark';
          const derivedIntensity = Math.min(85, Math.max(20, Math.round(analysis.saturation * 100 * 0.9)));
          let derivedBrightness;
          if (derivedMode === 'dark') {
            derivedBrightness = Math.min(60, Math.max(40, Math.round(40 + (Math.min(0.58, analysis.luminance) / 0.58) * 20)));
          } else {
            const normLum = Math.max(0, Math.min(1, (analysis.luminance - 0.58) / (1 - 0.58)));
            derivedBrightness = Math.min(75, Math.max(55, Math.round(55 + normLum * 20)));
          }

          smoothThemeSwap(() => applyTheme(analysis.accent, derivedMode, derivedIntensity, derivedBrightness, analysis.accent2, true));
        });
      } else {
        applyTheme(state.themeAccent, 'dark', state.themeIntensity, state.themeBrightness, null, true);
      }
    } else {
      applyTheme(state.themeAccent, state.themeMode, state.themeIntensity, state.themeBrightness, null, false);
    }

    if (el.themeModeBtns) {
      el.themeModeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.themeMode === state.themeMode));
    }
  }

  const el = {
    btnMinimize: document.getElementById('btn-minimize'),
                          btnMaximize: document.getElementById('btn-maximize'),
                          btnClose: document.getElementById('btn-close'),

                          searchInput: document.getElementById('search-input'),
                          searchClearBtn: document.getElementById('search-clear-btn'),
                          searchIconBtn: document.getElementById('search-icon-btn'),
                          platformYt: document.getElementById('platform-yt'),
                          platformYtm: document.getElementById('platform-ytm'),
                          platformSc: document.getElementById('platform-sc'),

                          navActiveIndicator: document.getElementById('nav-active-indicator'),
                          navDiscover: document.getElementById('nav-discover'),
                          navFavorites: document.getElementById('nav-favorites'),
                          navAlbums: document.getElementById('nav-albums'),
                          navLocal: document.getElementById('nav-local'),
                          navHistory: document.getElementById('nav-history'),
                          navQueue: document.getElementById('nav-queue'),
                          navSettings: document.getElementById('nav-settings'),
                          favoritesCount: document.getElementById('favorites-count'),
                          localCount: document.getElementById('local-count'),
                          queueCount: document.getElementById('queue-count'),

                          presetsContainer: document.getElementById('presets-container'),
                          btnSavePresetDialog: document.getElementById('btn-save-preset-dialog'),
                          savePresetModal: document.getElementById('save-preset-modal'),
                          newPresetName: document.getElementById('new-preset-name'),
                          btnCancelPreset: document.getElementById('btn-cancel-preset'),
                          btnConfirmSavePreset: document.getElementById('btn-confirm-save-preset'),

                          renamePresetModal: document.getElementById('rename-preset-modal'),
                          renamePresetName: document.getElementById('rename-preset-name'),
                          btnCancelRenamePreset: document.getElementById('btn-cancel-rename-preset'),
                          btnConfirmRenamePreset: document.getElementById('btn-confirm-rename-preset'),

                          playlistsList: document.getElementById('playlists-list'),
                          btnNewPlaylist: document.getElementById('btn-new-playlist'),

                          viewDiscover: document.getElementById('view-discover'),
                          viewFavorites: document.getElementById('view-favorites'),
                          viewAlbums: document.getElementById('view-albums'),
                          viewLocal: document.getElementById('view-local'),
                          viewHistory: document.getElementById('view-history'),
                          viewQueue: document.getElementById('view-queue'),
                          viewPlaylistDetail: document.getElementById('view-playlist-detail'),
                          viewAlbum: document.getElementById('view-album'),
                          viewArtist: document.getElementById('view-artist'),
                          viewSettings: document.getElementById('view-settings'),

                          btnBackAlbum: document.getElementById('btn-back-album'),
                          albumDetailCover: document.getElementById('album-detail-cover'),
                          albumDetailTitle: document.getElementById('album-detail-title'),
                          albumDetailArtist: document.getElementById('album-detail-artist'),
                          albumDetailCount: document.getElementById('album-detail-count'),
                          btnPlayAlbum: document.getElementById('btn-play-album'),
                          albumTracksList: document.getElementById('album-tracks-list'),

                          artistHero: document.getElementById('artist-hero'),
                          artistHeroImg: document.getElementById('artist-hero-img'),
                          artistFansLine: document.getElementById('artist-fans-line'),
                          btnBackArtist: document.getElementById('btn-back-artist'),
                          artistVerifiedBadge: document.getElementById('artist-verified-badge'),
                          artistProfileName: document.getElementById('artist-profile-name'),
                          artistProfileBio: document.getElementById('artist-profile-bio'),
                          btnPlayArtistTracks: document.getElementById('btn-play-artist-tracks'),
                          artistTracksCount: document.getElementById('artist-tracks-count'),
                          artistTracksList: document.getElementById('artist-tracks-list'),

                          discoverEmpty: document.getElementById('discover-empty'),
                          searchResultsContainer: document.getElementById('search-results-container'),
                          searchTracksList: document.getElementById('search-tracks-list'),
                          suggestionChips: document.getElementById('suggestion-chips'),

                          favoritesTracksList: document.getElementById('favorites-tracks-list'),
                          favoritesSearchInput: document.getElementById('favorites-search-input'),
                          favoritesSort: document.getElementById('favorites-sort'),
                          playlistSearchInput: document.getElementById('playlist-search-input'),
                          playlistSort: document.getElementById('playlist-sort'),
                          favoritesSubtitle: document.getElementById('favorites-subtitle'),
                          localTracksList: document.getElementById('local-tracks-list'),
                          localSearchInput: document.getElementById('local-search-input'),
                          localSubtitle: document.getElementById('local-subtitle'),
                          btnAddLocalFiles: document.getElementById('btn-add-local-files'),
                          btnAddLocalFilesEmpty: document.getElementById('btn-add-local-files-empty'),
                          historyTracksList: document.getElementById('history-tracks-list'),
                          btnClearHistory: document.getElementById('btn-clear-history'),
                          queueTracksList: document.getElementById('queue-tracks-list'),
                          btnClearQueue: document.getElementById('btn-clear-queue'),
                          playlistTracksList: document.getElementById('playlist-tracks-list'),
                          playlistDetailTitle: document.getElementById('playlist-detail-title'),
                          playlistDetailCount: document.getElementById('playlist-detail-count'),
                          btnBackPlaylists: document.getElementById('btn-back-playlists'),
                          btnPlayPlaylist: document.getElementById('btn-play-playlist'),
                          btnDeletePlaylist: document.getElementById('btn-delete-playlist'),

                          rightPanel: document.getElementById('right-panel'),
                          btnCloseRightPanel: document.getElementById('btn-close-right-panel'),
                          btnToggleLyricsPanel: document.getElementById('btn-toggle-lyrics-panel'),
                          btnLyricsMode: document.getElementById('btn-lyrics-mode'),
                          coverContainer: document.getElementById('cover-container'),
                          rightPanelArtworkBox: document.getElementById('right-panel-artwork-box'),
                          rightPanelCover: document.getElementById('right-panel-cover'),
                          rightPanelFallback: document.getElementById('right-panel-fallback'),
                          rightPanelTitle: document.getElementById('right-panel-title'),
                          rightPanelArtist: document.getElementById('right-panel-artist'),
                          lyricsStatus: document.getElementById('lyrics-status'),
                          lyricsContainer: document.getElementById('lyrics-container'),
                          lyricsHint: document.getElementById('lyrics-hint'),
                          btnTranslateLyrics: document.getElementById('btn-translate-lyrics'),
                          btnTrEnabled: document.getElementById('btn-tr-enabled'),
                          selectTrLang: document.getElementById('select-tr-lang'),
                          btnTrAuto: document.getElementById('btn-tr-auto'),
                          btnTvKaraoke: document.getElementById('btn-tv-karaoke'),
                          tvKaraoke: document.getElementById('tv-karaoke'),
                          tvBg: document.getElementById('tv-bg'),
                          tvCover: document.getElementById('tv-cover'),
                          tvKaraokeContent: document.getElementById('tv-karaoke-content'),
                          tvKaraokeClose: document.getElementById('btn-close-tv-karaoke'),
                          tvKaraokeTitle: document.getElementById('tv-karaoke-title'),
                          tvKaraokeArtist: document.getElementById('tv-karaoke-artist'),
                          btnTvkFav: document.getElementById('btn-tvk-fav'),
                          tvkFavIcon: document.getElementById('tvk-fav-icon'),
                          btnTvkShuffle: document.getElementById('btn-tvk-shuffle'),
                          btnTvkRepeat: document.getElementById('btn-tvk-repeat'),
                          tvkVolumeSlider: document.getElementById('tvk-volume-slider'),

                          playbar: document.getElementById('playbar'),
                          playbarArtwork: document.getElementById('playbar-artwork'),
                          artworkFallback: document.getElementById('artwork-fallback'),
                          playbarTitle: document.getElementById('playbar-title'),
                          playbarArtist: document.getElementById('playbar-artist'),
                          btnToggleFav: document.getElementById('btn-toggle-fav'),
                          favIcon: document.getElementById('fav-icon'),
                          btnShuffle: document.getElementById('btn-shuffle'),
                          btnPrev: document.getElementById('btn-prev'),
                          btnPlayPause: document.getElementById('btn-play-pause'),
                          playIcon: document.getElementById('play-icon'),
                          pauseIcon: document.getElementById('pause-icon'),
                          playbarSpinner: document.getElementById('playbar-spinner'),
                          btnNext: document.getElementById('btn-next'),
                          btnRepeat: document.getElementById('btn-repeat'),

                          timeCurrent: document.getElementById('time-current'),
                          timeDuration: document.getElementById('time-duration'),
                          scrubberTrack: document.getElementById('scrubber-track'),

                          visualizerCanvas: document.getElementById('visualizer-canvas'),
                          btnOpenSettings: document.getElementById('btn-open-settings'),
                          btnOpenVisualSettings: document.getElementById('btn-open-visual-settings'),
                          settingsModifiedDot: document.getElementById('settings-modified-dot'),
                          btnVolumeMute: document.getElementById('btn-volume-mute'),
                          volumeIcon: document.getElementById('volume-icon'),
                          volumeMutedIcon: document.getElementById('volume-muted-icon'),
                          volumeSlider: document.getElementById('volume-slider'),

                          downloadModal: document.getElementById('download-modal'),
                          btnCloseDownloadModal: document.getElementById('btn-close-download-modal'),
                          btnCancelDownload: document.getElementById('btn-cancel-download'),
                          btnConfirmDownload: document.getElementById('btn-confirm-download'),
                          downloadSpinner: document.getElementById('download-spinner'),
                          downloadBtnText: document.getElementById('download-btn-text'),
                          downloadPreviewThumb: document.getElementById('download-preview-thumb'),
                          downloadPreviewFallback: document.getElementById('download-preview-fallback'),
                          downloadPreviewTitle: document.getElementById('download-preview-title'),
                          downloadPreviewArtist: document.getElementById('download-preview-artist'),
                          btnPlaybarMore: document.getElementById('btn-playbar-more'),

                          audioSettingsModal: document.getElementById('audio-settings-modal'),
                          btnCloseSettings: document.getElementById('btn-close-settings'),
                          sleepTimerStatus: document.getElementById('sleep-timer-status'),
                          btnResetAudio: document.getElementById('btn-reset-audio'),
                          commandPalette: document.getElementById('command-palette'),
                          commandPaletteInput: document.getElementById('command-palette-input'),
                          commandPaletteResults: document.getElementById('command-palette-results'),
                          btnDedupePlaylist: document.getElementById('btn-dedupe-playlist'),
                          btnDedupePlaylistLabel: document.getElementById('btn-dedupe-playlist-label'),

                          btnToggleHqAudio: document.getElementById('toggle-hq-audio'),
                          hqEnhancerCard: document.querySelector('.hq-enhancer-card'),
                          hqPanelWrapper: document.getElementById('hq-panel-wrapper'),
                          hqEngineSelect: document.getElementById('hq-engine-select'),
                          sliderHqVocal: document.getElementById('slider-hq-vocal'),
                          valHqVocal: document.getElementById('val-hq-vocal'),
                          sliderHqAir: document.getElementById('slider-hq-air'),
                          valHqAir: document.getElementById('val-hq-air'),
                          sliderHqBass: document.getElementById('slider-hq-bass'),
                          valHqBass: document.getElementById('val-hq-bass'),
                          hqPresetChips: document.querySelectorAll('.hq-preset-chip'),

                          sliderSpeed: document.getElementById('slider-speed'),
                          valSpeed: document.getElementById('val-speed'),
                          sliderSpeedPitch: document.getElementById('slider-speed-pitch'),
                          valSpeedPitch: document.getElementById('val-speed-pitch'),
                          sliderPitch: document.getElementById('slider-pitch'),
                          valPitch: document.getElementById('val-pitch'),
                          sliderReverb: document.getElementById('slider-reverb'),
                          valReverb: document.getElementById('val-reverb'),
                          sliderDistortion: document.getElementById('slider-distortion'),
                          valDistortion: document.getElementById('val-distortion'),
                          sliderGain: document.getElementById('slider-gain'),
                          valGain: document.getElementById('val-gain'),
                          sliderEcho: document.getElementById('slider-echo'),
                          valEcho: document.getElementById('val-echo'),
                          sliderEqLow: document.getElementById('slider-eq-low'),
                          valEqLow: document.getElementById('val-eq-low'),
                          sliderEqMid: document.getElementById('slider-eq-mid'),
                          valEqMid: document.getElementById('val-eq-mid'),
                          sliderEqHigh: document.getElementById('slider-eq-high'),
                          valEqHigh: document.getElementById('val-eq-high'),
                          eqBands: document.getElementById('eq-bands'),
                          btnResetEqBands: document.getElementById('btn-reset-eq-bands'),

                          sliderScale: document.getElementById('settings-slider-scale') || document.getElementById('slider-scale'),
                          valScale: document.getElementById('settings-val-scale') || document.getElementById('val-scale'),
                          sliderFontScale: document.getElementById('slider-font-scale'),
                          valFontScale: document.getElementById('val-font-scale'),
                          sliderCornerRadius: document.getElementById('slider-corner-radius'),
                          valCornerRadius: document.getElementById('val-corner-radius'),
                          sliderUiAlpha: document.getElementById('slider-ui-alpha'),
                          valUiAlpha: document.getElementById('val-ui-alpha'),
                          btnResetUiAlpha: document.getElementById('btn-reset-ui-alpha'),
                          sliderTextAlpha: document.getElementById('slider-text-alpha'),
                          valTextAlpha: document.getElementById('val-text-alpha'),
                          btnResetTextAlpha: document.getElementById('btn-reset-text-alpha'),
                          themeModeBtns: document.querySelectorAll('.theme-mode-btn[data-theme-mode]'),
                          themeSwatches: document.querySelectorAll('.theme-swatch'),
                          customColorInput: document.getElementById('settings-custom-color-input'),
                          sliderHue: document.getElementById('slider-theme-hue'),
                          valHue: document.getElementById('val-theme-hue'),
                          sliderIntensity: document.getElementById('slider-theme-intensity'),
                          valIntensity: document.getElementById('val-theme-intensity'),
                          sliderBrightness: document.getElementById('slider-theme-brightness'),
                          valBrightness: document.getElementById('val-theme-brightness'),

                          visualSettingsModal: document.getElementById('visual-settings-modal'),
                          btnCloseVisualSettings: document.getElementById('btn-close-visual-settings'),
                          btnResetVfx: document.getElementById('btn-reset-vfx'),

                          createPlaylistModal: document.getElementById('create-playlist-modal'),
                          newPlaylistInput: document.getElementById('new-playlist-input'),
                          btnCancelNewPlaylist: document.getElementById('btn-cancel-new-playlist'),
                          btnConfirmNewPlaylist: document.getElementById('btn-confirm-new-playlist'),

                          addToPlaylistModal: document.getElementById('add-to-playlist-modal'),
                          playlistPickList: document.getElementById('playlist-pick-list'),
                          btnCancelAddPlaylist: document.getElementById('btn-cancel-add-playlist'),

                          nativeAudio: document.getElementById('native-audio'),
                          trackLoadingOverlay: document.getElementById('track-loading-overlay'),
                          trackLoadingTitle: document.getElementById('track-loading-title'),
                          trackLoadingSub: document.getElementById('track-loading-sub'),

                          btnAddCustomLyrics: document.getElementById('btn-add-custom-lyrics'),
                          btnSyncLyrics: document.getElementById('btn-sync-lyrics'),
                          customLyricsModal: document.getElementById('custom-lyrics-modal'),
                          customLyricsTextarea: document.getElementById('custom-lyrics-textarea'),
                          customLyricsTrackTitle: document.getElementById('custom-lyrics-track-title'),
                          customLyricsTrackArtist: document.getElementById('custom-lyrics-track-artist'),
                          btnCloseCustomLyrics: document.getElementById('btn-close-custom-lyrics'),
                          btnCancelCustomLyrics: document.getElementById('btn-cancel-custom-lyrics'),
                          btnSaveCustomLyrics: document.getElementById('btn-save-custom-lyrics'),
                          syncModeOverlay: document.getElementById('sync-mode-overlay'),
                          syncModeLyrics: document.getElementById('sync-mode-lyrics'),
                          syncProgressText: document.getElementById('sync-progress-text'),
                          btnRestartSync: document.getElementById('btn-restart-sync'),
                          btnSaveSync: document.getElementById('btn-save-sync'),
                          btnCancelSync: document.getElementById('btn-cancel-sync'),

                          btnEditCurrentTrack: document.getElementById('btn-edit-current-track'),
                          renameTrackModal: document.getElementById('rename-track-modal'),
                          inputRenameTitle: document.getElementById('rename-track-title'),
                          inputRenameArtist: document.getElementById('rename-track-artist'),
                          btnCancelRenameTrack: document.getElementById('btn-cancel-rename-track'),
                          btnConfirmRenameTrack: document.getElementById('btn-confirm-rename-track'),

                          btnRefreshVibe: document.getElementById('btn-refresh-vibe')
  };

  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    if (slider) {
      slider.min = -50;
      slider.max = 50;
      slider.value = state.hqSettings[type.toLowerCase()];
    }
  });

  if (el.sliderScale) el.sliderScale.value = state.uiScale;
  if (el.valScale) el.valScale.textContent = `${state.uiScale}%`;

  const savedFontScale = localStorage.getItem('muriel_font_scale') || '100';
  const fontVal = parseInt(savedFontScale, 10) || 100;
  if (el.sliderFontScale) el.sliderFontScale.value = fontVal.toString();
  if (el.valFontScale) el.valFontScale.textContent = `${fontVal}%`;
  document.documentElement.style.setProperty('--font-scale', ((fontVal / 100) * 0.95 * 1.25).toString());

  const savedRadius = localStorage.getItem('muriel_corner_radius') || '16';
  if (el.sliderCornerRadius) el.sliderCornerRadius.value = savedRadius;
  if (el.valCornerRadius) el.valCornerRadius.textContent = savedRadius === '16' ? 'Default' : `${savedRadius}px`;
  document.documentElement.style.setProperty('--md-shape-corner-l', `${savedRadius}px`);
  document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, parseInt(savedRadius) - 4)}px`);

  applyReducedMotionSetting();

  const savedBannerBlur = parseInt(localStorage.getItem('muriel_banner_blur') || '3', 10);
  const savedBannerOpacity = parseInt(localStorage.getItem('muriel_banner_opacity') || '100', 10);
  const savedBannerFade = parseInt(localStorage.getItem('muriel_banner_fade') || '38', 10);
  const savedBannerFit = localStorage.getItem('muriel_banner_fit') || 'zoom';

  document.documentElement.style.setProperty('--banner-blur', `${savedBannerBlur}px`);
  document.documentElement.style.setProperty('--banner-opacity', `${savedBannerOpacity / 100}`);
  document.documentElement.style.setProperty('--banner-fade-base', `${savedBannerFade}%`);
  document.documentElement.style.setProperty('--banner-fade-end', `${savedBannerFade}%`);
  applyBannerFit(savedBannerFit);

  function applyUiOpacity() {
    const rawUi = parseInt(localStorage.getItem('muriel_ui_alpha') || '20', 10);
    const rawText = parseInt(localStorage.getItem('muriel_text_alpha') || '100', 10);
    const uiAlpha = Math.max(20, Math.min(100, isNaN(rawUi) ? 100 : rawUi));
    const textAlpha = Math.max(1, Math.min(100, isNaN(rawText) ? 100 : rawText));

    document.documentElement.style.setProperty('--ui-alpha', `${uiAlpha}%`);
    document.documentElement.style.setProperty('--text-alpha', `${textAlpha}%`);

    if (el.sliderUiAlpha) el.sliderUiAlpha.value = uiAlpha;
    if (el.valUiAlpha) el.valUiAlpha.textContent = `${uiAlpha}%`;
    if (el.sliderTextAlpha) el.sliderTextAlpha.value = textAlpha;
    if (el.valTextAlpha) el.valTextAlpha.textContent = `${textAlpha}%`;
  }

  applyUiOpacity();

  updateThemeFromState();

  if (state.themeMode !== 'auto') {
    if (el.sliderIntensity) el.sliderIntensity.value = state.themeIntensity;
    if (el.valIntensity) el.valIntensity.textContent = state.themeIntensity + '%';
    if (el.sliderBrightness) el.sliderBrightness.value = state.themeBrightness;
    if (el.valBrightness) el.valBrightness.textContent = state.themeBrightness + '%';
  }

  const railDrawer = document.getElementById('rail-drawer');
  const sidebarEl = document.querySelector('.sidebar');
  const btnTogglePresets = document.getElementById('btn-toggle-presets-drawer');
  const btnTogglePlaylists = document.getElementById('btn-toggle-playlists-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-rail-drawer');
  const sectionPresets = document.getElementById('drawer-section-presets');
  const sectionPlaylists = document.getElementById('drawer-section-playlists');
  const drawerTitle = document.getElementById('rail-drawer-title');

  let openDrawerState = null;
  let activeDrawerMode = null;
  let railDrawerCloseTimeout = null;

  function applyDrawerState(triggerBtn) {
    if (!railDrawer) return;

    if (!openDrawerState) {
      if (activeDrawerMode !== null) {
        if (sidebarEl) sidebarEl.classList.remove('has-drawer-open');
        if (btnTogglePresets) btnTogglePresets.classList.remove('active');
        if (btnTogglePlaylists) btnTogglePlaylists.classList.remove('active');
        activeDrawerMode = null;
        if (railDrawerCloseTimeout) {
          clearTimeout(railDrawerCloseTimeout);
          railDrawerCloseTimeout = null;
        }
        railDrawer.classList.remove('open');
        railDrawerCloseTimeout = setTimeout(() => {
          railDrawer.classList.add('hidden');
          railDrawerCloseTimeout = null;
        }, 200);
      }
    } else {
      const isPresets = openDrawerState === 'presets';
      const trigger = triggerBtn || (isPresets ? btnTogglePresets : btnTogglePlaylists);

      if (btnTogglePresets) btnTogglePresets.classList.toggle('active', isPresets);
      if (btnTogglePlaylists) btnTogglePlaylists.classList.toggle('active', !isPresets);
      railDrawer.classList.toggle('drawer-presets-mode', isPresets);

      if (activeDrawerMode === null) {
        activeDrawerMode = openDrawerState;
        if (railDrawerCloseTimeout) {
          clearTimeout(railDrawerCloseTimeout);
          railDrawerCloseTimeout = null;
        }
        railDrawer.classList.remove('hidden');
        void railDrawer.offsetWidth;
        railDrawer.classList.add('open');
        if (sectionPresets) sectionPresets.style.display = isPresets ? 'flex' : 'none';
        if (sectionPlaylists) sectionPlaylists.style.display = isPresets ? 'none' : 'flex';
        if (drawerTitle) drawerTitle.textContent = isPresets ? 'Presets' : 'Playlists';
        if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
        if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
        if (sidebarEl) sidebarEl.classList.add('has-drawer-open');
        if (isPresets) {
          renderPresets();
          requestAnimationFrame(updatePresetsFade);
        } else {
          renderPlaylistsList();
        }
      } else if (activeDrawerMode !== openDrawerState) {
        activeDrawerMode = openDrawerState;
        const outgoing = isPresets ? sectionPlaylists : sectionPresets;
        const incoming = isPresets ? sectionPresets : sectionPlaylists;

        if (outgoing) outgoing.classList.add('section-switching-out');
        setTimeout(() => {
          if (outgoing) {
            outgoing.style.display = 'none';
            outgoing.classList.remove('section-switching-out');
          }
          if (drawerTitle) drawerTitle.textContent = isPresets ? 'Presets' : 'Playlists';
          railDrawer.classList.toggle('drawer-presets-mode', isPresets);
          if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
          if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
          if (incoming) {
            incoming.style.display = 'flex';
            incoming.classList.add('section-switching-in');
            setTimeout(() => incoming.classList.remove('section-switching-in'), 200);
            if (isPresets) {
              renderPresets();
              requestAnimationFrame(updatePresetsFade);
            } else {
              renderPlaylistsList();
            }
          }
        }, 120);
      }
    }
  }

  function openDrawer(mode, triggerBtn) {
    openDrawerState = mode;
    applyDrawerState(triggerBtn);
  }

  function closeDrawer() {
    openDrawerState = null;
    applyDrawerState();
  }

  if (btnTogglePresets) {
    btnTogglePresets.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'presets' ? null : 'presets';
      applyDrawerState(btnTogglePresets);
    });
  }

  if (btnTogglePlaylists) {
    btnTogglePlaylists.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'playlists' ? null : 'playlists';
      applyDrawerState(btnTogglePlaylists);
    });
  }

  if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener('click', () => closeDrawer());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDrawerState) closeDrawer();
  });

  const resumeAudioOnce = () => {
    initAudioContext();
    document.removeEventListener('click', resumeAudioOnce);
    document.removeEventListener('keydown', resumeAudioOnce);
  };
  document.addEventListener('click', resumeAudioOnce);
  document.addEventListener('keydown', resumeAudioOnce);

  document.addEventListener('click', (e) => {
    if (openDrawerState && railDrawer) {
      if (!railDrawer.contains(e.target) &&
        (!btnTogglePresets || !btnTogglePresets.contains(e.target)) &&
        (!btnTogglePlaylists || !btnTogglePlaylists.contains(e.target))) {
        closeDrawer();
      }
    }
  });

  const PRESS_MIN = 180;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('button, .chip-btn, .mix-card, .track-row, .nav-item, .rail-icon-btn, .preset-chip');
    if (!el) return;
    el.classList.add('pressed');
    const t0 = performance.now();
    const release = () => {
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      setTimeout(() => el.classList.remove('pressed'), Math.max(0, PRESS_MIN - (performance.now() - t0)));
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }, true);

  const RIPPLE_SEL = '.btn-pill-primary, .btn-outline-pill, .btn-icon-pill, .chip-btn, .control-btn, .rail-icon-btn, .preset-chip, .theme-mode-btn, .nav-item, .settings-nav-btn, .audio-tab, .titlebar-btn, .mix-card, .track-row';
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.body.classList.contains('perf')) return;
    const el = e.target.closest(RIPPLE_SEL);
    if (!el || el.disabled) return;
    let host = el.querySelector(':scope > .ripple-host');
    if (!host) {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      host = document.createElement('span'); host.className = 'ripple-host'; el.appendChild(host);
    }
    const r = el.getBoundingClientRect();
    const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
    const d = document.createElement('span'); d.className = 'ripple';
    d.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    host.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
  }, true);

  // Holding a finger on a song opens its menu. iOS never sends 'contextmenu' for a held finger, and
  // Android sends it mid-hold, where it fights hold-to-reorder, so the menu opens on release instead.
  const TOUCH_HOLD_MS = 450;
  (() => {
    let hold = null;
    const end = () => {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold.row.classList.remove('is-held');
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', cancel, true);
      hold = null;
    };
    const openMenu = (h) => {
      // swallow the click this release turns into, it would start the song
      const swallow = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, true);
      setTimeout(() => document.removeEventListener('click', swallow, true), 400);
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: h.x, clientY: h.y });
      ev.murielHold = true;
      h.row.dispatchEvent(ev);
    };
    const move = (e) => {
      if (!hold || e.pointerId !== hold.id || Math.hypot(e.clientX - hold.x, e.clientY - hold.y) <= 8) return;
      hold.moved = true;
      if (!hold.fired) end();
    };
    const up = (e) => {
      if (!hold || e.pointerId !== hold.id) return;
      const h = hold; end();
      if (h.fired && !h.moved) openMenu(h);
    };
    // Android can cancel the pointer right after its own long-press event; that still counts as a hold
    const cancel = (e) => {
      if (!hold || e.pointerId !== hold.id) return;
      const h = hold; end();
      if (h.fired && h.native && !h.moved) openMenu(h);
    };
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const row = e.target.closest('.track-row');
      if (!row || e.target.closest('button, input, select, a')) return;
      end();
      hold = { row, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, fired: false, native: false };
      hold.timer = setTimeout(() => {
        if (!hold) return;
        hold.fired = true;
        row.classList.add('is-held');
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
      }, TOUCH_HOLD_MS);
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
      document.addEventListener('pointercancel', cancel, true);
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (!hold || e.murielHold || !e.target.closest || !e.target.closest('.track-row')) return;
      hold.native = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  })();

  function openTrackRenameDialog() {
    const currentTitle = state.currentTrack?.title || '';
    const currentArtist = state.currentTrack?.artist || '';

    if (el.inputRenameTitle) el.inputRenameTitle.value = currentTitle;
    if (el.inputRenameArtist) el.inputRenameArtist.value = currentArtist;
    if (el.renameTrackModal) openModal(el.renameTrackModal);
    if (el.inputRenameTitle) el.inputRenameTitle.focus();
  }

  if (el.btnEditCurrentTrack) el.btnEditCurrentTrack.addEventListener('click', openTrackRenameDialog);
  if (el.btnCancelRenameTrack) el.btnCancelRenameTrack.addEventListener('click', () => closeModal(el.renameTrackModal));

  if (el.btnConfirmRenameTrack) {
    el.btnConfirmRenameTrack.addEventListener('click', () => {
      const newTitle = el.inputRenameTitle ? el.inputRenameTitle.value.trim() || 'Untitled track' : 'Untitled track';
      const newArtist = el.inputRenameArtist ? el.inputRenameArtist.value.trim() || 'Unknown artist' : 'Unknown artist';

      // the artist's channel stays with the artist it came with, not with a name typed over it
      const artistChanged = !!state.currentTrack && state.currentTrack.artist !== newArtist;
      if (state.currentTrack) {
        state.currentTrack.title = newTitle;
        state.currentTrack.artist = newArtist;
        if (artistChanged) delete state.currentTrack.artistId;
      }

      updateNowPlayingUI(state.currentTrack);

      const updateArr = (arr) => {
        let updated = false;
        arr.forEach(t => {
          if (t.id === state.currentTrack?.id) {
            t.title = newTitle;
            t.artist = newArtist;
            if (artistChanged) delete t.artistId;
            updated = true;
          }
        });
        return updated;
      };

      if (updateArr(state.history)) localStorage.setItem('devsize_history', JSON.stringify(state.history));
      if (updateArr(state.favorites)) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      if (updateArr(state.queue)) renderQueueView();

      sendStateToServer();
      updateMediaSession();

      if (el.renameTrackModal) closeModal(el.renameTrackModal);
      showToast(Tm('Track info updated'), 'info');
    });
  }

  const audioEngine = new window.MurielAudioEngine();
  window.audioEngine = audioEngine;
  // Paused on a phone with the app in the background, the context is left running: a resume() there may not
  // settle until the app is opened again, so play from the lock screen or the notification stayed silent (#24)
  audioEngine.keepRunning = () => !!(document.hidden && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  let hlsInstance = null;
  animationFrameId = null;

  let levelAvgDb = -120;
  function normalizeEnabled() { return localStorage.getItem('muriel_audio_normalize') === '1'; }
  function resetLevelWatcher() { levelAvgDb = -120; if (audioEngine && audioEngine.setNormalizeGainDb) audioEngine.setNormalizeGainDb(0); }
  // the phone app has no Web Audio graph (see mobile-ui.js), so nothing to measure there
  const isPhoneApp = document.documentElement.classList.contains('is-mobile');
  // when to look up the next song: phones download it whole, so halfway through; the computer only needs
  // a stream URL (a few seconds of yt-dlp), so in the last 45 seconds (#16)
  function nextPrefetchDue(cur, dur) {
    if (!(dur > 0) || !(cur >= 0)) return false;
    return isPhoneApp ? cur / dur > 0.5 : dur - cur <= 45;
  }
  window.addEventListener('muriel:storage-full', () => showToast(Tm('Storage is full: some changes could not be saved'), 'error'));
  // <audio>/<img> can't send the token header the fetch wrapper adds, so local-server media URLs carry it
  const tokenUrl = (u) => {
    const t = window.electronAPI && window.electronAPI.serverToken;
    return t ? `${u}${u.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}` : u;
  };
  if (!isPhoneApp) setInterval(() => {
    if (!normalizeEnabled()) {
      if (levelAvgDb > -120) resetLevelWatcher();
      return;
    }
    const audio = el.nativeAudio;
    if (!audioEngine || !audioEngine.getLevelDb || !audio || audio.paused || !state.isPlaying) return;
    const db = audioEngine.getLevelDb();
    if (db > -50) {
      levelAvgDb = levelAvgDb <= -120 ? db : levelAvgDb + (db - levelAvgDb) * 0.05;
      const gainDb = Math.max(-9, Math.min(9, -17 - levelAvgDb));
      audioEngine.setNormalizeGainDb(gainDb);
    }
  }, 100);

  syncSettingsSlidersToState();
  updateHqRouting();
  renderPresets();

  function initAudioContext() {
    audioEngine.init(el.nativeAudio);
    
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume().catch(() => {});
    }
    
    audioEngine.setHqEnabled(state.hqEnabled);
    audioEngine.setHqSettings(state.hqSettings);
    audioEngine.setAudioSettings(effectiveAudioSettings());
    audioEngine.setVolume(state.volume, state.isMuted);
    
    startVisualizers();
  }

  function updateHqRouting() {
    audioEngine.setHqEnabled(state.hqEnabled);
    if (el.btnToggleHqAudio) el.btnToggleHqAudio.classList.toggle('active', !!state.hqEnabled);
    if (el.hqPanelWrapper) el.hqPanelWrapper.classList.toggle('expanded', !!state.hqEnabled);
    if (el.hqEnhancerCard) el.hqEnhancerCard.classList.toggle('is-expanded', !!state.hqEnabled);
  }

  let soundSettingsSaveTimer = null;
  function persistSoundSettings() {
    if (!soundPersistenceEnabled) return;
    if (soundSettingsSaveTimer) clearTimeout(soundSettingsSaveTimer);
    soundSettingsSaveTimer = setTimeout(() => {
      soundSettingsSaveTimer = null;
      try {
        localStorage.setItem('muriel_hq_enabled', state.hqEnabled ? '1' : '0');
        localStorage.setItem('muriel_hq_settings', JSON.stringify(state.hqSettings));
        localStorage.setItem('muriel_audio_settings', JSON.stringify(state.audioSettings));
        localStorage.setItem('muriel_active_preset', state.activePresetId || '');
      } catch (e) {
        console.warn('Failed to save sound settings', e);
      }
    }, 300);
  }

  function applyHqSettings() {
    updateHqRouting();
    audioEngine.setHqSettings(state.hqSettings);
    persistSoundSettings();
  }
  
  function applyAudioSettings() {
    audioEngine.setAudioSettings(effectiveAudioSettings());
    audioEngine.setVolume(state.volume, state.isMuted);
    audioEngine.applySettings(el.nativeAudio);
    persistSoundSettings();
    
    if (el.settingsModifiedDot) {
      if (audioEngine.isModified()) {
        el.settingsModifiedDot.classList.remove('hidden');
      } else {
        el.settingsModifiedDot.classList.add('hidden');
      }
    }
  }


  // ---- Per-track speed / pitch / volume and speed & pitch presets (issue #11; logic in track-audio.js) ----
  // state.audioSettings stays the global sound; a song's own tempo values (keyed by its canonical id) go over it
  var trackAudioStore = null;
  var trackAudioOnlyDraft = false; // "For this track only" switched on, nothing changed yet
  var trackAudioLastKey = '';
  function trackAudioLib() { return window.MurielTrackAudio || null; }
  function allTrackAudio() {
    if (!trackAudioStore) {
      const TA = trackAudioLib();
      const raw = safeJson('muriel_track_audio', {});
      trackAudioStore = TA ? TA.cleanStore(raw) : {};
    }
    return trackAudioStore;
  }
  function saveAllTrackAudio() {
    try { localStorage.setItem('muriel_track_audio', JSON.stringify(trackAudioStore || {})); } catch (e) { console.warn('Failed to save per-track audio', e); }
  }
  function trackAudioKey(track) { return track ? (getTrackCanonicalId(track) || '') : ''; }
  function ignoreTrackAudio() { try { return localStorage.getItem('muriel_ignore_track_audio') === '1'; } catch (e) { return false; } }
  function currentTrackAudio() {
    const key = trackAudioKey(state.currentTrack);
    return key ? allTrackAudio()[key] || null : null;
  }
  function effectiveAudioSettings() {
    const TA = trackAudioLib();
    if (!TA) return state.audioSettings;
    return TA.effectiveSettings(state.audioSettings, currentTrackAudio(), ignoreTrackAudio());
  }
  // a speed / pitch / volume change from a slider or a preset: the playing song's own, or the global one
  function setTempoValues(values) {
    const TA = trackAudioLib();
    const key = trackAudioKey(state.currentTrack);
    const perTrack = TA && key && !ignoreTrackAudio() && (trackAudioOnlyDraft || currentTrackAudio());
    if (perTrack) {
      const base = TA.normalizeEntry(currentTrackAudio() || {}, TA.normalizeEntry(state.audioSettings));
      trackAudioStore = TA.setEntry(allTrackAudio(), key, { ...base, ...values });
      trackAudioOnlyDraft = false;
      saveAllTrackAudio();
    } else {
      Object.assign(state.audioSettings, values);
    }
    renderTrackAudioControls();
  }
  function renderTrackAudioControls() {
    const sw = document.getElementById('toggle-track-audio');
    const ign = document.getElementById('toggle-ignore-track-audio');
    const hint = document.getElementById('track-audio-hint');
    const ignored = ignoreTrackAudio();
    const has = !!currentTrackAudio();
    if (sw) {
      sw.classList.toggle('active', !ignored && (has || trackAudioOnlyDraft));
      sw.disabled = ignored || !state.currentTrack;
      const row = sw.closest('.setting-item');
      if (row) row.classList.toggle('is-disabled', sw.disabled);
    }
    if (ign) ign.classList.toggle('active', ignored);
    if (hint) {
      hint.textContent = !state.currentTrack ? T('Play a song to give it its own speed, pitch and volume')
        : ignored ? T('Per-track settings are ignored: every song uses the global values')
        : has ? T('This song keeps its own speed, pitch and volume')
        : T('Speed, pitch and volume changes apply to the playing song only');
    }
    renderTempoPresets();
  }
  function onTrackAudioTrackChange() {
    const key = trackAudioKey(state.currentTrack);
    if (key === trackAudioLastKey) return;
    trackAudioLastKey = key;
    trackAudioOnlyDraft = false;
    applyAudioSettings();
    syncSettingsSlidersToState();
    renderTrackAudioControls();
  }
  function customTempoPresets() {
    const TA = trackAudioLib();
    return TA ? TA.cleanPresets(safeJson('muriel_tempo_presets', [])) : [];
  }
  function renderTempoPresets() {
    const wrap = document.getElementById('tempo-preset-chips');
    const TA = trackAudioLib();
    if (!wrap || !TA) return;
    const cur = effectiveAudioSettings();
    const custom = customTempoPresets();
    wrap.innerHTML = '';
    for (const p of [...TA.BUILTIN_PRESETS, ...custom]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn tempo-preset-chip' + (TA.presetMatches(p, cur) ? ' active' : '');
      const label = document.createElement('span');
      if (p.builtin) { label.textContent = T(p.name); } else { label.textContent = p.name; label.setAttribute('data-no-i18n', ''); }
      chip.appendChild(label);
      chip.addEventListener('click', () => {
        initAudioContext();
        setTempoValues(p.values);
        state.activePresetId = null;
        applyAudioSettings();
        syncSettingsSlidersToState();
        renderPresets();
      });
      if (!p.builtin) {
        const del = document.createElement('span');
        del.className = 'tempo-preset-del';
        del.setAttribute('role', 'button');
        del.setAttribute('aria-label', T('Delete preset'));
        del.title = T('Delete preset');
        del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          const list = customTempoPresets().filter(x => x.id !== p.id);
          try { localStorage.setItem('muriel_tempo_presets', JSON.stringify(list)); } catch (err) {}
          renderTempoPresets();
        });
        chip.appendChild(del);
      }
      wrap.appendChild(chip);
    }
  }
  (function setupTrackAudio() {
    const sw = document.getElementById('toggle-track-audio');
    const ign = document.getElementById('toggle-ignore-track-audio');
    if (sw) sw.addEventListener('click', () => {
      if (sw.disabled) return;
      const key = trackAudioKey(state.currentTrack);
      if (!key) return;
      if (currentTrackAudio() || trackAudioOnlyDraft) {
        // off: the song goes back to the global values
        trackAudioStore = trackAudioLib().setEntry(allTrackAudio(), key, null);
        trackAudioOnlyDraft = false;
        saveAllTrackAudio();
      } else {
        trackAudioOnlyDraft = true;
      }
      applyAudioSettings();
      syncSettingsSlidersToState();
      renderTrackAudioControls();
    });
    if (ign) ign.addEventListener('click', () => {
      try { localStorage.setItem('muriel_ignore_track_audio', ignoreTrackAudio() ? '0' : '1'); } catch (e) {}
      trackAudioOnlyDraft = false;
      applyAudioSettings();
      syncSettingsSlidersToState();
      renderTrackAudioControls();
    });
    window.addEventListener('storage', (e) => { if (!e.key || /muriel_track_audio$/.test(e.key)) trackAudioStore = null; });

    const saveBtn = document.getElementById('btn-save-tempo-preset');
    const nameInput = document.getElementById('tempo-preset-name');
    const save = () => {
      const TA = trackAudioLib();
      if (!TA || !nameInput) return;
      const p = TA.makePreset(nameInput.value, effectiveAudioSettings());
      if (!p) { nameInput.focus(); return; }
      const list = customTempoPresets();
      list.push(p);
      try { localStorage.setItem('muriel_tempo_presets', JSON.stringify(list)); } catch (e) {}
      nameInput.value = '';
      showToast(Tm('Preset saved'), 'info');
      renderTempoPresets();
    };
    if (saveBtn) saveBtn.addEventListener('click', save);
    if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    renderTrackAudioControls();
  })();


  let cachedTrackWidth = 0;
  let cachedTrackHeight = 40;
  let cachedTvkWidth = 0;
  let cachedTvkHeight = 0;
  let tvkSmoothedHeights = null;
  let vizPrev = null;
  function vizSettings() {
    const smooth = Math.min(0.95, Math.max(0, (parseInt(localStorage.getItem('muriel_viz_smooth') || '70', 10)) / 100));
    const sens = Math.min(3, Math.max(0.3, (parseInt(localStorage.getItem('muriel_viz_sens') || '100', 10)) / 100));
    return { smooth, sens };
  }

  // ---- Riff 43: visualizer drawn wide behind the player bar, and the "connected" (one liquid wave) style ----
  // Same analyser and frame cap as the other visualizers; off in performance mode, and phones have no analyser.
  var vizConnected = localStorage.getItem('muriel_viz_connected') === '1';
  function isVizConnectedMode() { return vizConnected; }
  let barBgSmoothed = null;
  let barBgW = 0;
  let BAR_BG_H = 88;
  let barBgSettings = null;
  let barBgSettingsAt = 0;
  function drawConnectedLiquidWave(ctx, w, h, heights, color) {
    const rawN = heights.length;
    if (!rawN || w <= 0 || h <= 0) return;
    // few bars (mini, karaoke): mirror them so the wave rises in the middle
    let pts;
    if (rawN < 40) {
      const half = Math.min(18, rawN);
      pts = new Float32Array(half * 2);
      for (let i = 0; i < half; i++) { pts[half - 1 - i] = heights[i] || 0; pts[half + i] = heights[i] || 0; }
    } else {
      pts = Float32Array.from(heights);
    }
    const n = pts.length;
    const stepX = w / (n + 1);
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    let px = 0;
    let py = h;
    for (let i = 0; i <= n; i++) {
      let x = w;
      let y = h;
      if (i < n) {
        const avg = (pts[Math.max(0, i - 2)] * 0.12 + pts[Math.max(0, i - 1)] * 0.24 + pts[i] * 0.28 + pts[Math.min(n - 1, i + 1)] * 0.24 + pts[Math.min(n - 1, i + 2)] * 0.12);
        const taper = Math.pow(Math.sin(((i + 0.5) / n) * Math.PI), 0.65);
        x = (i + 1) * stepX;
        y = h - Math.max(0, Math.min(h - 4, Math.max(0, avg - 3.5) * taper));
      }
      const midX = (px + x) * 0.5;
      ctx.bezierCurveTo(midX, py, midX, y, x, y);
      px = x;
      py = y;
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function clearBarBgVisualizer(ctx) {
    barBgSmoothed = null;
    if (barBgW) ctx.clearRect(0, 0, barBgW, BAR_BG_H);
  }
  function drawBarBgVisualizer(ctx, data) {
    const w = barBgW;
    const h = BAR_BG_H;
    if (!w || !data) return;
    const now = performance.now();
    if (!barBgSettings || now - barBgSettingsAt > 1000) { barBgSettings = vizSettings(); barBgSettingsAt = now; }
    const { smooth, sens } = barBgSettings;
    const half = 26;
    const minH = 3;
    // a quiet backdrop: the bars stay in the lower part of the bar, under the time labels and seek bar
    const capH = Math.round(h * 0.42);
    if (!barBgSmoothed) barBgSmoothed = new Float32Array(half).fill(minH);
    let any = false;
    for (let i = 0; i < half; i++) {
      let target = minH;
      if (state.isPlaying) {
        const raw = (((data[i * 2] || 0) + (data[Math.min(data.length - 1, i * 2 + 1)] || 0)) * 0.5) * sens;
        target = minH + Math.pow(Math.min(1, Math.max(0, raw / 255)), 1.25) * (capH - minH);
      }
      barBgSmoothed[i] = barBgSmoothed[i] * smooth + target * (1 - smooth);
      if (barBgSmoothed[i] > minH + 0.5) any = true;
    }
    ctx.clearRect(0, 0, w, h);
    if (!any && !state.isPlaying) { barBgSmoothed = null; return; }
    const count = half * 2;
    const sym = new Float32Array(count);
    for (let i = 0; i < half; i++) { sym[half - 1 - i] = barBgSmoothed[i]; sym[half + i] = barBgSmoothed[i]; }
    if (!cachedPrimaryColor) refreshCachedThemeColors();
    const base = cachedPrimaryColor || '#ffffff';
    // fade out toward the top so the tallest bars melt away before they reach the controls
    const color = ctx.createLinearGradient(0, h, 0, h - capH);
    color.addColorStop(0, base);
    color.addColorStop(1, 'transparent');
    if (vizConnected) { drawConnectedLiquidWave(ctx, w, h, sym, color); return; }
    const gap = 2;
    const barW = Math.max(2, (w - gap * (count - 1)) / count);
    const startX = Math.max(0, (w - (count * barW + gap * (count - 1))) / 2);
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const barH = Math.max(2, Math.min(capH, sym[i]));
      ctx.beginPath();
      ctx.roundRect(startX + i * (barW + gap), h - barH, barW, barH, 3);
      ctx.fill();
    }
  }

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    if (el.scrubberTrack) {
      let scrubberCanvas = document.getElementById('squiggly-canvas');
      if (!scrubberCanvas) {
        scrubberCanvas = document.createElement('canvas');
        scrubberCanvas.id = 'squiggly-canvas';
        scrubberCanvas.className = 'squiggly-canvas';
        el.scrubberTrack.appendChild(scrubberCanvas);
      }
      const rect = el.scrubberTrack.getBoundingClientRect();
      // measured while the playbar is still hidden the width is 0, which left a 0px canvas behind
      const rw = rect.width || el.scrubberTrack.clientWidth || 300;
      cachedTrackWidth = rw;
      cachedTrackHeight = Math.max(40, rect.height);
      hasDrawnPausedFrame = false;
      scrubberCanvas.width = Math.round(rw * dpr);
      scrubberCanvas.height = Math.round(Math.max(40, rect.height) * dpr);
      scrubberCanvas.style.width = '100%';
      scrubberCanvas.style.height = `${Math.max(40, rect.height)}px`;
      const ctx = scrubberCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    }
    if (el.visualizerCanvas) {
      el.visualizerCanvas.width = 60 * dpr;
      el.visualizerCanvas.height = 24 * dpr;
      el.visualizerCanvas.style.width = '60px';
      el.visualizerCanvas.style.height = '24px';
      const ctx = el.visualizerCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    }
    const tvkCanvas = document.getElementById('tvk-visualizer-canvas');
    if (tvkCanvas) {
      const cssW = Math.min(760, Math.max(360, Math.round(window.innerWidth * 0.64)));
      const cssH = Math.min(84, Math.max(52, Math.round(window.innerHeight * 0.085)));
      cachedTvkWidth = cssW;
      cachedTvkHeight = cssH;
      tvkCanvas.width = Math.round(cssW * dpr);
      tvkCanvas.height = Math.round(cssH * dpr);
      tvkCanvas.style.width = `${cssW}px`;
      tvkCanvas.style.height = `${cssH}px`;
      const ctx = tvkCanvas.getContext('2d');
      if (ctx) {
        ctx.resetTransform();
        ctx.scale(dpr, dpr);
      }
    }
    const barBgCanvas = document.getElementById('playbar-bg-visualizer');
    if (barBgCanvas && el.playbar && !isPhoneApp) {
      // the canvas covers the whole player bar (see .playbar-bg-visualizer)
      barBgW = Math.max(200, el.playbar.clientWidth);
      BAR_BG_H = Math.max(40, el.playbar.clientHeight || 88);
      barBgCanvas.width = Math.round(barBgW * dpr);
      barBgCanvas.height = Math.round(BAR_BG_H * dpr);
      const bctx = barBgCanvas.getContext('2d');
      if (bctx) { bctx.resetTransform(); bctx.scale(dpr, dpr); }
    }
  }
  window.addEventListener('resize', resizeCanvases);
  setTimeout(resizeCanvases, 100);

  let smoothAmplitude = 0;
  let smoothPhase = 0;
  let scrubPhase = 0;
  let scrubProgress = 0;
  let scrubPrevKnobX = null;
  let scrubKnobAnim = 0;
  let scrubLastTime = 0;
  let lastDisplayedSec = -1;

  let lastFrameTime = 0;
  function startVisualizers() {
    if (!state.isWindowVisible) return;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    const analyserNode = audioEngine && audioEngine.getAnalyserNode ? audioEngine.getAnalyserNode() : null;
    const miniCanvas = el.visualizerCanvas;
    const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;
    const tvkCanvas = document.getElementById('tvk-visualizer-canvas');
    const tvkCtx = tvkCanvas ? tvkCanvas.getContext('2d') : null;
    const barBgCanvas = document.getElementById('playbar-bg-visualizer');
    const barBgCtx = barBgCanvas ? barBgCanvas.getContext('2d') : null;

    let bufferLength = analyserNode ? analyserNode.frequencyBinCount : 0;
    let freqData = bufferLength > 0 ? new Uint8Array(bufferLength) : null;

    function renderLoop(timestamp) {
      if (document.hidden || !state.isWindowVisible) {
        animationFrameId = null;
        if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
        return;
      }

      if (!state.isPlaying && !isDraggingScrubber) {
        if (hasDrawnPausedFrame) {
          animationFrameId = null;
          if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
          return;
        }
        hasDrawnPausedFrame = true;
      } else {
        hasDrawnPausedFrame = false;
      }

      // phones: with the player sheet closed nothing this loop draws is on screen (the mini player
      // follows timeupdate), so stop until the sheet or TV lyrics open again
      if (isPhoneApp && !state.isRightPanelOpen && !state.isTvKaraokeOpen) {
        animationFrameId = null;
        return;
      }

      animationFrameId = requestAnimationFrame(renderLoop);

      const fpsCap = document.body.classList.contains('perf') ? 30 : isPhoneApp ? 20 : (parseInt(localStorage.getItem('muriel_fps_cap') || '0', 10) || 0);
      if (fpsCap && timestamp - lastFrameTime < 1000 / fpsCap - 1) return;
      lastFrameTime = timestamp;

      const isVisualizerVisible = miniCanvas && miniCanvas.offsetParent !== null && !document.hidden;
      const isTvkVisualizerVisible = state.isTvKaraokeOpen && tvkCanvas && tvkCanvas.offsetParent !== null && !document.hidden;
      const needBassPulse = !!(state.vfx && state.vfx.bassPulse);
      const isBehindVizVisible = !!(barBgCanvas && !state.isTvKaraokeOpen && barBgCanvas.offsetParent !== null);

      if (!document.body.classList.contains('perf') && (isVisualizerVisible || isTvkVisualizerVisible || isBehindVizVisible || needBassPulse)) {
        if (!freqData && audioEngine && audioEngine.getAnalyserNode) {
          const an = audioEngine.getAnalyserNode();
          if (an && an.frequencyBinCount) {
            freqData = new Uint8Array(an.frequencyBinCount);
          }
        }
        if (freqData && audioEngine && audioEngine.getFrequencyData) {
          audioEngine.getFrequencyData(freqData);

          let bassEnergy = (freqData[0] + freqData[1] + freqData[2] + freqData[3]) / (4 * 255);

          if (needBassPulse) {
            const scaleMul = 1.0 + (bassEnergy * 0.035);
            const targetTransform = `scale(${scaleMul.toFixed(3)})`;
            if (el.coverContainer && el.coverContainer.style.transform !== targetTransform) {
              el.coverContainer.style.transform = targetTransform;
            }
          } else {
            if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
          }

          if (miniCtx && miniCanvas && isVisualizerVisible) {
            miniCtx.clearRect(0, 0, 60, 24);
            if (state.isPlaying) {
              const barCount = 12;
              const barWidth = 3;
              const gap = 2;
              const startX = (60 - (barCount * (barWidth + gap))) / 2;
              const connected = isVizConnectedMode();
              const heights = connected ? [] : null;

              for (let i = 0; i < barCount; i++) {
                const val = freqData[i * 2] || 0;
                let barHeight = (val / 255) * (24 - 4);
                if (barHeight < 2) barHeight = 2;
                if (connected) { heights.push(barHeight); continue; }

                const x = startX + i * (barWidth + gap);
                const y = 24 - barHeight;

                miniCtx.fillStyle = '#ffffff';
                miniCtx.beginPath();
                miniCtx.roundRect(x, y, barWidth, barHeight, 2);
                miniCtx.fill();
              }
              if (connected) drawConnectedLiquidWave(miniCtx, 60, 24, heights, '#ffffff');
            }
          }

          if (tvkCtx && tvkCanvas && isTvkVisualizerVisible) {
            if (!cachedTvkWidth && typeof resizeCanvases === 'function') {
              resizeCanvases();
            }
            const w = cachedTvkWidth || (tvkCanvas.width / (window.devicePixelRatio || 1)) || 600;
            const h = cachedTvkHeight || (tvkCanvas.height / (window.devicePixelRatio || 1)) || 64;

            tvkCtx.clearRect(0, 0, w, h);

            if (state.isPlaying && freqData) {
              const data = freqData;
              const { smooth, sens } = vizSettings();
              if (!vizPrev || vizPrev.length !== data.length) vizPrev = new Float32Array(data.length);
              for (let i = 0; i < data.length; i++) {
                const v = Math.min(255, data[i] * sens);
                vizPrev[i] = vizPrev[i] * smooth + v * (1 - smooth);
              }

              const barCount = 28;
              if (!tvkSmoothedHeights || tvkSmoothedHeights.length !== barCount) {
                tvkSmoothedHeights = new Float32Array(barCount);
              }

              const gap = Math.max(3, Math.min(6, Math.round(w / 115)));
              const totalGap = gap * (barCount - 1);
              const barWidth = Math.max(4, Math.floor((w - totalGap) / barCount));
              const usedWidth = barCount * barWidth + totalGap;
              const startX = Math.max(0, (w - usedWidth) / 2);
              const minHeight = 4;
              const usableHeight = Math.max(10, h - minHeight - 2);
              const connected = isVizConnectedMode();

              for (let i = 0; i < barCount; i++) {
                const b0 = i * 2;
                const b1 = Math.min(63, b0 + 1);
                const raw = ((vizPrev[b0] || 0) + (vizPrev[b1] || 0)) * 0.5;

                const norm = raw / 255;
                const compressed = Math.pow(norm, 1.3) * 0.78;
                const targetHeight = minHeight + compressed * usableHeight;

                const barH = targetHeight;
                tvkSmoothedHeights[i] = barH;
                if (connected) continue;

                const x = startX + i * (barWidth + gap);
                const y = h - barH;

                tvkCtx.fillStyle = '#ffffff';
                tvkCtx.beginPath();
                tvkCtx.roundRect(x, y, barWidth, barH, Math.min(barWidth / 2, 3));
                tvkCtx.fill();
              }
              if (connected) {
                tvkCtx.save();
                tvkCtx.translate(startX, 0);
                drawConnectedLiquidWave(tvkCtx, usedWidth, h, tvkSmoothedHeights, '#ffffff');
                tvkCtx.restore();
              }
            } else if (tvkSmoothedHeights) {
              let anyActive = false;
              const barCount = tvkSmoothedHeights.length;
              const gap = Math.max(3, Math.min(6, Math.round(w / 115)));
              const totalGap = gap * (barCount - 1);
              const barWidth = Math.max(4, Math.floor((w - totalGap) / barCount));
              const usedWidth = barCount * barWidth + totalGap;
              const startX = Math.max(0, (w - usedWidth) / 2);
              const minHeight = 4;
              const connected = isVizConnectedMode();

              for (let i = 0; i < barCount; i++) {
                tvkSmoothedHeights[i] += (minHeight - tvkSmoothedHeights[i]) * 0.15;
                if (tvkSmoothedHeights[i] > minHeight + 0.5) anyActive = true;
                if (connected) continue;

                const barH = tvkSmoothedHeights[i];
                const x = startX + i * (barWidth + gap);
                const y = h - barH;

                tvkCtx.fillStyle = '#ffffff';
                tvkCtx.beginPath();
                tvkCtx.roundRect(x, y, barWidth, barH, Math.min(barWidth / 2, 3));
                tvkCtx.fill();
              }
              if (connected) {
                tvkCtx.save();
                tvkCtx.translate(startX, 0);
                drawConnectedLiquidWave(tvkCtx, usedWidth, h, tvkSmoothedHeights, '#ffffff');
                tvkCtx.restore();
              }
              if (!anyActive) {
                tvkSmoothedHeights = null;
              }
            }
          }

          if (barBgCtx && isBehindVizVisible) drawBarBgVisualizer(barBgCtx, freqData);
        }
      } else {
        if (audioEngine && audioEngine.setAnalyserEnabled && !needBassPulse) audioEngine.setAnalyserEnabled(false);
        if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
        if (miniCtx && miniCanvas) miniCtx.clearRect(0, 0, 60, 24);
        if (tvkCtx && tvkCanvas) {
          const w = cachedTvkWidth || (tvkCanvas.width / (window.devicePixelRatio || 1)) || 500;
          const h = cachedTvkHeight || (tvkCanvas.height / (window.devicePixelRatio || 1)) || 64;
          tvkCtx.clearRect(0, 0, w, h);
        }
        if (barBgCtx) clearBarBgVisualizer(barBgCtx);
      }

      let scrubberCanvas = document.getElementById('squiggly-canvas');
      if (scrubberCanvas && el.scrubberTrack) {
        const sCtx = scrubberCanvas.getContext('2d');
        const sw = cachedTrackWidth || (el.scrubberTrack ? el.scrubberTrack.clientWidth : 0);
        const sh = cachedTrackHeight || 40;
        sCtx.clearRect(0, 0, sw, sh);

        const dt = scrubLastTime === 0 ? 0.016 : Math.min((timestamp - scrubLastTime) / 1000, 0.1);
        scrubLastTime = timestamp;

        const dur = (el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
          ? el.nativeAudio.duration
          : (state.currentTrack && Number.isFinite(state.currentTrack.duration) ? state.currentTrack.duration : 0);
        let cur = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;

        if (isDraggingScrubber && state.scrubberDragTargetTime !== undefined) {
          cur = state.scrubberDragTargetTime;
          const t = formatDuration(cur);
          if (el.timeCurrent && el.timeCurrent.textContent !== t) el.timeCurrent.textContent = t;
        } else if (state.isPlaying) {
          const roundedSec = Math.floor(cur);
          if (lastDisplayedSec !== roundedSec) {
            lastDisplayedSec = roundedSec;
            const t = formatDuration(cur);
            if (el.timeCurrent && el.timeCurrent.textContent !== t) el.timeCurrent.textContent = t;
          }
          if (dur > 0 && el.timeDuration) {
            const d = formatDuration(dur);
            if (el.timeDuration.textContent !== d) el.timeDuration.textContent = d;
          }
          if (nextPrefetchDue(cur, dur) && !state.nextTrackPrefetched) {
            state.nextTrackPrefetched = true;
            prefetchNextQueueTrack();
          }
          if (state.isRightPanelOpen || state.isTvKaraokeOpen) {
            updateSyncedLyricsHighlight(cur);
          } else if (miniLyricsShown()) {
            updateMiniLyricsHighlight(cur);
          }
        }

        const targetProgress = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
        const followSpeed = isDraggingScrubber ? 32 : 45;
        scrubProgress += (targetProgress - scrubProgress) * Math.min(1, dt * followSpeed);

        const targetAnim = isDraggingScrubber ? 1 : 0;
        scrubKnobAnim += (targetAnim - scrubKnobAnim) * Math.min(1, Math.max(0, dt * 16));
        // a NaN here sticks for good and roundRect throws on a negative radius
        scrubKnobAnim = Math.max(0, Math.min(1, Number.isFinite(scrubKnobAnim) ? scrubKnobAnim : 0));
        const curKnobW = 7.5 + (9.0 - 7.5) * scrubKnobAnim;
        const curKnobH = 24 + (32 - 24) * scrubKnobAnim;
        const curKnobR = Math.max(0, 3.75 + (4.5 - 3.75) * scrubKnobAnim);

        const padLeft = 5.5;
        const padRight = 5.5;
        const trackWidth = sw - padLeft - padRight;
        const knobCenterX = padLeft + scrubProgress * trackWidth;

        if (scrubPrevKnobX === null) scrubPrevKnobX = knobCenterX;
        const deltaX = knobCenterX - scrubPrevKnobX;
        scrubPrevKnobX = knobCenterX;

        const k = (2 * Math.PI) / 42;

        if (isDraggingScrubber) {
          scrubPhase += deltaX * k;
        } else if (state.isPlaying) {
          scrubPhase += 3.5 * dt;
        }

        const noKnob = document.body.classList.contains('no-knob');
        const capRadius = 9.5 / 2;
        const knobLeft = knobCenterX - curKnobW / 2;
        const waveStart = padLeft;
        const waveEnd = noKnob ? knobCenterX : (knobLeft - 4.5 - capRadius);

        const inactiveStart = noKnob ? knobCenterX : (knobCenterX + (curKnobW / 2) + 4);
        const inactiveEnd = sw - padRight;

        if (!cachedPrimaryColor) refreshCachedThemeColors();
        const primaryColor = cachedPrimaryColor;
        const dimColor = cachedDimColor;

        const centerY = sh / 2;

        const showProgressBg = localStorage.getItem('muriel_progress_bg') !== 'false';
        if (showProgressBg && inactiveEnd > inactiveStart) {
          sCtx.save();
          sCtx.globalAlpha = 0.3;
          sCtx.beginPath();
          sCtx.lineWidth = 11;
          sCtx.lineCap = 'round';
          sCtx.strokeStyle = dimColor;
          sCtx.moveTo(inactiveStart, centerY);
          sCtx.lineTo(inactiveEnd, centerY);
          sCtx.stroke();
          sCtx.restore();
        }

        if (waveEnd > waveStart) {
          sCtx.beginPath();
          sCtx.lineWidth = 9.5;
          sCtx.lineCap = 'round';
          sCtx.lineJoin = 'round';
          sCtx.strokeStyle = primaryColor;

          if (document.body.classList.contains('no-wavy')) {
            sCtx.moveTo(waveStart, centerY);
            sCtx.lineTo(waveEnd, centerY);
            sCtx.stroke();
          } else {
            const step = 2;
            for (let x = waveStart; x <= waveEnd; x += step) {
              const angle = scrubPhase - (waveEnd - x) * k;
              const y = centerY + Math.sin(angle) * 5;
              if (x === waveStart) {
                sCtx.moveTo(x, y);
              } else {
                sCtx.lineTo(x, y);
              }
            }

            const finalY = centerY + Math.sin(scrubPhase) * 5;
            sCtx.lineTo(waveEnd, finalY);
            sCtx.stroke();
          }
        }

        if (!noKnob) {
          sCtx.beginPath();
          sCtx.roundRect(knobLeft, centerY - curKnobH / 2, curKnobW, curKnobH, curKnobR);
          sCtx.fillStyle = primaryColor;
          sCtx.fill();
        }
      }
    }
    renderLoop(0);
  }

  function handleVisibilityChange(visible) {
    state.isWindowVisible = visible;
    syncBgVideoPlayback();
    if (audioEngine && audioEngine.setHidden) audioEngine.setHidden(!visible);
    if (!visible) {
      if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
        cancelAnimationFrame(lyricsScrollRaf);
        lyricsScrollRaf = 0;
      }
      if (typeof gradientRaf !== 'undefined' && gradientRaf) {
        cancelAnimationFrame(gradientRaf);
        gradientRaf = 0;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (typeof cacheRafId !== 'undefined' && cacheRafId) {
        cancelAnimationFrame(cacheRafId);
        cacheRafId = 0;
      }
      document.body.classList.add('app-paused');
      document.body.classList.add('hidden-window');
      if (getAdv('trim_bg', true)) {
        clearTimeout(handleVisibilityChange.trimTimer);
        // wait a bit so quick alt-tabs don't throw away decoded images we're about to redraw
        handleVisibilityChange.trimTimer = setTimeout(() => {
          if (!state.isWindowVisible && window.electronAPI && window.electronAPI.trimMemory) window.electronAPI.trimMemory();
        }, 10000);
      }
    } else {
      document.body.classList.remove('app-paused');
      document.body.classList.remove('hidden-window');
      resizeCanvases();
      // the daily mixes wait while the window is hidden (#16): make them now if they're still missing
      try { if (spHomeReady && isSpotifyHome() && !readDailyMixes()) renderMadeForYou(); } catch (e) {}
      hasDrawnPausedFrame = false;
      if (state.isPlaying || isDraggingScrubber) startVisualizers();
      if (typeof cacheModal !== 'undefined' && cacheModal && cacheModal.classList.contains('visible') && typeof cacheRafId !== 'undefined' && !cacheRafId) {
        cacheRafId = requestAnimationFrame(cacheFrame);
      }
      if (typeof updateLyricsPadding === 'function') {
        const syncOnRestore = () => {
          updateLyricsPadding();
          state.forceSnapLyrics = true;
          state.forceLyricsScroll = true;
          state.lastActiveLyricIdx = -1;
          if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
        };
        syncOnRestore();
        requestAnimationFrame(syncOnRestore);
        setTimeout(syncOnRestore, 80);
        setTimeout(syncOnRestore, 220);
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    handleVisibilityChange(!document.hidden);
  });

  if (window.electronAPI && window.electronAPI.onWindowVisibility) {
    window.electronAPI.onWindowVisibility(visible => handleVisibilityChange(visible));
  }
  // WKWebView doesn't always fire visibilitychange on lock/home; the native app-state event does
  try {
    const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (capApp && capApp.addListener) capApp.addListener('appStateChange', (s) => handleVisibilityChange(!!(s && s.isActive)));
  } catch (_) {}

  function applyVisualEffects() {
    const v = state.vfx;

    if (el.coverContainer) {
      el.coverContainer.classList.toggle('vinyl-mode', !!v.vinylSpin);
      el.coverContainer.classList.toggle('spinning', !!v.vinylSpin && state.isPlaying);
    }
    document.body.classList.toggle('vfx-spotlight-on', !!v.lyricsSpotlight);
    syncVisualSettingsUI();
  }

  function syncVisualSettingsUI() {
    const v = state.vfx;
    const vfxList = [
      { id: 'vfx-pulse', key: 'bassPulse' },
      { id: 'vfx-vinyl', key: 'vinylSpin' },
      { id: 'vfx-spotlight', key: 'lyricsSpotlight' }
    ];

    vfxList.forEach(item => {
      const card = document.getElementById(`card-${item.id}`);
      const badge = document.getElementById(`badge-${item.id}`);
      const btn = document.getElementById(`toggle-${item.id}`);
      const isEnabled = v[item.key];

      if (card) card.classList.toggle('enabled', !!isEnabled);
      if (badge) badge.textContent = T(isEnabled ? 'on' : 'off');
      if (btn) {
        btn.classList.toggle('active', !!isEnabled);
        
      }
    });
  }

  const EQ_BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

  function syncSettingsSlidersToState() {
    const s = effectiveAudioSettings();
    // the engine dropdown is plain markup that always said hqmusic-3, whatever engine was saved or reset to
    const engine = state.hqSettings && state.hqSettings.engine;
    if (engine) {
      if (el.hqEngineSelect) el.hqEngineSelect.value = engine;
      const opts = document.querySelectorAll('#hq-engine-menu .m3-dropdown-option');
      opts.forEach(o => o.classList.toggle('selected', o.dataset.value === engine));
      const picked = [...opts].find(o => o.dataset.value === engine);
      const label = document.getElementById('hq-engine-label');
      if (picked && label) label.textContent = picked.textContent;
    }
    if (el.sliderSpeed) el.sliderSpeed.value = s.speed;
    if (el.valSpeed) el.valSpeed.textContent = `${s.speed.toFixed(2)}x`;

    if (el.sliderSpeedPitch) el.sliderSpeedPitch.value = s.speedPitch;
    if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${s.speedPitch.toFixed(2)}x`;

    if (el.sliderPitch) el.sliderPitch.value = s.pitch;
    if (el.valPitch) el.valPitch.textContent = `${s.pitch > 0 ? '+' : ''}${s.pitch} st`;

    if (el.sliderReverb) el.sliderReverb.value = s.reverb;
    if (el.valReverb) el.valReverb.textContent = `${s.reverb}%`;

    if (el.sliderDistortion) el.sliderDistortion.value = s.distortion;
    if (el.valDistortion) el.valDistortion.textContent = `${s.distortion}%`;

    if (el.sliderGain) el.sliderGain.value = Math.round(s.volume * 100);
    if (el.valGain) el.valGain.textContent = `${Math.round(s.volume * 100)}%`;

    if (el.sliderEcho) el.sliderEcho.value = s.echo;
    if (el.valEcho) el.valEcho.textContent = `${s.echo}%`;

    const eq = s.eq || { low: 0, mid: 0, high: 0 };
    if (el.sliderEqLow) el.sliderEqLow.value = eq.low;
    if (el.valEqLow) el.valEqLow.textContent = `${eq.low > 0 ? '+' : ''}${eq.low} dB`;
    if (el.sliderEqMid) el.sliderEqMid.value = eq.mid;
    if (el.valEqMid) el.valEqMid.textContent = `${eq.mid > 0 ? '+' : ''}${eq.mid} dB`;
    if (el.sliderEqHigh) el.sliderEqHigh.value = eq.high;
    if (el.valEqHigh) el.valEqHigh.textContent = `${eq.high > 0 ? '+' : ''}${eq.high} dB`;

    const bands = s.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (el.eqBands) {
      const inputs = el.eqBands.querySelectorAll('.eq-band-range');
      const valLabels = el.eqBands.querySelectorAll('.eq-band-val');
      inputs.forEach((input, i) => {
        const v = bands[i] !== undefined ? bands[i] : 0;
        input.value = v;
        if (valLabels[i]) valLabels[i].textContent = `${v > 0 ? '+' : ''}${v} dB`;
      });
    }

    if (state.hqSettings) {
      if (el.sliderHqVocal) { el.sliderHqVocal.value = state.hqSettings.vocal; if (el.valHqVocal) el.valHqVocal.textContent = `${state.hqSettings.vocal > 0 ? '+' : ''}${state.hqSettings.vocal}%`; }
      if (el.sliderHqAir) { el.sliderHqAir.value = state.hqSettings.air; if (el.valHqAir) el.valHqAir.textContent = `${state.hqSettings.air > 0 ? '+' : ''}${state.hqSettings.air}%`; }
      if (el.sliderHqBass) { el.sliderHqBass.value = state.hqSettings.bass; if (el.valHqBass) el.valHqBass.textContent = `${state.hqSettings.bass > 0 ? '+' : ''}${state.hqSettings.bass}%`; }
      if (el.hqPresetChips) el.hqPresetChips.forEach(c => c.classList.toggle('active', c.dataset.preset === state.hqSettings.preset));
    }
  }

  // Crossfades cover art: the old image is cloned into a ghost that fades/shrinks out
  // while the new one blurs in underneath. The new src is decoded first so it never pops.
  function swapArtwork(img, src) {
    const artSwapTokens = swapArtwork.tokens || (swapArtwork.tokens = new WeakMap());
    const token = {};
    artSwapTokens.set(img, token);
    const shown = img.style.display === 'block' && img.complete && img.naturalWidth > 0;
    if (!shown || img.getAttribute('src') === src || document.body.classList.contains('perf') || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      img.src = src;
      img.style.display = 'block';
      return;
    }
    const pre = new Image();
    pre.src = src;
    const commit = () => {
      if (artSwapTokens.get(img) !== token) return;
      img.parentElement.querySelectorAll('.art-ghost').forEach(g => g.remove());
      const ghost = img.cloneNode(false);
      ghost.removeAttribute('id');
      ghost.classList.remove('art-in');
      ghost.classList.add('art-ghost');
      ghost.style.cssText = `position:absolute;left:${img.offsetLeft}px;top:${img.offsetTop}px;width:${img.offsetWidth}px;height:${img.offsetHeight}px;display:block;margin:0;pointer-events:none;`;
      img.after(ghost);
      ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
      setTimeout(() => ghost.remove(), 900);
      img.src = src;
      img.style.display = 'block';
      img.classList.remove('art-in');
      void img.offsetWidth;
      img.classList.add('art-in');
    };
    pre.decode().then(commit, commit);
  }

  const FADE_IMG_SEL = '.track-row-thumb, .my-wave-track-cover, .quick-play-pill-img';
  const markImgLoaded = (e) => { const t = e.target; if (t.tagName === 'IMG' && t.matches(FADE_IMG_SEL)) t.classList.add('is-loaded'); };
  document.addEventListener('load', markImgLoaded, true);
  document.addEventListener('error', markImgLoaded, true);

  // Colours the drawer with a soft glow from the cover's own palette (cheap stand-in for the old blurred banner).
  function tintNowPlaying(src) {
    const panel = el.rightPanel;
    if (!panel) return;
    if (!src) {
      panel.style.removeProperty('--np-c1');
      panel.style.removeProperty('--np-c2');
      return;
    }
    analyzeCover(src).then(a => {
      if (!state.currentTrack || getTrackThumbUrl(state.currentTrack) !== src) return;
      panel.style.setProperty('--np-c1', a.accent);
      panel.style.setProperty('--np-c2', a.accent2 || a.accent);
    });
  }

  function updateNowPlayingUI(track) {
    window.dispatchEvent(new CustomEvent('muriel:track', { detail: track }));
    if (el.playbarTitle) el.playbarTitle.textContent = track.title || 'Untitled';
    if (el.playbarTitle) el.playbarTitle.dataset.origTitle = track.title || '';
    if (el.playbarArtist) el.playbarArtist.textContent = track.artist || 'Unknown artist';

    const thumb = getTrackThumbUrl(track);
    if (thumb) {
      if (el.playbarArtwork) {
        el.playbarArtwork.onload = () => {
          // a fallback that loaded replaces the song's dead cover for good
          const shown = el.playbarArtwork.getAttribute('src') || '';
          if (el.playbarArtwork.__artTrack === track && shown !== thumb) rememberTrackArt(getTrackCanonicalId(track), shown);
          if (state.currentTrack && 'mediaSession' in navigator && navigator.mediaSession.metadata) {
            const curThumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(state.currentTrack) : '') || state.currentTrack.thumbnail || '';
            const art = getMediaArtwork(curThumb);
            if (art.length > 0) {
              navigator.mediaSession.metadata.artwork = art;
            }
          }
        };
        swapArtwork(el.playbarArtwork, thumb);
        if (typeof m3cSetImage === 'function') m3cSetImage(thumb);
        el.playbarArtwork.onerror = () => {
          // a dead cover: try the song's other covers (the right panel follows) before showing the placeholder
          const next = nextPlayerArt(track, el.playbarArtwork);
          if (next) {
            if (typeof m3cSetImage === 'function') m3cSetImage(next);
            if (el.rightPanelCover) el.rightPanelCover.src = next;
            updateRightPanelBanner(next);
            updateThemeFromState();
            return;
          }
          el.playbarArtwork.style.display = 'none';
          if (el.artworkFallback) el.artworkFallback.style.display = 'flex';
        };
      }
      if (el.artworkFallback) el.artworkFallback.style.display = 'none';
      if (el.rightPanelCover) {
        swapArtwork(el.rightPanelCover, thumb);
        el.rightPanelCover.onerror = () => {
          const next = nextPlayerArt(track, el.rightPanelCover);
          if (next) { updateRightPanelBanner(next); return; }
          el.rightPanelCover.style.display = 'none';
          if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'flex';
        };
      }
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'none';
    } else {
      if (el.playbarArtwork) el.playbarArtwork.style.display = 'none';
      if (typeof m3cSetImage === 'function') m3cSetImage('');
      if (el.artworkFallback) el.artworkFallback.style.display = 'flex';
      if (el.rightPanelCover) el.rightPanelCover.style.display = 'none';
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'flex';
    }

    if (el.rightPanelTitle) el.rightPanelTitle.textContent = track.title || 'Untitled';
    if (el.rightPanelArtist) el.rightPanelArtist.textContent = track.artist || 'Unknown artist';

    if (el.btnPlaybarMore) el.btnPlaybarMore.style.display = track.platform === 'local' ? 'none' : '';
    if (el.timeDuration && track && track.duration) el.timeDuration.textContent = formatDuration(track.duration);

    updateRightPanelBanner(thumb);
    tintNowPlaying(thumb);
    refreshMeshCover();
    setCoverBg(thumb);
    updateFavoriteIcon();
    applyVisualEffects();
    highlightPlayingRow();
    updateThemeFromState();
    updateMediaSession();
    if (state.isTvKaraokeOpen) updateTvKaraokeMeta();
  }

  function updateRightPanelBanner(thumbUrl) {
    const banner = document.getElementById('right-panel-banner');
    if (!banner) return;
    if (!getAdv('banners', true) || !getAdv('track_banners', true)) {
      banner.style.display = 'none';
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }
    banner.style.display = '';
    const bannerImg = banner.querySelector('.banner-image') || banner;
    const trackArt = state.currentTrack ? getTrackArt(state.currentTrack) : {};
    const trackBanner = trackArt.banner || null;
    const globalMedia = localStorage.getItem('muriel_banner_media');
    const mediaToUse = trackBanner || globalMedia || thumbUrl;
    banner._pendingMedia = mediaToUse;

    if (!mediaToUse) {
      banner.classList.add('fading-out');
      setTimeout(() => {
        bannerImg.style.backgroundImage = 'none';
        const vid = banner.querySelector('video.banner-video');
        if (vid) vid.remove();
        banner.style.opacity = '0';
        banner.classList.remove('fading-out');
        if (state.isTvKaraokeOpen) syncTvBanner();
      }, 300);
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }

    const isVideo = /\.(mp4|webm)($|\?)/i.test(mediaToUse);
    if (isVideo) {
      bannerImg.style.backgroundImage = 'none';
      let vid = banner.querySelector('video.banner-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.className = 'banner-video';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        banner.appendChild(vid);
      }
      vid.onerror = () => {
        if (trackBanner && state.currentTrack) {
          setTrackArt(state.currentTrack, { banner: undefined });
          updateRightPanelBanner(thumbUrl);
        } else {
          banner.style.opacity = '0';
          if (state.isTvKaraokeOpen) syncTvBanner();
        }
      };
      if (vid.src !== mediaToUse) {
        vid.src = mediaToUse;
        vid.play().catch(() => {});
      }
      banner.style.opacity = '1';
      if (state.isTvKaraokeOpen) syncTvBanner();
      return;
    }

    const vid = banner.querySelector('video.banner-video');
    if (vid) vid.remove();

    const img = new Image();
    img.src = mediaToUse;
    img.onload = () => {
      if (banner._pendingMedia !== mediaToUse) return;
      const nextBg = `url("${mediaToUse}")`;
      const cur = banner.querySelector('.banner-image');
      const curBg = cur ? cur.style.backgroundImage : '';
      if (cur && curBg === nextBg) {
        banner.style.opacity = '1';
      } else if (!cur || !curBg || curBg === 'none' || banner.style.opacity !== '1' || document.body.classList.contains('perf')) {
        bannerImg.style.backgroundImage = nextBg;
        banner.style.opacity = '1';
      } else {
        // Crossfade: new layer goes underneath (first in DOM, so querySelector finds it), old one fades out on top.
        banner.querySelectorAll('.banner-image.banner-leaving').forEach(n => n.remove());
        const next = cur.cloneNode(false);
        next.style.backgroundImage = nextBg;
        cur.before(next);
        cur.classList.add('banner-leaving');
        cur.addEventListener('animationend', () => cur.remove(), { once: true });
        setTimeout(() => cur.remove(), 1200);
      }
      if (state.isTvKaraokeOpen) syncTvBanner();
    };
    img.onerror = () => {
      if (trackBanner && state.currentTrack) {
        setTrackArt(state.currentTrack, { banner: undefined });
        updateRightPanelBanner(thumbUrl);
      } else {
        banner.style.opacity = '0';
        if (state.isTvKaraokeOpen) syncTvBanner();
      }
    };
    if (state.isTvKaraokeOpen) syncTvBanner();
  }

  function updatePlaylistDetailBanner(thumbUrl) {
    const banner = document.getElementById('playlist-header-banner');
    if (!banner) return;
    if (!getAdv('banners', true)) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    const bannerImg = banner.querySelector('.banner-image') || banner;
    const globalMedia = localStorage.getItem('muriel_banner_media');
    const mediaToUse = globalMedia || thumbUrl;

    if (!mediaToUse) {
      banner.style.opacity = '0';
      bannerImg.style.backgroundImage = 'none';
      const vid = banner.querySelector('video.banner-video');
      if (vid) vid.remove();
      return;
    }

    const isVideo = /\.(mp4|webm)($|\?)/i.test(mediaToUse);
    if (isVideo) {
      bannerImg.style.backgroundImage = 'none';
      let vid = banner.querySelector('video.banner-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.className = 'banner-video';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        banner.appendChild(vid);
      }
      if (vid.src !== mediaToUse) {
        vid.src = mediaToUse;
        vid.play().catch(() => {});
      }
      banner.style.opacity = '1';
      return;
    }

    const vid = banner.querySelector('video.banner-video');
    if (vid) vid.remove();

    const img = new Image();
    img.src = mediaToUse;
    img.onload = () => {
      bannerImg.style.backgroundImage = `url("${mediaToUse}")`;
      banner.style.opacity = '1';
    };
    img.onerror = () => {
      banner.style.opacity = '0';
    };
  }

  function getTrackCanonicalId(track) {
    if (!track) return '';
    const platform = track.platform || state.platform || 'yt';
    if (track.id) return `${platform}:${track.id}`;
    if (track.url || track.videoId) return `${platform}:${track.url || track.videoId}`;
    const t = (track.title || '').trim().toLowerCase();
    const a = (track.artist || '').trim().toLowerCase();
    const d = Math.round(Number(track.duration) || 0);
    return `${platform}:${t}|${a}|${d}`;
  }

  function isSameTrack(a, b) {
    if (!a || !b) return false;
    return getTrackCanonicalId(a) === getTrackCanonicalId(b);
  }

  function matchesTrackQuery(track, query) {
    if (!query) return true;
    return normalizeSearch(track && track.title).includes(query) || normalizeSearch(track && track.artist).includes(query);
  }

  function getTrackArt(t) {
    try {
      return JSON.parse(localStorage.getItem('muriel_track_art') || '{}')[getTrackCanonicalId(t)] || {};
    } catch (e) {
      return {};
    }
  }

  function setTrackArt(t, patch) {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem('muriel_track_art') || '{}');
    } catch (e) {}
    const id = getTrackCanonicalId(t);
    if (!id) return;
    const cur = { ...(all[id] || {}), ...patch };
    for (const k in cur) if (!cur[k]) delete cur[k];
    if (Object.keys(cur).length) all[id] = cur; else delete all[id];
    localStorage.setItem('muriel_track_art', JSON.stringify(all));
  }

  let crossfadeTriggered = false;
  let crossfadeFadeInPending = false;
  // undoes the Crossfade fade-out of the playing song (a seek back, a pause, a skip, the queue ending)
  function cancelEndFade() {
    if (!crossfadeTriggered) return;
    crossfadeTriggered = false;
    if (audioEngine && audioEngine.masterGain && audioEngine.ctx) {
      try { audioEngine.masterGain.gain.cancelScheduledValues(audioEngine.ctx.currentTime); } catch (e) {}
      audioEngine._applyMasterVolume();
    }
  }

  // ---- Crossfade with overlap (#29) ----
  // The #22 fix let the song fade out to its real end, but the next one only started on 'ended', so Crossfade
  // sounded like no crossfade at all. Now the last X seconds of the song move to a second player (the "tail",
  // the same file opened again and seeked to that point before it's needed), which keeps playing to the song's
  // real end (or its trim end) while fading out; the main player goes on to the next song at once, which fades
  // in. Everything else (queue, now playing, scrobbling, media session) follows the main player as for any
  // next song. Falls back to the plain fade-out when the song can't be opened twice (hls.js / blob sources),
  // and on iPhones, where a player's volume can't be changed (so neither song could fade).
  const xfade = { prep: null, tail: null, handingOver: false, fadeInRaf: 0 };
  const crossfadeSeconds = () => parseInt(localStorage.getItem('muriel_crossfade') || '0', 10) || 0;
  let volumeWorks = null;
  function elementVolumeWorks() {
    if (volumeWorks === null) {
      try { const t = new Audio(); t.volume = 0.5; volumeWorks = Math.abs(t.volume - 0.5) < 0.01; } catch (e) { volumeWorks = false; }
    }
    return volumeWorks;
  }
  function canOverlap(a) {
    if (!a || hlsInstance) return false;
    const src = a.currentSrc || '';
    if (!src || /^(blob|data):/.test(src)) return false;
    return elementVolumeWorks();
  }
  // the level the song plays at: on computers the engine's master volume (the tail skips the effects chain)
  function tailLevel() {
    if (!audioEngine) return 1;
    if (audioEngine.isMuted) return 0;
    if (isPhoneApp) return 1;
    const v = (Number(audioEngine.volume) || 0) * ((audioEngine.audioSettings && Number(audioEngine.audioSettings.volume)) || 1);
    return Math.max(0, Math.min(1, v));
  }
  function disposeTailEl(t) {
    if (!t) return;
    try { t.pause(); t.removeAttribute('src'); t.load(); } catch (e) {}
  }
  function dropCrossfadePrep() {
    const p = xfade.prep;
    xfade.prep = null;
    if (p) { clearTimeout(p.timer); disposeTailEl(p.el); }
  }
  // ends the old song's tail: at its end, or quickly (`fadeSec`) on a skip
  function stopCrossfadeTail(fadeSec = 0) {
    const t = xfade.tail;
    if (!t) return;
    xfade.tail = null;
    clearInterval(t.loop);
    if (!(fadeSec > 0) || t.el.paused) { disposeTailEl(t.el); return; }
    const from = t.el.volume;
    const started = performance.now();
    const step = setInterval(() => {
      const p = (performance.now() - started) / (fadeSec * 1000);
      if (p >= 1) { clearInterval(step); disposeTailEl(t.el); return; }
      try { t.el.volume = from * (1 - p); } catch (e) {}
    }, 30);
  }
  function resumeCrossfadeTail() {
    const t = xfade.tail;
    if (t) Promise.resolve(t.el.play()).then(null, () => { if (xfade.tail === t) stopCrossfadeTail(0); });
  }
  function crossfadeTailRemaining() {
    const t = xfade.tail;
    if (!t) return 0;
    return Math.max(0, (t.end - (t.el.currentTime || 0)) / (t.el.playbackRate || 1));
  }
  // the second player opened at the crossfade point, ready before it's needed
  function prepareCrossfade(point, end) {
    const a = el.nativeAudio;
    dropCrossfadePrep();
    const t = new Audio();
    const p = { el: t, token: state.loadToken, point, end, ready: false, timer: 0 };
    xfade.prep = p;
    try {
      t.preload = 'auto';
      if (a.crossOrigin) t.crossOrigin = a.crossOrigin;
      t.volume = 0;
      t.playbackRate = a.playbackRate;
      if ('preservesPitch' in a) t.preservesPitch = a.preservesPitch;
      if (a.sinkId && typeof t.setSinkId === 'function') t.setSinkId(a.sinkId).catch(() => {});
      t.addEventListener('loadedmetadata', () => { try { t.currentTime = point; } catch (e) {} }, { once: true });
      t.addEventListener('seeked', () => { if (xfade.prep === p) p.ready = true; }, { once: true });
      t.addEventListener('error', () => { if (xfade.prep === p) dropCrossfadePrep(); }, { once: true });
      t.src = a.currentSrc;
    } catch (e) { dropCrossfadePrep(); return; }
    // timeupdate comes only every quarter second or so: a timer starts the overlap on time
    const arm = () => {
      clearTimeout(p.timer);
      const wait = Math.max(0, ((point - (a.currentTime || 0)) / (a.playbackRate || 1)) * 1000);
      p.timer = setTimeout(() => {
        if (xfade.prep !== p) return;
        if ((a.currentTime || 0) < point - 0.03) { arm(); return; }
        startCrossfade();
      }, wait);
    };
    arm();
  }
  // the main player is at the point: the tail takes over the old song, the main player goes on to the next one
  function startCrossfade() {
    const a = el.nativeAudio;
    const p = xfade.prep;
    if (!p || p.started) return;
    p.started = true;
    clearTimeout(p.timer);
    const fallback = () => {
      if (xfade.prep === p) dropCrossfadePrep();
      if (p.token !== state.loadToken || a.paused || crossfadeTriggered) return;
      // the plain fade-out of #22: the song still plays to its end, the next one starts on 'ended'
      crossfadeTriggered = true;
      if (audioEngine) audioEngine.fadeOut(Math.max(0.3, (p.end - a.currentTime) / (a.playbackRate || 1)));
    };
    if (!p.ready || p.token !== state.loadToken || a.paused || state.isRepeat || queueFinished()) { fallback(); return; }
    const t = p.el;
    const level = tailLevel();
    try { t.currentTime = Math.min(p.end, a.currentTime + 0.02); } catch (e) {}
    t.volume = 0; // silent until the main player lets go, or the two would play the same seconds twice
    const played = t.play();
    Promise.resolve(played).then(() => {
      if (xfade.prep !== p || p.token !== state.loadToken || a.paused) { if (xfade.prep === p) dropCrossfadePrep(); else disposeTailEl(t); return; }
      xfade.prep = null;
      stopCrossfadeTail(0);
      t.volume = level;
      const tail = { el: t, end: p.end, point: p.point, level, loop: 0 };
      xfade.tail = tail;
      // fade out along the song's own time, so a pause holds the fade where it is
      tail.loop = setInterval(() => {
        if (xfade.tail !== tail) { clearInterval(tail.loop); return; }
        const cur = t.currentTime || 0;
        if (t.ended || cur >= tail.end - 0.02) { stopCrossfadeTail(0); return; }
        try { t.volume = tail.level * window.MurielTrim.fadeOutGain((cur - tail.point) / (tail.end - tail.point)); } catch (e) {}
      }, 40);
      crossfadeFadeInPending = true;
      xfade.handingOver = true;
      state._isNaturalEnding = true;
      try { playNext(); } finally { state._isNaturalEnding = false; xfade.handingOver = false; }
    }, () => fallback());
  }
  // the next song fades in while the tail fades out: through the engine on computers, the volume on phones
  function crossfadeFadeIn() {
    const X = crossfadeSeconds();
    const secs = Math.max(0.5, crossfadeTailRemaining() || X / 2);
    if (!isPhoneApp) { if (X > 0 && audioEngine) audioEngine.fadeIn(secs); return; }
    if (!elementVolumeWorks()) return;
    const a = el.nativeAudio;
    const started = performance.now();
    cancelAnimationFrame(xfade.fadeInRaf);
    const tick = () => {
      const p = (performance.now() - started) / (secs * 1000);
      try { a.volume = p >= 1 ? 1 : window.MurielTrim.fadeInGain(p); } catch (e) {}
      if (p < 1) xfade.fadeInRaf = requestAnimationFrame(tick);
    };
    // a timer, not only frames: a phone with the screen off draws none
    const timer = setInterval(() => { if (performance.now() - started > secs * 1000) { clearInterval(timer); try { a.volume = 1; } catch (e) {} } }, 250);
    tick();
  }
  // anything but the crossfade itself starting a song (a skip, a pick, Previous) ends the tail quickly
  function crossfadeOnTrackChange() {
    dropCrossfadePrep();
    if (xfade.handingOver) {
      // the next song starts silent and fades in once it plays ('playing' -> crossfadeFadeIn)
      if (isPhoneApp && elementVolumeWorks()) { try { el.nativeAudio.volume = 0; } catch (e) {} }
      else if (audioEngine && audioEngine.masterGain && audioEngine.ctx) {
        try { audioEngine.masterGain.gain.cancelScheduledValues(audioEngine.ctx.currentTime); audioEngine.masterGain.gain.setValueAtTime(0.001, audioEngine.ctx.currentTime); } catch (e) {}
      }
      return;
    }
    stopCrossfadeTail(0.25);
    cancelAnimationFrame(xfade.fadeInRaf);
    // a song that ended after the plain fade-out still fades the next one in ('ended' set it)
    if (state._isNaturalEnding) return;
    crossfadeFadeInPending = false;
    if (isPhoneApp && elementVolumeWorks()) { try { el.nativeAudio.volume = 1; } catch (e) {} }
  }
  let currentAlbumPlayRunId = 0;

  function pushPlayHistory(track) {
    if (!track) return;
    const h = state.playHistory || (state.playHistory = []);
    if (h.length && h[h.length - 1].id === track.id) return;
    h.push(track);
    if (h.length > 100) h.shift();
  }
  let navigatingBack = false;

  const shuffleBag = { queue: null, played: new Set(), next: [] }; // see pickShuffleIndex

  // A song that can't be played used to stop a whole playlist. When playing through a list (or after Next)
  // it is skipped instead; several failures in a row (offline, say) still stop.
  const SKIP_CONTEXTS = new Set(['playlist', 'favorites', 'album', 'queue', 'history', 'local', 'artist']);
  let advancing = false; // true while playNext starts the next song
  let skipOnFailToken = -1; // loadToken of the song that gets skipped if it fails
  let failStreak = 0;
  // true from the moment a song is asked for until it plays (or fails for good). Nothing is audible in
  // between, so the phone apps keep themselves running on this (mobile/background-audio.js, media-controls.js).
  function setTrackLoading(on) {
    if (!!state.trackLoading === on) return;
    state.trackLoading = on;
    window.dispatchEvent(new Event('muriel:loading'));
  }
  // every failure path asks this; a false answer means nothing else will be loaded, so loading is over
  function skipUnplayable(token, track) {
    if (token !== state.loadToken) return false;
    if (token !== skipOnFailToken) { setTrackLoading(false); return false; }
    if (state.queue.length < 2 || failStreak >= Math.min(5, state.queue.length - 1)) { failStreak = 0; setTrackLoading(false); return false; }
    failStreak++;
    showToast(track && track.title ? Tm('Couldn\'t play "{0}", playing the next one', track.title) : Tm("Couldn't play this song, playing the next one"), 'info');
    setTimeout(() => { if (token === state.loadToken) playNext(); }, 1200);
    return true;
  }

  async function playTrack(track, queueList = null, startIndex = -1, context = null) {
    if (!track || !el.nativeAudio) return;
    resetLevelWatcher();
    vizPrev = null;
    if (state.currentTrack && state.currentTrack.id !== track.id && !navigatingBack) pushPlayHistory(state.currentTrack);

    if (!state._isNaturalEnding && state.myWaveActive && state.currentTrack && !isSameTrack(state.currentTrack, track)) {
      const curId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id;
      if (state._skipRecordedFor !== curId) {
        const cur = (el.nativeAudio && typeof el.nativeAudio.currentTime === 'number') ? el.nativeAudio.currentTime : 0;
        if (cur < 12 && typeof recordWaveSkip === 'function') {
          recordWaveSkip(state.currentTrack);
        }
      }
    }
    state._skipRecordedFor = null;

    if (context !== 'album') currentAlbumPlayRunId++;
    cancelEndFade();
    crossfadeOnTrackChange();
    state.nextTrackPrefetched = false;
    initAudioContext();
    el.nativeAudio.preload = 'auto';

    try {
      el.nativeAudio.pause();
      el.nativeAudio.removeAttribute('src');
      el.nativeAudio.load();
    } catch (e) {}

    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) {}
      hlsInstance = null;
    }

    state.isPlaying = false;
    updatePlayPauseButton(false, true);
    sendStateToServer();

    if (el.lyricsContainer) el.lyricsContainer.scrollTop = 0;
    if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
      cancelAnimationFrame(lyricsScrollRaf);
      lyricsScrollRaf = 0;
    }
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;

    if (el.timeCurrent) el.timeCurrent.textContent = '0:00';
    if (el.timeDuration) el.timeDuration.textContent = formatDuration(track.duration || 0);
    scrubPrevKnobX = null;
    scrubProgress = 0;

    if (el.trackLoadingOverlay) {
      if (el.trackLoadingTitle) el.trackLoadingTitle.textContent = track.title || T('loading track...');
      if (el.trackLoadingSub) I18N.text(el.trackLoadingSub, track.artist ? '{0} • buffering stream' : 'buffering audio stream', track.artist);
      el.trackLoadingOverlay.classList.remove('hidden');
    }

    state.loadToken++;
    const currentToken = state.loadToken;
    if (advancing || SKIP_CONTEXTS.has(context)) skipOnFailToken = currentToken;
    setTrackLoading(true);

    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;

    state.currentTrack = track;
    emitPluginEvent('trackchange', track);
    onTrackAudioTrackChange();
    state.currentTrackContext = context;
    state.currentTrackIndexInContext = startIndex;

    if (queueList) {
      state.queue = [...queueList];
      shuffleBag.next = [];
      if (startIndex >= 0 && startIndex < state.queue.length && isSameTrack(state.queue[startIndex], track)) {
        state.queueIndex = startIndex;
      } else {
        state.queueIndex = state.queue.findIndex(t => isSameTrack(t, track));
      }
      if (state.queueIndex === -1) {
        state.queue.unshift(track);
        state.queueIndex = 0;
      }
      state.queueHistory = [state.queueIndex];
    } else {
      const existingIndex = state.queue.findIndex(t => isSameTrack(t, track));
      if (existingIndex === -1) {
        state.queue.push(track);
        state.queueIndex = state.queue.length - 1;
      } else {
        state.queueIndex = existingIndex;
      }
      state.queueHistory = [state.queueIndex];
    }
    updateQueueBadge();

    track.playedAt = Date.now();
    state.history = state.history.filter(t => !isSameTrack(t, track));
    state.history.unshift(track);
    if (state.history.length > 100) state.history.pop();
    localStorage.setItem('devsize_history', JSON.stringify(state.history));
    if (state.currentView === 'history') renderHistoryView();

    updateNowPlayingUI(track);
    updatePlayPauseButton(false, true);

    loadSyncedLyrics(track.title, track.artist, currentToken);

    try {
      if (track.platform === 'local') {
        const streamUrl = tokenUrl(`http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(track.id)}`);
        if (currentToken !== state.loadToken) return;
        el.nativeAudio.preload = 'auto';
        el.nativeAudio.src = streamUrl;
        playSmooth();
        applyAudioSettings();
        return;
      }

      let resolvedUrl = track.url;
      let resolvedId = track.id;

      if ((!resolvedUrl && !resolvedId) || (resolvedUrl && resolvedUrl.includes('/results?search_query='))) {
        if (track.searchQuery) {
          try {
            const searchRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(track.searchQuery)}&platform=youtube&limit=1`, { signal });
            const sData = await searchRes.json();
            if (sData.success && sData.tracks && sData.tracks[0]) {
              resolvedUrl = sData.tracks[0].url;
              resolvedId = sData.tracks[0].id;
              state.currentTrack.id = resolvedId;
              state.currentTrack.url = resolvedUrl;
              if (!state.currentTrack.thumbnail && sData.tracks[0].thumbnail) state.currentTrack.thumbnail = sData.tracks[0].thumbnail;
            }
          } catch (e) {}
        }
      }

      if (!await attachStream(track, resolvedUrl, resolvedId, currentToken, signal, false)) return;
      applyAudioSettings();
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (currentToken === state.loadToken) {
        logPlaybackIssue('Track playback notice', err);
        if (retryFresh(currentToken, track)) return;
        updatePlayPauseButton(false, false);
        if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
        if (!skipUnplayable(currentToken, track)) showToast(err.message || Tm('Could not load audio stream'), 'error');
      }
    }
  }

  // Looks the song up (/api/stream-info) and gives its stream to the audio element. Resolves false when
  // another song was started meanwhile; throws when there is nothing to play.
  async function attachStream(track, resolvedUrl, resolvedId, currentToken, signal, fresh) {
    const streamInfoUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(resolvedUrl || '')}&id=${encodeURIComponent(resolvedId || '')}${fresh ? '&fresh=1' : ''}&platform=${track.platform || state.platform}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&thumbnail=${encodeURIComponent(track.thumbnail || '')}`;
    const res = await fetch(streamInfoUrl, { signal });
    const data = await res.json();

    if (currentToken !== state.loadToken) return false;

    if (!data || !data.success || !data.streamUrl) {
      if (!navigator.onLine) {
        showToast(Tm('Offline: this track is not available in local cache'));
        throw new Error('Offline: track not cached locally');
      }
      throw new Error((data && data.error) || 'Failed to extract audio stream');
    }

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    el.nativeAudio.preload = 'auto';

    if (data.isHls && window.Hls && Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000 });
      hlsInstance.loadSource(data.streamUrl);
      hlsInstance.attachMedia(el.nativeAudio);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (currentToken === state.loadToken) {
          playSmooth();
        }
      });
      // without this a dead HLS stream just sat on the loading spinner
      hlsInstance.on(Hls.Events.ERROR, (evt, info) => {
        if (!info || !info.fatal || currentToken !== state.loadToken) return;
        const hls = hlsInstance;
        if (info.type === Hls.ErrorTypes.MEDIA_ERROR && !hls._murielRecovered) {
          hls._murielRecovered = true;
          try { hls.recoverMediaError(); return; } catch (e) {}
        }
        try { hls.destroy(); } catch (e) {}
        if (hlsInstance === hls) hlsInstance = null;
        state.isPlaying = false;
        document.body.classList.remove('is-playing');
        updatePlayPauseButton(false, false);
        if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
        if (retryFresh(currentToken, track)) return;
        if (!skipUnplayable(currentToken, track)) showToast(Tm('Could not play this song. Try again or skip.'), 'error');
      });
    } else {
      // #17: a YouTube media URL is bound to the player client yt-dlp resolved it with; Chromium fetching it
      // with its own headers got "Format error" (code 4). On desktop it plays through the local proxy,
      // which fetches with yt-dlp's headers; the direct URL stays as a fallback.
      const src = pickStreamSrc(data);
      proxyFallback = src !== data.streamUrl ? null : { token: currentToken, track, url: data.proxyUrl || '' };
      el.nativeAudio.src = src;
      playSmooth();
    }
    return true;
  }

  function isGoogleVideoUrl(u) {
    try { const h = new URL(u).hostname; return h === 'googlevideo.com' || h.endsWith('.googlevideo.com'); } catch (e) { return false; }
  }
  // the src the audio element gets for a /api/stream-info answer (same rule as stream-source.js): phones
  // play downloaded files and keep the URL they were given
  function pickStreamSrc(data) {
    const isMobile = !!(window.electronAPI && window.electronAPI.isMobile);
    if (!isMobile && !data.isHls && !data.isLocal && data.proxyUrl && isGoogleVideoUrl(data.streamUrl)) return data.proxyUrl;
    return data.streamUrl;
  }
  // a direct (not proxied) stream that failed to load is tried once through the local proxy before a fresh lookup
  let proxyFallback = null;
  function tryProxyFallback(token, track) {
    const fb = proxyFallback;
    proxyFallback = null;
    if (!fb || !fb.url || fb.token !== token || token !== state.loadToken || fb.track !== track || track !== state.currentTrack) return false;
    if (window.electronAPI && window.electronAPI.isMobile) return false;
    const me = el.nativeAudio.error;
    if (!me || (me.code !== 4 && me.code !== 2)) return false;
    console.warn('Track playback: direct stream failed, trying the local proxy');
    el.nativeAudio.src = fb.url;
    playSmooth();
    return true;
  }

  // A song that fails the first time (the lookup, the audio element on its URL, or nothing arriving) is
  // looked up once more, afresh, before the listener is told: the first failure was usually passing (a
  // shared lookup that failed, a remembered stream URL YouTube no longer serves) and Retry then played it.
  let freshRetryToken = -1;
  // One line for the console and the app log: what failed, with the DOMException's name and message and
  // the audio element's state (error code, readyState, networkState, which host it was loading from).
  function describeMediaState(audio) {
    if (!audio) return 'no audio element';
    let host = '';
    try { const s = audio.currentSrc || audio.src; host = s ? new URL(s).host : '(none)'; } catch (e) { host = '(bad url)'; }
    const me = audio.error;
    return `mediaError=${me ? me.code + (me.message ? ' ' + me.message : '') : 'none'} readyState=${audio.readyState} networkState=${audio.networkState} paused=${audio.paused} src=${host}${hlsInstance ? ' hls' : ''}`;
  }
  function logPlaybackIssue(what, err) {
    const desc = err ? `${err.name || 'Error'}: ${err.message || String(err)}` : 'no details';
    const line = `${what}: ${desc} | ${describeMediaState(el.nativeAudio)} | load=${state.loadToken}`;
    console.warn(line);
    try { if (window.__riffLogError) window.__riffLogError('WARN', line, null); } catch (e) {}
    return line;
  }
  function retryFresh(token, track) {
    if (token !== state.loadToken || freshRetryToken === token || !state.trackLoading || !track || track !== state.currentTrack || track.platform === 'local') return false;
    if (!navigator.onLine) return false;
    freshRetryToken = token;
    console.warn('Track playback: retrying with a fresh lookup');
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
    try { el.nativeAudio.pause(); el.nativeAudio.removeAttribute('src'); el.nativeAudio.load(); } catch (e) {}
    setTrackLoading(true);
    if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.remove('hidden');
    const signal = state.currentAbortController ? state.currentAbortController.signal : undefined;
    attachStream(track, track.url, track.id, token, signal, true).then((ok) => { if (ok) applyAudioSettings(); }, (err) => {
      if (err && err.name === 'AbortError') return;
      if (token !== state.loadToken) return;
      logPlaybackIssue('Track playback notice (fresh retry)', err);
      updatePlayPauseButton(false, false);
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      if (!skipUnplayable(token, track)) showToast((err && err.message) || Tm('Could not load audio stream'), 'error');
    });
    return true;
  }

  function flipAnimate(elements, mutateFn, duration = 380) {
    const validElements = (elements || []).filter(item => item && item.getBoundingClientRect);
    const firstRects = new Map();
    validElements.forEach(item => {
      firstRects.set(item, item.getBoundingClientRect());
    });

    validElements.forEach(item => {
      item.style.transition = 'none';
      item.style.transform = 'none';
    });

    if (typeof mutateFn === 'function') {
      mutateFn();
    }

    const animatingElements = [];
    validElements.forEach(item => {
      const first = firstRects.get(item);
      const last = item.getBoundingClientRect();
      if (!first || !last) return;
      if ((first.width === 0 && first.height === 0) || (last.width === 0 && last.height === 0)) return;

      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        item.style.transform = `translate(${dx}px, ${dy}px)`;
        animatingElements.push(item);
      } else {
        item.style.transform = '';
        item.style.transition = '';
      }
    });

    if (animatingElements.length === 0) return;

    animatingElements.forEach(item => item.offsetHeight);

    requestAnimationFrame(() => {
      animatingElements.forEach(item => {
        item.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;
        item.style.transform = '';

        let cleaned = false;
        const cleanUp = () => {
          if (cleaned) return;
          cleaned = true;
          item.removeEventListener('transitionend', onEnd);
          item.style.transition = '';
          item.style.transform = '';
        };
        const onEnd = (e) => {
          if (e.target !== item || e.propertyName !== 'transform') return;
          cleanUp();
        };
        item.addEventListener('transitionend', onEnd);
        setTimeout(cleanUp, duration + 50);
      });
    });
  }

  function setLyricsEmpty(isEmpty) {
    const panel = el.rightPanel || document.getElementById('right-panel');
    if (!panel) return;
    const currentlyEmpty = panel.classList.contains('lyrics-empty');
    if (currentlyEmpty === !!isEmpty) {
      syncTvLayout();
      return;
    }

    const hero = el.rightPanelArtworkBox || document.getElementById('right-panel-artwork-box');

    flipAnimate([hero], () => {
      panel.classList.toggle('lyrics-empty', !!isEmpty);
      syncTvLayout();
    }, 380);
    syncTvLayout(!!isEmpty);
  }

  async function loadSyncedLyrics(title, artist, token) {
    if (el.lyricsContainer) {
      el.lyricsContainer.scrollTop = 0;
      el.lyricsContainer.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
      el.lyricsContainer.style.opacity = '0';
    }
    if (typeof lyricsScrollRaf !== 'undefined' && lyricsScrollRaf) {
      cancelAnimationFrame(lyricsScrollRaf);
      lyricsScrollRaf = 0;
    }
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    state.syncedLyrics = [];
    state.isCustomLyrics = false;
    // the previous song's translations were shown under the new song's lines until its own translation loaded
    state.currentTranslations = null;
    // the iPhone lock screen / Dynamic Island lyrics (mobile/live-activity.js) follow state.syncedLyrics
    window.dispatchEvent(new Event('muriel:lyrics'));
    renderMiniLyrics();

    try {
      // skipping through songs fired one lookup (several lrclib requests) per song and got rate limited
      await new Promise(r => setTimeout(r, 350));
      if (token !== state.loadToken) return;
      const onlineParam = getAdv('online_lyrics', true) ? '1' : '0';
      const dur = state.currentTrack && (state.currentTrack.title || '') === title ? Math.round(Number(state.currentTrack.duration) || 0) : 0;
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&online=${onlineParam}${dur ? `&duration=${dur}` : ''}&source=${lyricsSourcePref()}`);
      const data = await res.json();

      if (token !== state.loadToken || (state.currentTrack && (state.currentTrack.title || '') !== title)) return;

      if (!data.success || !data.lyrics) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.scrollTop = 0;
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
        return;
      }

      state.isCustomLyrics = !!data.isCustom;

      const raw = data.lyrics;
      const lines = raw.split('\n');
      const parsed = [];
      const lrcRegex = /\[(\d+):(\d+(\.\d+)?)\](.*)/;

      for (const line of lines) {
        const match = lrcRegex.exec(line);
        if (match) {
          const min = parseInt(match[1], 10);
          const sec = parseFloat(match[2]);
          const raw = match[4].trim();
          // enhanced LRC: <mm:ss.xx> before each word gives that word its own time
          const words = raw.includes('<') && window.MurielLyricsSources ? window.MurielLyricsSources.parseEnhancedLrcWords(raw, min * 60 + sec + 4) : null;
          const text = words ? raw.replace(/<\d+:\d+(?:\.\d+)?>/g, '').replace(/\s+/g, ' ').trim() : raw;
          if (text) {
            parsed.push(words ? { time: min * 60 + sec, text, words } : { time: min * 60 + sec, text: text });
          }
        } else if (line.trim()) {
          parsed.push({ time: -1, text: line.trim() });
        }
      }

      if (parsed.length === 0) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.scrollTop = 0;
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
        return;
      }

      state.syncedLyrics = parsed;
      window.dispatchEvent(new Event('muriel:lyrics'));
      const hasSyncTimes = parsed.some(p => p.time >= 0);
      if (el.lyricsStatus) el.lyricsStatus.textContent = data.isCustom ? (hasSyncTimes ? 'Custom synced' : 'Custom') : (hasSyncTimes ? 'Synced' : 'Plain');
      if (state.trEnabled && state.trAuto) {
        state.trActive = true;
        fetchAndApplyTranslation();
      } else {
        state.trActive = false;
        state.currentTranslations = null;
      }
      updateLyricsTranslationUI();
      renderLyricsView();
      setLyricsEmpty(false);
      if (el.lyricsContainer) {
        el.lyricsContainer.scrollTop = 0;
        el.lyricsContainer.style.opacity = '0';
        requestAnimationFrame(() => {
          el.lyricsContainer.style.transition = 'opacity 250ms cubic-bezier(0.2, 0, 0, 1)';
          el.lyricsContainer.style.opacity = '1';
        });
      }
      state.lastActiveLyricIdx = -1;
      state.forceLyricsScroll = true;
      state.forceSnapLyrics = true;
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      if (!data.isCustom) fetchAndUpgradeWords(title, artist, token);
    } catch (e) {
      if (token === state.loadToken) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
      }
    }
  }

  function getLyricsWordStyle() { return localStorage.getItem('muriel_lyrics_word_style') === 'words' ? 'words' : 'gradient'; }
  function isGradientMode() { return state.lyricsMode === 'word' && getAdv('karaoke_words', true) && getLyricsWordStyle() === 'gradient'; }

  function renderLyricsView() {
    if (!el.lyricsContainer) return;
    if (state.syncedLyrics.length === 0) return;
    el.lyricsContainer.innerHTML = '';

    state.syncedLyrics.forEach((line, index) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.id = `lyric-line-${index}`;
      if (isRtlText(line.text)) div.classList.add('rtl');

      if (isGradientMode()) {
        const fill = document.createElement('span');
        fill.className = 'lyric-fill';
        fill.textContent = line.text.replace(/<[^>]+>/g, '').trim();
        div.classList.add('gradient-line');
        div.appendChild(fill);
      } else if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        div.innerHTML = lyricWordSpans(line);
      } else {
        div.textContent = line.text;
      }

      if (state.trActive && state.currentTranslations && state.currentTranslations[index]) {
        const trDiv = document.createElement('div');
        trDiv.className = 'lyric-translation';
        trDiv.dir = 'auto';
        trDiv.textContent = state.currentTranslations[index];
        div.appendChild(trDiv);
      }

      if (line.time >= 0) {
        div.addEventListener('click', () => {
          const seekTime = getLineStartTime(index);
          if (el.nativeAudio && seekTime >= 0) el.nativeAudio.currentTime = seekTime;
        });
      }
      el.lyricsContainer.appendChild(div);
    });
    updateLyricsPadding();
    state.lastActiveLyricIdx = -1;
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  }

  function updateLyricsPadding() {
    const c = el.lyricsContainer;
    if (!c || !c.clientHeight) return;
    const pad = Math.round(c.clientHeight * 0.42);
    c.style.paddingTop = `${pad}px`;
    c.style.paddingBottom = `${pad}px`;
  }
  window.addEventListener('resize', () => {
    updateLyricsPadding();
    state.forceLyricsScroll = true;
    state.forceSnapLyrics = true;
    state.lastActiveLyricIdx = -1;
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  });
  if (window.ResizeObserver && el.lyricsContainer) {
    let lastObservedH = 0;
    new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect?.height || el.lyricsContainer.clientHeight || 0);
      if (h <= 0) {
        lastObservedH = 0;
        return;
      }
      if (Math.abs(h - lastObservedH) > 4) {
        lastObservedH = h;
        updateLyricsPadding();
        state.forceLyricsScroll = true;
        state.forceSnapLyrics = true;
        state.lastActiveLyricIdx = -1;
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    }).observe(el.lyricsContainer);
  }

  const TRANSLATION_LANGUAGES = [
    { code: 'af', name: 'Afrikaans', flag: '🇿🇦' },
    { code: 'sq', name: 'Albanian', flag: '🇦🇱' },
    { code: 'am', name: 'Amharic', flag: '🇪🇹' },
    { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
    { code: 'hy', name: 'Armenian', flag: '🇦🇲' },
    { code: 'as', name: 'Assamese', flag: '🇮🇳' },
    { code: 'ay', name: 'Aymara', flag: '🇧🇴' },
    { code: 'az', name: 'Azerbaijani', flag: '🇦🇿' },
    { code: 'bm', name: 'Bambara', flag: '🇲🇱' },
    { code: 'eu', name: 'Basque', flag: '🇪🇸' },
    { code: 'be', name: 'Belarusian', flag: '🇧🇾' },
    { code: 'bn', name: 'Bengali', flag: '🇧🇩' },
    { code: 'bho', name: 'Bhojpuri', flag: '🇮🇳' },
    { code: 'bs', name: 'Bosnian', flag: '🇧🇦' },
    { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
    { code: 'ca', name: 'Catalan', flag: '🇪🇸' },
    { code: 'ceb', name: 'Cebuano', flag: '🇵🇭' },
    { code: 'ny', name: 'Chichewa', flag: '🇲🇼' },
    { code: 'zh-CN', name: 'Chinese (Simplified)', flag: '🇨🇳' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', flag: '🇹🇼' },
    { code: 'co', name: 'Corsican', flag: '🇫🇷' },
    { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
    { code: 'cs', name: 'Czech', flag: '🇨🇿' },
    { code: 'da', name: 'Danish', flag: '🇩🇰' },
    { code: 'dv', name: 'Dhivehi', flag: '🇲🇻' },
    { code: 'doi', name: 'Dogri', flag: '🇮🇳' },
    { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'eo', name: 'Esperanto', flag: '🌐' },
    { code: 'et', name: 'Estonian', flag: '🇪🇪' },
    { code: 'ee', name: 'Ewe', flag: '🇬🇭' },
    { code: 'tl', name: 'Filipino', flag: '🇵🇭' },
    { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'fy', name: 'Frisian', flag: '🇳🇱' },
    { code: 'gl', name: 'Galician', flag: '🇪🇸' },
    { code: 'ka', name: 'Georgian', flag: '🇬🇪' },
    { code: 'de', name: 'German', flag: '🇩🇪' },
    { code: 'el', name: 'Greek', flag: '🇬🇷' },
    { code: 'gn', name: 'Guarani', flag: '🇵🇾' },
    { code: 'gu', name: 'Gujarati', flag: '🇮🇳' },
    { code: 'ht', name: 'Haitian Creole', flag: '🇭🇹' },
    { code: 'ha', name: 'Hausa', flag: '🇳🇬' },
    { code: 'haw', name: 'Hawaiian', flag: '🇺🇸' },
    { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
    { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    { code: 'hmn', name: 'Hmong', flag: '🇱🇦' },
    { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
    { code: 'is', name: 'Icelandic', flag: '🇮🇸' },
    { code: 'ig', name: 'Igbo', flag: '🇳🇬' },
    { code: 'ilo', name: 'Ilocano', flag: '🇵🇭' },
    { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
    { code: 'ga', name: 'Irish', flag: '🇮🇪' },
    { code: 'it', name: 'Italian', flag: '🇮🇹' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
    { code: 'jw', name: 'Javanese', flag: '🇮🇩' },
    { code: 'kn', name: 'Kannada', flag: '🇮🇳' },
    { code: 'kk', name: 'Kazakh', flag: '🇰🇿' },
    { code: 'km', name: 'Khmer', flag: '🇰🇭' },
    { code: 'rw', name: 'Kinyarwanda', flag: '🇷🇼' },
    { code: 'gom', name: 'Konkani', flag: '🇮🇳' },
    { code: 'ko', name: 'Korean', flag: '🇰🇷' },
    { code: 'kri', name: 'Krio', flag: '🇸🇱' },
    { code: 'ku', name: 'Kurdish (Kurmanji)', flag: '🇹🇷' },
    { code: 'ckb', name: 'Kurdish (Sorani)', flag: '🇮🇶' },
    { code: 'ky', name: 'Kyrgyz', flag: '🇰🇬' },
    { code: 'lo', name: 'Lao', flag: '🇱🇦' },
    { code: 'la', name: 'Latin', flag: '🏛️' },
    { code: 'lv', name: 'Latvian', flag: '🇱🇻' },
    { code: 'ln', name: 'Lingala', flag: '🇨🇩' },
    { code: 'lt', name: 'Lithuanian', flag: '🇱🇹' },
    { code: 'lg', name: 'Luganda', flag: '🇺🇬' },
    { code: 'lb', name: 'Luxembourgish', flag: '🇱🇺' },
    { code: 'mk', name: 'Macedonian', flag: '🇲🇰' },
    { code: 'mai', name: 'Maithili', flag: '🇮🇳' },
    { code: 'mg', name: 'Malagasy', flag: '🇲🇬' },
    { code: 'ms', name: 'Malay', flag: '🇲🇾' },
    { code: 'ml', name: 'Malayalam', flag: '🇮🇳' },
    { code: 'mt', name: 'Maltese', flag: '🇲🇹' },
    { code: 'mi', name: 'Maori', flag: '🇳🇿' },
    { code: 'mr', name: 'Marathi', flag: '🇮🇳' },
    { code: 'mni-Mtei', name: 'Meiteilon (Manipuri)', flag: '🇮🇳' },
    { code: 'lus', name: 'Mizo', flag: '🇮🇳' },
    { code: 'mn', name: 'Mongolian', flag: '🇲🇳' },
    { code: 'my', name: 'Myanmar (Burmese)', flag: '🇲🇲' },
    { code: 'ne', name: 'Nepali', flag: '🇳🇵' },
    { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
    { code: 'or', name: 'Odia (Oriya)', flag: '🇮🇳' },
    { code: 'om', name: 'Oromo', flag: '🇪🇹' },
    { code: 'ps', name: 'Pashto', flag: '🇦🇫' },
    { code: 'fa', name: 'Persian', flag: '🇮🇷' },
    { code: 'pl', name: 'Polish', flag: '🇵🇱' },
    { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
    { code: 'pa', name: 'Punjabi', flag: '🇮🇳' },
    { code: 'qu', name: 'Quechua', flag: '🇵🇪' },
    { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
    { code: 'ru', name: 'Russian', flag: '🇷🇺' },
    { code: 'sm', name: 'Samoan', flag: '🇼🇸' },
    { code: 'sa', name: 'Sanskrit', flag: '🇮🇳' },
    { code: 'gd', name: 'Scots Gaelic', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
    { code: 'sr', name: 'Serbian', flag: '🇷🇸' },
    { code: 'st', name: 'Sesotho', flag: '🇱🇸' },
    { code: 'sn', name: 'Shona', flag: '🇿🇼' },
    { code: 'sd', name: 'Sindhi', flag: '🇵🇰' },
    { code: 'si', name: 'Sinhala', flag: '🇱🇰' },
    { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
    { code: 'sl', name: 'Slovenian', flag: '🇸🇮' },
    { code: 'so', name: 'Somali', flag: '🇸🇴' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'su', name: 'Sundanese', flag: '🇮🇩' },
    { code: 'sw', name: 'Swahili', flag: '🇰🇪' },
    { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
    { code: 'tg', name: 'Tajik', flag: '🇹🇯' },
    { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
    { code: 'tt', name: 'Tatar', flag: '🇷🇺' },
    { code: 'te', name: 'Telugu', flag: '🇮🇳' },
    { code: 'th', name: 'Thai', flag: '🇹🇭' },
    { code: 'ti', name: 'Tigrinya', flag: '🇪🇷' },
    { code: 'ts', name: 'Tsonga', flag: '🇿🇦' },
    { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
    { code: 'tk', name: 'Turkmen', flag: '🇹🇲' },
    { code: 'ak', name: 'Twi (Akan)', flag: '🇬🇭' },
    { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
    { code: 'ur', name: 'Urdu', flag: '🇵🇰' },
    { code: 'ug', name: 'Uyghur', flag: '🇨🇳' },
    { code: 'uz', name: 'Uzbek', flag: '🇺🇿' },
    { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
    { code: 'cy', name: 'Welsh', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
    { code: 'xh', name: 'Xhosa', flag: '🇿🇦' },
    { code: 'yi', name: 'Yiddish', flag: '🇮🇱' },
    { code: 'yo', name: 'Yoruba', flag: '🇳🇬' },
    { code: 'zu', name: 'Zulu', flag: '🇿🇦' }
  ];

  const lyricsTranslationCache = new Map();

  async function fetchAndApplyTranslation() {
    if (!state.currentTrack || !state.syncedLyrics || state.syncedLyrics.length === 0) return;
    const track = state.currentTrack;
    const lang = state.trLang || 'en';
    const cacheKey = `${track.title || ''}|${track.artist || ''}|${lang}`.toLowerCase();

    if (lyricsTranslationCache.has(cacheKey)) {
      state.currentTranslations = lyricsTranslationCache.get(cacheKey);
      renderLyricsView();
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      return;
    }

    const texts = state.syncedLyrics.map(l => l.text);
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, targetLang: lang })
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.translations)) {
        lyricsTranslationCache.set(cacheKey, data.translations);
        capMap(lyricsTranslationCache, 30);
        const curKey = `${(state.currentTrack && state.currentTrack.title) || ''}|${(state.currentTrack && state.currentTrack.artist) || ''}|${state.trLang || 'en'}`.toLowerCase();
        if (curKey === cacheKey && state.trActive) {
          state.currentTranslations = data.translations;
          renderLyricsView();
          if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
        }
      }
    } catch (e) {
      console.error('Translation error:', e);
    }
  }

  function updateLyricsTranslationUI() {
    if (el.btnTrEnabled) el.btnTrEnabled.classList.toggle('active', !!state.trEnabled);
    if (el.selectTrLang) el.selectTrLang.value = state.trLang || 'en';
    const trLangMenu = document.getElementById('tr-lang-menu');
    const trLangLabel = document.getElementById('tr-lang-label');
    const curLang = state.trLang || 'en';
    if (trLangMenu) {
      trLangMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        const isSel = opt.dataset.value === curLang;
        opt.classList.toggle('selected', isSel);
        if (isSel && trLangLabel) trLangLabel.textContent = opt.textContent;
      });
    }
    if (trLangLabel && (!trLangMenu || !trLangMenu.querySelector('.m3-dropdown-option.selected'))) {
      const found = TRANSLATION_LANGUAGES.find(l => l.code === curLang);
      if (found) trLangLabel.textContent = `${found.flag} ${found.name} (${found.code})`;
    }
    if (el.btnTrAuto) el.btnTrAuto.classList.toggle('active', !!state.trAuto);
    if (el.btnTranslateLyrics) {
      el.btnTranslateLyrics.classList.toggle('hidden', !state.trEnabled);
      el.btnTranslateLyrics.classList.toggle('active', !!state.trActive);
    }
  }

  const CUSTOM_SHIFT_LEAD_SECONDS = 4.0;

  function getLineStartTime(idx) {
    const lines = state.syncedLyrics;
    if (idx < 0 || idx >= lines.length) return -1;
    const raw = lines[idx].time;
    if (raw < 0) return -1;
    if (!state.isCustomLyrics) return raw;
    for (let j = idx - 1; j >= 0; j--) {
      if (lines[j].time >= 0) return lines[j].time;
    }
    return Math.max(0, raw - CUSTOM_SHIFT_LEAD_SECONDS);
  }

  function getLineEndTime(idx) {
    const start = getLineStartTime(idx);
    const lines = state.syncedLyrics;
    for (let j = idx + 1; j < lines.length; j++) {
      const t = getLineStartTime(j);
      if (t >= 0) return t;
    }
    return start + 4.0;
  }

  const LYRIC_EASINGS = {
    inout: { css: 'cubic-bezier(0.65, 0, 0.35, 1)', fn: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) },
    quad: { css: 'cubic-bezier(0.45, 0, 0.55, 1)', fn: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) },
    sine: { css: 'cubic-bezier(0.37, 0, 0.63, 1)', fn: (t) => -(Math.cos(Math.PI * t) - 1) / 2 },
    out: { css: 'cubic-bezier(0.22, 1, 0.36, 1)', fn: (t) => 1 - Math.pow(1 - t, 4) },
    outsine: { css: 'cubic-bezier(0.39, 0.575, 0.565, 1)', fn: (t) => Math.sin((t * Math.PI) / 2) },
    expo: { css: 'cubic-bezier(0.16, 1, 0.3, 1)', fn: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)) },
    linear: { css: 'linear', fn: (t) => t }
  };
  function getLyricsEase() {
    const v = localStorage.getItem('muriel_lyrics_ease');
    return LYRIC_EASINGS[v] ? v : 'inout';
  }
  function getLyricsSpeed() {
    const v = parseFloat(localStorage.getItem('muriel_lyrics_speed'));
    return (v >= 0.5 && v <= 2.5) ? v : 1.0;
  }
  function applyLyricsEase() {
    const ease = LYRIC_EASINGS[getLyricsEase()] || LYRIC_EASINGS.inout;
    document.documentElement.style.setProperty('--lyric-ease', ease.css);
    const speed = getLyricsSpeed();
    document.documentElement.style.setProperty('--lyric-duration', `${(0.45 / speed).toFixed(2)}s`);
  }
  function getLyricsGradientTightness() {
    const v = parseInt(localStorage.getItem('muriel_lyrics_gradient_tightness') || localStorage.getItem('muriel_gradient_tight'), 10);
    return (v >= 0 && v <= 40) ? v : 2;
  }
  function applyLyricsGradientTightness() {
    const span = getLyricsGradientTightness();
    document.documentElement.style.setProperty('--lyric-gradient-span', `${span}%`);
    document.documentElement.style.setProperty('--lyric-gradient-full', `${100 + span}%`);
    document.documentElement.style.setProperty('--lyric-fw', `${span}%`);
  }
  let lyricsScrollRaf = 0;
  function animateLyricsScroll(container, target) {
    cancelAnimationFrame(lyricsScrollRaf);
    const from = container.scrollTop;
    const delta = target - from;
    if (Math.abs(delta) < 1) return;
    const ease = (LYRIC_EASINGS[getLyricsEase()] || LYRIC_EASINGS.inout).fn;
    const speed = getLyricsSpeed();
    const duration = Math.max(120, Math.min(750, Math.max(420, Math.abs(delta) * 1.2)) / speed);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      container.scrollTop = from + delta * ease(t);
      if (t < 1) lyricsScrollRaf = requestAnimationFrame(step);
    };
    lyricsScrollRaf = requestAnimationFrame(step);
  }
  if (el.lyricsContainer) ['wheel', 'touchstart', 'pointerdown'].forEach((ev) => el.lyricsContainer.addEventListener(ev, () => cancelAnimationFrame(lyricsScrollRaf), { passive: true }));
  applyLyricsEase();
  applyLyricsGradientTightness();

  const PUNCT_OR_SPACE_REGEX = /^[\s\p{P}]$/u;
  const CJK_REGEX = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]$/u;
  const MARK_REGEX = /^\p{M}$/u;
  const CYRILLIC_VOWELS = new Set('аеёиоуыэюяєіїўѣѵѫѧѩѭ');
  const LATIN_VOWEL_EXTRA = new Set(['æ', 'ø', 'œ', 'ı']);

  function getCharBaseWeight(c) {
    if (PUNCT_OR_SPACE_REGEX.test(c)) return 0.4;
    if (CJK_REGEX.test(c)) return 3.0;
    if (MARK_REGEX.test(c)) return 3.0;
    const lower = c.toLowerCase();
    if (CYRILLIC_VOWELS.has(lower)) return 3.0;
    const base = c.normalize('NFD')[0].toLowerCase();
    if ('aeiouy'.includes(base) || LATIN_VOWEL_EXTRA.has(lower)) return 3.0;
    return 1.0;
  }

  let gradientLineCache = {
    lineEl: null,
    lineIdx: -1,
    text: '',
    N: 0,
    cumWeights: null,
    totalWeight: 0
  };

  function getLineGradientWeights(lineEl, idx, text) {
    if (gradientLineCache.lineEl === lineEl && gradientLineCache.lineIdx === idx && gradientLineCache.text === text) {
      return gradientLineCache;
    }
    const chars = Array.from(text);
    const N = chars.length;
    if (N === 0) {
      gradientLineCache = { lineEl, lineIdx: idx, text, N: 0, cumWeights: null, totalWeight: 0 };
      return gradientLineCache;
    }
    const outroStart = Math.floor(N * 0.8);
    const cumWeights = new Float64Array(N + 1);
    cumWeights[0] = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const baseW = getCharBaseWeight(chars[i]);
      const w = (i >= outroStart) ? baseW * 1.6 : baseW;
      total += w;
      cumWeights[i + 1] = total;
    }
    gradientLineCache = {
      lineEl,
      lineIdx: idx,
      text,
      N,
      cumWeights,
      totalWeight: total
    };
    return gradientLineCache;
  }

  let gradientRaf = 0;
  function updateActiveGradient() {
    const lineEl = document.querySelector('.lyric-line.active.gradient-line');
    if (!lineEl || !el.nativeAudio) return;
    const fill = lineEl.firstElementChild;
    if (!fill) return;

    const idx = parseInt(lineEl.id.replace('lyric-line-', ''), 10);
    const start = getLineStartTime(idx);
    const dur = Math.max(0.5, getLineEndTime(idx) - start);
    const t = el.nativeAudio.currentTime + (state.isCustomLyrics ? 0.25 : 0);
    const tau = Math.min(1, Math.max(0, (t - start) / dur));

    const text = fill.textContent || '';
    const cache = getLineGradientWeights(lineEl, idx, text);
    const timed = lineTimedWords(state.syncedLyrics[idx]);
    const timedK = timed ? window.MurielLyricsSources.timedProgress(timed, t) : null;

    let k = tau;
    if (timedK !== null) {
      k = timedK;
    } else if (cache.N > 0 && cache.totalWeight > 0) {
      if (tau <= 0) {
        k = 0;
      } else if (tau >= 1) {
        k = 1;
      } else {
        const tw = tau * cache.totalWeight;
        const cw = cache.cumWeights;
        const N = cache.N;
        let low = 0, high = N - 1;
        let i = 0;
        while (low <= high) {
          const mid = (low + high) >> 1;
          if (cw[mid + 1] <= tw) {
            low = mid + 1;
          } else if (cw[mid] > tw) {
            high = mid - 1;
          } else {
            i = mid;
            break;
          }
        }
        const charWeight = cw[i + 1] - cw[i];
        const pi = charWeight > 0 ? (tw - cw[i]) / charWeight : 0;
        k = Math.min(1, Math.max(0, (i + pi) / N));
      }
    }

    fill.style.setProperty('--k', k.toFixed(4));
  }
  function startGradientLoop() {
    if (gradientRaf) return;
    const tick = () => {
      gradientRaf = 0;
      if (!state.isPlaying || !state.isWindowVisible || !isGradientMode()) return;
      updateActiveGradient();
      gradientRaf = requestAnimationFrame(tick);
    };
    gradientRaf = requestAnimationFrame(tick);
  }

  function getLyricTargetScroll(activeEl, parent) {
    if (!activeEl || !parent) return 0;
    let top = 0;
    let curr = activeEl;
    let reachedParent = false;
    while (curr) {
      if (curr === parent) {
        reachedParent = true;
        break;
      }
      top += curr.offsetTop;
      curr = curr.offsetParent;
    }
    const parentH = parent.clientHeight;
    const lineH = activeEl.offsetHeight;
    if (!reachedParent) {
      const pR = parent.getBoundingClientRect(), lR = activeEl.getBoundingClientRect();
      if (pR.height > 0) {
        return Math.max(0, parent.scrollTop + (lR.top - pR.top) - (pR.height / 2) + (lR.height / 2));
      }
      return 0;
    }
    return Math.max(0, top - (parentH / 2) + (lineH / 2));
  }

  function updateSyncedLyricsHighlight(currentTime) {
    if (miniLyricsShown()) updateMiniLyricsHighlight(currentTime);
    if (state.syncedLyrics.length === 0 || !state.isWindowVisible) return;
    let activeIndex = -1;

    const validLines = [];
    for (let i = 0; i < state.syncedLyrics.length; i++) {
      const startTime = getLineStartTime(i);
      if (startTime >= 0) {
        validLines.push({ time: startTime, index: i });
      }
    }

    const lookAhead = state.isCustomLyrics ? 0.25 : 0.0;
    const matchTime = currentTime + lookAhead;

    for (let i = 0; i < validLines.length; i++) {
      const current = validLines[i];
      const next = validLines[i + 1];
      const nextTime = next ? next.time : Infinity;
      if (matchTime >= current.time && matchTime < nextTime) {
        activeIndex = current.index;
        break;
      }
    }

    if (activeIndex >= 0 && state.isPlaying) {
      const currentLineTime = getLineStartTime(activeIndex);
      const nextLineTime = getLineEndTime(activeIndex);
      const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
      const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

      const cleanText = state.syncedLyrics[activeIndex].text.replace(/<[^>]+>/g, '').trim();
      const words = cleanText.split(/\s+/).filter(Boolean);
      const totalWords = words.length;
      const currentWordIndex = totalWords > 0 ? Math.floor(progress * totalWords) : 0;
      const activeWordText = totalWords > 0 ? words[currentWordIndex] : '';

      const stateKey = `${activeIndex}-${currentWordIndex}`;
      if (state.lastBroadcastStateKey !== stateKey) {
        state.lastBroadcastStateKey = stateKey;
        sendStateToServer(activeWordText, currentWordIndex, activeIndex);
      }
    }

    const parent = el.lyricsContainer;
    const hasLayout = !!(parent && parent.clientHeight >= 40);
    const lineChanged = state.lastActiveLyricIdx !== activeIndex || state.forceLyricsScroll;
    const shouldSnap = state.forceSnapLyrics;
    let targetY = null;
    if (hasLayout && (lineChanged || shouldSnap) && getAdv('lyrics_autoscroll', true)) {
      if (activeIndex >= 0) {
        const activeEl = document.getElementById(`lyric-line-${activeIndex}`);
        if (activeEl) {
          targetY = getLyricTargetScroll(activeEl, parent);
          state.forceLyricsScroll = false;
          state.forceSnapLyrics = false;
          state.lastActiveLyricIdx = activeIndex;
        }
      } else {
        targetY = 0;
        state.forceLyricsScroll = false;
        state.forceSnapLyrics = false;
        state.lastActiveLyricIdx = activeIndex;
      }
    } else if (hasLayout && !state.forceLyricsScroll) {
      state.lastActiveLyricIdx = activeIndex;
    }

    document.querySelectorAll('.lyric-line').forEach((lineEl, idx) => {
      if (lineChanged) lineEl.style.setProperty('--dist', activeIndex >= 0 ? Math.abs(idx - activeIndex) : 0);
      if (idx === activeIndex) {
        if (!lineEl.classList.contains('active')) lineEl.classList.add('active');

        if (isGradientMode()) {
          updateActiveGradient();
          startGradientLoop();
        } else if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
          const currentLineTime = getLineStartTime(idx);
          const nextLineTime = getLineEndTime(idx);
          const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
          const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

          const wordSpans = lineEl.querySelectorAll('.lyric-word');
          const totalWords = wordSpans.length;
          const timed = lineTimedWords(state.syncedLyrics[idx]);
          const currentWordIndex = timed && timed.length === totalWords ? timedWordIndex(timed, matchTime) : Math.floor(progress * totalWords);

          wordSpans.forEach((wSpan, wIdx) => {
            if (wIdx < currentWordIndex) {
              wSpan.className = 'lyric-word past-word';
            } else if (wIdx === currentWordIndex) {
              wSpan.className = 'lyric-word active-word';
            } else {
              wSpan.className = 'lyric-word';
            }
          });
        }
      } else {
        lineEl.classList.remove('active');
        if (lineEl.classList.contains('gradient-line')) {
          lineEl.firstElementChild && lineEl.firstElementChild.style.setProperty('--k', '0');
        }
        if (!isGradientMode() && getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
          lineEl.querySelectorAll('.lyric-word').forEach(wSpan => {
            wSpan.className = idx < activeIndex ? 'lyric-word past-word' : 'lyric-word';
          });
        }
      }
    });
    if (targetY !== null && parent) {
      if (shouldSnap) {
        cancelAnimationFrame(lyricsScrollRaf);
        parent.scrollTop = targetY;
      } else {
        animateLyricsScroll(parent, targetY);
      }
    }
  }

  function updateLyricsModeButton() {
    if (!el.btnLyricsMode) return;
    const isWordEnabled = getAdv('karaoke_words', true);
    if (!isWordEnabled && state.lyricsMode === 'word') {
      state.lyricsMode = 'line';
    }
    I18N.text(el.btnLyricsMode.querySelector('span'), state.lyricsMode === 'word' ? 'Word' : 'Line');
  }

  if (el.btnLyricsMode) {
    updateLyricsModeButton();
    el.btnLyricsMode.addEventListener('click', () => {
      if (!getAdv('karaoke_words', true)) {
        state.lyricsMode = 'line';
        updateLyricsModeButton();
        return;
      }
      state.lyricsMode = state.lyricsMode === 'line' ? 'word' : 'line';
      updateLyricsModeButton();
      renderLyricsView();
      // word timings are only looked up for word-by-word karaoke
      if (state.lyricsMode === 'word' && state.currentTrack && !state.isCustomLyrics) fetchAndUpgradeWords(state.currentTrack.title, state.currentTrack.artist, state.loadToken);
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    });
  }

  if (el.btnTranslateLyrics) {
    el.btnTranslateLyrics.addEventListener('click', () => {
      state.trActive = !state.trActive;
      updateLyricsTranslationUI();
      if (state.trActive) {
        fetchAndApplyTranslation();
      } else {
        state.currentTranslations = null;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    });
  }

  let lyricsContainerParent = null;
  let lyricsContainerSibling = null;
  let tvIdleTimer = null;

  function resetTvIdleTimer() {
    if (!state.isTvKaraokeOpen || !el.tvKaraoke) return;
    el.tvKaraoke.classList.remove('tv-idle');
    clearTimeout(tvIdleTimer);
    tvIdleTimer = setTimeout(() => {
      const tvkPanel = document.getElementById('tvk-panel');
      if (tvkPanel && tvkPanel.classList.contains('open')) return;
      if (state.isTvKaraokeOpen && el.tvKaraoke) {
        el.tvKaraoke.classList.add('tv-idle');
      }
    }, 3000);
  }

  let activeTvBannerKey = '';
  let activeTvLayerIdx = 0;
  let tvBannerTransitionTimer = null;

  function syncTvBanner() {
    const tvBg = el.tvBg || document.getElementById('tv-bg');
    if (!tvBg) return;

    let layerA = document.getElementById('tv-bg-layer-a');
    let layerB = document.getElementById('tv-bg-layer-b');
    if (!layerA || !layerB) {
      tvBg.innerHTML = '<div class="tv-bg-layer active" id="tv-bg-layer-a"></div><div class="tv-bg-layer" id="tv-bg-layer-b"></div>';
      layerA = document.getElementById('tv-bg-layer-a');
      layerB = document.getElementById('tv-bg-layer-b');
      activeTvLayerIdx = 0;
      activeTvBannerKey = '';
    }

    const banner = document.getElementById('right-panel-banner');
    let bannerType = 'none';
    let bannerSrc = '';

    if (banner && banner.style.display !== 'none' && banner.style.opacity !== '0') {
      const bannerImg = banner.querySelector('.banner-image');
      const video = banner.querySelector('video');
      const img = banner.querySelector('img');
      if (video && video.src) {
        bannerType = 'video';
        bannerSrc = video.src;
      } else if (img && img.src) {
        bannerType = 'img';
        bannerSrc = img.src;
      } else if (bannerImg && bannerImg.style.backgroundImage && bannerImg.style.backgroundImage !== 'none') {
        bannerType = 'bg';
        bannerSrc = bannerImg.style.backgroundImage;
      } else if (banner.style.backgroundImage && banner.style.backgroundImage !== 'none') {
        bannerType = 'bg';
        bannerSrc = banner.style.backgroundImage;
      }
    }

    // the song's own banner (Track art dialog), with its own blur / opacity / fade when it has them (Riff 43)
    const songArt = state.currentTrack ? getTrackArt(state.currentTrack) : {};
    applyTrackBannerFx(songArt);
    if (bannerType === 'none' && songArt.banner) {
      bannerType = /\.(mp4|webm)($|\?)/i.test(songArt.banner) ? 'video' : 'img';
      bannerSrc = songArt.banner;
    }

    // no banner (they're gone in Muriel): use the custom background if there is one, else the cover
    const customBg = localStorage.getItem('muriel_bg_url') || '';
    if (bannerType === 'none' && customBg) {
      bannerType = /\.(mp4|webm)($|\?)/i.test(customBg) ? 'video' : 'img';
      bannerSrc = customBg;
    }

    if (bannerType === 'none') {
      const thumb = getTrackThumbUrl(state.currentTrack);
      if (thumb) {
        bannerType = 'fallback';
        bannerSrc = thumb;
      }
    }
    setTvkAmbient(bannerType === 'fallback' || bannerType === 'none');

    const newKey = `${bannerType}:${bannerSrc}`;
    if (newKey === activeTvBannerKey) return;

    const layers = [layerA, layerB];
    const prevLayer = layers[activeTvLayerIdx];
    const nextIdx = 1 - activeTvLayerIdx;
    const nextLayer = layers[nextIdx];

    if (tvBannerTransitionTimer) {
      clearTimeout(tvBannerTransitionTimer);
      tvBannerTransitionTimer = null;
    }

    nextLayer.innerHTML = '';
    nextLayer.style.backgroundImage = '';
    nextLayer.classList.remove('fallback');

    let transitionDone = false;
    const activateNext = () => {
      if (transitionDone) return;
      transitionDone = true;
      nextLayer.classList.add('active');
      prevLayer.classList.remove('active');
      activeTvLayerIdx = nextIdx;
      activeTvBannerKey = newKey;

      tvBannerTransitionTimer = setTimeout(() => {
        prevLayer.innerHTML = '';
        prevLayer.style.backgroundImage = '';
        prevLayer.classList.remove('fallback');
        tvBannerTransitionTimer = null;
      }, 550);
    };

    if (bannerType === 'video') {
      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.src = bannerSrc;
      vid.onloadeddata = () => {
        vid.play().catch(() => {});
        activateNext();
      };
      vid.onerror = () => activateNext();
      nextLayer.appendChild(vid);
    } else if (bannerType === 'img') {
      const img = document.createElement('img');
      img.onload = () => activateNext();
      img.onerror = () => activateNext();
      img.src = bannerSrc;
      nextLayer.appendChild(img);
    } else if (bannerType === 'bg') {
      nextLayer.style.backgroundImage = bannerSrc;
      activateNext();
    } else if (bannerType === 'fallback') {
      nextLayer.classList.add('fallback');
      const img = new Image();
      img.onload = () => {
        nextLayer.style.backgroundImage = `url("${bannerSrc}")`;
        activateNext();
      };
      img.onerror = () => {
        nextLayer.style.backgroundImage = `url("${bannerSrc}")`;
        activateNext();
      };
      img.src = bannerSrc;
    } else {
      activateNext();
    }
  }

  function syncTvLayout(forcedNoLyrics) {
    const tv = el.tvKaraoke || document.getElementById('tv-karaoke');
    if (!tv) return;
    const panel = el.rightPanel || document.getElementById('right-panel');
    const noLyrics = typeof forcedNoLyrics === 'boolean'
      ? forcedNoLyrics
      : (panel ? panel.classList.contains('lyrics-empty') : (!state.syncedLyrics || state.syncedLyrics.length === 0));
    const wasNoLyrics = tv.classList.contains('tv-nolyrics');
    tv.classList.toggle('tv-nolyrics', !!noLyrics);
    if (wasNoLyrics !== !!noLyrics && typeof resizeCanvases === 'function') {
      requestAnimationFrame(resizeCanvases);
    }
  }

  let lastTvMetaTrackKey = '';
  function updateTvKaraokeMeta() {
    const curTrack = state.currentTrack;
    const trackKey = curTrack ? `${curTrack.id || ''}:${curTrack.title || ''}:${curTrack.artist || ''}` : '';
    const isNew = trackKey !== lastTvMetaTrackKey;
    lastTvMetaTrackKey = trackKey;

    const titleText = (curTrack && curTrack.title) || 'No track';
    const artistText = (curTrack && curTrack.artist) || '';

    if (el.tvKaraokeTitle) {
      if (isNew && el.tvKaraokeTitle.textContent !== titleText) {
        el.tvKaraokeTitle.style.opacity = '0';
        el.tvKaraokeTitle.style.transform = 'translateY(6px)';
        setTimeout(() => {
          el.tvKaraokeTitle.textContent = titleText;
          el.tvKaraokeTitle.style.opacity = '1';
          el.tvKaraokeTitle.style.transform = 'none';
        }, 120);
      } else {
        el.tvKaraokeTitle.textContent = titleText;
      }
    }
    if (el.tvKaraokeArtist) {
      if (isNew && el.tvKaraokeArtist.textContent !== artistText) {
        el.tvKaraokeArtist.style.opacity = '0';
        el.tvKaraokeArtist.style.transform = 'translateY(6px)';
        setTimeout(() => {
          el.tvKaraokeArtist.textContent = artistText;
          el.tvKaraokeArtist.style.opacity = '1';
          el.tvKaraokeArtist.style.transform = 'none';
        }, 120);
      } else {
        el.tvKaraokeArtist.textContent = artistText;
      }
    }

    const coverEl = el.tvCover || document.getElementById('tv-cover');
    if (coverEl) {
      const thumb = getTrackThumbUrl(curTrack);
      if (thumb) {
        if (coverEl.dataset.currentThumb !== thumb) {
          coverEl.dataset.currentThumb = thumb;
          const preImg = new Image();
          preImg.onload = () => {
            if (coverEl.dataset.currentThumb === thumb) {
              coverEl.style.opacity = '0';
              coverEl.style.transform = 'scale(0.96)';
              setTimeout(() => {
                coverEl.src = thumb;
                coverEl.style.display = 'block';
                coverEl.style.opacity = '1';
                coverEl.style.transform = 'scale(1)';
              }, 120);
            }
          };
          preImg.onerror = () => {
            coverEl.src = thumb;
            coverEl.style.display = 'block';
            coverEl.style.opacity = '1';
            coverEl.style.transform = 'scale(1)';
          };
          preImg.src = thumb;
        }
      } else {
        coverEl.dataset.currentThumb = '';
        coverEl.style.display = 'none';
        coverEl.src = '';
      }
    }
    syncTvBanner();
    syncTvLayout();
  }

  let tvkOutputInterval = null;
  async function updateTvkOutput() {
    const nameEl = document.getElementById('tvk-output-name');
    const batteryEl = document.getElementById('tvk-battery');
    const batteryPctEl = document.getElementById('tvk-battery-pct');
    const batteryLevelEl = document.getElementById('tvk-battery-level');
    const outputContainer = document.getElementById('tvk-output');
    if (!nameEl) return;

    let deviceName = '';
    let batteryLevel = null;

    if (window.electronAPI && typeof window.electronAPI.getAudioOutputInfo === 'function') {
      try {
        const info = await window.electronAPI.getAudioOutputInfo();
        if (info && info.name && info.name !== 'Default output') {
          deviceName = info.name;
        }
        if (info && typeof info.battery === 'number') {
          batteryLevel = info.battery;
        }
      } catch (e) {}
    }

    if (!deviceName) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/audio-output-info`);
        if (res.ok) {
          const info = await res.json();
          if (info && info.name && info.name !== 'Default output') {
            deviceName = info.name;
          }
          if (info && typeof info.battery === 'number') {
            batteryLevel = info.battery;
          }
        }
      } catch (e) {}
    }

    if (!deviceName && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
        const audioEl = el.nativeAudio || document.getElementById('native-audio');
        const sinkId = (audioEl && audioEl.sinkId) ? audioEl.sinkId : '';

        let matched = null;
        if (sinkId) {
          matched = audioOutputs.find(d => d.deviceId === sinkId);
        }
        if (!matched) {
          matched = audioOutputs.find(d => d.deviceId === 'default') || audioOutputs[0];
        }

        let label = matched && matched.label ? matched.label.trim() : '';
        label = label.replace(/^Default\s*[-–—:]\s*/i, '').trim();
        if (label && label.toLowerCase() !== 'default') {
          deviceName = label;
        }
      } catch (e) {}
    }

    const finalName = deviceName || T('Default output');
    nameEl.textContent = finalName;
    if (outputContainer) outputContainer.title = finalName;

    if (batteryEl && batteryPctEl && batteryLevelEl) {
      if (batteryLevel !== null && !isNaN(batteryLevel) && batteryLevel >= 0) {
        const clampedPct = Math.max(0, Math.min(100, Math.round(batteryLevel)));
        batteryPctEl.textContent = `${clampedPct}%`;
        const fillH = Math.max(clampedPct > 0 ? 1 : 0, Math.min(12, Math.round(12 * (clampedPct / 100))));
        const fillY = 19 - fillH;
        batteryLevelEl.setAttribute('y', fillY);
        batteryLevelEl.setAttribute('height', fillH);
        batteryLevelEl.setAttribute('x', '8');
        batteryLevelEl.setAttribute('width', '8');
        batteryEl.classList.remove('hidden');
        batteryEl.classList.toggle('battery-low', clampedPct <= 20);
        batteryEl.title = Tf('Battery level: {0}%', clampedPct);
      } else {
        batteryEl.classList.add('hidden');
      }
    }
  }

  function openTvKaraoke() {
    if (!el.tvKaraoke || !el.lyricsContainer) return;
    if (state.isTvKaraokeOpen) return;
    state.isTvKaraokeOpen = true;
    if (!animationFrameId) { hasDrawnPausedFrame = false; startVisualizers(); }

    lyricsContainerParent = el.lyricsContainer.parentElement;
    lyricsContainerSibling = el.lyricsContainer.nextSibling;

    if (el.tvKaraokeContent) {
      el.tvKaraokeContent.appendChild(el.lyricsContainer);
    }
    if (el.lyricsContainer) {
      el.lyricsContainer.style.paddingTop = '';
      el.lyricsContainer.style.paddingBottom = '';
      el.lyricsContainer.scrollTop = 0;
    }
    updateTvKaraokeMeta();
    syncTvBanner();
    syncTvLayout();
    el.tvKaraoke.classList.remove('hidden');
    syncTvkAmbientPlayback();
    applyTvk();
    syncTvkUI();
    resetTvIdleTimer();
    resizeCanvases();
    if (state.isPlaying) {
      if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
      startVisualizers();
    }

    cancelAnimationFrame(lyricsScrollRaf);
    renderLyricsView();
    const syncTvLyrics = () => {
      updateLyricsPadding();
      state.forceSnapLyrics = true;
      state.forceLyricsScroll = true;
      state.lastActiveLyricIdx = -1;
      if (el.nativeAudio) {
        const cur = el.nativeAudio.currentTime || 0;
        const dur = el.nativeAudio.duration || (state.currentTrack ? state.currentTrack.duration : 0);
        updateSyncedLyricsHighlight(cur);
        syncTvkProgress(cur, dur);
      }
    };
    syncTvLyrics();
    requestAnimationFrame(syncTvLyrics);
    setTimeout(syncTvLyrics, 50);
    setTimeout(syncTvLyrics, 150);
    const isTvPlaying = !!(state.isPlaying && el.nativeAudio && !el.nativeAudio.paused);
    updatePlayPauseButton(isTvPlaying, state.isBuffering);
    setPlayPauseState(isTvPlaying, false);
    updateTvkOutput();
    if (tvkOutputInterval) clearInterval(tvkOutputInterval);
    tvkOutputInterval = setInterval(updateTvkOutput, 8000);
  }

  function closeTvKaraoke() {
    if (!state.isTvKaraokeOpen || !el.tvKaraoke) return;
    state.isTvKaraokeOpen = false;
    clearTimeout(tvIdleTimer);
    if (tvkOutputInterval) {
      clearInterval(tvkOutputInterval);
      tvkOutputInterval = null;
    }
    const tvkPanel = document.getElementById('tvk-panel');
    if (tvkPanel) {
      tvkPanel.classList.remove('open');
      const btnSettings = document.getElementById('btn-tvk-settings');
      if (btnSettings) btnSettings.classList.remove('open');
    }
    el.tvKaraoke.classList.remove('tv-idle');
    el.tvKaraoke.classList.add('hidden');
    syncTvkAmbientPlayback();

    const targetParent = (lyricsContainerParent && lyricsContainerParent.isConnected)
      ? lyricsContainerParent
      : (document.querySelector('.lyrics-section') || (el.rightPanel && el.rightPanel.querySelector('.lyrics-section')));
    if (targetParent && el.lyricsContainer) {
      if (lyricsContainerSibling && lyricsContainerSibling.parentNode === targetParent) {
        targetParent.insertBefore(el.lyricsContainer, lyricsContainerSibling);
      } else {
        targetParent.appendChild(el.lyricsContainer);
      }
    }
    if (el.lyricsContainer) {
      el.lyricsContainer.style.paddingTop = '';
      el.lyricsContainer.style.paddingBottom = '';
      el.lyricsContainer.scrollTop = 0;
    }

    cancelAnimationFrame(lyricsScrollRaf);
    renderLyricsView();
    const syncSidebarLyrics = () => {
      updateLyricsPadding();
      state.forceSnapLyrics = true;
      state.forceLyricsScroll = true;
      state.lastActiveLyricIdx = -1;
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    };
    syncSidebarLyrics();
    requestAnimationFrame(syncSidebarLyrics);
    setTimeout(syncSidebarLyrics, 50);
    setTimeout(syncSidebarLyrics, 150);
    setTimeout(syncSidebarLyrics, 300);
  }

  window.openTvKaraoke = openTvKaraoke;
  window.closeTvKaraoke = closeTvKaraoke;

  if (el.btnTvKaraoke) {
    el.btnTvKaraoke.addEventListener('click', openTvKaraoke);
  }
  if (el.tvKaraokeClose) {
    el.tvKaraokeClose.addEventListener('click', closeTvKaraoke);
  }
  if (el.tvKaraoke) {
    el.tvKaraoke.addEventListener('mousemove', resetTvIdleTimer);
  }

  const btnTvkPrev = document.getElementById('btn-tvk-prev');
  const btnTvkPlay = document.getElementById('btn-tvk-play');
  const btnTvkNext = document.getElementById('btn-tvk-next');
  if (btnTvkPrev) btnTvkPrev.addEventListener('click', () => playPrev());
  if (btnTvkNext) btnTvkNext.addEventListener('click', () => playNext());
  if (btnTvkPlay) btnTvkPlay.addEventListener('click', () => togglePlayPause());
  if (el.btnTvkFav) el.btnTvkFav.addEventListener('click', () => {
    if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
  });

  // ---- Settings > Tracks > Output device (from Riff 43.1; computers) ----
  // The song plays through the Web Audio graph when it is set up and through the <audio> element before that,
  // so both get the device. A device that disappears while it plays (headphones unplugged) pauses the song
  // instead of letting it go on from the speakers.
  const OUTPUT_DEVICE_KEY = 'muriel_audio_output_device';
  const canPickOutput = !isPhoneApp && !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) && !!el.nativeAudio && typeof el.nativeAudio.setSinkId === 'function';
  let outputDeviceId = (() => { try { return localStorage.getItem(OUTPUT_DEVICE_KEY) || ''; } catch (e) { return ''; } })();
  let knownOutputIds = null;
  async function applyOutputDevice() {
    if (!canPickOutput) return;
    const id = outputDeviceId === 'default' ? '' : outputDeviceId;
    try { if (el.nativeAudio.sinkId !== id) await el.nativeAudio.setSinkId(id); } catch (e) { console.warn('Output device:', e && e.message); }
    const ctx = audioEngine && audioEngine.ctx;
    try { if (ctx && typeof ctx.setSinkId === 'function' && (ctx.sinkId || '') !== id) await ctx.setSinkId(id); } catch (e) {}
  }
  async function listOutputDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch (e) { return []; }
  }
  async function renderOutputDevices() {
    const menu = document.getElementById('audio-output-menu');
    const label = document.getElementById('audio-output-label');
    if (!canPickOutput || !menu) return;
    const devices = (await listOutputDevices()).filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    knownOutputIds = new Set(devices.map((d) => d.deviceId));
    menu.textContent = '';
    const add = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm3-dropdown-option' + ((outputDeviceId || '') === value ? ' selected' : '');
      b.dataset.value = value;
      b.textContent = text;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        outputDeviceId = value;
        try { if (value) localStorage.setItem(OUTPUT_DEVICE_KEY, value); else localStorage.removeItem(OUTPUT_DEVICE_KEY); } catch (_) {}
        document.getElementById('audio-output-dropdown')?.classList.remove('open');
        renderOutputDevices();
        applyOutputDevice().then(() => updateTvkOutput());
      });
      menu.appendChild(b);
      if ((outputDeviceId || '') === value && label) label.textContent = text;
    };
    add('', T('System default'));
    devices.forEach((d, i) => add(d.deviceId, (d.label || '').replace(/^Default\s*[-–—:]\s*/i, '').trim() || Tf('Output {0}', i + 1)));
    // the saved device is not connected now: shown as itself, played on the system default until it is back
    if (outputDeviceId && !knownOutputIds.has(outputDeviceId)) add(outputDeviceId, T('Saved device (not connected)'));
  }
  if (canPickOutput) {
    const row = document.getElementById('setting-audio-output-row');
    if (row) row.hidden = false;
    const dd = document.getElementById('audio-output-dropdown');
    const trigger = document.getElementById('audio-output-trigger');
    if (dd && trigger) {
      trigger.addEventListener('click', (e) => { e.stopPropagation(); renderOutputDevices(); dd.classList.toggle('open'); });
      document.addEventListener('click', () => dd.classList.remove('open'));
    }
    renderOutputDevices();
    if (outputDeviceId) applyOutputDevice();
    // the Web Audio graph is made on the first play: it gets the device then
    el.nativeAudio.addEventListener('playing', () => { if (outputDeviceId) applyOutputDevice(); });
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      updateTvkOutput();
      if (!canPickOutput) return;
      const before = knownOutputIds;
      const now = new Set((await listOutputDevices()).map((d) => d.deviceId).filter((id) => id && id !== 'default' && id !== 'communications'));
      const lostChosen = !!outputDeviceId && !!before && before.has(outputDeviceId) && !now.has(outputDeviceId);
      if (state.isPlaying && lostChosen && el.nativeAudio && !el.nativeAudio.paused) {
        el.nativeAudio.pause();
        showToast(Tm('Paused: the output device was disconnected'), 'info');
      }
      renderOutputDevices();
      if (outputDeviceId && now.has(outputDeviceId)) applyOutputDevice();
    });
  }

  const TVK_DEFAULTS = {
    font: 'inherit',
    align: 'center',
    size: 100,
    weight: 700,
    gap: 16,
    anim: 'slide',
    speed: 900
  };

  const TVK_FONTS = {
    'default': 'inherit',
    'inherit': 'inherit',
    'sf': SF_FONT_STACK,
    'SF Pro': SF_FONT_STACK,
    [SF_FONT_STACK]: SF_FONT_STACK,
    'serif': "Georgia, 'Times New Roman', serif",
    "Georgia, 'Times New Roman', serif": "Georgia, 'Times New Roman', serif",
    'rounded': "ui-rounded, 'Nunito', system-ui, sans-serif",
    "ui-rounded, 'Nunito', system-ui, sans-serif": "ui-rounded, 'Nunito', system-ui, sans-serif",
    'mono': "ui-monospace, 'JetBrains Mono', monospace",
    "ui-monospace, 'JetBrains Mono', monospace": "ui-monospace, 'JetBrains Mono', monospace",
    'condensed': "'Arial Narrow', 'Roboto Condensed', sans-serif",
    "'Arial Narrow', 'Roboto Condensed', sans-serif": "'Arial Narrow', 'Roboto Condensed', sans-serif"
  };

  function getTvk() {
    try {
      const raw = localStorage.getItem('muriel_tvk');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          font: parsed.font || TVK_DEFAULTS.font,
          align: ['left', 'center', 'right'].includes(parsed.align) ? parsed.align : TVK_DEFAULTS.align,
          size: Number(parsed.size) || TVK_DEFAULTS.size,
          weight: Number(parsed.weight) || TVK_DEFAULTS.weight,
          gap: (parsed.gap !== undefined && !isNaN(Number(parsed.gap))) ? Number(parsed.gap) : TVK_DEFAULTS.gap,
          anim: parsed.anim || TVK_DEFAULTS.anim,
          speed: Number(parsed.speed) || TVK_DEFAULTS.speed
        };
      }
    } catch (_) {}
    return { ...TVK_DEFAULTS };
  }

  function saveTvk(settings) {
    try {
      localStorage.setItem('muriel_tvk', JSON.stringify(settings));
    } catch (_) {}
  }

  function updateTvkVisualizerSetting(enabled) {
    const on = enabled !== false && enabled !== 'false';
    localStorage.setItem('muriel_tvk_visualizer', on ? 'true' : 'false');
    const tv = document.getElementById('tv-karaoke');
    if (tv) {
      tv.classList.toggle('no-tvk-visualizer', !on);
    }
    const btnTvkVis = document.getElementById('btn-tvk-visualizer');
    if (btnTvkVis) btnTvkVis.classList.toggle('active', on);
    const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
    if (btnTvkVisSetting) btnTvkVisSetting.classList.toggle('active', on);
    if (on && state.isPlaying) {
      if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
      startVisualizers();
    }
  }

  function updateTvkVisualizerLyricsSetting(enabled) {
    const on = enabled === true || enabled === 'true';
    localStorage.setItem('muriel_tvk_visualizer_lyrics', on ? 'true' : 'false');
    const tv = document.getElementById('tv-karaoke');
    if (tv) {
      tv.classList.toggle('tvk-show-lyrics-visualizer', on);
    }
    const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
    if (btnTvkVisLyrics) btnTvkVisLyrics.classList.toggle('active', on);
    const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
    if (btnTvkVisLyricsSetting) btnTvkVisLyricsSetting.classList.toggle('active', on);
    if (on && state.isPlaying) {
      if (audioEngine && audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(true);
      startVisualizers();
    }
  }

  function updateTvkVisualizerOpacity(opacityVal) {
    let val = parseInt(opacityVal, 10);
    if (isNaN(val)) val = 85;
    val = Math.max(10, Math.min(100, val));
    localStorage.setItem('muriel_tvk_visualizer_opacity', val.toString());

    const norm = (val / 100).toFixed(2);
    const tv = document.getElementById('tv-karaoke');
    if (tv) {
      tv.style.setProperty('--tvk-vis-opacity', norm);
    }

    const sliderPanel = document.getElementById('tvk-vis-opacity');
    if (sliderPanel && parseInt(sliderPanel.value, 10) !== val) sliderPanel.value = val;
    const valPanel = document.getElementById('val-tvk-vis-opacity');
    if (valPanel) valPanel.textContent = `${val}%`;

    const sliderSetting = document.getElementById('slider-tvk-vis-opacity-setting');
    if (sliderSetting && parseInt(sliderSetting.value, 10) !== val) sliderSetting.value = val;
    const valSetting = document.getElementById('val-tvk-vis-opacity-setting');
    if (valSetting) valSetting.textContent = `${val}%`;
  }

  function applyTvk() {
    const tv = document.getElementById('tv-karaoke');
    if (!tv) return;
    const s = getTvk();
    const font = TVK_FONTS[s.font] || s.font || 'inherit';
    if (s.font === 'sf' || font.includes('SF Pro')) {
      ensureSfFontLoaded();
    }
    const align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'center';
    const scale = (Number(s.size) || 100) / 100;
    const weight = Number(s.weight) || 700;
    const gap = (s.gap !== undefined && !isNaN(Number(s.gap))) ? Number(s.gap) : 16;
    const speed = Number(s.speed) || 900;
    const anim = ['smooth', 'slide', 'fade', 'pop', 'none'].includes(s.anim) ? s.anim : 'slide';

    tv.style.setProperty('--tvk-font', font);
    tv.style.setProperty('--tvk-scale', String(scale));
    tv.style.setProperty('--tvk-weight', String(weight));
    tv.style.setProperty('--tvk-gap', `${gap}px`);
    tv.style.setProperty('--tvk-speed', `${speed}ms`);
    tv.setAttribute('data-tvk-anim', anim);
    tv.setAttribute('data-tvk-align', align);

    const tvkVisOn = localStorage.getItem('muriel_tvk_visualizer') !== 'false';
    tv.classList.toggle('no-tvk-visualizer', !tvkVisOn);
    const tvkVisLyricsOn = localStorage.getItem('muriel_tvk_visualizer_lyrics') === 'true';
    tv.classList.toggle('tvk-show-lyrics-visualizer', tvkVisLyricsOn);
    const visOpacity = parseInt(localStorage.getItem('muriel_tvk_visualizer_opacity') || '85', 10);
    tv.style.setProperty('--tvk-vis-opacity', (Math.max(10, Math.min(100, visOpacity)) / 100).toFixed(2));
  }

  function syncTvkUI() {
    const s = getTvk();
    const selFont = document.getElementById('tvk-font');
    const sliderSize = document.getElementById('tvk-size');
    const sliderWeight = document.getElementById('tvk-weight');
    const sliderGap = document.getElementById('tvk-gap');
    const selAnim = document.getElementById('tvk-anim');
    const sliderSpeed = document.getElementById('tvk-speed');

    const valSize = document.getElementById('val-tvk-size');
    const valWeight = document.getElementById('val-tvk-weight');
    const valGap = document.getElementById('val-tvk-gap');
    const valSpeed = document.getElementById('val-tvk-speed');

    const fontVal = TVK_FONTS[s.font] || s.font;
    if (selFont) {
      selFont.value = fontVal;
      if (!selFont.value) selFont.value = s.font;
    }
    const fontLabel = document.getElementById('tvk-font-label');
    const fontMenu = document.getElementById('tvk-font-menu');
    if (fontMenu) {
      const options = fontMenu.querySelectorAll('.m3-dropdown-option');
      let matched = false;
      options.forEach(opt => {
        const isMatch = opt.dataset.value === s.font || opt.dataset.value === fontVal;
        opt.classList.toggle('selected', isMatch);
        if (isMatch) {
          if (fontLabel) fontLabel.textContent = opt.textContent;
          matched = true;
        }
      });
      if (!matched && fontLabel) fontLabel.textContent = 'Default';
    }

    const alignGroup = document.getElementById('tvk-align-group');
    if (alignGroup) {
      alignGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === s.align);
      });
    }

    const animGroup = document.getElementById('tvk-anim-group');
    if (animGroup) {
      animGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === s.anim);
      });
    }
    if (selAnim) selAnim.value = s.anim;

    if (sliderSize) sliderSize.value = s.size;
    if (sliderWeight) sliderWeight.value = s.weight;
    if (sliderGap) sliderGap.value = s.gap;
    if (sliderSpeed) sliderSpeed.value = s.speed;

    if (valSize) valSize.textContent = `${s.size}%`;
    if (valWeight) valWeight.textContent = `${s.weight}`;
    if (valGap) valGap.textContent = `${s.gap}px`;
    if (valSpeed) valSpeed.textContent = `${s.speed}ms`;

    const tvkVisOn = localStorage.getItem('muriel_tvk_visualizer') !== 'false';
    const btnTvkVis = document.getElementById('btn-tvk-visualizer');
    if (btnTvkVis) btnTvkVis.classList.toggle('active', tvkVisOn);
    const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
    if (btnTvkVisSetting) btnTvkVisSetting.classList.toggle('active', tvkVisOn);

    const tvkVisLyricsOn = localStorage.getItem('muriel_tvk_visualizer_lyrics') === 'true';
    const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
    if (btnTvkVisLyrics) btnTvkVisLyrics.classList.toggle('active', tvkVisLyricsOn);
    const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
    if (btnTvkVisLyricsSetting) btnTvkVisLyricsSetting.classList.toggle('active', tvkVisLyricsOn);

    const visOpacity = parseInt(localStorage.getItem('muriel_tvk_visualizer_opacity') || '85', 10);
    const sliderTvkVisOpacity = document.getElementById('tvk-vis-opacity');
    if (sliderTvkVisOpacity) sliderTvkVisOpacity.value = visOpacity;
    const valTvkVisOpacity = document.getElementById('val-tvk-vis-opacity');
    if (valTvkVisOpacity) valTvkVisOpacity.textContent = `${visOpacity}%`;

    const sliderTvkVisOpacitySetting = document.getElementById('slider-tvk-vis-opacity-setting');
    if (sliderTvkVisOpacitySetting) sliderTvkVisOpacitySetting.value = visOpacity;
    const valTvkVisOpacitySetting = document.getElementById('val-tvk-vis-opacity-setting');
    if (valTvkVisOpacitySetting) valTvkVisOpacitySetting.textContent = `${visOpacity}%`;
  }

  function initTvk() {
    applyTvk();
    syncTvkUI();

    const btnSettings = document.getElementById('btn-tvk-settings');
    const panel = document.getElementById('tvk-panel');
    const btnReset = document.getElementById('btn-tvk-reset');

    const selFont = document.getElementById('tvk-font');
    const fontDropdown = document.getElementById('tvk-font-dropdown');
    const fontTrigger = document.getElementById('tvk-font-trigger');
    const fontMenu = document.getElementById('tvk-font-menu');

    const alignGroup = document.getElementById('tvk-align-group');
    const animGroup = document.getElementById('tvk-anim-group');

    const sliderSize = document.getElementById('tvk-size');
    const sliderWeight = document.getElementById('tvk-weight');
    const sliderGap = document.getElementById('tvk-gap');
    const selAnim = document.getElementById('tvk-anim');
    const sliderSpeed = document.getElementById('tvk-speed');

    const valSize = document.getElementById('val-tvk-size');
    const valWeight = document.getElementById('val-tvk-weight');
    const valGap = document.getElementById('val-tvk-gap');
    const valSpeed = document.getElementById('val-tvk-speed');

    if (btnSettings && panel) {
      btnSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.classList.contains('open');
        if (!isOpen) {
          panel.classList.add('open');
          btnSettings.classList.add('open');
          if (el.tvKaraoke) el.tvKaraoke.classList.remove('tv-idle');
          clearTimeout(tvIdleTimer);
        } else {
          panel.classList.remove('open');
          btnSettings.classList.remove('open');
          if (fontDropdown) fontDropdown.classList.remove('open');
          resetTvIdleTimer();
        }
      });
    }

    document.addEventListener('click', (e) => {
      if (!panel || !panel.classList.contains('open')) return;
      if (!panel.contains(e.target) && (!btnSettings || !btnSettings.contains(e.target))) {
        panel.classList.remove('open');
        if (btnSettings) btnSettings.classList.remove('open');
        if (fontDropdown) fontDropdown.classList.remove('open');
        resetTvIdleTimer();
      }
    });

    if (fontTrigger && fontDropdown) {
      fontTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        fontDropdown.classList.toggle('open');
      });
    }

    if (fontMenu) {
      fontMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          if (selFont) selFont.value = val;
          const current = getTvk();
          current.font = val;
          saveTvk(current);
          applyTvk();
          syncTvkUI();
          if (fontDropdown) fontDropdown.classList.remove('open');
        });
      });
    }

    if (alignGroup) {
      alignGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = btn.dataset.value;
          const current = getTvk();
          current.align = val;
          saveTvk(current);
          applyTvk();
          syncTvkUI();
        });
      });
    }

    if (animGroup) {
      animGroup.querySelectorAll('.tvk-pill-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = btn.dataset.value;
          if (selAnim) selAnim.value = val;
          const current = getTvk();
          current.anim = val;
          saveTvk(current);
          applyTvk();
          syncTvkUI();
        });
      });
    }

    const onTvkInput = () => {
      const current = getTvk();
      const tvk = {
        font: (selFont && selFont.value) || current.font || 'inherit',
        align: current.align || 'center',
        size: Number(sliderSize && sliderSize.value) || 100,
        weight: Number(sliderWeight && sliderWeight.value) || 700,
        gap: (sliderGap && sliderGap.value !== undefined) ? Number(sliderGap.value) : 16,
        anim: (selAnim && selAnim.value) || current.anim || 'smooth',
        speed: Number(sliderSpeed && sliderSpeed.value) || 350
      };
      saveTvk(tvk);
      applyTvk();
      if (valSize) valSize.textContent = `${tvk.size}%`;
      if (valWeight) valWeight.textContent = `${tvk.weight}`;
      if (valGap) valGap.textContent = `${tvk.gap}px`;
      if (valSpeed) valSpeed.textContent = `${tvk.speed}ms`;
    };

    [selFont, sliderSize, sliderWeight, sliderGap, selAnim, sliderSpeed].forEach(input => {
      if (!input) return;
      input.addEventListener('input', onTvkInput);
      input.addEventListener('change', onTvkInput);
    });

    const btnTvkVis = document.getElementById('btn-tvk-visualizer');
    if (btnTvkVis) {
      btnTvkVis.addEventListener('click', () => {
        const cur = localStorage.getItem('muriel_tvk_visualizer') !== 'false';
        updateTvkVisualizerSetting(!cur);
      });
    }
    const btnTvkVisSetting = document.getElementById('btn-tvk-visualizer-setting');
    if (btnTvkVisSetting) {
      btnTvkVisSetting.addEventListener('click', () => {
        const cur = localStorage.getItem('muriel_tvk_visualizer') !== 'false';
        updateTvkVisualizerSetting(!cur);
      });
    }

    const btnTvkVisLyrics = document.getElementById('btn-tvk-visualizer-lyrics');
    if (btnTvkVisLyrics) {
      btnTvkVisLyrics.addEventListener('click', () => {
        const cur = localStorage.getItem('muriel_tvk_visualizer_lyrics') === 'true';
        updateTvkVisualizerLyricsSetting(!cur);
      });
    }
    const btnTvkVisLyricsSetting = document.getElementById('btn-tvk-visualizer-lyrics-setting');
    if (btnTvkVisLyricsSetting) {
      btnTvkVisLyricsSetting.addEventListener('click', () => {
        const cur = localStorage.getItem('muriel_tvk_visualizer_lyrics') === 'true';
        updateTvkVisualizerLyricsSetting(!cur);
      });
    }

    const sliderTvkVisOpacity = document.getElementById('tvk-vis-opacity');
    if (sliderTvkVisOpacity) {
      const onOpInput = (e) => {
        updateTvkVisualizerOpacity(e.target.value);
      };
      sliderTvkVisOpacity.addEventListener('input', onOpInput);
      sliderTvkVisOpacity.addEventListener('change', onOpInput);
    }
    const sliderTvkVisOpacitySetting = document.getElementById('slider-tvk-vis-opacity-setting');
    if (sliderTvkVisOpacitySetting) {
      const onOpInput = (e) => {
        updateTvkVisualizerOpacity(e.target.value);
      };
      sliderTvkVisOpacitySetting.addEventListener('input', onOpInput);
      sliderTvkVisOpacitySetting.addEventListener('change', onOpInput);
    }

    const sliderVizSmooth = document.getElementById('slider-viz-smooth');
    const valVizSmooth = document.getElementById('val-viz-smooth');
    if (sliderVizSmooth) {
      const saved = localStorage.getItem('muriel_viz_smooth');
      if (saved !== null) sliderVizSmooth.value = saved;
      if (valVizSmooth) valVizSmooth.textContent = `${sliderVizSmooth.value}%`;
      const onSmoothInput = (e) => {
        const v = e.target.value;
        if (valVizSmooth) valVizSmooth.textContent = `${v}%`;
        localStorage.setItem('muriel_viz_smooth', v);
      };
      sliderVizSmooth.addEventListener('input', onSmoothInput);
      sliderVizSmooth.addEventListener('change', onSmoothInput);
    }

    const sliderVizSens = document.getElementById('slider-viz-sens');
    const valVizSens = document.getElementById('val-viz-sens');
    if (sliderVizSens) {
      const saved = localStorage.getItem('muriel_viz_sens');
      if (saved !== null) sliderVizSens.value = saved;
      if (valVizSens) valVizSens.textContent = `${sliderVizSens.value}%`;
      const onSensInput = (e) => {
        const v = e.target.value;
        if (valVizSens) valVizSens.textContent = `${v}%`;
        localStorage.setItem('muriel_viz_sens', v);
      };
      sliderVizSens.addEventListener('input', onSensInput);
      sliderVizSens.addEventListener('change', onSensInput);
    }

    if (btnReset) {
      btnReset.addEventListener('click', () => {
        saveTvk(TVK_DEFAULTS);
        updateTvkVisualizerSetting(true);
        updateTvkVisualizerLyricsSetting(false);
        updateTvkVisualizerOpacity(85);
        applyTvk();
        syncTvkUI();
      });
    }
  }

  function openCustomLyricsEditor() {
    if (!state.currentTrack) {
      showToast(Tm('Play a track first to add lyrics'), 'info');
      return;
    }
    if (el.customLyricsTrackTitle) el.customLyricsTrackTitle.textContent = (state.currentTrack.title || 'untitled');
    if (el.customLyricsTrackArtist) el.customLyricsTrackArtist.textContent = (state.currentTrack.artist || '');

    // the editor stays open across song changes: remember which song it is for
    customLyricsFor = { title: state.currentTrack.title || '', artist: state.currentTrack.artist || '' };
    if (state.syncedLyrics.length > 0) {
      // keep the timestamps, or fixing a typo in synced lyrics saved them unsynced
      if (el.customLyricsTextarea) el.customLyricsTextarea.value = state.syncedLyrics.map(l => (l.time >= 0 ? `${lrcStamp(l.time)}${l.text}` : l.text)).join('\n');
    } else {
      if (el.customLyricsTextarea) el.customLyricsTextarea.value = '';
    }
    if (el.customLyricsModal) {
      openModal(el.customLyricsModal);
      if (el.customLyricsTextarea) setTimeout(() => el.customLyricsTextarea.focus(), 100);
    }
  }

  function closeCustomLyricsEditor() {
    if (el.customLyricsModal) closeModal(el.customLyricsModal);
  }

  let customLyricsFor = null;
  const lrcStamp = (t) => `[${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}]`;
  const isCurrentSong = (s) => !!(s && state.currentTrack && (state.currentTrack.title || '') === s.title && (state.currentTrack.artist || '') === s.artist);

  async function saveCustomLyrics() {
    if (!customLyricsFor || !el.customLyricsTextarea) return;
    const text = el.customLyricsTextarea.value.trim();

    const { title, artist } = customLyricsFor;

    try {
      const res = await fetch(
        `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ lyrics: text })
                              }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');

      showToast(text ? Tm('Lyrics saved successfully') : Tm('Lyrics removed'), 'info');
      closeCustomLyricsEditor();
      if (isCurrentSong({ title, artist })) loadSyncedLyrics(title, artist, state.loadToken);
    } catch (e) {
      showToast(Tm('Failed to save lyrics: {0}', e.message), 'error');
    }
  }

  if (el.btnAddCustomLyrics) el.btnAddCustomLyrics.addEventListener('click', openCustomLyricsEditor);
  if (el.btnCloseCustomLyrics) el.btnCloseCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnCancelCustomLyrics) el.btnCancelCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnSaveCustomLyrics) el.btnSaveCustomLyrics.addEventListener('click', saveCustomLyrics);

  if (el.customLyricsModal) {
    el.customLyricsModal.addEventListener('click', (e) => {
      if (e.target === el.customLyricsModal) closeCustomLyricsEditor();
    });
  }

  let syncState = {
    active: false,
    lines: [],
    currentIndex: 0
  };

  function openSyncMode() {
    if (!state.currentTrack) {
      showToast(Tm('Play a track first to sync lyrics'), 'info');
      return;
    }

    if (state.syncedLyrics.length === 0) {
      showToast(Tm('Add lyrics first using the edit button, then sync them'), 'info');
      return;
    }

    syncState.active = true;
    syncState.lines = state.syncedLyrics.map(l => ({ text: l.text, time: null }));
    syncState.currentIndex = 0;
    // the overlay stays open when the song ends: the timings belong to this song, not whatever plays at Save
    syncState.song = { title: state.currentTrack.title || '', artist: state.currentTrack.artist || '' };

    renderSyncLines();
    // the banner shipped with placeholder text and was never filled in
    const syncTitle = document.getElementById('sync-track-title');
    const syncArtist = document.getElementById('sync-track-artist');
    if (syncTitle) syncTitle.textContent = (state.currentTrack && state.currentTrack.title) || 'Untitled';
    if (syncArtist) syncArtist.textContent = (state.currentTrack && state.currentTrack.artist) || '';
    if (el.syncModeOverlay) openModal(el.syncModeOverlay);

    if (state.currentTrack && !state.isPlaying) {
      playSmooth();
    }

    showToast(Tm('Press play, then click or tap each line when you hear it'), 'info');
  }

  function updateSyncProgress() {
    const synced = syncState.lines.filter(l => l.time !== null).length;
    const total = syncState.lines.length;
    if (el.syncProgressText) el.syncProgressText.textContent = `${synced} / ${total} lines synced`;
  }

  function renderSyncLines() {
    if (!el.syncModeLyrics) return;
    const prevTop = el.syncModeLyrics.scrollTop;
    el.syncModeLyrics.innerHTML = '';
    syncState.lines.forEach((line, idx) => {
      const div = document.createElement('div');
      div.className = 'sync-line';
      div.textContent = line.text;

      if (line.time !== null) {
        div.classList.add('synced');
        const min = Math.floor(line.time / 60);
        const sec = (line.time % 60).toFixed(2);
        div.setAttribute('data-time', `[${min}:${sec.padStart(5, '0')}]`);
      }

      if (idx === syncState.currentIndex && line.time === null) {
        div.classList.add('next-line');
      }

      div.addEventListener('click', () => handleSyncLineClick(idx));
      el.syncModeLyrics.appendChild(div);
    });

    el.syncModeLyrics.scrollTop = prevTop;
    updateSyncProgress();

    const nextEl = el.syncModeLyrics.querySelector('.next-line');
    if (nextEl) {
      const c = el.syncModeLyrics;
      const cr = c.getBoundingClientRect(), nr = nextEl.getBoundingClientRect();
      animateLyricsScroll(c, c.scrollTop + (nr.top - cr.top) - c.clientHeight / 2 + nr.height / 2);
    }
  }

  function handleSyncLineClick(idx) {
    if (!syncState.active || !el.nativeAudio) return;
    if (!isCurrentSong(syncState.song)) { showToast(Tm('The song changed. Save or restart the sync.'), 'info'); return; }

    const currentTime = el.nativeAudio.currentTime || 0;
    syncState.lines[idx].time = currentTime;

    let next = -1;
    for (let i = idx + 1; i < syncState.lines.length; i++) {
      if (syncState.lines[i].time === null) {
        next = i;
        break;
      }
    }
    syncState.currentIndex = next >= 0 ? next : syncState.lines.length;

    renderSyncLines();
  }

  function restartSync() {
    syncState.lines.forEach(l => l.time = null);
    syncState.currentIndex = 0;
    if (el.nativeAudio && isCurrentSong(syncState.song)) el.nativeAudio.currentTime = 0;
    renderSyncLines();
    showToast(Tm('Sync restarted'), 'info');
  }

  async function saveSyncAndExit() {
    if (!syncState.song) return;

    const lrcLines = syncState.lines.map(line => {
      if (line.time !== null) {
        const min = Math.floor(line.time / 60);
        const sec = (line.time % 60).toFixed(2);
        return `[${min}:${sec.padStart(5, '0')}]${line.text}`;
      }
      return line.text;
    });
    const lrcContent = lrcLines.join('\n');

    const { title, artist } = syncState.song;

    try {
      const res = await fetch(
        `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ lyrics: lrcContent })
                              }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');

      showToast(Tm('Synced lyrics saved'), 'info');
      closeSyncMode();
      if (isCurrentSong({ title, artist })) loadSyncedLyrics(title, artist, state.loadToken);
    } catch (e) {
      showToast(Tm('Failed to save synced lyrics: {0}', e.message), 'error');
    }
  }

  function closeSyncMode() {
    syncState.active = false;
    if (el.syncModeOverlay) closeModal(el.syncModeOverlay);
  }

  if (el.btnSyncLyrics) el.btnSyncLyrics.addEventListener('click', openSyncMode);
  if (el.btnRestartSync) el.btnRestartSync.addEventListener('click', restartSync);
  if (el.btnSaveSync) el.btnSaveSync.addEventListener('click', saveSyncAndExit);
  if (el.btnCancelSync) el.btnCancelSync.addEventListener('click', closeSyncMode);

  if (el.syncModeOverlay) {
    el.syncModeOverlay.addEventListener('click', (e) => {
      if (e.target === el.syncModeOverlay) closeSyncMode();
    });
  }

  let smoothFadeToken = 0;
  let isAppClosing = false;
  window.addEventListener('beforeunload', () => { isAppClosing = true; });

  function pauseSmooth() {
    const curToken = ++smoothFadeToken;
    state.isPlaying = false;
    // a pause someone asked for: not undone when another app's sound ends (mobile/audio-interruption.js)
    state.pausedByUser = true;
    setTrackLoading(false);
    updatePlayPauseButton(false, false);
    document.body.classList.remove('is-playing');
    if (el.coverContainer) el.coverContainer.classList.remove('spinning');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    sendStateToServer();
    updateMediaSession();
    // a pause during a crossfade holds the old song's tail too (the fade follows its time, so it resumes in place)
    dropCrossfadePrep();
    if (xfade.tail) { try { xfade.tail.el.pause(); } catch (e) {} }

    const audio = el.nativeAudio;
    if (isAppClosing || !audio || audio.paused) {
      if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        try {
          audioEngine.fadeGain.gain.cancelScheduledValues(audioEngine.ctx.currentTime);
          audioEngine.fadeGain.gain.setValueAtTime(0, audioEngine.ctx.currentTime);
        } catch (e) {}
      }
      if (audio) {
        try { audio.pause(); } catch (e) {}
      }
      if (state.secondaryAudio) {
        try { state.secondaryAudio.pause(); } catch (e) {}
      }
      if (audioEngine && audioEngine.flushEffects) {
        audioEngine.flushEffects();
      }
      return;
    }

    if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
      try {
        const ct = audioEngine.ctx.currentTime;
        audioEngine.fadeGain.gain.cancelScheduledValues(ct);
        audioEngine.fadeGain.gain.setTargetAtTime(0, ct, 0.06);
      } catch (e) {}
    }

    setTimeout(() => {
      if (curToken !== smoothFadeToken) return;
      if (audio) {
        try { audio.pause(); } catch (e) {}
      }
      if (state.secondaryAudio) {
        try { state.secondaryAudio.pause(); } catch (e) {}
      }
      if (audioEngine && audioEngine.flushEffects) {
        audioEngine.flushEffects();
      }
    }, 280);
  }

  async function playSmooth() {
    const curToken = ++smoothFadeToken;
    state.isPlaying = true;
    state.pausedByUser = false;
    document.body.classList.add('is-playing');
    updatePlayPauseButton(true, false);
    if (el.coverContainer && state.vfx.vinylSpin) el.coverContainer.classList.add('spinning');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    sendStateToServer();
    updateMediaSession();

    if (xfade.tail && xfade.tail.el.paused) resumeCrossfadeTail();
    initAudioContext();
    if (audioEngine && audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      // in a backgrounded WebView resume() can hang until the app is opened; don't let it hold play() back (#24).
      // The 'play' / 'playing' handlers ask the context to resume again.
      await Promise.race([audioEngine.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    }
    if (curToken !== smoothFadeToken) return;

    if (crossfadeFadeInPending) {
      if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        try {
          audioEngine.fadeGain.gain.cancelScheduledValues(audioEngine.ctx.currentTime);
          audioEngine.fadeGain.gain.setValueAtTime(1, audioEngine.ctx.currentTime);
        } catch (e) {}
      }
    } else {
      if (audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
        try {
          const ct = audioEngine.ctx.currentTime;
          audioEngine.fadeGain.gain.cancelScheduledValues(ct);
          audioEngine.fadeGain.gain.setValueAtTime(0, ct);
        } catch (e) {}
      }
    }

    if (el.nativeAudio) {
      const loadTok = state.loadToken;
      const playSrc = el.nativeAudio.currentSrc || el.nativeAudio.src;
      el.nativeAudio.play().catch(e => {
        // "[object DOMException]" told nobody anything (#17): say which one, and what the element was doing
        logPlaybackIssue('Play error', e);
        // AbortError: our own pause() or a newer src/load() interrupted this play(), not a failure
        if (e && e.name === 'AbortError') return;
        // a newer song (or a newer play/pause) took over meanwhile
        if (loadTok !== state.loadToken || curToken !== smoothFadeToken) return;
        if ((el.nativeAudio.currentSrc || el.nativeAudio.src) !== playSrc && !hlsInstance) return;
        // a media error also fires the element's 'error' event, which retries / tells the listener itself
        if (el.nativeAudio.error) return;
        if (!el.nativeAudio.paused) return;
        // anything else (NotAllowedError, NotSupportedError without a media error): look it up afresh once
        if (retryFresh(loadTok, state.currentTrack)) return;
        // a refused play() (no gesture yet, source gone) left the button showing pause on a silent player.
        state.isPlaying = false;
        setTrackLoading(false);
        document.body.classList.remove('is-playing');
        updatePlayPauseButton(false, false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      });
    }

    if (!crossfadeFadeInPending && audioEngine && audioEngine.fadeGain && audioEngine.ctx) {
      try {
        const ct = audioEngine.ctx.currentTime;
        audioEngine.fadeGain.gain.setTargetAtTime(1, ct, 0.05);
      } catch (e) {}
    }
  }

  window.pauseSmooth = pauseSmooth;
  window.playSmooth = playSmooth;

  let queueEndedToken = -1; // the song the queue ended on with repeat off, see the 'ended' handler
  function togglePlayPause() {
    if (!state.currentTrack) {
      if (state.queue.length > 0) playTrack(state.queue[0]);
      else if (el.nativeAudio && el.nativeAudio.src) {
        if (state.isPlaying) pauseSmooth();
        else playSmooth();
      }
      return;
    }
    if (state.isPlaying) {
      pauseSmooth();
      saveQueueState();
    } else if (queueEndedToken === state.loadToken && el.nativeAudio && el.nativeAudio.ended) {
      queueEndedToken = -1;
      playNext();
    } else if (el.nativeAudio && !el.nativeAudio.src && state.currentTrack) {
      const resumeAt = state.queueRestorePosition || 0;
      state.queueRestorePosition = 0;
      playTrack(state.currentTrack, state.queue, state.queueIndex);
      // playTrack bumps loadToken before its first await: a skip before the song loads must not seek the next one
      const resumeToken = state.loadToken;
      if (resumeAt > 3) {
        const seekOnce = () => {
          el.nativeAudio.removeEventListener('loadedmetadata', seekOnce);
          if (resumeToken !== state.loadToken) return;
          if (!el.nativeAudio.duration || resumeAt < el.nativeAudio.duration - 5) el.nativeAudio.currentTime = resumeAt;
        };
        el.nativeAudio.addEventListener('loadedmetadata', seekOnce);
      }
    } else {
      playSmooth();
    }
  }

  // Shuffle used to roll any index, the current song included (a third of Nexts in a 3-song queue replayed
  // it), and never looked at "Play next". Now it plays the Play-next songs first, then songs not heard yet
  // in this queue, and starts a new round once everything has played.
  function pickShuffleIndex() {
    const q = state.queue;
    if (shuffleBag.queue !== q) { shuffleBag.queue = q; shuffleBag.played = new Set(); }
    if (q[state.queueIndex]) shuffleBag.played.add(q[state.queueIndex]);
    while (shuffleBag.next.length) {
      const i = q.indexOf(shuffleBag.next.shift());
      if (i >= 0 && i !== state.queueIndex) return i;
    }
    // the song chosen (and downloaded) in advance by planShuffleNext
    const planned = shuffleBag.planned;
    shuffleBag.planned = null;
    const pi = planned ? q.indexOf(planned) : -1;
    if (pi >= 0 && pi !== state.queueIndex && !shuffleBag.played.has(planned)) return pi;
    if (q.length < 2) return 0;
    let pool = [];
    q.forEach((t, i) => { if (i !== state.queueIndex && !shuffleBag.played.has(t) && !isBlocked(t)) pool.push(i); });
    if (!pool.length) {
      shuffleBag.played = new Set([q[state.queueIndex]]);
      q.forEach((t, i) => { if (i !== state.queueIndex && !isBlocked(t)) pool.push(i); });
    }
    // everything else is blocked: the queue still moves on
    if (!pool.length) q.forEach((t, i) => { if (i !== state.queueIndex) pool.push(i); });
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Shuffle picks the next song while this one plays, so it can be downloaded in time: songs are fetched
  // ahead, and a gap between songs could let iOS suspend Muriel with the screen locked.
  function planShuffleNext() {
    const q = state.queue;
    if (q.length < 2) return null;
    const pending = shuffleBag.next.find(t => q.indexOf(t) >= 0 && t !== q[state.queueIndex]);
    if (pending) return pending;
    if (shuffleBag.planned && q.indexOf(shuffleBag.planned) >= 0 && shuffleBag.planned !== q[state.queueIndex]) return shuffleBag.planned;
    const played = shuffleBag.queue === q ? shuffleBag.played : new Set();
    let pool = q.filter((t, i) => i !== state.queueIndex && !played.has(t) && !isBlocked(t));
    if (!pool.length) pool = q.filter((t, i) => i !== state.queueIndex && !isBlocked(t));
    if (!pool.length) pool = q.filter((t, i) => i !== state.queueIndex);
    shuffleBag.planned = pool[Math.floor(Math.random() * pool.length)] || null;
    return shuffleBag.planned;
  }

  // With repeat off, the queue plays once: true while the last song of it plays (with shuffle on, the last
  // one not heard yet). Repeat 'all' starts over instead, and My Wave keeps adding songs.
  function queueFinished() {
    const q = state.queue;
    if (state.repeatMode !== 'off' || state.myWaveActive || !q.length) return false;
    if (!state.isShuffle) return state.queueIndex >= q.length - 1;
    if (shuffleBag.next.some(t => q.indexOf(t) >= 0 && t !== q[state.queueIndex])) return false;
    const played = shuffleBag.queue === q ? shuffleBag.played : new Set();
    return q.every((t, i) => i === state.queueIndex || played.has(t));
  }

  function recordPlayedIndex(idx) {
    if (typeof idx !== 'number' || idx < 0) return;
    const h = state.queueHistory;
    if (h[h.length - 1] !== idx) h.push(idx);
    if (h.length > 200) h.shift();
  }

  function playNext() {
    advancing = true;
    try { playNextSong(); } finally { advancing = false; }
  }

  function playNextSong() {
    if (state.queue.length === 0) return;

    if (!state._isNaturalEnding && state.myWaveActive && state.currentTrack) {
      const cur = (el.nativeAudio && typeof el.nativeAudio.currentTime === 'number') ? el.nativeAudio.currentTime : 0;
      if (cur < 12 && typeof recordWaveSkip === 'function') {
        recordWaveSkip(state.currentTrack);
        state._skipRecordedFor = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id;
      }
    }

    if (state.isShuffle) {
      const nextIdx = pickShuffleIndex();
      state.queueIndex = nextIdx;
      recordPlayedIndex(nextIdx);
      playTrack(state.queue[nextIdx]);
      return;
    }

    let nextIdx = state.queueIndex + 1;
    while (nextIdx < state.queue.length && isBlocked(state.queue[nextIdx])) nextIdx++;
    if (nextIdx >= state.queue.length) {
      if (state.myWaveActive && typeof extendMyWaveQueue === 'function') {
        const tok = state.loadToken;
        setTrackLoading(true); // the next songs are still being picked
        const done = () => { if (tok === state.loadToken) setTrackLoading(false); };
        extendMyWaveQueue().then(added => {
          if (added && tok === state.loadToken && state.queueIndex + 1 < state.queue.length) {
            playNext();
          } else done();
        }, done);
        return;
      }
      nextIdx = 0;
      while (nextIdx < state.queueIndex && isBlocked(state.queue[nextIdx])) nextIdx++;
    }
    if (shuffleBag.next.length) shuffleBag.next = shuffleBag.next.filter(t => t !== state.queue[nextIdx]);
    state.queueIndex = nextIdx;
    recordPlayedIndex(nextIdx);
    playTrack(state.queue[nextIdx]);

    if (state.myWaveActive && state.queueIndex >= state.queue.length - 3 && typeof extendMyWaveQueue === 'function') {
      extendMyWaveQueue();
    }
  }

  function playPrev() {
    if (el.nativeAudio && el.nativeAudio.currentTime > 3) {
      el.nativeAudio.currentTime = 0;
      return;
    }
    {
      const h = state.playHistory || [];
      if (h.length) {
        const prev = h.pop();
        navigatingBack = true;
        try { playTrack(prev); } finally { navigatingBack = false; }
        const prevIdx = state.queue.findIndex(t => t.id === prev.id || isSameTrack(t, prev));
        if (prevIdx !== -1) state.queueIndex = prevIdx;
        return;
      }
    }
    if (state.queue.length === 0) return;

    const h = state.queueHistory;
    if (h.length > 1) {
      h.pop();
      const prevIdx = h[h.length - 1];
      if (prevIdx >= 0 && prevIdx < state.queue.length) {
        state.queueIndex = prevIdx;
        playTrack(state.queue[prevIdx]);
        return;
      }
      h.push(state.queueIndex);
    }

    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = state.queue.length - 1;
    state.queueIndex = prevIdx;
    state.queueHistory = [prevIdx];
    playTrack(state.queue[prevIdx]);
  }

  if (el.nativeAudio) {
    el.nativeAudio.addEventListener('error', () => {
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      // only an error on the song that is actually loaded counts (unloading one between songs is not a failure)
      if (!state.currentTrack || (!el.nativeAudio.src && !hlsInstance)) return;
      logPlaybackIssue('Audio element error', null);
      state.isPlaying = false;
      document.body.classList.remove('is-playing');
      if (tryProxyFallback(state.loadToken, state.currentTrack)) return;
      if (retryFresh(state.loadToken, state.currentTrack)) return;
      updatePlayPauseButton(false, false);
      if (skipUnplayable(state.loadToken, state.currentTrack)) return;
      if (state.currentTrack.platform === 'local') showToast(Tm('File missing from library'));
      else showToast(Tm('Could not play this song. Try again or skip.'), 'error');
    });

    el.nativeAudio.addEventListener('waiting', () => {
      updatePlayPauseButton(state.isPlaying, true);
    });

    // Each look-up starts yt-dlp, which can run a JavaScript runtime at full CPU (#16), so the computer
    // only looks up the one song that plays next, and only near the end of this one. Phones download
    // whole songs to play them, so they start on that halfway through.
    function prefetchNextQueueTrack() {
      const nextTrack = state.isShuffle ? planShuffleNext() : (state.queue && state.queue.slice(state.queueIndex + 1).find((t) => !isBlocked(t)));
      if (!nextTrack || nextTrack.platform === 'local' || !(nextTrack.url || nextTrack.id)) return;
      const q = `url=${encodeURIComponent(nextTrack.url || '')}&id=${encodeURIComponent(nextTrack.id || '')}&platform=${nextTrack.platform || state.platform}&title=${encodeURIComponent(nextTrack.title || '')}&artist=${encodeURIComponent(nextTrack.artist || '')}&duration=${encodeURIComponent(nextTrack.duration || 0)}&thumbnail=${encodeURIComponent(nextTrack.thumbnail || '')}`;
      fetch(`http://127.0.0.1:${state.serverPort}/api/${isPhoneApp ? 'stream-info' : 'prefetch'}?${q}&next=1`).catch(() => {});
    }

    el.nativeAudio.addEventListener('playing', () => {
      failStreak = 0;
      state.isPlaying = true;
      setTrackLoading(false);
      registerMediaActions();
      document.body.classList.add('is-playing');
      updatePlayPauseButton(true, false);
      // phones warm up the next two songs (staggered) so skipping or a slow network never leaves a gap;
      // the computer looks up only the next one, near the end of this one (prefetchNextQueueTrack, #16)
      const upcoming = !isPhoneApp ? [] : state.isShuffle ? [planShuffleNext()] : [1, 2].map(ahead => state.queue && state.queue[state.queueIndex + ahead]);
      upcoming.forEach((nextTrack, k) => {
        if (nextTrack && nextTrack.url && nextTrack.platform !== 'local') {
          setTimeout(() => {
            fetch(`http://127.0.0.1:${state.serverPort}/api/prefetch?url=${encodeURIComponent(nextTrack.url)}&id=${encodeURIComponent(nextTrack.id || '')}&platform=${nextTrack.platform || state.platform}&title=${encodeURIComponent(nextTrack.title || '')}&artist=${encodeURIComponent(nextTrack.artist || '')}&duration=${encodeURIComponent(nextTrack.duration || 0)}&thumbnail=${encodeURIComponent(nextTrack.thumbnail || '')}`).catch(() => {});
          }, 2000 + k * 6000);
        }
      });
    });

    el.nativeAudio.addEventListener('canplay', () => {
      updatePlayPauseButton(state.isPlaying, false);
    });

    el.nativeAudio.addEventListener('play', () => {
      emitPluginEvent('play');
      if (!hasNotifiedMediaKeysActive) {
        hasNotifiedMediaKeysActive = true;
        if (window.electronAPI && window.electronAPI.mediaKeysActive) {
          window.electronAPI.mediaKeysActive();
        }
      }
      updatePlayPauseButton(true, false);
      if (!state.isPlaying) {
        state.isPlaying = true;
        document.body.classList.add('is-playing');
        if (el.coverContainer && state.vfx.vinylSpin) el.coverContainer.classList.add('spinning');
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        sendStateToServer();
        updateMediaSession();
      }
      updateMediaPositionState();
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      hasDrawnPausedFrame = false;
      if (!animationFrameId) startVisualizers();
      if (audioEngine) {
        if (audioEngine.resumeAudioContext) audioEngine.resumeAudioContext();
        audioEngine._applyMasterVolume();
      }
      if (crossfadeFadeInPending) {
        crossfadeFadeInPending = false;
        crossfadeFadeIn();
      }
      sendStateToServer();
      updateMediaSession();
      if (typeof m3cStart === 'function') m3cStart();
    });

    el.nativeAudio.addEventListener('pause', () => {
      if (!el.nativeAudio.ended) cancelEndFade();
      emitPluginEvent('pause');
      updatePlayPauseButton(false, false);
      if (state.isPlaying) {
        state.isPlaying = false;
        document.body.classList.remove('is-playing');
        if (el.coverContainer) el.coverContainer.classList.remove('spinning');
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
        sendStateToServer();
        updateMediaSession();
      }
      updateMediaPositionState();
      if (audioEngine) {
        if (audioEngine.suspendAudioContextDebounced) audioEngine.suspendAudioContextDebounced(5000);
        if (audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
      }
      if (typeof applyM3Cover === 'function') applyM3Cover();
    });

    el.nativeAudio.addEventListener('ended', () => {
      updatePlayPauseButton(false, false);
      if (state.sleepTimer && state.sleepTimer.mode === 'end') {
        state.sleepTimer = null;
        updateSleepTimerUI();
        return;
      }
      if (audioEngine) {
        if (audioEngine.suspendAudioContextDebounced) audioEngine.suspendAudioContextDebounced(5000);
        if (audioEngine.setAnalyserEnabled) audioEngine.setAnalyserEnabled(false);
      }
      // a song that faded out (Crossfade) hands over to one that fades in
      const fadedOut = crossfadeTriggered && !state.isRepeat && !queueFinished();
      if (!fadedOut) cancelEndFade();
      if (state.isRepeat) {
        el.nativeAudio.currentTime = 0;
        playSmooth();
      } else if (queueFinished()) {
        // repeat is off and that was the last song: stop here; play starts the queue over
        queueEndedToken = state.loadToken;
        saveQueueState();
      } else {
        if (fadedOut) crossfadeFadeInPending = true;
        state._isNaturalEnding = true;
        try {
          playNext();
        } finally {
          state._isNaturalEnding = false;
        }
      }
    });

    // speed / pitch (Sound settings) for every song: iPhones put playbackRate back to 1 once a new song
    // has loaded, which undid the settings applied when it started loading (issue #5)
    const keepPlaybackRate = () => {
      if (!audioEngine || !audioEngine.playbackFor) return;
      const { rate, preservePitch } = audioEngine.playbackFor();
      const a = el.nativeAudio;
      if (Math.abs(a.playbackRate - rate) > 0.001 || a.preservesPitch !== preservePitch) audioEngine.applySettings(a);
    };
    ['loadedmetadata', 'canplay', 'playing'].forEach(ev => el.nativeAudio.addEventListener(ev, keepPlaybackRate));

    // The iPhone's Now Playing widget moves its progress bar on its own from the last position and rate it was
    // given. Told only at play / pause, it kept the rate WebKit had reset to 1 before the song's speed was put
    // back (a sped-up song's bar lagged), and a length that wasn't known yet (#26). Tell it again whenever any
    // of them changes, and now and then while playing.
    let positionSentAt = 0;
    const sendPosition = () => { positionSentAt = Date.now(); updateMediaPositionState(); };
    ['ratechange', 'durationchange', 'loadedmetadata', 'seeked', 'playing'].forEach(ev => el.nativeAudio.addEventListener(ev, sendPosition));
    el.nativeAudio.addEventListener('timeupdate', () => {
      if (!el.nativeAudio.paused && Date.now() - positionSentAt > 10000) sendPosition();
    });

    el.nativeAudio.addEventListener('durationchange', () => {
      const audio = el.nativeAudio;
      if (state.currentTrack && Number.isFinite(audio.duration) && audio.duration > 1) {
        const newDur = Math.round(audio.duration);
        if (Math.abs(audio.duration - (state.currentTrack.duration || 0)) > 1.5) {
          state.currentTrack.duration = newDur;
          const tid = state.currentTrack.id;
          if (Array.isArray(state.queue)) {
            state.queue.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
          }
          if (Array.isArray(state.playlists)) {
            state.playlists.forEach((p) => {
              if (p && Array.isArray(p.tracks)) {
                p.tracks.forEach((t) => { if (t && t.id === tid) t.duration = newDur; });
              }
            });
          }
        }
        if (el.timeDuration) el.timeDuration.textContent = formatDuration(newDur);
      }
      updateMediaPositionState();
    });

    el.nativeAudio.addEventListener('seeked', () => {
      cancelEndFade(); // timeupdate fades again from here if the seek stayed inside the last seconds
      updateMediaPositionState();
      updateDiscordPresence();
      state.forceLyricsScroll = true;
      state.forceSnapLyrics = true;
      state.lastActiveLyricIdx = -1;
      if (state.isRightPanelOpen || state.isTvKaraokeOpen) {
        updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      }
    });

    let lastTimeupdateSec = -1;
    el.nativeAudio.addEventListener('timeupdate', () => {
      if (enforceTrackTrim()) return;
      const cur = (el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime)) ? el.nativeAudio.currentTime : 0;
      const dur = (el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
        ? el.nativeAudio.duration
        : (state.currentTrack && Number.isFinite(state.currentTrack.duration) ? state.currentTrack.duration : 0);
      if (state.isTvKaraokeOpen) syncTvkProgress(cur, dur);
      if (miniLyricsShown()) updateMiniLyricsHighlight(cur);

      // Crossfade (off by default): fade the song out over its last X seconds while it keeps playing; the
      // 'ended' handler starts the next one, which fades in. This used to skip to the next song X seconds before
      // the end, which cut every song short by the crossfade length (#22).
      // With overlap (#29) the last X seconds move to a second player that plays them to the end while the next
      // song starts (prepareCrossfade); the song itself is never cut short.
      const X = crossfadeSeconds();
      if (X > 0 && !crossfadeTriggered && !state.isRepeat && !el.nativeAudio.paused && audioEngine && !audioEngine.isLiveStream(el.nativeAudio) && window.MurielTrim) {
        const trim = state.currentTrack ? getTrackTrim(state.currentTrack) : null;
        const end = window.MurielTrim.isActive(trim) ? Math.min(trim.end, dur) : dur;
        const sleepAtEnd = state.sleepTimer && state.sleepTimer.mode === 'end';
        const step = !sleepAtEnd && canOverlap(el.nativeAudio) && !queueFinished() ? window.MurielTrim.crossfadeStep(cur, end, X, el.nativeAudio.playbackRate) : null;
        if (step && !xfade.prep) {
          prepareCrossfade(window.MurielTrim.crossfadePoint(end, X), end);
        } else if (!step && !xfade.prep) {
          const fade = window.MurielTrim.endFadeSeconds(cur, end, X, el.nativeAudio.playbackRate);
          if (fade > 0) {
            crossfadeTriggered = true;
            audioEngine.fadeOut(fade);
          }
        }
      }

      if (state.isPlaying && nextPrefetchDue(cur, dur) && !state.nextTrackPrefetched) {
        state.nextTrackPrefetched = true;
        prefetchNextQueueTrack();
      }

      if (!state.isPlaying && typeof m3cDraw === 'function' && typeof m3cEnabled === 'function' && m3cEnabled()) {
        m3cDraw(performance.now());
      }

      if (isDraggingScrubber || state.isPlaying) return;
      const roundedSec = Math.floor(cur);
      if (lastTimeupdateSec === roundedSec) return;
      lastTimeupdateSec = roundedSec;
      if (state.isRightPanelOpen || state.isTvKaraokeOpen) {
        updateSyncedLyricsHighlight(cur);
      }
      if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(cur);
      if (el.timeDuration) el.timeDuration.textContent = formatDuration(dur);
    });
  }

  let isDraggingScrubber = false;

  function updateScrubberPositionFromEvent(e) {
    if (!el.scrubberTrack) return 0;
    const rect = el.scrubberTrack.getBoundingClientRect();
    const padLeft = 5.5;
    const trackWidth = rect.width - 2 * padLeft;
    let pos = trackWidth > 0 ? (e.clientX - rect.left - padLeft) / trackWidth : 0;
    pos = Math.max(0, Math.min(1, pos));
    const dur = (el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
      ? el.nativeAudio.duration
      : (state.currentTrack && Number.isFinite(state.currentTrack.duration) ? state.currentTrack.duration : 0);
    const targetTime = pos * dur;

    state.scrubberDragTargetTime = targetTime;
    if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(targetTime);
    return targetTime;
  }

  // Pointer events (not mouse events) so a finger drag scrubs too: on Android a touch drag never fires
  // mousemove, only the tap's synthesized mousedown/mouseup, so only tapping used to seek (#21).
  let scrubberPointerId = null;
  if (el.scrubberTrack) {
    el.scrubberTrack.style.touchAction = 'none';
    el.scrubberTrack.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      isDraggingScrubber = true;
      scrubberPointerId = e.pointerId;
      try { el.scrubberTrack.setPointerCapture(e.pointerId); } catch (_) {}
      hasDrawnPausedFrame = false;
      if (!animationFrameId) startVisualizers();
      el.scrubberTrack.classList.add('dragging');
      updateScrubberPositionFromEvent(e);
    });
  }

  window.addEventListener('pointermove', (e) => {
    if (!isDraggingScrubber || e.pointerId !== scrubberPointerId) return;
    updateScrubberPositionFromEvent(e);
  });

  const endScrub = (e, commit) => {
    if (!isDraggingScrubber || e.pointerId !== scrubberPointerId) return;
    isDraggingScrubber = false;
    scrubberPointerId = null;
    if (el.scrubberTrack) el.scrubberTrack.classList.remove('dragging');
    const targetTime = commit ? updateScrubberPositionFromEvent(e) : state.scrubberDragTargetTime;
    if (targetTime !== undefined && !isNaN(targetTime) && el.nativeAudio) {
      el.nativeAudio.currentTime = targetTime;
      updateMediaPositionState();
    }
    state.scrubberDragTargetTime = undefined;
  };
  window.addEventListener('pointerup', (e) => endScrub(e, true));
  window.addEventListener('pointercancel', (e) => endScrub(e, false));

  function getAllPresets() {
    return [...defaultPresets, ...state.customPresets];
  }

  function renderPresets() {
    if (!el.presetsContainer) return;
    el.presetsContainer.innerHTML = '';
    const all = getAllPresets();
    all.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'preset-chip';
      if (state.activePresetId === p.id) chip.classList.add('active');

      const isCustom = p.id.startsWith('custom_');
      chip.dataset.isCustom = isCustom ? 'true' : 'false';
      chip.dataset.presetId = p.id;

      chip.innerHTML = `
      <span class="preset-name-label">${escapeHtml(p.name)}</span>
      ${isCustom ? `
        <div class="preset-actions">
          <button type="button" class="preset-btn-action btn-rename-p" title="Rename" aria-label="Rename preset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <button type="button" class="preset-btn-action btn-delete-p" title="Delete" aria-label="Delete preset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>` : ''}
        `;

        if (isCustom) {
          const btnRename = chip.querySelector('.btn-rename-p');
          const btnDelete = chip.querySelector('.btn-delete-p');
          if (btnRename) {
            btnRename.addEventListener('click', (e) => {
              e.stopPropagation();
              openRenamePresetModal(p);
            });
          }
          if (btnDelete) {
            btnDelete.addEventListener('click', (e) => {
              e.stopPropagation();
              openDeletePresetConfirm(p);
            });
          }
        }

        chip.addEventListener('click', (e) => {
          if (e.target.closest('.btn-delete-p') || e.target.closest('.btn-rename-p')) return;
          applyPreset(p);
        });

        el.presetsContainer.appendChild(chip);
    });
    updatePresetsFade();
  }

  function updateFade(el) {
    if (!el) return;
    el.classList.toggle('fade-top', el.scrollTop > 4);
    el.classList.toggle('fade-bottom', el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  }
  window.updateFade = updateFade;

  function updatePresetsFade() {
    updateFade(document.getElementById('presets-container'));
  }

  if (el.presetsContainer) {
    el.presetsContainer.addEventListener('scroll', updatePresetsFade, { passive: true });
  }
  window.addEventListener('resize', () => {
    updatePresetsFade();
    const c = document.querySelector('#view-album .album-tracks-col');
    if (c) updateFade(c);
  });

  let activeTweenRaf = null;
  function tweenSettings(from, to, ms, apply) {
    if (activeTweenRaf) cancelAnimationFrame(activeTweenRaf);
    const t0 = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - t0) / ms), e = k * k * (3 - 2 * k);
      const cur = {};
      for (const key in to) {
        if (typeof to[key] === 'number') cur[key] = from[key] + (to[key] - from[key]) * e;
        else if (Array.isArray(to[key])) {
          cur[key] = to[key].map((v, idx) => (from[key]?.[idx] ?? 0) + (v - (from[key]?.[idx] ?? 0)) * e);
        } else if (typeof to[key] === 'object' && to[key] !== null) {
          cur[key] = { ...from[key] };
          for (const subKey in to[key]) cur[key][subKey] = (from[key]?.[subKey] ?? 0) + (to[key][subKey] - (from[key]?.[subKey] ?? 0)) * e;
        } else cur[key] = to[key];
      }
      apply(cur);
      if (k < 1) activeTweenRaf = requestAnimationFrame(step);
      else activeTweenRaf = null;
    })(t0);
  }

  function applyPreset(preset) {
    const normalized = normalizePreset(preset);
    if (!normalized) return;
    state.activePresetId = normalized.id;
    initAudioContext();
    renderPresets();
    if (activeTweenRaf) { cancelAnimationFrame(activeTweenRaf); activeTweenRaf = null; }
    if (localStorage.getItem('muriel_smooth_presets') === 'false') {
      state.audioSettings = { ...normalized.settings };
      syncSettingsSlidersToState();
      applyAudioSettings();
      return;
    }
    const fromAudio = JSON.parse(JSON.stringify(state.audioSettings));
    const toAudio = JSON.parse(JSON.stringify(normalized.settings));
    tweenSettings(fromAudio, toAudio, 400, (cur) => {
      state.audioSettings = { ...state.audioSettings, ...cur };
      syncSettingsSlidersToState();
      applyAudioSettings();
    });
  }

  function saveCustomPreset(name) {
    if (!name || !name.trim()) return;
    const newPreset = {
      id: 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: name.trim(),
      settings: {
        ...state.audioSettings,
        eq: { ...(state.audioSettings.eq || {}) },
        eqBands: [...(state.audioSettings.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
      }
    };
    state.customPresets.push(newPreset);
    state.activePresetId = newPreset.id;
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    renderPresets();
    persistSoundSettings();
  }

  function openRenamePresetModal(preset) {
    state.presetToRenameId = preset.id;
    if (el.renamePresetName) el.renamePresetName.value = preset.name;
    if (el.renamePresetModal) openModal(el.renamePresetModal);
    if (el.renamePresetName) el.renamePresetName.focus();
  }

  function renameCustomPreset(id, newName) {
    if (!newName || !newName.trim()) return;
    const p = state.customPresets.find(x => x.id === id);
    if (p) {
      p.name = newName.trim();
      localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
      renderPresets();
    }
  }

  function deleteCustomPreset(id) {
    state.customPresets = state.customPresets.filter(p => p.id !== id);
    if (state.activePresetId === id) state.activePresetId = 'p_default';
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    renderPresets();
    persistSoundSettings();
  }

  function openDeletePresetConfirm(preset) {
    state.presetToDeleteId = preset.id;
    const msg = document.getElementById('delete-preset-msg');
    if (msg) I18N.text(msg, 'Delete preset "{0}"?', preset.name);
    const modal = document.getElementById('delete-preset-modal');
    if (modal) openModal(modal);
  }

  async function fetchArtistCardForSearch(query, token, searchTracks) {
    const container = document.getElementById('search-artist-card-container');
    if (!container) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?name=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (state.searchToken !== token) return;
      if (!data.success || !data.artist || !data.artist.name) return;

      const artist = data.artist;
      const normQ = normalizeImportText(query);
      const normA = normalizeImportText(artist.name);

      const isExactOrPrefix = normA === normQ || normA.startsWith(normQ) || normQ.startsWith(normA);
      const isTopTrackArtist = Array.isArray(searchTracks) && searchTracks.slice(0, 5).some(t => {
        const normT = normalizeImportText(t.artist);
        return normT === normA || normT.includes(normA) || normA.includes(normT);
      });

      if (!isExactOrPrefix && !isTopTrackArtist) {
        return;
      }

      const avatarUrl = artist.avatar || (searchTracks && searchTracks[0] ? searchTracks[0].thumbnail : '');
      container.innerHTML = `
        <div class="search-artist-card" role="button" tabindex="0">
          <div class="search-artist-avatar-wrap">
            ${avatarUrl ? `<img class="search-artist-avatar" loading="lazy" decoding="async" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(artist.name)}" />` : '<div style="width:100%;height:100%;background:var(--md-sys-color-surface-container);"></div>'}
          </div>
          <div class="search-artist-info">
            <span class="search-artist-name">${escapeHtml(artist.name)}</span>
            <span class="search-artist-label" data-i18n>Artist</span>
          </div>
        </div>
      `;

      const card = container.querySelector('.search-artist-card');
      if (card) {
        card.addEventListener('click', () => openArtistProfile(artist.name));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openArtistProfile(artist.name);
          }
        });
      }
    } catch (e) {}
  }

  const albumResolved = new Map();

  function normalizeMatchText(str) {
    if (!str) return '';
    return str
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function resolveAlbumTrack(album, t) {
    if (!album || !t) return null;
    const albumId = album.id || '';
    const trackNo = t.no != null ? t.no : 1;
    const cacheKey = `${albumId}:${trackNo}`;
    if (albumResolved.has(cacheKey)) {
      return albumResolved.get(cacheKey);
    }

    const query = `${t.artist || album.artist || ''} ${t.title || ''}`.trim();
    const platform = state.platform || 'youtube';
    let picked = null;
    try {
      const url = `http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(query)}&platform=${platform}&limit=5`;
      const res = await fetch(url);
      const data = await res.json();
      const results = (data && Array.isArray(data.tracks)) ? data.tracks.slice(0, 5) : [];
      if (results.length > 0) {
        const normAlbumTitle = normalizeMatchText((t.title || '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/\b(feat|ft)\b.*$/i, ''));
        const targetSec = t.durationMs ? t.durationMs / 1000 : null;
        const matching = normAlbumTitle
          ? results.filter(cand => normalizeMatchText(cand.title).includes(normAlbumTitle))
          : [];

        if (matching.length > 0) {
          if (targetSec != null) {
            picked = matching.find(c => {
              const cSec = toSeconds(c.duration);
              return cSec > 0 && Math.abs(cSec - targetSec) <= 6;
            }) || matching[0];
          } else {
            picked = matching[0];
          }
        }
      }
    } catch (err) {
      console.warn('[albums] resolve error:', err);
    }

    if (picked) {
      albumResolved.set(cacheKey, picked);
    }
    return picked;
  }

  function isEpisodeAlbum(tracks) {
    if (!tracks || tracks.length < 4) return false;
    const chapterLike = tracks.filter(t => /^(kapitel|inhaltsangabe|titelmusik|teil|chapter)\b|\((teil|kapitel|part|chapter)\s*\d+\)/i.test((t.title || '').trim())).length;
    return chapterLike / tracks.length >= 0.6;
  }

  async function playEpisodeAlbum(album, tracks, runId) {
    const totalSec = tracks.reduce((a, t) => a + (t.durationMs || 0), 0) / 1000;
    const platform = state.platform || 'youtube';
    const queries = [
      `${album.artist || ''} ${album.title || ''} ganzes Hörspiel`.trim(),
      `${album.artist || ''} ${album.title || ''}`.trim()
    ];
    let picked = null;
    for (const query of queries) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(query)}&platform=${platform}&limit=8`);
        const data = await res.json();
        const results = (data && Array.isArray(data.tracks)) ? data.tracks : [];
        const epTitle = normalizeMatchText((album.title || '').replace(/^\s*folge\s*\d+\s*[:\-]?\s*/i, '').replace(/\(.*?\)/g, ''));
        const epNum = ((album.title || '').match(/folge\s*(\d+)/i) || [])[1];
        const long = results.filter(c => {
          if (toSeconds(c.duration) < 600) return false;
          const ct = normalizeMatchText(c.title);
          if (epTitle && ct.includes(epTitle)) return true;
          return !!epNum && new RegExp('folge\\s*' + epNum + '(\\D|$)').test(ct);
        });
        if (long.length) {
          picked = long.slice().sort((a, b) => Math.abs(toSeconds(a.duration) - totalSec) - Math.abs(toSeconds(b.duration) - totalSec))[0];
          break;
        }
      } catch (e) {}
    }
    if (currentAlbumPlayRunId !== runId) return;
    if (!picked) {
      showToast(Tm('This album does not exist'), 'warning');
      return;
    }
    playTrack(picked, [picked], 0, 'album');
  }

  async function playAlbumFrom(album, tracks, startIndex = 0) {
    if (!album || !tracks || !tracks.length) return;
    const runId = ++currentAlbumPlayRunId;

    const toastTimer = setTimeout(() => {
      showToast(Tm('Finding tracks…'), 'info');
    }, 800);

    if (isEpisodeAlbum(tracks)) {
      await playEpisodeAlbum(album, tracks, runId);
      clearTimeout(toastTimer);
      return;
    }

    const startIdx = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const firstResolved = await resolveAlbumTrack(album, tracks[startIdx]);
    clearTimeout(toastTimer);

    if (currentAlbumPlayRunId !== runId) return;

    if (!firstResolved) {
      showToast(Tm('This album does not exist'), 'warning');
      return;
    }

    playTrack(firstResolved, [firstResolved], 0, 'album');

    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');

    try {
      const remaining = tracks.map((t, idx) => ({ t, idx })).filter(item => item.idx !== startIdx);
      const resolvedMap = new Map();
      let skippedCount = 0;

      await pool(remaining, 4, async (item) => {
        if (currentAlbumPlayRunId !== runId) return;
        const resTrack = await resolveAlbumTrack(album, item.t);
        if (currentAlbumPlayRunId !== runId) return;
        if (resTrack) {
          resolvedMap.set(item.idx, resTrack);
        } else {
          skippedCount++;
        }
      });

      if (currentAlbumPlayRunId !== runId) return;

      // the album continues after the song that was clicked; the earlier songs come after the last one
      // (they used to be queued right after it, so Next on track 4 played track 1)
      for (let k = 1; k < tracks.length; k++) {
        const i = (startIdx + k) % tracks.length;
        const cand = resolvedMap.get(i);
        if (!cand) continue;
        const alreadyInQueue = state.queue.some(q => isSameTrack(q, cand));
        if (!alreadyInQueue) {
          state.queue.push(cand);
        }
      }
      updateQueueBadge();
      if (state.currentView === 'queue') renderQueueView();

      if (skippedCount > 0) {
        showToast(Tm('{0} tracks not found', skippedCount), 'warning');
      }
    } finally {
      if (hasBusy) endBusy('import');
    }
  }

  // ---- saved albums: the heart on an album page and the Albums tab (Settings > Tracks > Show Albums tab) ----
  // Kept in muriel_saved_albums, the same on every linked device (sync.js). library-pages.js decides what is
  // "the same album" and what a saved album keeps.
  const Lib = window.MurielLibrary;
  const SAVED_ALBUMS_KEY = 'muriel_saved_albums';
  const getSavedAlbums = () => safeArray(SAVED_ALBUMS_KEY);
  function setSavedAlbums(list) {
    try { localStorage.setItem(SAVED_ALBUMS_KEY, JSON.stringify(list)); } catch (e) {}
    updateAlbumsCount();
    if (state.currentView === 'albums') renderSavedAlbums();
  }
  function updateAlbumsCount() {
    const n = getSavedAlbums().length;
    const badge = document.getElementById('albums-count');
    if (badge) badge.textContent = n;
    const sub = document.getElementById('albums-subtitle');
    if (sub) sub.textContent = `${n} album${n === 1 ? '' : 's'} saved`;
  }
  function renderSavedAlbums() {
    const grid = document.getElementById('saved-albums-grid');
    if (!grid) return;
    updateAlbumsCount();
    const albums = sortedLibrary('albums', getSavedAlbums());
    if (!albums.length) {
      grid.innerHTML = '<div class="empty-hint">No saved albums yet. Open an album and tap the heart to save it.</div>';
      return;
    }
    renderAlbumCards(grid, albums, (a) => [a.type && a.type !== 'Album' ? a.type : '', a.artist, a.year].filter(Boolean).join(' · '));
  }
  // the Albums tab and the heart only show when Settings > Tracks > Show Albums tab is on
  const btnShowAlbums = document.getElementById('btn-show-albums');
  function applyShowAlbums() {
    const show = localStorage.getItem('muriel_show_albums') === '1';
    document.body.classList.toggle('hide-albums-tab', !show);
    if (el.navAlbums) el.navAlbums.classList.toggle('nav-collapsed', !show);
    if (btnShowAlbums) btnShowAlbums.classList.toggle('active', show);
    if (!show && state.currentView === 'albums') switchView('discover');
    refreshStacks();
    updateNavIndicator(false);
  }
  if (btnShowAlbums) {
    btnShowAlbums.addEventListener('click', () => {
      localStorage.setItem('muriel_show_albums', localStorage.getItem('muriel_show_albums') === '1' ? '0' : '1');
      applyShowAlbums();
    });
  }

  // the album on the album page (an album, or a Daily Mix)
  let albumOnPage = null;
  function updateSaveAlbumButton() {
    const btn = document.getElementById('btn-save-album');
    if (!btn || !albumOnPage) return;
    const saved = Lib.isAlbumSaved(getSavedAlbums(), albumOnPage);
    btn.classList.toggle('active', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    btn.title = saved ? 'Remove from your albums' : 'Save album';
    btn.setAttribute('aria-label', btn.title);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', saved ? 'currentColor' : 'none');
  }
  const btnSaveAlbum = document.getElementById('btn-save-album');
  if (btnSaveAlbum) {
    btnSaveAlbum.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!albumOnPage || albumOnPage.type === 'Daily Mix') return;
      const r = Lib.toggleSavedAlbum(getSavedAlbums(), albumOnPage);
      setSavedAlbums(r.list);
      updateSaveAlbumButton();
      showToast(r.saved ? 'Saved to your albums' : 'Removed from your albums', 'info');
    });
  }

  // ---- Daily Mixes: thumbs up / down ("Do you like these songs?") on a mix's page ----
  // A liked mix makes its songs and artists count for more in My Wave and tomorrow's mixes; a disliked one keeps
  // what it brought in out of them (library-pages.js). Asked once per mix, and the mixes change every day.
  const MIX_FEEDBACK_KEY = 'muriel_mix_feedback';
  const getMixFeedback = () => Lib.cleanFeedback(safeJson(MIX_FEEDBACK_KEY, null));
  function showAlbumExtras(album) {
    albumOnPage = album;
    const isMix = album.type === 'Daily Mix';
    if (btnSaveAlbum) btnSaveAlbum.hidden = isMix;
    updateSaveAlbumButton();
    const box = document.getElementById('daily-mix-feedback');
    if (!box) return;
    box.classList.toggle('hidden', !isMix || Lib.isMixRated(getMixFeedback(), album.id));
    box.classList.remove('fading-out');
    box.querySelectorAll('.daily-mix-rate-btn').forEach(b => b.classList.remove('active'));
  }
  function rateDailyMix(isLike) {
    const mix = albumOnPage;
    if (!mix || mix.type !== 'Daily Mix') return;
    const fb = Lib.rateMix(getMixFeedback(), { id: mix.id, artists: mix.mixArtists || [], tracks: mix.tracks || [] }, isLike, (t) => getTrackNormalizedKey(t.artist, t.title));
    try { localStorage.setItem(MIX_FEEDBACK_KEY, JSON.stringify(fb)); } catch (e) {}
    const like = document.getElementById('btn-dm-like');
    const dislike = document.getElementById('btn-dm-dislike');
    if (like) like.classList.toggle('active', isLike);
    if (dislike) dislike.classList.toggle('active', !isLike);
    showToast(isLike ? 'Glad you like this mix' : 'Got it. Less like this from now on', 'info');
    const box = document.getElementById('daily-mix-feedback');
    setTimeout(() => {
      if (!box) return;
      box.classList.add('fading-out');
      setTimeout(() => { box.classList.add('hidden'); box.classList.remove('fading-out'); }, 280);
    }, 350);
  }
  const btnDmLike = document.getElementById('btn-dm-like');
  const btnDmDislike = document.getElementById('btn-dm-dislike');
  if (btnDmLike) btnDmLike.addEventListener('click', () => rateDailyMix(true));
  if (btnDmDislike) btnDmDislike.addEventListener('click', () => rateDailyMix(false));

  // ---- Download a whole album (#19): the playlist download (openDownloadAllModal) with the album's songs.
  // Songs already on this device (downloaded, or in the offline cache) are left out; when that is all of them
  // the button shows a check. While it runs the button counts the songs.
  let albumDownload = null;
  function renderAlbumDownloadButton() {
    const btn = document.getElementById('btn-download-album');
    if (!btn) return;
    const d = albumDownload;
    const items = d ? d.items : [];
    const all = !!d && items.length > 0 && d.downloaded.length === items.length && d.downloaded.every(Boolean);
    btn.disabled = !items.length;
    btn.classList.toggle('is-done', all && !(d && d.busy));
    btn.classList.toggle('is-busy', !!(d && d.busy));
    const prog = btn.querySelector('.dl-album-progress');
    if (prog) prog.textContent = d && d.busy ? d.progress : '';
    btn.title = d && d.busy ? Tf('Downloading {0}', d.progress) : all ? T('Album downloaded') : T('Download album');
    btn.setAttribute('aria-label', btn.title);
  }
  async function refreshAlbumDownloadState(d) {
    if (!d || !state.serverPort) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/downloaded-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: d.items.map((t) => ({ title: t.title || '', artist: t.artist || '', id: String(t.id || '') })) }),
      });
      const data = await res.json();
      if (albumDownload !== d || !data || !data.success || !Array.isArray(data.downloaded)) return;
      d.downloaded = data.downloaded.map(Boolean);
    } catch (e) {}
    if (albumDownload === d) renderAlbumDownloadButton();
  }
  // items: the rows of the album page; sources: the album's own songs (found on YouTube when downloaded)
  function setupAlbumDownload(album, items, sources, isMix) {
    // a download of another album still running keeps its own object; this page gets a new one
    const keep = (items || []).map((t, i) => ({ t, src: (sources || [])[i] })).filter((x) => x.t && x.t.platform !== 'local');
    albumDownload = { album, items: keep.map((x) => x.t), sources: keep.map((x) => x.src), isMix, downloaded: [], busy: false, progress: '' };
    renderAlbumDownloadButton();
    refreshAlbumDownloadState(albumDownload);
  }
  function resetAlbumDownload() {
    albumDownload = null;
    renderAlbumDownloadButton();
  }
  const btnDownloadAlbum = document.getElementById('btn-download-album');
  if (btnDownloadAlbum) {
    btnDownloadAlbum.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = albumDownload;
      if (!d || !d.items.length) return;
      if (d.busy) { showToast(Tm('This album is downloading: {0}', d.progress), 'info'); return; }
      const missing = d.items.filter((_, i) => !d.downloaded[i]);
      if (!missing.length) { showToast(Tm('This album is already downloaded'), 'info'); return; }
      const byId = new Map(d.items.map((t, i) => [t.id, d.sources[i]]));
      if (missing.length < d.items.length) showToast(Tm('{0} of {1} songs are already downloaded: getting the rest', d.items.length - missing.length, d.items.length), 'info');
      openDownloadAllModal({
        name: d.album.title || 'Album',
        tracks: missing,
        resolve: d.isMix ? null : (t) => resolveAlbumTrack(d.album, byId.get(t.id)),
        onProgress: (i, n) => {
          d.busy = true;
          d.progress = `${i + 1}/${n}`;
          if (albumDownload === d) renderAlbumDownloadButton();
        },
        onDone: () => {
          d.busy = false;
          d.progress = '';
          if (albumDownload === d) { renderAlbumDownloadButton(); refreshAlbumDownloadState(d); }
        },
      }, 'Download album');
    });
  }

  let currentAlbumRunId = 0;

  // An album from iTunes (its songs are found on YouTube when played), or a Daily Mix (album.type 'Daily Mix',
  // its songs already in album.tracks, playable as they are)
  async function openAlbum(album) {
    if (!album || !album.id) return;
    const runId = ++currentAlbumRunId;
    const isMix = album.type === 'Daily Mix';
    const kind = album.type || 'Album';

    state.previousView = state.currentView;
    switchView('album');
    showAlbumExtras(album);
    resetAlbumDownload();

    const coverEl = document.getElementById('album-detail-cover');
    if (coverEl) {
      if (Array.isArray(album.gridCovers) && album.gridCovers.length >= 4) {
        coverEl.innerHTML = `<div class="sp-grid-cover album-grid-cover">${album.gridCovers.slice(0, 4).map(c => `<img loading="lazy" decoding="async" src="${escapeHtml(c)}" alt="" />`).join('')}</div>`;
      } else {
        coverEl.innerHTML = album.cover
          ? `<img loading="lazy" decoding="async" src="${escapeHtml(album.cover)}" alt="${escapeHtml(album.title)}" style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;object-fit:cover;box-shadow:none;" />`
          : '<div style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;background:var(--md-sys-color-surface-container);"></div>';
      }
    }

    const titleEl = document.getElementById('album-detail-title');
    if (titleEl) titleEl.textContent = album.title || 'Untitled album';

    const artistBtn = document.getElementById('album-detail-artist');
    const setAlbumArtist = (name) => {
      if (!artistBtn) return;
      artistBtn.textContent = name;
      // a mix lists the artists it was made from: nothing to open
      artistBtn.title = isMix ? '' : Tf('View {0}', name);
      artistBtn.classList.toggle('is-static', isMix);
      artistBtn.onclick = isMix ? null : () => {
        if (name && typeof openArtistProfile === 'function') openArtistProfile(name);
      };
    };
    setAlbumArtist(album.artist || '');

    const countEl = document.getElementById('album-detail-count');
    const baseCount = album.trackCount ? `${album.trackCount} track${album.trackCount === 1 ? '' : 's'}` : '';
    const initialMeta = [kind, album.year, baseCount].filter(Boolean).join(' · ');
    if (countEl) countEl.textContent = initialMeta || kind;

    const albumView = document.getElementById('view-album');
    const albumHeroFx = document.getElementById('album-hero-fx');
    const colorCover = album.cover || (album.gridCovers && album.gridCovers[0]) || '';
    if (albumHeroFx) {
      albumHeroFx.style.backgroundImage = colorCover ? `url("${colorCover}")` : '';
    }
    if (colorCover) {
      getCoverDominantColors(colorCover).then(([domColor]) => {
        if (state.currentView === 'album' && currentAlbumRunId === runId) {
          if (albumView) albumView.style.setProperty('--playlist-accent-color', domColor);
          if (albumHeroFx) albumHeroFx.style.setProperty('--playlist-accent-color', domColor);
          document.documentElement.style.setProperty('--playlist-accent-color', domColor);
        }
      });
    } else {
      if (albumView) albumView.style.removeProperty('--playlist-accent-color');
      if (albumHeroFx) albumHeroFx.style.removeProperty('--playlist-accent-color');
      document.documentElement.style.removeProperty('--playlist-accent-color');
    }

    const playAlbumBtnInit = document.getElementById('btn-play-album');
    if (playAlbumBtnInit) {
      playAlbumBtnInit.disabled = true;
      playAlbumBtnInit.onclick = null;
    }

    const listEl = document.getElementById('album-tracks-list');
    if (listEl) {
      listEl.innerHTML = `<div class="m3-loader-container" style="display: flex; justify-content: center; align-items: center; padding: 64px 0; width: 100%;">
        <svg class="g-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>
      </div>`;
    }

    try {
      let tracks = isMix && Array.isArray(album.tracks) && album.tracks.length ? album.tracks : null;
      let albumArtist = album.artist || '';
      let albumYear = album.year || '';
      if (!tracks) {
        // the id first; the title and artist find the album when the id doesn't (iTunes gives it another id in
        // another country, and saved albums come along from linked devices)
        const q = new URLSearchParams({ id: album.id });
        if (album.title) q.set('title', album.title);
        if (album.artist) q.set('artist', album.artist);
        if (album.source) q.set('source', album.source);
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/album-tracks?${q}`);
        const data = await res.json();
        if (currentAlbumRunId !== runId) return;

        if (!data || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
          throw new Error(data && data.error ? data.error : 'Failed to load album tracks');
        }
        tracks = data.tracks;
        albumArtist = (data.album && data.album.artist) || albumArtist;
        albumYear = (data.album && data.album.year) || albumYear;
        // opened without a cover (a saved album from a device that had none): the album's own, here and in the saved list
        if (!album.cover && data.album && data.album.cover) {
          album.cover = data.album.cover;
          if (coverEl) coverEl.innerHTML = `<img loading="lazy" decoding="async" src="${escapeHtml(album.cover)}" alt="${escapeHtml(album.title)}" style="width:100%;height:100%;aspect-ratio:1;border-radius:20px;object-fit:cover;box-shadow:none;" />`;
          if (albumHeroFx) albumHeroFx.style.backgroundImage = `url("${album.cover}")`;
          const saved = getSavedAlbums();
          if (saved.some(a => Lib.sameAlbum(a, album) && !a.cover)) setSavedAlbums(saved.map(a => (Lib.sameAlbum(a, album) && !a.cover ? { ...a, cover: album.cover } : a)));
        }
      }

      if (albumArtist && !isMix) setAlbumArtist(albumArtist);

      if (countEl) {
        const cnt = tracks.length === 1 ? T('1 track') : Tf('{0} tracks', tracks.length);
        countEl.textContent = [T(kind), albumYear, cnt].filter(Boolean).join(' · ');
      }

      album._tracks = tracks;
      if (!album.trackCount) album.trackCount = tracks.length;

      // a mix's songs play as they are; an album's are found on YouTube (playAlbumFrom)
      const items = tracks.map((t, idx) => (isMix ? { ...t, albumArtist } : {
        id: `${album.id}_${t.disc || 1}_${t.no || (idx + 1)}`,
        title: t.title,
        artist: t.artist || albumArtist,
        albumArtist: albumArtist,
        duration: Math.round((t.durationMs || 0) / 1000),
        durationMs: t.durationMs || 0,
        album: album.title || '',
        cover: album.cover,
        thumbnail: album.cover,
        no: t.no || (idx + 1),
        disc: t.disc || 1,
        ...(t.isExplicit ? { isExplicit: true } : {})
      }));
      const playFrom = (idx) => (isMix ? playTrack(items[idx], items, idx, 'album') : playAlbumFrom(album, tracks, idx));
      setupAlbumDownload(album, items, isMix ? items : tracks, isMix);

      const playAlbumBtn = document.getElementById('btn-play-album');
      if (playAlbumBtn) {
        playAlbumBtn.disabled = false;
        playAlbumBtn.onclick = () => playFrom(0);
      }

      if (listEl) {
        listEl.innerHTML = '';
        const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
        items.forEach((trackItem, idx) => {
          const row = createTrackRow(trackItem, idx, currentCanonicalId, 'album', isMix ? items : tracks, listEl);
          row.addEventListener('click', (e) => {
            if (e.target.closest('.track-row-actions')) return;
            if (e.target.classList.contains('track-row-artist')) {
              e.stopPropagation();
              openTrackArtist(trackItem);
              return;
            }
            e.stopImmediatePropagation();
            playFrom(idx);
          }, true);
          listEl.appendChild(row);
        });
        highlightPlayingRow();
        const albumTracksCol = document.querySelector('#view-album .album-tracks-col');
        if (albumTracksCol) {
          albumTracksCol.scrollTop = 0;
          updateFade(albumTracksCol);
          if (!albumTracksCol._fadeBound) {
            albumTracksCol._fadeBound = true;
            albumTracksCol.addEventListener('scroll', () => updateFade(albumTracksCol), { passive: true });
          }
        }
      }
    } catch (err) {
      if (currentAlbumRunId !== runId) return;
      if (listEl) {
        listEl.innerHTML = `<div class="empty-hint" style="color: var(--md-sys-color-error, #ba1a1a);"><span data-i18n>Failed to load album:</span> ${escapeHtml(err.message)}</div>`;
      }
    }
  }
  window.openAlbum = openAlbum;

  function updateRowFade(row) {
    if (!row) return;
    const maxScroll = row.scrollWidth - row.clientWidth;
    if (maxScroll <= 0) {
      row.classList.remove('fade-left', 'fade-right');
      return;
    }
    row.classList.toggle('fade-left', row.scrollLeft > 4);
    row.classList.toggle('fade-right', row.scrollLeft < maxScroll - 4);
  }
  window.updateRowFade = updateRowFade;

  // one window listener for all rows: each search added its own, which kept every old album row alive
  const fadeRows = new Set();
  window.addEventListener('resize', () => {
    fadeRows.forEach(r => { if (r.isConnected) updateRowFade(r); else fadeRows.delete(r); });
  }, { passive: true });

  // a mouse wheel over a sideways row scrolls the row while it can still go that way; at its ends the page
  // scrolls on (Ctrl+wheel is zoom, left alone)
  function wheelRowSideways(row, e) {
    if (e.ctrlKey || e.defaultPrevented || row.scrollWidth <= row.clientWidth + 1) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if ((delta < 0 && row.scrollLeft > 0) || (delta > 0 && row.scrollLeft < row.scrollWidth - row.clientWidth - 1)) {
      e.preventDefault();
      row.scrollBy({ left: e.deltaMode === 1 ? delta * 40 : delta, behavior: 'smooth' });
    }
  }
  // rows drawn without bindHorizontalWheel (For you: artists and songs, Your playlists, an artist's namesakes)
  // scrolled the whole page under the wheel (#10): one listener for all of them
  const SIDEWAYS_ROWS = '.fy-row, .home-pl-row, .sp-row, .search-albums-row';
  document.addEventListener('wheel', (e) => {
    const row = e.target && e.target.closest ? e.target.closest(SIDEWAYS_ROWS) : null;
    if (row && !row._wheelBound) wheelRowSideways(row, e);
  }, { passive: false });
  function bindHorizontalWheel(row) {
    if (!row || row._wheelBound) return;
    row._wheelBound = true;
    row.addEventListener('wheel', (e) => wheelRowSideways(row, e), { passive: false });

    row.addEventListener('scroll', () => updateRowFade(row), { passive: true });
    fadeRows.add(row);
    updateRowFade(row);
  }
  window.bindHorizontalWheel = bindHorizontalWheel;

  async function fetchAlbumsForSearch(query, token) {
    let container = document.getElementById('search-albums-container');
    if (!container) {
      const artistContainer = document.getElementById('search-artist-card-container');
      if (artistContainer && artistContainer.parentNode) {
        container = document.createElement('div');
        container.id = 'search-albums-container';
        artistContainer.parentNode.insertBefore(container, artistContainer.nextSibling);
      }
    }
    if (!container) return;

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/albums/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (state.searchToken !== token) return;
      if (!data || !data.success || !Array.isArray(data.albums) || data.albums.length === 0) {
        container.innerHTML = '';
        return;
      }

      const albums = data.albums;
      container.innerHTML = `
        <div class="search-albums-section">
          <div class="section-sub-header">
            <h3 data-i18n>Albums</h3>
          </div>
          <div class="search-albums-row">
            ${albums.map(album => {
              const sub = album.year ? `${escapeHtml(album.artist)} · ${escapeHtml(album.year)}` : escapeHtml(album.artist || '');
              return `
                <div class="search-album-card" role="button" tabindex="0">
                  <img class="search-album-cover" src="${escapeHtml(album.cover || '')}" alt="${escapeHtml(album.title)}" loading="lazy" />
                  <div class="search-album-info">
                    <span class="search-album-title" title="${escapeHtml(album.title)}">${escapeHtml(album.title)}</span>
                    <span class="search-album-sub" title="${sub}">${sub}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;

      const row = container.querySelector('.search-albums-row');
      if (row) {
        bindHorizontalWheel(row);
        requestAnimationFrame(() => updateRowFade(row));
      }

      const cards = container.querySelectorAll('.search-album-card');
      cards.forEach((card, idx) => {
        const album = albums[idx];
        if (!album) return;
        card.addEventListener('click', () => openAlbum(album));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAlbum(album);
          }
        });
      });
    } catch (e) {
      if (state.searchToken === token && container) {
        container.innerHTML = '';
      }
    }
  }

  async function performSearch(query) {
    if (!query || !query.trim()) return;
    // a shared playlist link pasted into the search bar adds the playlist
    if (window.MurielShare && window.MurielShare.payloadFrom(query)) {
      if (el.searchInput) { el.searchInput.value = ''; el.searchInput.blur(); }
      if (el.searchClearBtn) el.searchClearBtn.classList.add('hidden');
      importSharedPlaylist(query);
      return;
    }

    const searchToken = (state.searchToken || 0) + 1;
    state.searchToken = searchToken;

    state.searchQuery = query.trim().toLowerCase();
    switchView('discover');

    if (el.discoverEmpty) el.discoverEmpty.classList.add('hidden');
    if (el.searchResultsContainer) el.searchResultsContainer.classList.remove('hidden');
    if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();

    const artistCardContainer = document.getElementById('search-artist-card-container');
    if (artistCardContainer) artistCardContainer.innerHTML = '';

    const albumsContainer = document.getElementById('search-albums-container');
    if (albumsContainer) albumsContainer.innerHTML = '';

    const trimmedQuery = query.trim();
    if (getAdv('albums', true) && trimmedQuery.length >= 3) {
      fetchAlbumsForSearch(trimmedQuery, searchToken);
    }

    if (el.searchTracksList) {
      el.searchTracksList.innerHTML = `<div class="m3-loader-container" style="display: flex; justify-content: center; align-items: center; padding: 64px 0; width: 100%;">
        <svg class="g-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>
      </div>`;
    }

    try {
      if (!navigator.onLine) {
        if (el.searchTracksList) el.searchTracksList.innerHTML = `<div class="empty-hint" data-i18n>Offline: connect to the internet to search new tracks</div>`;
        return;
      }
      const searchUrl = `http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(state.searchQuery)}&platform=${state.platform}&limit=20`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      if (state.searchToken !== searchToken) return;

      if (!data.success || !data.tracks) {
        if (state.platform === 'ytmusic') showToast(Tm('YouTube Music is unavailable'));
        throw new Error(data.error || 'Failed to load search results');
      }

      state.searchResults = data.tracks;

      requestAnimationFrame(() => {
        if (el.searchTracksList) renderTracks(el.searchTracksList, data.tracks, 'search');
      });

      const showArtists = localStorage.getItem('muriel_search_artists') !== '0';
      const trimmedQuery = query.trim();
      if (showArtists && trimmedQuery.length >= 3) {
        fetchArtistCardForSearch(trimmedQuery, searchToken, data.tracks);
      }
    } catch (err) {
      if (state.searchToken !== searchToken) return;
      console.error('Search error:', err);
      const isOff = !navigator.onLine;
      if (el.searchTracksList) el.searchTracksList.innerHTML = `<div class="empty-hint">${isOff ? 'Offline: connect to the internet to search new tracks' : 'Error fetching results: ' + escapeHtml(err.message)}</div>`;
    }
  }


  const multiSel = { active: false, context: '', tracks: new Map() };

  function updateMultiSelectBar() {
    const bar = document.getElementById('multi-select-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !multiSel.active);
    const count = document.getElementById('multi-select-count');
    if (count) count.textContent = `${multiSel.tracks.size} selected`;
    const hasSel = multiSel.tracks.size > 0;
    ['multi-select-fav', 'multi-select-add', 'multi-select-radio', 'multi-select-download', 'multi-select-remove'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = !hasSel;
    });
  }

  function rerenderMultiSelectView() {
    if (multiSel.context === 'playlist' && state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
    else if (multiSel.context === 'favorites') renderFavoritesView();
  }

  function exitMultiSelect(rerender = true) {
    if (!multiSel.active) return;
    multiSel.active = false;
    multiSel.tracks.clear();
    document.body.classList.remove('multi-select-on');
    updateMultiSelectBar();
    if (rerender) rerenderMultiSelectView();
  }

  function startMultiSelect(context) {
    if (multiSel.active) return exitMultiSelect();
    multiSel.active = true;
    multiSel.context = context;
    multiSel.tracks.clear();
    document.body.classList.add('multi-select-on');
    updateMultiSelectBar();
    rerenderMultiSelectView();
  }

  function toggleTrackSelection(track, row) {
    const key = getTrackCanonicalId(track);
    if (multiSel.tracks.has(key)) multiSel.tracks.delete(key);
    else multiSel.tracks.set(key, track);
    if (row) row.classList.toggle('selected', multiSel.tracks.has(key));
    updateMultiSelectBar();
  }

  // only what the list shows: with a search typed in, "Select all" took every song and Remove deleted hidden ones
  function multiSelectSourceTracks() {
    const fav = multiSel.context === 'favorites';
    const pl = fav ? null : state.playlists.find(p => p.id === state.currentPlaylistId);
    const all = fav ? state.favorites : (pl ? (pl.tracks || []) : []);
    const input = fav ? el.favoritesSearchInput : el.playlistSearchInput;
    const query = input ? normalizeSearch(input.value) : '';
    return query ? all.filter(t => matchesTrackQuery(t, query)) : all;
  }

  function createTrackRow(track, idx, currentCanonicalId, context, tracks, container) {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.tabIndex = 0;
      const canonicalId = getTrackCanonicalId(track);
      row.dataset.canonicalId = canonicalId;
      row.dataset.trackIndex = String(idx);
      row.dataset.trackId = track.id || '';
      row.dataset.trackTitle = track.title || '';
      row.dataset.trackArtist = track.artist || '';

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTrackContextMenu(e.clientX, e.clientY, track, context, row);
      });

      const isMatch = currentCanonicalId && canonicalId === currentCanonicalId;
      if (isMatch) {
        if (state.currentTrackContext === context && state.currentTrackIndexInContext >= 0) {
          if (state.currentTrackIndexInContext === idx) {
            row.classList.add('playing');
          }
        } else {
          row.classList.add('playing');
        }
      }

      const isFav = state.favorites.some(f => isSameSong(f, track));
      const rowThumb = getTrackThumbUrl(track);
      const isAlbum = context === 'album';
      const albumArtist = (track.albumArtist || '').trim().toLowerCase();
      const trackArtist = (track.artist || '').trim().toLowerCase();
      const showArtist = isAlbum ? (Boolean(trackArtist) && Boolean(albumArtist) && trackArtist !== albumArtist) : true;
      // [E] before the artist (Settings > Tracks > Show explicit tag hides it)
      const explicitTag = window.MurielLibrary && window.MurielLibrary.isTrackExplicit(track) ? '<span class="explicit-badge" title="Explicit">E</span>' : '';
      const artistSpan = showArtist ? `<span class="track-row-artist" title="view artist profile" data-i18n-attr="title">${escapeHtml(track.artist || 'unknown artist')}</span>` : '';

      row.innerHTML = `
      <span class="track-row-index">${(isAlbum && track.no) ? track.no : (idx + 1)}</span>
      ${!isAlbum ? `<img class="track-row-thumb" src="${escapeHtml(listThumb(rowThumb) || '')}" data-full="${escapeHtml(rowThumb || '')}" data-saved="${escapeHtml(track.thumbnail || '')}" data-art="${escapeHtml(JSON.stringify(trackArtCandidates(track)))}" alt="" loading="lazy" decoding="async" onerror="${THUMB_FALLBACK}">` : ''}
      <div class="track-row-info">
      <span class="track-row-title">${escapeHtml(track.title || 'untitled')}</span>
      ${explicitTag ? `<span class="track-row-artist-wrap">${explicitTag}${artistSpan}</span>` : artistSpan}
      </div>
      <span class="track-row-duration">${formatDuration(track.duration)}</span>
      <div class="track-row-actions">
      <button class="btn-icon-pill btn-row-fav" title="favorite" data-i18n-attr="title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>
      </button>
      <button class="btn-icon-pill btn-row-art" title="Customize cover & banner" data-i18n-attr="title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
      </button>
      <button class="btn-icon-pill btn-row-add-playlist" title="add to playlist" data-i18n-attr="title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      ${track.platform === 'local' ? `
      <button class="btn-icon-pill btn-row-remove-local delete-btn" title="Remove from library">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      </button>` : `
      <button class="btn-icon-pill btn-row-more" title="download & options">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle><circle cx="5" cy="12" r="2"></circle></svg>
      </button>`}
      ${context === 'playlist' ? `
        <button class="btn-icon-pill btn-row-remove-playlist delete-btn" title="remove from playlist">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>` : ''}
        </div>
        `;

        if (multiSel.active && multiSel.context === context) {
          const chk = document.createElement('span');
          chk.className = 'track-row-check';
          chk.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
          row.insertBefore(chk, row.firstChild);
          row.classList.add('selectable');
          if (multiSel.tracks.has(canonicalId)) row.classList.add('selected');
        }

        row.addEventListener('click', (e) => {
          if (e.target.closest('.track-row-actions')) return;
          if (multiSel.active && multiSel.context === context) {
            toggleTrackSelection(track, row);
            return;
          }
          if (e.target.classList.contains('track-row-artist')) {
            e.stopPropagation();
            openTrackArtist(track);
            return;
          }
          let clickIndex = idx;
          let currentList = tracks;
          // the row's own object first: with a song in the list twice, the second copy played from the first
          const indexIn = (list) => { const i = list.indexOf(track); return i >= 0 ? i : list.findIndex(t => isSameTrack(t, track)); };
          if (context === 'favorites') {
            currentList = sortTracksFor('favorites', state.favorites);
            clickIndex = indexIn(currentList);
          } else if (context === 'playlist') {
            const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
            if (pl && pl.tracks) {
              currentList = sortTracksFor('playlist', pl.tracks);
              clickIndex = indexIn(currentList);
            }
          } else if (context === 'artist') {
            const artistTracks = (state.currentArtistData && state.currentArtistData.tracks) || tracks;
            if (artistTracks) {
              currentList = artistTracks;
              clickIndex = indexIn(artistTracks);
            }
          } else if (context === 'queue') {
            // the queue as it is now: the rendered list could predate "Play next", and replaying it dropped that song
            currentList = state.queue;
            clickIndex = indexIn(currentList);
          }
          playTrack(track, currentList, clickIndex >= 0 ? clickIndex : idx, context);
        });

        // A finger tap gets moved onto the nearest element that listens for clicks, and only the buttons did,
        // so a tap on a short song title on a phone hit the heart. Listening here makes the title area its own
        // target; the click still bubbles to the row above, which plays the song.
        if (isPhoneApp) {
          const info = row.querySelector('.track-row-info');
          if (info) info.addEventListener('click', () => {});
        }

        const btnFav = row.querySelector('.btn-row-fav');
        if (btnFav) {
          btnFav.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavoriteTrack(track);
            const isFavNow = state.favorites.some(f => isSameSong(f, track));
            const svg = btnFav.querySelector('svg');
            if (svg) svg.setAttribute('fill', isFavNow ? 'currentColor' : 'none');
          });
        }

        const btnArt = row.querySelector('.btn-row-art');
        if (btnArt) {
          btnArt.addEventListener('click', (e) => {
            e.stopPropagation();
            openTrackArtModal(track, btnArt);
          });
        }

        const btnMore = row.querySelector('.btn-row-more');
        if (btnMore) {
          btnMore.addEventListener('click', (e) => {
            e.stopPropagation();
            // phones have no right-click: "..." opens the song's menu there (Download is one of its items)
            if (isPhoneApp) {
              const r = btnMore.getBoundingClientRect();
              openTrackContextMenu(r.right, r.bottom, track, context, row);
              return;
            }
            openDownloadModal(track);
          });
        }

        const btnAddPl = row.querySelector('.btn-row-add-playlist');
        if (btnAddPl) {
          btnAddPl.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track);
          });
        }

        const btnRemPl = row.querySelector('.btn-row-remove-playlist');
        if (btnRemPl) {
          btnRemPl.addEventListener('click', (e) => {
            e.stopPropagation();
            removeTrackFromCurrentPlaylist(track);
          });
        }

        const btnRemLocal = row.querySelector('.btn-row-remove-local');
        if (btnRemLocal) {
          btnRemLocal.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await fetch(`http://127.0.0.1:${state.serverPort}/api/library-remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: track.id })
              });
              if (Array.isArray(state.localTracks)) {
                state.localTracks = state.localTracks.filter(t => t.id !== track.id);
              }
              if (Array.isArray(tracks)) {
                const tIdx = tracks.findIndex(t => isSameTrack(t, track));
                if (tIdx !== -1) tracks.splice(tIdx, 1);
              }
              updateLocalBadge();
              row.remove();
              if (state.currentView === 'local') {
                if (!state.localTracks || state.localTracks.length === 0) {
                  renderLocalView();
                } else if (el.localSubtitle) {
                  const query = el.localSearchInput ? el.localSearchInput.value.trim().toLowerCase() : '';
                  el.localSubtitle.textContent = query
                    ? `${tracks.length} of ${state.localTracks.length} tracks`
                    : `${state.localTracks.length} tracks in library`;
                }
              }
              showToast(Tm('Removed from library'));
            } catch (err) {
              console.warn('Remove local track error:', err);
            }
          });
        }
        
      return row;
  }

  let trackMenuEl = null;

  function closeTrackContextMenu() {
    if (trackMenuEl) {
      trackMenuEl.remove();
      trackMenuEl = null;
    }
  }

  // ---------- blocked artists and songs (from Riff 43.1; matching in library-pages.js) ----------
  // Skipped when the queue moves on (a blocked song still plays when tapped), kept out of My Wave, the mixes and
  // For you. Per profile, and the same on linked devices (sync.js).
  const BLOCKED_ARTISTS_KEY = 'muriel_blocked_artists';
  const BLOCKED_SONGS_KEY = 'muriel_blocked_tracks';
  // parsed again only when the stored text changed (a linked device or another profile wrote it)
  let blocksCache = null;
  function getBlocks() {
    let rawA = '', rawS = '';
    try { rawA = localStorage.getItem(BLOCKED_ARTISTS_KEY) || ''; rawS = localStorage.getItem(BLOCKED_SONGS_KEY) || ''; } catch (e) {}
    if (blocksCache && blocksCache.rawA === rawA && blocksCache.rawS === rawS) return blocksCache;
    const parse = (raw) => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
    blocksCache = { rawA, rawS, artists: parse(rawA).filter((a) => typeof a === 'string'), songs: parse(rawS).filter((t) => t && typeof t === 'object') };
    return blocksCache;
  }
  function isBlocked(track) {
    const b = getBlocks();
    return (b.artists.length > 0 || b.songs.length > 0) && Lib.isTrackBlocked(b, track);
  }
  function saveBlocks(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
    blocksCache = null;
    renderBlockedSettings();
    updateArtistBlockButton();
  }
  function toggleBlockArtist(name) {
    const r = Lib.toggleBlockedArtist(getBlocks().artists, name);
    saveBlocks(BLOCKED_ARTISTS_KEY, r.list);
    showToast(Tm(r.blocked ? 'Blocked {0}: their songs are skipped' : 'Unblocked {0}', name), 'info');
  }
  function toggleBlockSong(track) {
    const r = Lib.toggleBlockedSong(getBlocks().songs, track);
    saveBlocks(BLOCKED_SONGS_KEY, r.list);
    showToast(Tm(r.blocked ? 'Blocked "{0}": it is skipped' : 'Unblocked "{0}"', track.title || ''), 'info');
  }
  // Settings > Tracks: what is blocked, a tap unblocks it
  function renderBlockedSettings() {
    const box = document.getElementById('blocked-items-list');
    if (!box) return;
    const { artists, songs } = getBlocks();
    box.textContent = '';
    if (!artists.length && !songs.length) {
      const none = document.createElement('span');
      none.className = 'blocked-empty';
      I18N.text(none, 'Nothing blocked. Block an artist or a song from its menu or the artist page.');
      box.appendChild(none);
      return;
    }
    const pill = (label, kind, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'blocked-item-pill';
      b.title = T('Unblock');
      const name = document.createElement('span');
      name.className = 'blocked-item-name';
      name.textContent = label;
      const tag = document.createElement('span');
      tag.className = 'blocked-item-kind';
      I18N.text(tag, kind);
      b.append(name, tag);
      b.insertAdjacentHTML('beforeend', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>');
      b.addEventListener('click', run);
      box.appendChild(b);
    };
    artists.forEach((a) => pill(a, 'Artist', () => toggleBlockArtist(a)));
    songs.forEach((t) => pill(t.artist ? `${t.title} · ${t.artist}` : t.title, 'Song', () => toggleBlockSong(t)));
  }
  renderBlockedSettings();

  function openTrackContextMenu(x, y, track, context, row) {
    closeTrackContextMenu();
    const isFav = state.favorites.some(f => isSameSong(f, track));
    const items = [
      { label: 'Play', run: () => row.click() },
      { label: 'Play next', run: () => {
        if (!state.queue.length || state.queueIndex < 0) { playTrack(track); return; }
        state.queue = state.queue.filter((t, i) => i <= state.queueIndex || !isSameTrack(t, track));
        state.queue.splice(state.queueIndex + 1, 0, track);
        // the filter made a new queue array; keep shuffle's "already heard" list instead of starting over
        if (shuffleBag.queue) shuffleBag.queue = state.queue;
        shuffleBag.next.push(track);
        updateQueueBadge();
        showToast(Tm('Playing next'), 'success');
      } },
      { label: 'Add to queue', run: () => {
        // only songs still to come count: one that already played is queued again
        const upcoming = state.queue.findIndex((t, i) => i > state.queueIndex && isSameTrack(t, track));
        if (upcoming >= 0 || (state.queue[state.queueIndex] && isSameTrack(state.queue[state.queueIndex], track))) {
          showToast(Tm('Already in the queue'), 'info');
          return;
        }
        state.queue.push(track);
        updateQueueBadge();
        showToast(Tm('Added to queue'), 'success');
      } },
      ...(songRadioEnabled() ? [{ label: 'Start radio', run: () => startSongRadio([track]) }] : []),
      { label: 'Add to playlist…', run: () => openAddToPlaylistModal(track) },
      { label: isFav ? 'Remove from favorites' : 'Add to favorites', run: () => {
        toggleFavoriteTrack(track);
        const on = state.favorites.some(f => isSameSong(f, track));
        const svg = row.querySelector('.btn-row-fav svg');
        if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
      } }
    ];
    if (track.artist && !/^unknown artist$/i.test(track.artist)) {
      items.push({ label: 'Go to artist', run: () => openTrackArtist(track) });
    }
    if (track.platform !== 'local') {
      items.push({ label: 'Download…', run: () => openDownloadModal(track) });
    }
    if (context === 'playlist') {
      items.push({ label: 'Remove from playlist', danger: true, run: () => removeTrackFromCurrentPlaylist(track) });
    }
    if (track.title) {
      items.push({ label: Lib.isSongBlocked(getBlocks().songs, track) ? 'Unblock song' : 'Block song', run: () => toggleBlockSong(track) });
    }
    if (track.artist && !/^unknown artist$/i.test(track.artist)) {
      const artistName = String(track.artist).split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
      if (artistName) items.push({ label: Lib.isArtistBlocked(getBlocks().artists, artistName) ? 'Unblock artist' : 'Block artist', run: () => toggleBlockArtist(artistName) });
    }

    const menu = document.createElement('div');
    menu.className = 'track-context-menu';
    menu.setAttribute('role', 'menu');
    items.forEach(item => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'track-context-item' + (item.danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.textContent = T(item.label);
      b.dataset.i18n = '';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTrackContextMenu();
        item.run();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    trackMenuEl = menu;
  }

  document.addEventListener('click', closeTrackContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTrackContextMenu(); });
  window.addEventListener('blur', closeTrackContextMenu);
  window.addEventListener('resize', closeTrackContextMenu);
  document.addEventListener('scroll', closeTrackContextMenu, true);

  function renderTracks(container, tracks, context = 'search') {
    if (!container) return;
    
    // lists inside the drawer scroll the drawer pane, everything else scrolls the main column
    const scrollParent = container.closest('.drawer-pane') || document.querySelector('.main-content');
    if (container._vScrollHandler && scrollParent) {
      scrollParent.removeEventListener('scroll', container._vScrollHandler);
    }
    
    container.innerHTML = '';
    
    if (!tracks || tracks.length === 0) {
      container.style.paddingTop = '0px';
      container.style.paddingBottom = '0px';
      const emptyMessages = {
        search: 'No matching tracks. Try a different search',
        favorites: 'No favourites yet. Use the heart on a track to save it',
        playlist: 'This playlist is empty',
        local: 'Your library is empty. Add some music to get started',
        queue: 'Queue is empty. Play a track to start.'
      };
      container.innerHTML = `<div class="empty-hint" data-i18n>${emptyMessages[context] || 'No tracks to show'}</div>`;
      return;
    }

    const itemHeight = 64;
    const overscan = 15;
    
    function renderChunk() {
      if (!scrollParent || container._isDraggingReorder) return;
      const parentRect = scrollParent.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const relativeTop = containerRect.top - parentRect.top + scrollParent.scrollTop;
      
      const visibleTop = Math.max(0, scrollParent.scrollTop - relativeTop);
      let startIndex = Math.floor(visibleTop / itemHeight) - overscan;
      let endIndex = Math.ceil((visibleTop + scrollParent.clientHeight) / itemHeight) + overscan;
      
      startIndex = Math.floor(startIndex / 5) * 5;
      endIndex = Math.ceil(endIndex / 5) * 5;
      
      startIndex = Math.max(0, startIndex);
      endIndex = Math.min(tracks.length, endIndex);
      
      if (container._lastStartIndex === startIndex && container._lastEndIndex === endIndex) return;
      container._lastStartIndex = startIndex;
      container._lastEndIndex = endIndex;
      
      const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
      const fragment = document.createDocumentFragment();
      for (let idx = startIndex; idx < endIndex; idx++) {
         const track = tracks[idx];
         const row = createTrackRow(track, idx, currentCanonicalId, context, tracks, container);
         if (container._hasInitialRendered) row.style.animation = 'none';
         fragment.appendChild(row);
      }
      
      container.innerHTML = '';
      container.style.paddingTop = `${startIndex * itemHeight}px`;
      container.style.paddingBottom = `${(tracks.length - endIndex) * itemHeight}px`;
      container.appendChild(fragment);
      container._hasInitialRendered = true;
      highlightPlayingRow();
    }
    
    container._vScrollHandler = () => {
      if (!container._ticking) {
        window.requestAnimationFrame(() => {
          renderChunk();
          container._ticking = false;
        });
        container._ticking = true;
      }
    };
    
    if (scrollParent) {
       scrollParent.addEventListener('scroll', container._vScrollHandler, { passive: true });
    }
    
    container._hasInitialRendered = false;
    container._lastStartIndex = -1;
    container._lastEndIndex = -1;
    renderChunk();
  }

  function highlightPlayingRow() {
    const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
    const rows = document.querySelectorAll('.track-row');

    if (!currentCanonicalId) {
      rows.forEach(r => r.classList.remove('playing'));
      return;
    }

    const containers = new Set();
    rows.forEach(r => {
      r.classList.remove('playing');
      if (r.parentElement) containers.add(r.parentElement);
    });

    containers.forEach(container => {
      const matches = Array.from(container.querySelectorAll('.track-row')).filter(r => r.dataset.canonicalId === currentCanonicalId);
      if (matches.length === 1) {
        matches[0].classList.add('playing');
      } else if (matches.length > 1) {
        const targetIdx = String(state.currentTrackIndexInContext);
        const exact = matches.find(r => r.dataset.trackIndex === targetIdx);
        if (exact) {
          exact.classList.add('playing');
        } else {
          matches[0].classList.add('playing');
        }
      }
    });
  }

  const artistBioCache = new Map();

  // ---- the artist page: a banner with Play and Follow, About (the whole bio in a dialog), Songs and Albums tabs ----
  // The page is looked up by the artist's channel when the track knows it (artistId, or the video it plays), so
  // same-named artists stay apart; albums come from /api/artist-albums, which keeps to the iTunes namesake that
  // released this artist's songs.
  const compactCount = (n) => {
    try { return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch (e) { return String(n); }
  };
  const ARTIST_TOP_SONGS = 5;
  let artistTracksExpanded = false;

  function setArtistTab(tab, animate = true) {
    ['tracks', 'albums'].forEach((t) => {
      const btn = document.getElementById(`artist-tab-${t}`);
      const pane = document.getElementById(`artist-pane-${t}`);
      const on = t === tab;
      if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-selected', on ? 'true' : 'false'); }
      if (!pane) return;
      pane.classList.toggle('hidden', !on);
      pane.classList.toggle('active', on);
      if (on && animate) { pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = ''; }
    });
  }
  ['tracks', 'albums'].forEach((t) => {
    const btn = document.getElementById(`artist-tab-${t}`);
    if (btn) btn.addEventListener('click', () => setArtistTab(t));
  });

  // album cards for the artist page and the Albums tab
  function renderAlbumCards(container, albums, subOf) {
    container.innerHTML = albums.map(album => {
      const sub = escapeHtml(subOf(album) || '');
      return `
        <div class="search-album-card" role="button" tabindex="0">
          <img class="search-album-cover" src="${escapeHtml(album.cover || '')}" alt="${escapeHtml(album.title || '')}" loading="lazy" decoding="async" />
          <div class="search-album-info">
            <span class="search-album-title" title="${escapeHtml(album.title || '')}">${escapeHtml(album.title || '')}</span>
            <span class="search-album-sub" title="${sub}">${sub}</span>
          </div>
        </div>`;
    }).join('');
    container.querySelectorAll('.search-album-card').forEach((card, idx) => {
      const album = albums[idx];
      if (!album) return;
      card.addEventListener('click', () => openAlbum(album));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAlbum(album);
        }
      });
    });
  }

  async function loadArtistAlbums(artistQuery, run) {
    const tabs = document.getElementById('artist-horiz-tabs');
    const grid = document.getElementById('artist-albums-grid');
    const countEl = document.getElementById('artist-albums-count');
    if (!grid) return;
    if (tabs) tabs.style.display = 'none';
    grid.innerHTML = '';
    if (countEl) countEl.textContent = '';
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist-albums?${artistQuery}`);
      const data = await res.json();
      if (run !== artistRunId) return;
      if (!data || !data.success || !Array.isArray(data.albums) || data.albums.length === 0) return;
      const albums = data.albums;
      renderAlbumCards(grid, albums, (a) => a.year || '');
      if (countEl) countEl.textContent = `${albums.length} album${albums.length === 1 ? '' : 's'}`;
      // the tabs only show once there is something besides songs
      if (tabs) tabs.style.display = '';
    } catch (e) {}
  }

  async function fetchArtistMatches(name) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist-matches?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      return (data && data.success && Array.isArray(data.artists)) ? data.artists : [];
    } catch (e) {
      return [];
    }
  }

  // other artists with the same name, so the right one is a tap away when the page shows a namesake
  async function showArtistMatches(matchesPromise, artist, name, run) {
    const section = document.getElementById('artist-matches-section');
    const row = document.getElementById('artist-matches-row');
    if (!section || !row) return;
    const matches = await matchesPromise;
    if (run !== artistRunId) return;
    const shown = (artist && artist.ids) || [];
    const others = matches.filter(m => !shown.includes(m.id));
    // opened by name, the page can't tell which namesake it shows: offer them once there are two
    if (!others.length || (!shown.length && others.length < 2)) return;
    const title = document.getElementById('artist-matches-title');
    if (title) I18N.text(title, shown.length ? 'Other artists named {0}' : 'Artists named {0}', name);
    row.innerHTML = others.map(m => `
      <button class="fy-artist" type="button" title="${escapeHtml(m.subtitle || m.name)}">
        <img src="${escapeHtml(m.thumbnail || '')}" alt="" loading="lazy" decoding="async">
        <span>${escapeHtml(m.name)}</span>
        ${m.subtitle ? `<span class="fy-artist-name">${escapeHtml(m.subtitle)}</span>` : ''}
      </button>`).join('');
    row.querySelectorAll('.fy-artist').forEach((b, i) => b.addEventListener('click', () => openArtistProfile(others[i].name, { id: others[i].id })));
    section.style.display = '';
  }

  // the YouTube video a track plays, for tracks saved before they kept their artist's channel (artistId)
  function trackVideoId(track) {
    const m = String((track && track.url) || '').match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{11})/);
    if (m) return m[1];
    return track && track.platform === 'youtube' && /^[\w-]{11}$/.test(String(track.id || '')) ? track.id : '';
  }

  function openTrackArtist(track) {
    if (track && track.artist) openArtistProfile(track.artist, { id: track.artistId, video: trackVideoId(track) });
  }

  // About: four lines of the bio; "Show all" opens the whole of it
  function setArtistBio(text) {
    const card = document.getElementById('artist-about-card');
    const more = document.getElementById('btn-artist-bio-more');
    const bioEl = el.artistProfileBio;
    if (!bioEl) return;
    bioEl.textContent = text || '';
    bioEl.classList.remove('fade-end');
    if (card) card.classList.toggle('hidden', !text);
    if (more) more.classList.add('hidden');
    if (!text) return;
    requestAnimationFrame(() => {
      const over = bioEl.scrollHeight > bioEl.clientHeight + 1;
      bioEl.classList.toggle('fade-end', over);
      if (more) more.classList.toggle('hidden', !over);
    });
  }
  const artistBioModal = document.getElementById('artist-bio-modal');
  const btnArtistBioMore = document.getElementById('btn-artist-bio-more');
  if (btnArtistBioMore && artistBioModal) {
    btnArtistBioMore.addEventListener('click', () => {
      const t = document.getElementById('artist-bio-modal-title');
      const b = document.getElementById('artist-bio-modal-body');
      if (t) t.textContent = (state.currentArtistData && state.currentArtistData.name) || (el.artistProfileName ? el.artistProfileName.textContent : '') || 'Artist';
      if (b) b.textContent = el.artistProfileBio ? el.artistProfileBio.textContent : '';
      openModal(artistBioModal);
    });
    // the cut-off bio itself opens it too
    if (el.artistProfileBio) el.artistProfileBio.addEventListener('click', () => { if (!btnArtistBioMore.classList.contains('hidden')) btnArtistBioMore.click(); });
    const btnCloseBio = document.getElementById('btn-close-artist-bio');
    if (btnCloseBio) btnCloseBio.addEventListener('click', () => closeModal(artistBioModal));
    artistBioModal.addEventListener('click', (e) => { if (e.target === artistBioModal) closeModal(artistBioModal); });
  }

  // the banner (YouTube Music's wide header picture, or the artist's picture), tinted by its colours
  function setArtistHero(banner, avatar, run) {
    const hero = el.artistHero;
    const img = el.artistHeroImg;
    if (img) {
      img.onerror = null;
      if (banner || avatar) {
        img.onerror = () => {
          if (avatar && img.src !== avatar) img.src = avatar;
          else { img.onerror = null; img.style.display = 'none'; }
        };
        img.src = banner || avatar;
        img.style.display = 'block';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
    }
    const fallback = 'var(--md-sys-color-primary-container)';
    const setAccent = (c) => {
      if (hero) hero.style.setProperty('--artist-accent-color', c);
      document.documentElement.style.setProperty('--artist-accent-color', c);
    };
    if (!(banner || avatar)) { setAccent(fallback); return; }
    getCoverDominantColors(avatar || banner).then(([domColor]) => {
      if (run === artistRunId && state.currentView === 'artist') setAccent(domColor || fallback);
    }).catch(() => setAccent(fallback));
  }

  function setArtistFans(artist) {
    const line = el.artistFansLine;
    if (!line) return;
    const text = (artist && (artist.fansText || (artist.fans > 0 ? `${compactCount(artist.fans)} fans` : ''))) || '';
    line.textContent = text;
    line.style.display = text ? '' : 'none';
  }

  // Popular songs: the top five, "Show all" for the rest. Playing one plays them all, in this order.
  function renderArtistTracks() {
    const all = (state.currentArtistData && state.currentArtistData.tracks) || [];
    const btn = document.getElementById('btn-artist-tracks-toggle');
    if (btn) {
      btn.classList.toggle('hidden', all.length <= ARTIST_TOP_SONGS);
      btn.textContent = artistTracksExpanded ? 'Show less' : 'Show all';
    }
    if (el.artistTracksList) renderTracks(el.artistTracksList, artistTracksExpanded ? all : all.slice(0, ARTIST_TOP_SONGS), 'artist');
  }
  const btnArtistTracksToggle = document.getElementById('btn-artist-tracks-toggle');
  if (btnArtistTracksToggle) {
    btnArtistTracksToggle.addEventListener('click', () => {
      artistTracksExpanded = !artistTracksExpanded;
      renderArtistTracks();
    });
  }
  if (el.btnPlayArtistTracks) {
    el.btnPlayArtistTracks.addEventListener('click', () => {
      const all = (state.currentArtistData && state.currentArtistData.tracks) || [];
      if (all.length) playTrack(all[0], [...all], 0, 'artist');
    });
  }

  // ---- following artists: "Your artists" on the home page, the same on every linked device (sync.js) ----
  const FOLLOWED_ARTISTS_KEY = 'muriel_followed_artists';
  const getFollowedArtists = () => safeArray(FOLLOWED_ARTISTS_KEY);
  function setFollowedArtists(list) {
    try { localStorage.setItem(FOLLOWED_ARTISTS_KEY, JSON.stringify(list)); } catch (e) {}
    renderFollowedArtists();
  }
  // who the page shows: { name, id, ids, avatar, fans }; the name the page was opened with until it loads
  let artistOnPage = null;
  function updateFollowButton() {
    updateArtistBlockButton();
    const btn = document.getElementById('btn-artist-follow');
    if (!btn) return;
    const on = !!artistOnPage && Lib.isArtistFollowed(getFollowedArtists(), artistOnPage);
    btn.classList.toggle('following', on);
    I18N.text(btn, on ? 'Following' : 'Follow');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const btnArtistFollow = document.getElementById('btn-artist-follow');
  if (btnArtistFollow) {
    btnArtistFollow.addEventListener('click', () => {
      if (!artistOnPage) return;
      const r = Lib.toggleFollowArtist(getFollowedArtists(), artistOnPage);
      setFollowedArtists(r.list);
      updateFollowButton();
      showToast(r.followed ? `Following ${artistOnPage.name}` : `Unfollowed ${artistOnPage.name}`, 'info');
    });
  }

  function updateArtistBlockButton() {
    const btn = document.getElementById('btn-artist-block');
    if (!btn) return;
    const on = !!artistOnPage && Lib.isArtistBlocked(getBlocks().artists, artistOnPage.name);
    btn.classList.toggle('blocked', on);
    I18N.text(btn, on ? 'Blocked' : 'Block');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const btnArtistBlock = document.getElementById('btn-artist-block');
  if (btnArtistBlock) btnArtistBlock.addEventListener('click', () => { if (artistOnPage) toggleBlockArtist(artistOnPage.name); });

  let artistRunId = 0;
  // `id` (the artist's channel) or `video` (a video of theirs) tells artists with the same name apart;
  // a name alone opens the best-known namesake, and the page offers the others
  async function openArtistProfile(artistName, { id = '', video = '' } = {}) {
    if (!artistName || !artistName.trim()) return;
    const cleanName = artistName.replace(/ - Topic|VEVO|Official|Records/gi, '').trim();
    // a slow reply for an artist opened earlier must not replace the one opened since
    const run = ++artistRunId;
    const artistQuery = `name=${encodeURIComponent(cleanName)}${id ? `&id=${encodeURIComponent(id)}` : video ? `&video=${encodeURIComponent(video)}` : ''}`;

    // from one artist to another (a namesake), Back still returns to where the first was opened from
    if (state.currentView !== 'artist') state.previousView = state.currentView;
    switchView('artist');
    const main = document.querySelector('.main-content');
    if (main) main.scrollTop = 0;
    state.currentArtistData = null;
    artistTracksExpanded = false;
    setArtistTab('tracks', false);
    loadArtistAlbums(artistQuery, run);
    const matches = fetchArtistMatches(cleanName);
    const matchesSection = document.getElementById('artist-matches-section');
    if (matchesSection) matchesSection.style.display = 'none';

    artistOnPage = { name: cleanName, id: id || '' };
    updateFollowButton();
    if (el.artistProfileName) el.artistProfileName.textContent = cleanName;
    setArtistBio('');
    setArtistFans(null);
    setArtistHero('', '', run);
    if (el.artistTracksCount) el.artistTracksCount.textContent = '';
    if (el.btnPlayArtistTracks) el.btnPlayArtistTracks.disabled = true;
    const tracksToggle = document.getElementById('btn-artist-tracks-toggle');
    if (tracksToggle) tracksToggle.classList.add('hidden');
    if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.add('hidden');
    if (el.artistTracksList) el.artistTracksList.innerHTML = '<div class="empty-hint" data-i18n>Fetching official releases...</div>';

    // with only a video to go by, the server works out which artist it is: no cached bio of a namesake meanwhile
    const bioCacheKey = id || (video ? '' : cleanName.toLowerCase());
    let bioFromCache = false;
    if (bioCacheKey && artistBioCache.has(bioCacheKey)) {
      const cached = artistBioCache.get(bioCacheKey);
      if (cached) {
        bioFromCache = true;
        setArtistBio(cached);
      }
    }

    const bioController = new AbortController();
    const bioTimeout = setTimeout(() => bioController.abort(), 8000);

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?${artistQuery}`, { signal: bioController.signal });
      clearTimeout(bioTimeout);
      const data = await res.json();
      if (run !== artistRunId) return;

      if (!data.success || !data.artist) throw new Error('Artist not found');

      const artist = data.artist;
      state.currentArtistData = artist;
      if (el.artistProfileName) el.artistProfileName.textContent = artist.name;
      showArtistMatches(matches, artist, cleanName, run);

      // follow by the channel when the page has one; a followed entry learns the picture and the channel
      artistOnPage = { name: artist.name || cleanName, id: artist.id || id || '', ids: artist.ids || [], avatar: artist.avatar || '', fans: artist.fans || 0 };
      const refreshed = Lib.refreshFollowed(getFollowedArtists(), artistOnPage);
      if (refreshed.changed) setFollowedArtists(refreshed.list);
      updateFollowButton();

      if (!bioFromCache) {
        const cleanBio = String(artist.bio || '').replace(/<[^>]*>/g, '').trim();
        artistBioCache.set(artist.id || cleanName.toLowerCase(), cleanBio);
        capMap(artistBioCache, 100);
        setArtistBio(cleanBio);
      }

      if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.toggle('hidden', !artist.isVerified);
      setArtistFans(artist);
      setArtistHero(artist.banner || '', artist.avatar || '', run);

      const tracks = artist.tracks || [];
      if (el.artistTracksCount) el.artistTracksCount.textContent = tracks.length ? `${tracks.length} songs` : '';
      if (el.btnPlayArtistTracks) el.btnPlayArtistTracks.disabled = tracks.length === 0;
      requestAnimationFrame(() => {
        if (run !== artistRunId) return;
        if (tracks.length) renderArtistTracks();
        else if (el.artistTracksList) el.artistTracksList.innerHTML = '<div class="empty-hint">No tracks found for this artist.</div>';
      });
    } catch (e) {
      clearTimeout(bioTimeout);
      if (run !== artistRunId) return;
      console.warn('Artist load error:', e);
      showArtistMatches(matches, null, cleanName, run);
      setArtistHero('', '', run);
      if (!bioFromCache) setArtistBio('');
      if (el.artistTracksList) el.artistTracksList.innerHTML = '<div class="empty-hint" data-i18n>No tracks found for this artist.</div>';
    }
  }



  if (el.btnBackArtist) {
    el.btnBackArtist.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (state.previousView && state.previousView !== 'artist') ? state.previousView : 'discover';
      switchView(target);
    };
  }

  if (el.btnBackAlbum) {
    el.btnBackAlbum.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
      switchView(target);
    };
  }

  if (el.playbarArtist) {
    el.playbarArtist.addEventListener('click', (e) => {
      // On phones the mini player opens Now Playing wherever it's tapped (mobile-ui.js); the artist is a tap away
      // there. The line spans the whole bar, so only the name itself opens the artist: a tap just under a short
      // title used to.
      if (isPhoneApp && !document.body.classList.contains('np-open')) return;
      const name = document.createRange();
      name.selectNodeContents(el.playbarArtist);
      const box = name.getBoundingClientRect();
      if (box.width && (e.clientX < box.left - 4 || e.clientX > box.right + 4)) return;
      e.stopPropagation();
      if (state.currentTrack && state.currentTrack.artist) {
        openTrackArtist(state.currentTrack);
      }
    });
  }

  if (el.rightPanelArtist) {
    el.rightPanelArtist.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.currentTrack && state.currentTrack.artist) {
        openTrackArtist(state.currentTrack);
      }
    });
  }

  function toggleFavoriteTrack(track) {
    if (!track) return;
    const exists = state.favorites.some(f => isSameSong(f, track));
    
    if (exists) {
      state.favorites = state.favorites.filter(f => !isSameSong(f, track));
    } else {
      state.favorites.unshift(stampAddedAt(track));
    }
    
    localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
    updateFavoritesBadge();
    updateFavoriteIcon();
    if (state.currentView === 'favorites') renderFavoritesView();
  }

  function updateFavoriteIcon() {
    const isFav = !!(state.currentTrack && state.favorites.some(f => isSameSong(f, state.currentTrack)));
    if (el.favIcon) el.favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
    if (el.tvkFavIcon) el.tvkFavIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
    if (el.btnTvkFav) {
      el.btnTvkFav.classList.toggle('active', isFav);
      el.btnTvkFav.setAttribute('aria-pressed', String(isFav));
      el.btnTvkFav.disabled = !state.currentTrack;
    }
  }

  function updateFavoritesBadge() {
    if (el.favoritesCount) { el.favoritesCount.textContent = state.favorites.length; el.favoritesCount.hidden = !state.favorites.length; }
  }

  const TRACK_SORT_KEYS = { favorites: 'muriel_favorites_sort', playlist: 'muriel_playlist_sort' };

  function getTrackSortMode(kind) {
    const stored = localStorage.getItem(TRACK_SORT_KEYS[kind]);
    return TRACK_SORT_MODES.includes(stored) ? stored : 'manual';
  }

  function setTrackSortMode(kind, mode) {
    localStorage.setItem(TRACK_SORT_KEYS[kind], TRACK_SORT_MODES.includes(mode) ? mode : 'manual');
  }

  function sortTracksFor(kind, tracks) {
    return sortTracks(tracks, getTrackSortMode(kind));
  }

  function stampAddedAt(track) {
    return { ...track, addedAt: Date.now() };
  }

  function renderFavoritesView() {
    const query = el.favoritesSearchInput ? normalizeSearch(el.favoritesSearchInput.value) : '';
    let filtered = state.favorites;
    if (query) {
      filtered = filtered.filter(t => matchesTrackQuery(t, query));
    }
    filtered = sortTracksFor('favorites', filtered);
    if (el.favoritesSort) { el.favoritesSort.value = getTrackSortMode('favorites'); syncSortDropdown('favorites'); }
    if (el.favoritesSubtitle) el.favoritesSubtitle.textContent = query ? `${filtered.length} of ${state.favorites.length} tracks` : `${state.favorites.length} tracks saved`;
    if (el.favoritesTracksList) renderTracks(el.favoritesTracksList, filtered, 'favorites');
  }

  if (el.favoritesSearchInput) {
    el.favoritesSearchInput.addEventListener('input', () => renderFavoritesView());
  }

  // Sort menus of Favorites and playlists: a Material dropdown in front of the <select> (still the value), with
  // the select's options, so the list of orders stays in one place (track-sort.js does the sorting)
  // (var: a view can render before this line has run)
  var sortDropdowns = {};
  function syncSortDropdown(kind) {
    const d = sortDropdowns && sortDropdowns[kind];
    if (!d) return;
    d.menu.querySelectorAll('.m3-dropdown-option').forEach((opt) => {
      const on = opt.dataset.value === d.select.value;
      opt.classList.toggle('selected', on);
      opt.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && d.label) d.label.textContent = opt.textContent;
    });
  }
  function setupSortDropdown(kind, selectEl) {
    const dropdown = document.getElementById(`${kind}-sort-dropdown`);
    const trigger = document.getElementById(`${kind}-sort-trigger`);
    const menu = document.getElementById(`${kind}-sort-menu`);
    if (!dropdown || !trigger || !menu || !selectEl) return;
    sortDropdowns[kind] = { dropdown, menu, select: selectEl, label: document.getElementById(`${kind}-sort-label`) };
    menu.innerHTML = '';
    [...selectEl.options].forEach((o) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'm3-dropdown-option';
      opt.setAttribute('role', 'option');
      opt.dataset.value = o.value;
      opt.textContent = o.textContent;
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        if (selectEl.value !== o.value) {
          selectEl.value = o.value;
          selectEl.dispatchEvent(new Event('change'));
        }
        syncSortDropdown(kind);
      });
      menu.appendChild(opt);
    });
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      Object.values(sortDropdowns).forEach((d) => { if (d.dropdown !== dropdown) d.dropdown.classList.remove('open'); });
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dropdown.classList.remove('open'); });
    syncSortDropdown(kind);
  }

  if (el.favoritesSort) {
    el.favoritesSort.addEventListener('change', () => {
      setTrackSortMode('favorites', el.favoritesSort.value);
      renderFavoritesView();
    });
    el.favoritesSort.value = getTrackSortMode('favorites');
    setupSortDropdown('favorites', el.favoritesSort);
  }

  // Sorting the Albums tab, the playlists list and the Artists tab (#19); track-sort.js does the sorting.
  // Kept per view in localStorage. (var and function declarations: the lists can render before this line runs)
  var LIBRARY_SORT_KEYS = { albums: 'muriel_albums_sort', playlists: 'muriel_playlists_sort', artists: 'muriel_artists_sort' };
  function getLibrarySort(kind) {
    let v = null;
    try { v = localStorage.getItem((LIBRARY_SORT_KEYS || {})[kind] || ''); } catch (e) {}
    return librarySortMode(kind, v);
  }
  function sortedLibrary(kind, items) {
    return sortLibrary(kind, items, getLibrarySort(kind), kind === 'artists' ? { plays: (a) => artistPlays(a.name) } : {});
  }
  ['albums', 'playlists', 'artists'].forEach((kind) => {
    const sel = document.getElementById(`${kind}-sort`);
    if (!sel) return;
    sel.value = getLibrarySort(kind);
    sel.addEventListener('change', () => {
      try { localStorage.setItem(LIBRARY_SORT_KEYS[kind], librarySortMode(kind, sel.value)); } catch (e) {}
      syncSortDropdown(kind);
      if (kind === 'albums') renderSavedAlbums();
      else if (kind === 'artists') renderArtistsTab();
      else renderPlaylistsList();
    });
    setupSortDropdown(kind, sel);
  });

  function renderHistoryView() {
    if (el.historyTracksList) renderTracks(el.historyTracksList, state.history, 'history');
  }

  let queueRerender = 0;
  function updateQueueBadge() {
    window.dispatchEvent(new Event('muriel:queue'));
    if (el.queueCount) { el.queueCount.textContent = state.queue.length; el.queueCount.style.display = state.queue.length ? 'inline-block' : 'none'; }
    scheduleQueueSave();
    // an open queue list kept showing the old order after Play next / Add to queue
    if (!queueRerender && (state.currentView === 'queue' || (state.isRightPanelOpen && state.drawerTab === 'queue'))) {
      queueRerender = requestAnimationFrame(() => {
        queueRerender = 0;
        const list = el.queueTracksList;
        // a plain skip keeps the same queue (the row highlight follows on its own); only redraw when it changed
        if (list && (list._renderedQueue !== state.queue || list._renderedLen !== state.queue.length)) renderQueueView();
      });
    }
  }

  function renderQueueView() {
    if (!el.queueTracksList) return;
    renderTracks(el.queueTracksList, state.queue, 'queue');
    el.queueTracksList._renderedQueue = state.queue;
    el.queueTracksList._renderedLen = state.queue.length;
  }

  function updateLocalBadge() {
    if (el.localCount) { const n = (state.localTracks && state.localTracks.length) || 0; el.localCount.textContent = n; el.localCount.hidden = !n; }
  }

  // The server looks up missing covers in the background; pick them up while the library is open.
  let localCoverRefreshTimer = null;
  let localCoverRefreshCount = 0;
  function scheduleLocalCoverRefresh() {
    if (localCoverRefreshTimer) clearTimeout(localCoverRefreshTimer);
    localCoverRefreshTimer = null;
    const missing = (state.localTracks || []).filter(t => !t.thumbnail).length;
    if (!missing) { localCoverRefreshCount = 0; return; }
    if (localCoverRefreshCount >= 40) return;
    localCoverRefreshTimer = setTimeout(async () => {
      localCoverRefreshTimer = null;
      if (state.currentView !== 'local') return;
      localCoverRefreshCount++;
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/library`);
        const fresh = await res.json();
        const before = (state.localTracks || []).filter(t => t.thumbnail).length;
        const after = fresh.filter(t => t.thumbnail).length;
        if (after !== before) {
          state.localTracks = fresh;
          renderLocalView(false);
          return;
        }
      } catch (e) {}
      scheduleLocalCoverRefresh();
    }, 15000);
  }

  async function renderLocalView(forceFetch = true) {
    if (forceFetch || !state.localTracks) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/library`);
        state.localTracks = await res.json();
      } catch (e) {
        if (!Array.isArray(state.localTracks)) state.localTracks = [];
      }
    }
    updateLocalBadge();
    scheduleLocalCoverRefresh();
    const query = el.localSearchInput ? normalizeSearch(el.localSearchInput.value) : '';
    let filtered = state.localTracks || [];
    if (query) {
      filtered = filtered.filter(t => matchesTrackQuery(t, query));
    }
    if (el.localSubtitle) {
      el.localSubtitle.textContent = query
        ? `${filtered.length} of ${state.localTracks.length} tracks`
        : `${state.localTracks.length} tracks in library`;
    }
    if (el.localTracksList) {
      if (!state.localTracks || state.localTracks.length === 0) {
        el.localTracksList.style.paddingTop = '0px';
        el.localTracksList.style.paddingBottom = '0px';
        el.localTracksList.innerHTML = `
          <div class="empty-hint" style="display:flex;flex-direction:column;align-items:center;gap:12px;">
            <span data-i18n>No local tracks in library yet.</span>
            <button class="btn-pill-primary" id="btn-add-local-files-empty" data-i18n>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              Add files
            </button>
          </div>`;
        const emptyBtn = el.localTracksList.querySelector('#btn-add-local-files-empty');
        if (emptyBtn) emptyBtn.addEventListener('click', importLocalFiles);
      } else {
        renderTracks(el.localTracksList, filtered, 'local');
      }
    }
  }

  if (el.localSearchInput) {
    el.localSearchInput.addEventListener('input', () => renderLocalView(false));
  }

  async function importLocalFiles(opts) {
    if (!window.electronAPI || !window.electronAPI.importAudioFiles) return;
    try {
      const items = await window.electronAPI.importAudioFiles(opts && opts.folder ? { folder: true } : undefined);
      if (!items || items.length === 0) return;

      await fetch(`http://127.0.0.1:${state.serverPort}/api/library-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });

      if (state.currentView === 'local') renderLocalView(true);

      let idx = 0;
      async function worker() {
        while (idx < items.length) {
          const item = items[idx++];
          if (!item || !item.id) continue;
          await new Promise(resolve => {
            const url = tokenUrl(`http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(item.id)}`);
            // set src after construction: new Audio(url) skips the phone bridge's src rewrite
            const a = new Audio();
            a.preload = 'metadata';
            a.src = url;
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              a.src = '';
              resolve();
            };
            a.onloadedmetadata = async () => {
              const dur = Math.round(a.duration || 0);
              if (dur > 0) {
                try {
                  await fetch(`http://127.0.0.1:${state.serverPort}/api/library-update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: item.id, duration: dur })
                  });
                } catch (e) {}
              }
              finish();
            };
            a.onerror = () => finish();
            setTimeout(finish, 5000);
          });
        }
      }
      // one at a time on phones: each probe can pull a whole (lossless, so big) file into memory there
      await Promise.all(isPhoneApp ? [worker()] : [worker(), worker()]);

      await renderLocalView(true);
      showToast(Tm('Added {0} tracks', items.length));
    } catch (e) {
      console.warn('Import audio files error:', e);
    }
  }

  // Small-list art: a 44px row doesn't need a 720p frame decoded into RAM (~1.1 MB each).
  // Falls back to the full URL via data-full if the small variant 404s.
  function listThumb(url) {
    if (!url || !getAdv('light_thumbs', true)) return url;
    const yt = url.match(/^https?:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([\w-]{6,})\//);
    if (yt) return `https://i.ytimg.com/vi/${yt[1]}/mqdefault.jpg`;
    if (/(googleusercontent|ggpht)\.com/.test(url)) return url.replace(/=w\d+-h\d+[^&?]*$/, '=w120-h120-l90-rj').replace(/=s\d+[^&?]*$/, '=s120');
    if (/sndcdn\.com/.test(url)) return url.replace(/-(t500x500|original|crop)\./, '-t300x300.');
    return url;
  }

  // Cover art (#18). Many saved songs (synced, restored, imported, matched on play) carry no thumbnail or a
  // dead one, and the row just hid its picture. A YouTube song's cover can always be derived from its id, and a
  // failed picture walks down a list of candidates instead of giving up.
  const YT_THUMB = /^https?:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//;
  function trackYoutubeId(track) {
    if (!track) return '';
    const p = String(track.platform || '').toLowerCase();
    if (p === 'local' || p === 'soundcloud' || p === 'sc') return '';
    const m = String(track.url || track.videoId || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return m[1];
    if (/^[\w-]{11}$/.test(String(track.videoId || ''))) return track.videoId;
    if ((p === 'youtube' || p === 'ytmusic' || p === 'yt' || (!p && !track.url)) && /^[\w-]{11}$/.test(String(track.id || ''))) return String(track.id);
    return '';
  }
  // other sizes of a cover we already have (YouTube frames, SoundCloud artwork)
  function artVariants(url) {
    if (!url || typeof url !== 'string') return [];
    const yt = url.match(YT_THUMB);
    if (yt) return ['hqdefault', 'mqdefault', 'default'].map((s) => `https://i.ytimg.com/vi/${yt[1]}/${s}.jpg`);
    if (/sndcdn\.com\/.*-(t500x500|original|large|crop|t300x300)\./.test(url)) return ['t500x500', 'large', 't300x300'].map((s) => url.replace(/-(t500x500|original|large|crop|t300x300)\./, `-${s}.`));
    return [];
  }
  function derivedTrackArt(track) {
    const id = trackYoutubeId(track);
    return id ? artVariants(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`) : [];
  }
  // every picture worth trying for a song, best first
  function trackArtCandidates(track) {
    if (!track) return [];
    const out = [];
    const add = (u) => { if (u && typeof u === 'string' && !out.includes(u)) out.push(u); };
    [getTrackArt(track).cover, track.localThumbnail, track.thumbnail, track.cover, track.image, track.artworkUrl].forEach((u) => { add(u); artVariants(u).forEach(add); });
    derivedTrackArt(track).forEach(add);
    // last: the same picture through the in-app server (kept on disk, so a blocked or dead cover host costs one
    // try), which falls back to the song's iTunes cover by artist and title. Computers only.
    if (!isPhoneApp && state.serverPort && track.title) {
      const first = out.find((u) => /^https?:\/\//.test(u) && !u.startsWith('http://127.0.0.1')) || '';
      add(tokenUrl(`http://127.0.0.1:${state.serverPort}/api/image-proxy?url=${encodeURIComponent(first)}&artist=${encodeURIComponent(track.artist || '')}&title=${encodeURIComponent(track.title)}`));
    }
    return out;
  }

  // next cover to try in a player <img> whose current one failed ('' when none is left)
  function nextPlayerArt(track, img) {
    if (!img || !track) return '';
    if (img.__artTrack !== track) { img.__artTrack = track; img.__artTried = new Set(); }
    const cur = img.getAttribute('src') || '';
    img.__artTried.add(cur);
    const next = trackArtCandidates(track).concat(artVariants(cur)).find((u) => !img.__artTried.has(u));
    if (!next) return '';
    img.__artTried.add(next);
    img.style.display = 'block';
    img.src = next;
    return next;
  }

  function getTrackThumbUrl(track) {
    if (!track) return '';
    const o = getTrackArt(track).cover;
    if (o) return o;
    if (track.localThumbnail) return track.localThumbnail;
    return track.thumbnail || track.cover || track.image || track.artworkUrl || derivedTrackArt(track)[0] || '';
  }

  // A song's cover that loaded in place of its saved (missing or dead) one is saved with the song.
  function rememberTrackArt(canonicalId, url) {
    if (!canonicalId || !/^https:\/\//.test(url || '')) return;
    const fix = (arr) => {
      let changed = false;
      (arr || []).forEach((t) => {
        if (t && t.thumbnail !== url && getTrackCanonicalId(t) === canonicalId && !getTrackArt(t).cover) { t.thumbnail = url; changed = true; }
      });
      return changed;
    };
    try {
      if (fix(state.favorites)) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      if (fix(state.history)) localStorage.setItem('devsize_history', JSON.stringify(state.history));
      let pl = false;
      (state.playlists || []).forEach((p) => { if (p && fix(p.tracks)) pl = true; });
      if (pl) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      if (state.currentTrack && getTrackCanonicalId(state.currentTrack) === canonicalId && !getTrackArt(state.currentTrack).cover) state.currentTrack.thumbnail = url;
    } catch (e) {}
  }

  // onerror of a cover <img>: next candidate (data-full, then data-art, then other sizes), hidden when none is left
  function nextTrackArt(img) {
    if (!img) return false;
    const tried = img.__artTried || (img.__artTried = new Set());
    const cur = img.getAttribute('src') || '';
    tried.add(cur);
    let list = [];
    try { list = JSON.parse(img.dataset.art || '[]'); } catch (e) {}
    if (img.dataset.full) list.unshift(img.dataset.full);
    list = list.concat(artVariants(cur));
    const next = list.find((u) => u && !tried.has(u));
    if (!next) { img.style.visibility = 'hidden'; return false; }
    tried.add(next);
    const row = img.closest && img.closest('[data-canonical-id]');
    if (row && !img.__artRemember) {
      img.__artRemember = true;
      img.addEventListener('load', () => {
        const ok = img.getAttribute('src');
        if (img.naturalWidth > 0 && ok && ok !== img.dataset.saved) rememberTrackArt(row.dataset.canonicalId, ok);
      });
    }
    img.style.visibility = '';
    img.src = next;
    return true;
  }
  window.murielArtNext = nextTrackArt;

  // Old saves: give YouTube songs without a cover the one derived from their id (no network), once, when idle.
  function backfillTrackArt() {
    const fill = (arr) => {
      let changed = false;
      (arr || []).forEach((t) => {
        if (t && !t.thumbnail && !t.localThumbnail) { const d = derivedTrackArt(t)[0]; if (d) { t.thumbnail = d; changed = true; } }
      });
      return changed;
    };
    try {
      if (fill(state.favorites)) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      if (fill(state.history)) localStorage.setItem('devsize_history', JSON.stringify(state.history));
      let pl = false;
      (state.playlists || []).forEach((p) => { if (p && fill(p.tracks)) pl = true; });
      if (pl) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    } catch (e) {}
  }
  (window.requestIdleCallback || ((f) => setTimeout(f, 3000)))(backfillTrackArt);

  function renderPlaylistCover(container, playlist, size = 64) {
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('playlist-cover-art');

    function renderFallback() {
      container.innerHTML = '';
      container.classList.remove('cover-single', 'cover-empty');
      const tracks = (playlist && playlist.tracks) ? playlist.tracks : [];
      let firstThumb = null;
      let firstTrack = null;
      for (const t of tracks) {
        const src = getTrackThumbUrl(t);
        if (src) {
          firstThumb = src;
          firstTrack = t;
          break;
        }
      }

      if (firstThumb) {
        container.classList.add('cover-single');
        const img = document.createElement('img');
        img.className = 'cover-single-img';
        img.src = firstThumb;
        img.alt = '';
        img.loading = 'lazy';
        img.style.objectFit = 'cover';
        img.dataset.art = JSON.stringify(trackArtCandidates(firstTrack));
        img.onerror = () => {
          if (nextTrackArt(img)) return;
          container.classList.remove('cover-single');
          container.classList.add('cover-empty');
          container.innerHTML = `<svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        };
        container.appendChild(img);
      } else {
        container.classList.add('cover-empty');
        container.innerHTML = `
          <svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
        `;
      }
    }

    if (playlist && playlist.cover && typeof playlist.cover === 'string' && playlist.cover.trim()) {
      container.classList.add('cover-single');
      const img = document.createElement('img');
      img.className = 'cover-single-img';
      img.src = playlist.cover.trim();
      img.alt = '';
      img.loading = 'lazy';
      img.style.objectFit = 'cover';
      img.onerror = () => {
        renderFallback();
      };
      container.appendChild(img);
      return;
    }

    renderFallback();
  }

  // Home: "Your playlists". They only lived in a side drawer, and many people never found them.
  function renderHomePlaylists() {
    const box = document.getElementById('section-home-playlists');
    if (!box) return;
    const lists = state.playlists || [];
    box.innerHTML = `<div class="onrepeat-head"><h3 class="section-title" data-i18n>Your playlists</h3></div><div class="home-pl-row"></div>`;
    const row = box.querySelector('.home-pl-row');
    const card = (cls, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `home-pl-card ${cls}`;
      b.addEventListener('click', onClick);
      row.appendChild(b);
      return b;
    };
    const add = card('home-pl-new', () => { if (el.btnNewPlaylist) el.btnNewPlaylist.click(); });
    add.innerHTML = `<span class="home-pl-cover"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></span><b data-i18n>New playlist</b><span>${lists.length ? '&nbsp;' : 'Make your first one'}</span>`;
    lists.forEach((pl) => {
      const b = card('', () => openPlaylistDetail(pl.id));
      const cover = document.createElement('span');
      cover.className = 'home-pl-cover';
      renderPlaylistCover(cover, pl, 150);
      const n = (pl.tracks || []).length;
      b.append(cover);
      b.insertAdjacentHTML('beforeend', `<b>${escapeHtml(pl.name || 'Untitled')}</b><span data-i18n>${n} song${n === 1 ? '' : 's'}</span>`);
    });
  }

  function renderPlaylistsList() {
    renderHomePlaylists();
    if (!el.playlistsList) return;
    el.playlistsList.innerHTML = '';
    if (!state.playlists || state.playlists.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'playlists-empty-note';
      emptyMsg.style.cssText = 'padding: 24px 12px; text-align: center; color: var(--md-sys-color-on-surface-variant); font-size: calc(13px * var(--font-scale, 1));';
      emptyMsg.textContent = 'No playlists yet';
      emptyMsg.dataset.i18n = '';
      el.playlistsList.appendChild(emptyMsg);
      return;
    }
    sortedLibrary('playlists', state.playlists).forEach(pl => {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      item.dataset.playlistId = pl.id;
      if (state.currentView === 'playlist-detail' && state.currentPlaylistId === pl.id) {
        item.classList.add('active');
      }

      const thumbEl = document.createElement('div');
      thumbEl.className = 'playlist-item-thumb';
      renderPlaylistCover(thumbEl, pl, 44);

      const infoEl = document.createElement('div');
      infoEl.className = 'playlist-item-info';
      const trackCount = (pl.tracks || []).length;
      infoEl.innerHTML = `
        <span class="playlist-item-name">${escapeHtml(pl.name || 'untitled')}</span>
        <span class="playlist-item-count" data-i18n>${trackCount} track${trackCount === 1 ? '' : 's'}</span>
      `;

      item.appendChild(thumbEl);
      item.appendChild(infoEl);

      item.addEventListener('click', () => {
        openPlaylistDetail(pl.id);
      });
      el.playlistsList.appendChild(item);
    });
  }

  function initListReordering({ container, itemSelector, setOrder, canDragItem, isFilterActive }) {
    if (!container) return;

    let draggedItem = null;
    let startX = 0;
    let startY = 0;
    let activePointerId = null;
    let isDragging = false;
    let pressTimer = null;
    let autoScrollTimer = null;
    let suppressClick = false;
    let startIndex = -1;
    let targetIndex = -1;
    let itemMetrics = [];
    let items = [];
    let draggedHeight = 0;
    let draggedStartTop = 0;
    let isTouch = false;

    const scrollParent = container.closest('.main-content, .rail-drawer') || container;

    window.addEventListener('click', (e) => {
      if (suppressClick) {
        e.stopImmediatePropagation();
        e.preventDefault();
        suppressClick = false;
      }
    }, true);

    const startDrag = () => {
      if (!draggedItem || isDragging) return;
      isDragging = true;
      suppressClick = true;
      container._isDraggingReorder = true;
      try {
        if (activePointerId !== null && draggedItem.setPointerCapture) {
          draggedItem.setPointerCapture(activePointerId);
        }
      } catch (e) {}

      container.style.userSelect = 'none';
      draggedItem.classList.add('is-dragging');

      items = Array.from(container.querySelectorAll(itemSelector)).filter(el => !canDragItem || canDragItem(el));
      startIndex = items.indexOf(draggedItem);
      targetIndex = startIndex;
      draggedHeight = draggedItem.offsetHeight;
      draggedStartTop = draggedItem.offsetTop;

      itemMetrics = items.map((el, i) => ({
        el,
        index: i,
        top: el.offsetTop,
        height: el.offsetHeight
      }));
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      // a second finger must not hijack a row that is already being moved
      if (draggedItem && isDragging) return;
      clearTimeout(pressTimer);
      if (isFilterActive && isFilterActive()) return;

      const item = e.target.closest(itemSelector);
      if (!item || item.parentElement !== container) return;
      if (canDragItem && !canDragItem(item)) return;

      if (e.target.closest('button, input, select, textarea, .btn-icon-pill, .track-fav, .track-download-btn, .btn-rename-p, .btn-delete-p')) return;

      draggedItem = item;
      startX = e.clientX;
      startY = e.clientY;
      activePointerId = e.pointerId;
      isDragging = false;
      isTouch = e.pointerType === 'touch';

      pressTimer = setTimeout(() => {
        startDrag();
      }, isTouch ? TOUCH_HOLD_MS : 250);

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!draggedItem) return;

      if (e.pointerId !== activePointerId) return;
      if (!isDragging) {
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist > 7) {
          clearTimeout(pressTimer);
          // a finger that moves before the hold is scrolling the list, not dragging a row
          if (isTouch) { onPointerUp(e); return; }
          startDrag();
        } else {
          return;
        }
      }

      const dy = e.clientY - startY;

      if (scrollParent) {
        const scRect = scrollParent.getBoundingClientRect();
        clearInterval(autoScrollTimer);
        if (e.clientY < scRect.top + 40) {
          autoScrollTimer = setInterval(() => { scrollParent.scrollTop -= 8; }, 16);
        } else if (e.clientY > scRect.bottom - 40) {
          autoScrollTimer = setInterval(() => { scrollParent.scrollTop += 8; }, 16);
        }
      }

      draggedItem.style.transform = `translate3d(0, ${dy}px, 0) scale(1.02)`;

      if (itemMetrics.length <= 1) return;

      const currentCenter = draggedStartTop + (draggedHeight / 2) + dy;
      let newTarget = 0;
      for (let i = 0; i < itemMetrics.length; i++) {
        const m = itemMetrics[i];
        const mid = m.top + (m.height / 2);
        if (currentCenter > mid) {
          newTarget = i;
        }
      }
      newTarget = Math.max(0, Math.min(newTarget, itemMetrics.length - 1));

      if (newTarget !== targetIndex) {
        targetIndex = newTarget;
        const shiftDistance = (itemMetrics.length > 1 && Math.abs(itemMetrics[1].top - itemMetrics[0].top) > 0)
          ? Math.abs(itemMetrics[1].top - itemMetrics[0].top)
          : draggedHeight;

        itemMetrics.forEach(metric => {
          if (metric.el === draggedItem) return;
          if (startIndex < targetIndex) {
            if (metric.index > startIndex && metric.index <= targetIndex) {
              metric.el.style.transform = `translate3d(0, -${shiftDistance}px, 0)`;
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            } else {
              metric.el.style.transform = '';
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            }
          } else if (startIndex > targetIndex) {
            if (metric.index >= targetIndex && metric.index < startIndex) {
              metric.el.style.transform = `translate3d(0, ${shiftDistance}px, 0)`;
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            } else {
              metric.el.style.transform = '';
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            }
          } else {
            metric.el.style.transform = '';
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          }
        });
      }
    };

    const onPointerUp = (e) => {
      if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
      // the browser took the gesture over (it began a scroll): put the row back where it was
      if (e && e.type === 'pointercancel') targetIndex = startIndex;
      clearTimeout(pressTimer);
      clearInterval(autoScrollTimer);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (!draggedItem) return;

      const item = draggedItem;
      const currentActiveId = activePointerId;
      draggedItem = null;
      activePointerId = null;

      try {
        if (currentActiveId !== null && item.hasPointerCapture && item.hasPointerCapture(currentActiveId)) {
          item.releasePointerCapture(currentActiveId);
        }
      } catch (e) {}

      if (isDragging) {
        let targetSlotDy = 0;
        if (targetIndex >= 0 && targetIndex < itemMetrics.length && targetIndex !== startIndex) {
          targetSlotDy = itemMetrics[targetIndex].top - draggedStartTop;
        }

        item.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
        item.style.transform = `translate3d(0, ${targetSlotDy}px, 0) scale(1)`;

        // Long track lists are virtualised (renderTracks): `items` is only the rendered slice, so positions
        // in it are not positions in the list. Each row knows its real index; without this, a drag in a
        // scrolled list reordered two other songs and saved that.
        const absolute = (i) => {
          const n = items[i] && items[i].dataset.trackIndex !== undefined ? Number(items[i].dataset.trackIndex) : NaN;
          return Number.isFinite(n) ? n : i;
        };
        const fromAbs = startIndex >= 0 ? absolute(startIndex) : -1;
        const toAbs = targetIndex >= 0 ? absolute(targetIndex) : -1;
        const sliceStart = container._lastStartIndex > 0 ? container._lastStartIndex : 0;

        setTimeout(() => {
          if (targetIndex !== startIndex && targetIndex >= 0 && targetIndex < items.length) {
            const targetItem = items[targetIndex];
            if (targetIndex > startIndex) {
              targetItem.after(item);
            } else {
              targetItem.before(item);
            }
          }

          item.classList.remove('is-dragging');
          item.style.transform = '';
          item.style.transition = '';
          item.style.willChange = '';

          items.forEach(el => {
            el.style.transform = '';
            el.style.transition = '';
          });

          container.style.userSelect = '';
          container.classList.add('no-enter-anim');

          container.querySelectorAll('.track-row').forEach((r, i) => {
            r.dataset.trackIndex = String(sliceStart + i);
            const num = r.querySelector('.track-row-index');
            if (num) num.textContent = String(sliceStart + i + 1);
          });

          if (fromAbs !== -1 && toAbs !== -1 && fromAbs !== toAbs) {
            setOrder(fromAbs, toAbs);
          }

          container._isDraggingReorder = false;
          setTimeout(() => { suppressClick = false; }, 80);
        }, 160);
      } else {
        suppressClick = false;
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    // once a held row is lifted the finger moves it, so the list must not scroll underneath
    container.addEventListener('touchmove', (e) => { if (isDragging) e.preventDefault(); }, { passive: false });
  }

  initListReordering({
    container: el.playlistsList,
    itemSelector: '.playlist-item',
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.playlists.splice(fromIdx, 1);
      state.playlists.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    },
    // dragging moves playlists in the custom order: not while the list shows another order
    isFilterActive: () => getLibrarySort('playlists') !== 'custom'
  });

  initListReordering({
    container: el.presetsContainer,
    itemSelector: '.preset-chip',
    canDragItem: (chip) => chip.dataset.isCustom === 'true',
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.customPresets.splice(fromIdx, 1);
      state.customPresets.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    }
  });

  initListReordering({
    container: el.favoritesTracksList,
    itemSelector: '.track-row',
    isFilterActive: () => Boolean(el.favoritesSearchInput && el.favoritesSearchInput.value.trim()) || getTrackSortMode('favorites') !== 'manual',
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.favorites.splice(fromIdx, 1);
      state.favorites.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      if (el.favoritesSubtitle) {
        el.favoritesSubtitle.textContent = `${state.favorites.length} tracks saved`;
      }
    }
  });

  initListReordering({
    container: el.playlistTracksList,
    itemSelector: '.track-row',
    isFilterActive: () => Boolean(el.playlistSearchInput && el.playlistSearchInput.value.trim()) || getTrackSortMode('playlist') !== 'manual',
    setOrder: (fromIdx, toIdx) => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl || !pl.tracks) return;
      const [moved] = pl.tracks.splice(fromIdx, 1);
      pl.tracks.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    }
  });

  function createPlaylist(name, initialTracks = [], cover = '', { open = true } = {}) {
    if (!name || !name.trim()) return null;
    const newPl = {
      id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: name.trim(),
      tracks: Array.isArray(initialTracks)
        ? initialTracks.map(t => (t && typeof t.addedAt === 'number') ? t : stampAddedAt(t))
        : []
    };
    if (cover && typeof cover === 'string' && cover.trim()) {
      newPl.cover = cover.trim();
    }
    state.playlists.push(newPl);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    renderPlaylistsList();
    if (open) openPlaylistDetail(newPl.id);
    return newPl;
  }

  function openPlaylistDetail(playlistId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    // the page shares its scroll with the view it was opened from: opened from "Your playlists" low on the
    // home screen, it showed up halfway down its song list with the header out of sight
    const opening = state.currentView !== 'playlist-detail' || state.currentPlaylistId !== playlistId;
    state.currentPlaylistId = playlistId;
    if (el.playlistDetailTitle) el.playlistDetailTitle.textContent = pl.name;
    const query = el.playlistSearchInput ? normalizeSearch(el.playlistSearchInput.value) : '';
    let filtered = pl.tracks;
    if (query) {
      filtered = pl.tracks.filter(t => matchesTrackQuery(t, query));
    }
    filtered = sortTracksFor('playlist', filtered);
    if (el.playlistSort) { el.playlistSort.value = getTrackSortMode('playlist'); syncSortDropdown('playlist'); }
    renderPlaylistDescription(pl);
    renderPlaylistDuplicateButton(pl);
    const totalSec = (pl.tracks || []).reduce((acc, t) => acc + (t.duration || 0), 0);
    const durStr = totalSec > 0 ? ` • ${formatDuration(totalSec)}` : '';
    if (el.playlistDetailCount) el.playlistDetailCount.textContent = (query ? `${filtered.length} of ${pl.tracks.length} tracks` : `${pl.tracks.length} tracks`) + durStr;
    const detailCover = document.getElementById('playlist-detail-cover');
    if (detailCover) renderPlaylistCover(detailCover, pl, 160);
    const coverSrc = (pl && pl.cover) ? pl.cover : ((pl.tracks && pl.tracks[0]) ? getTrackThumbUrl(pl.tracks[0]) : '');
    const plHeroFx = document.getElementById('playlist-hero-fx');
    if (plHeroFx) {
      plHeroFx.style.backgroundImage = coverSrc ? `url("${coverSrc}")` : '';
    }
    const headerEl = document.querySelector('.playlist-detail-header');
    if (headerEl) {
      if (coverSrc) {
        getCoverDominantColors(coverSrc).then(([domColor]) => {
          if (state.currentPlaylistId === playlistId) {
            headerEl.style.setProperty('--playlist-accent-color', domColor);
            document.documentElement.style.setProperty('--playlist-accent-color', domColor);
          }
        });
      } else {
        headerEl.style.removeProperty('--playlist-accent-color');
        document.documentElement.style.removeProperty('--playlist-accent-color');
      }
    }
    if (opening) { const main = document.querySelector('.main-content'); if (main) main.scrollTop = 0; }
    if (el.playlistTracksList) renderTracks(el.playlistTracksList, filtered, 'playlist');
    switchView('playlist-detail');
    renderPlaylistsList();
  }

  if (el.playlistSort) {
    el.playlistSort.addEventListener('change', () => {
      setTrackSortMode('playlist', el.playlistSort.value);
      if (state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
    });
    el.playlistSort.value = getTrackSortMode('playlist');
    setupSortDropdown('playlist', el.playlistSort);
  }

  // A playlist's description, written right on the page ("Add a description..."); it goes wherever the
  // playlist goes (sync, share links keep to name and songs)
  const playlistDescEl = document.getElementById('playlist-detail-desc');
  function renderPlaylistDescription(pl) {
    const desc = document.getElementById('playlist-detail-desc');
    if (!desc || document.activeElement === desc) return;
    desc.textContent = (pl && pl.description) || '';
  }
  if (playlistDescEl) {
    try { playlistDescEl.contentEditable = 'plaintext-only'; } catch (e) {}
    if (playlistDescEl.contentEditable !== 'plaintext-only') playlistDescEl.contentEditable = 'true';
    playlistDescEl.spellcheck = false;
    playlistDescEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); playlistDescEl.blur(); }
      if (e.key === 'Escape') {
        const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
        playlistDescEl.textContent = (pl && pl.description) || '';
        playlistDescEl.blur();
      }
      e.stopPropagation();
    });
    playlistDescEl.addEventListener('blur', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl) return;
      const next = playlistDescEl.textContent.replace(/\s+\n/g, '\n').trim().slice(0, 300);
      if ((pl.description || '') !== next) {
        if (next) pl.description = next;
        else delete pl.description;
        localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      }
      playlistDescEl.textContent = pl.description || '';
    });
  }
  // Play goes through the playlist in the order shown; Shuffle turns shuffle on and starts on a random song
  function playOpenPlaylist(shuffle) {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (!pl || !pl.tracks || !pl.tracks.length) return;
    const list = sortTracksFor('playlist', pl.tracks);
    setShuffle(shuffle);
    const i = shuffle ? Math.floor(Math.random() * list.length) : 0;
    playTrack(list[i], list, i, 'playlist');
  }
  // Share: the playlist goes inside a link (share-link.js) that opens in the web player or in Muriel
  async function sharePlaylist(pl) {
    const S = window.MurielShare;
    if (!pl || !S) return;
    let link, count;
    try { const r = await S.encode({ name: pl.name, tracks: pl.tracks || [] }); link = S.webLink(r.payload); count = r.count; } catch (e) { showToast(Tm("Couldn't make a link for this playlist"), 'error'); return; }
    if (!count) { showToast(Tm("Songs from your own files can't be shared, and this playlist has nothing else"), 'info'); return; }
    const skipped = (pl.tracks || []).length - count;
    const note = skipped > 0 ? ` (${skipped === 1 ? T('1 song from your own files left out') : Tf('{0} songs from your own files left out', skipped)})` : '';
    if (window.electronAPI && window.electronAPI.shareText) { // phones: the share sheet
      const r = await window.electronAPI.shareText(pl.name, `${pl.name} on Muriel 🎧 ${link}`);
      if (r === 'copied') showToast(Tm('Link copied{0}', note), 'success');
      else if (r === 'shared' && note) showToast(Tm('Shared{0}', note), 'info');
      else if (r === 'failed') showToast(Tm("Couldn't share the link"), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast(Tm('Link copied. Anyone can open it in the browser or in Muriel{0}', note), 'success');
    } catch (e) { window.prompt(T('Copy this link'), link); }
  }
  const btnSharePlaylist = document.getElementById('btn-share-playlist');
  if (btnSharePlaylist) btnSharePlaylist.addEventListener('click', () => sharePlaylist(state.playlists.find(p => p.id === state.currentPlaylistId)));

  // a playlist someone shared: from a muriel://playlist link, the search bar or the link importer
  let importingShare = '';
  async function importSharedPlaylist(text) {
    const S = window.MurielShare;
    const payload = S ? S.payloadFrom(text) : '';
    if (!payload) return false;
    if (importingShare === payload) return true;
    importingShare = payload;
    try {
      const { name, tracks } = await S.decode(payload);
      if (!tracks.length) { showToast(Tm('That playlist link has no songs Muriel can play'), 'info'); return true; }
      // short links carry only YouTube ids: look up titles and artists first
      if (tracks.some(t => t.needsInfo)) { showToast(Tm('Adding "{0}"…', name), 'info'); await S.fillInfo(tracks); }
      const key = (list) => list.map(t => `${t.platform}:${t.id}`).join('|');
      const same = state.playlists.find(p => p.name === name && key(p.tracks || []) === key(tracks));
      if (same) { openPlaylistDetail(same.id); showToast(Tm('You already have "{0}"', name), 'info'); return true; }
      const taken = new Set(state.playlists.map(p => p.name));
      let finalName = name;
      for (let i = 2; taken.has(finalName); i++) finalName = `${name} (${i})`;
      createPlaylist(finalName, tracks);
      showToast(tracks.length === 1 ? Tm('Added "{0}" (1 song)', finalName) : Tm('Added "{0}" ({1} songs)', finalName, tracks.length), 'success');
    } catch (e) {
      showToast(Tm("That playlist link didn't work. It may have been cut off, so ask for it again"), 'error');
    } finally {
      setTimeout(() => { if (importingShare === payload) importingShare = ''; }, 3000);
    }
    return true;
  }
  window.addEventListener('muriel:deeplink', (e) => { if (/^muriel:\/\/playlist/i.test(String(e.detail || ''))) importSharedPlaylist(e.detail); });

  if (el.btnPlayPlaylist) el.btnPlayPlaylist.addEventListener('click', () => playOpenPlaylist(false));
  const btnShufflePlaylist = document.getElementById('btn-shuffle-playlist');
  if (btnShufflePlaylist) btnShufflePlaylist.addEventListener('click', () => playOpenPlaylist(true));

  (function setupFavAllPlaylist() {
    const btn = document.getElementById('btn-fav-all-playlist');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl || !pl.tracks) return;
      let added = 0;
      for (let i = pl.tracks.length - 1; i >= 0; i--) {
        const track = pl.tracks[i];
        if (!state.favorites.some(f => isSameSong(f, track))) {
          state.favorites.unshift(stampAddedAt(track));
          added++;
        }
      }
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      updateFavoritesBadge();
      updateFavoriteIcon();
      btn.title = Tf('{0} added to favorites', added);
      const old = btn.style.color;
      btn.style.color = '#ff6b8a';
      setTimeout(() => { btn.style.color = old; btn.title = T('Add all to favorites'); }, 2500);
    });
  })();

  (function setupPlaylistRename() {
    const btn = document.getElementById('btn-rename-playlist');
    const titleEl = document.getElementById('playlist-detail-title');
    if (!btn || !titleEl) return;
    btn.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl || titleEl.querySelector('input')) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = pl.name || '';
      input.style.cssText = 'font:inherit;color:inherit;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.4);border-radius:12px;padding:2px 12px;width:100%;max-width:600px;outline:none;';
      titleEl.textContent = '';
      titleEl.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const newName = input.value.trim();
        if (save && newName) {
          pl.name = newName;
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
        }
        titleEl.textContent = pl.name;
        renderPlaylistsList();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    });
  })();

  (function setupMultiSelectControls() {
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('btn-select-playlist', () => startMultiSelect('playlist'));
    on('btn-select-favorites', () => startMultiSelect('favorites'));
    on('multi-select-done', () => exitMultiSelect());
    on('multi-select-all', () => {
      const all = multiSelectSourceTracks();
      const allSelected = all.length > 0 && all.every(t => multiSel.tracks.has(getTrackCanonicalId(t)));
      multiSel.tracks.clear();
      if (!allSelected) all.forEach(t => multiSel.tracks.set(getTrackCanonicalId(t), t));
      updateMultiSelectBar();
      rerenderMultiSelectView();
    });
    on('multi-select-fav', () => {
      let added = 0;
      multiSel.tracks.forEach(t => {
        if (!state.favorites.some(f => isSameSong(f, t))) { state.favorites.unshift(stampAddedAt(t)); added++; }
      });
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      updateFavoritesBadge();
      updateFavoriteIcon();
      showToast(!added ? Tm('Already in favorites') : added === 1 ? Tm('Added 1 track to favorites') : Tm('Added {0} tracks to favorites', added), added ? 'success' : 'info');
    });
    on('multi-select-radio', () => {
      const picked = Array.from(multiSel.tracks.values());
      if (!picked.length) return;
      if (picked.length > 5) showToast(Tm('Radio uses the first 5 selected songs'), 'info');
      exitMultiSelect();
      startSongRadio(picked);
    });
    on('multi-select-add', () => {
      const picked = Array.from(multiSel.tracks.values());
      if (picked.length) openAddToPlaylistModal(null, picked);
    });
    on('multi-select-remove', () => {
      const n = multiSel.tracks.size;
      if (!n || !window.confirm(n === 1 ? T('Remove 1 track?') : Tf('Remove {0} tracks?', n))) return;
      if (multiSel.context === 'favorites') {
        state.favorites = state.favorites.filter(f => !multiSel.tracks.has(getTrackCanonicalId(f)));
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
        updateFavoritesBadge();
        updateFavoriteIcon();
      } else {
        const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
        if (pl) {
          pl.tracks = pl.tracks.filter(t => !multiSel.tracks.has(getTrackCanonicalId(t)));
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          renderPlaylistsList();
        }
      }
      multiSel.tracks.clear();
      updateMultiSelectBar();
      rerenderMultiSelectView();
    });
  })();

  // takes the row's song object: a playlist can hold the same song twice, and removing one copy took all of them
  function removeTrackFromCurrentPlaylist(track) {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (!pl) return;
    const at = pl.tracks.indexOf(track);
    if (at >= 0) pl.tracks.splice(at, 1);
    else pl.tracks = pl.tracks.filter(t => !isSameTrack(t, track));
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    openPlaylistDetail(state.currentPlaylistId);
  }

  function deleteCurrentPlaylist() {
    if (!state.currentPlaylistId) return;
    state.playlists = state.playlists.filter(p => p.id !== state.currentPlaylistId);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    state.currentPlaylistId = null;
    renderPlaylistsList();
    switchView('discover');
  }

  let trackToAddToPlaylist = null;
  let manyToAddToPlaylist = null;
  // tracks waiting for the playlist that "New playlist" in the add dialog is about to create
  let tracksForNewPlaylist = null;
  function openAddToPlaylistModal(track, many = null) {
    trackToAddToPlaylist = track;
    manyToAddToPlaylist = many;
    if (!el.playlistPickList) return;

    const trackPreviewEl = document.getElementById('add-playlist-track-preview');
    if (trackPreviewEl) {
      if (track) {
        const thumb = getTrackThumbUrl(track) || '';
        trackPreviewEl.innerHTML = '';
        if (thumb) {
          const previewImg = document.createElement('img');
          previewImg.className = 'add-playlist-track-preview-thumb';
          previewImg.src = thumb;
          previewImg.alt = '';
          previewImg.style.width = '40px';
          previewImg.style.height = '40px';
          previewImg.style.flex = '0 0 40px';
          previewImg.onerror = () => { previewImg.style.visibility = 'hidden'; };
          trackPreviewEl.appendChild(previewImg);
        } else {
          const previewPlaceholder = document.createElement('div');
          previewPlaceholder.className = 'add-playlist-track-preview-thumb';
          previewPlaceholder.style.width = '40px';
          previewPlaceholder.style.height = '40px';
          previewPlaceholder.style.flex = '0 0 40px';
          previewPlaceholder.style.display = 'flex';
          previewPlaceholder.style.alignItems = 'center';
          previewPlaceholder.style.justifyContent = 'center';
          previewPlaceholder.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
          trackPreviewEl.appendChild(previewPlaceholder);
        }

        const previewInfo = document.createElement('div');
        previewInfo.className = 'add-playlist-track-preview-info';

        const previewTitle = document.createElement('span');
        previewTitle.className = 'add-playlist-track-preview-title';
        previewTitle.textContent = track.title || 'untitled';

        const previewArtist = document.createElement('span');
        previewArtist.className = 'add-playlist-track-preview-artist';
        previewArtist.textContent = track.artist || 'unknown artist';

        previewInfo.appendChild(previewTitle);
        previewInfo.appendChild(previewArtist);
        trackPreviewEl.appendChild(previewInfo);
        trackPreviewEl.style.display = 'flex';
      } else {
        trackPreviewEl.style.display = 'none';
        trackPreviewEl.innerHTML = '';
      }
    }

    el.playlistPickList.innerHTML = '';
    if (state.playlists.length === 0) {
      el.playlistPickList.innerHTML = '<div class="empty-hint" data-i18n style="padding: 24px 0; text-align: center; color: var(--md-sys-color-outline);">No playlists yet. Create one first.</div>';
    } else {
      state.playlists.forEach((pl, idx) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'playlist-pick-item';
        item.style.animationDelay = `${idx * 25}ms`;

        const isAlreadyAdded = many
          ? many.length > 0 && many.every(m => (pl.tracks || []).some(t => t.id === m.id))
          : track && (pl.tracks || []).some(t => t.id === track.id);
        if (isAlreadyAdded) item.classList.add('already-added');

        const thumbEl = document.createElement('div');
        thumbEl.className = 'playlist-pick-thumb';
        thumbEl.style.width = '44px';
        thumbEl.style.height = '44px';
        thumbEl.style.flex = '0 0 44px';
        renderPlaylistCover(thumbEl, pl, 44);
        const coverImg = thumbEl.querySelector('img');
        if (coverImg) {
          coverImg.style.width = '44px';
          coverImg.style.height = '44px';
          coverImg.style.objectFit = 'cover';
        }

        const infoEl = document.createElement('div');
        infoEl.className = 'playlist-pick-info';
        const trackCount = (pl.tracks || []).length;

        const nameEl = document.createElement('span');
        nameEl.className = 'playlist-pick-name';
        nameEl.textContent = pl.name || 'untitled';

        const countEl = document.createElement('span');
        countEl.className = 'playlist-pick-count';
        countEl.textContent = `${trackCount} track${trackCount === 1 ? '' : 's'}`;
        countEl.dataset.i18n = '';

        infoEl.appendChild(nameEl);
        infoEl.appendChild(countEl);

        const actionEl = document.createElement('div');
        if (isAlreadyAdded) {
          actionEl.className = 'playlist-pick-badge in-playlist';
          actionEl.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Added
          `;
        } else {
          actionEl.className = 'playlist-pick-action-btn';
          actionEl.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          `;
        }

        item.appendChild(thumbEl);
        item.appendChild(infoEl);
        item.appendChild(actionEl);

        item.addEventListener('click', () => {
          if (many) {
            const fresh = many.filter(m => !pl.tracks.some(t => t.id === m.id));
            fresh.forEach(m => pl.tracks.push(stampAddedAt(m)));
            if (fresh.length) {
              localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
              renderPlaylistsList();
            }
            showToast(!fresh.length ? Tm('Already in "{0}"', pl.name) : fresh.length === 1 ? Tm('Added 1 track to "{0}"', pl.name) : Tm('Added {0} tracks to "{1}"', fresh.length, pl.name), fresh.length ? 'success' : 'info');
          } else if (track) {
            if (!pl.tracks.some(t => t.id === track.id)) {
              pl.tracks.push(stampAddedAt(track));
              localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
              renderPlaylistsList();
              showToast(Tm('Added to "{0}"', pl.name), 'success');
            } else {
              showToast(Tm('Already in "{0}"', pl.name), 'info');
            }
          }
          if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
        });

        el.playlistPickList.appendChild(item);
      });
    }
    if (el.addToPlaylistModal) openModal(el.addToPlaylistModal);
  }

  function switchView(viewName) {
    // the queue lives in the drawer now, not in its own page
    if (viewName === 'queue') { openPanelDrawer('queue'); return; }
    state.currentView = viewName;
    if (multiSel.active) {
      const keep = (viewName === 'playlist-detail' && multiSel.context === 'playlist') || (viewName === 'favorites' && multiSel.context === 'favorites');
      if (!keep) exitMultiSelect(false);
    }

    requestAnimationFrame(() => {
      document.querySelectorAll('.no-enter-anim').forEach(c => c.classList.remove('no-enter-anim'));
      [el.viewDiscover, el.viewFavorites, el.viewAlbums, document.getElementById('view-artists'), el.viewLocal, el.viewHistory, el.viewQueue, el.viewPlaylistDetail, el.viewAlbum, el.viewArtist, el.viewSettings].forEach(v => {
        if (v) v.classList.remove('active');
      });

        [el.navDiscover, el.navFavorites, el.navAlbums, document.getElementById('nav-artists'), el.navLocal, el.navHistory, el.navQueue, el.navSettings].forEach(n => {
          if (n) n.classList.remove('active');
        });

          if (viewName === 'discover') {
            if (el.viewDiscover) el.viewDiscover.classList.add('active');
            if (el.navDiscover) el.navDiscover.classList.add('active');
            loadForYou();
            if (isSpotifyHome()) renderSpotifyHome();
          } else if (viewName === 'favorites') {
            if (el.viewFavorites) el.viewFavorites.classList.add('active');
            if (el.navFavorites) el.navFavorites.classList.add('active');
            renderFavoritesView();
          } else if (viewName === 'albums') {
            if (el.viewAlbums) el.viewAlbums.classList.add('active');
            if (el.navAlbums) el.navAlbums.classList.add('active');
            renderSavedAlbums();
          } else if (viewName === 'artists') {
            const v = document.getElementById('view-artists');
            const n = document.getElementById('nav-artists');
            if (v) v.classList.add('active');
            if (n) n.classList.add('active');
            renderArtistsTab();
          } else if (viewName === 'local') {
            if (el.viewLocal) el.viewLocal.classList.add('active');
            if (el.navLocal) el.navLocal.classList.add('active');
            renderLocalView();
          } else if (viewName === 'history') {
            if (el.viewHistory) el.viewHistory.classList.add('active');
            if (el.navHistory) el.navHistory.classList.add('active');
            renderHistoryView();
          } else if (viewName === 'queue') {
            if (el.viewQueue) el.viewQueue.classList.add('active');
            if (el.navQueue) el.navQueue.classList.add('active');
            renderQueueView();
          } else if (viewName === 'playlist-detail') {
            if (el.viewPlaylistDetail) el.viewPlaylistDetail.classList.add('active');
          } else if (viewName === 'album') {
            if (el.viewAlbum) el.viewAlbum.classList.add('active');
          } else if (viewName === 'artist') {
            if (el.viewArtist) el.viewArtist.classList.add('active');
          } else if (viewName === 'settings') {
            if (el.viewSettings) el.viewSettings.classList.add('active');
            if (el.navSettings) el.navSettings.classList.add('active');
            enterSettings();
            renderBlockedSettings(); // a linked device may have changed it
            updateOfflineStorageUI();
            updateMusicFolderUI();
  updateDownloadFolderUI();
  updateDownloadCaptionPath();
            checkToolsStatus(false);
          }

          updateNavIndicator(true);

          highlightPlayingRow();
          if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
          updateFxVisibility();
    });
  }

  function applyStackedRadius(container, itemSelector, horizontal) {
    if (!container) return;
    const raw = Array.isArray(container) ? container : [...container.querySelectorAll(itemSelector)];
    const items = raw.filter((n) => n.getBoundingClientRect().height > 1 && getComputedStyle(n).display !== 'none');
    const stackClasses = ['stack-only', 'stack-first', 'stack-mid', 'stack-last'];
    items.forEach((n, i) => {
      const target = items.length === 1 ? 'stack-only' : i === 0 ? 'stack-first' : i === items.length - 1 ? 'stack-last' : 'stack-mid';
      const needH = !!horizontal;
      if (n.classList.contains('stack-h') !== needH) n.classList.toggle('stack-h', needH);
      stackClasses.forEach((cls) => {
        if (cls === target) {
          if (!n.classList.contains(cls)) n.classList.add(cls);
        } else {
          if (n.classList.contains(cls)) n.classList.remove(cls);
        }
      });
    });
  }
  let stackRetry = false;
  function refreshStacks() {
    const sNav = document.querySelector('.sidebar-nav');
    if (sNav) {
      const all = [...sNav.querySelectorAll('.nav-item')];
      const visible = all.filter((n) => n.getBoundingClientRect().height > 1 && getComputedStyle(n).display !== 'none');
      if (all.length > 0 && visible.length === 0) {
        if (!stackRetry) {
          stackRetry = true;
          requestAnimationFrame(() => { stackRetry = false; refreshStacks(); });
        }
        return;
      }
      const div = sNav.querySelector('.rail-divider');
      if (div) {
        const divIdx = [...sNav.children].indexOf(div);
        applyStackedRadius(all.filter((n) => [...sNav.children].indexOf(n) < divIdx), null, false);
        applyStackedRadius(all.filter((n) => [...sNav.children].indexOf(n) > divIdx), null, false);
      } else {
        applyStackedRadius(all, null, false);
      }
    }
    applyStackedRadius(document.querySelector('.settings-nav'), '.settings-nav-btn', false);
    applyStackedRadius(document.getElementById('audio-tabs'), '.audio-tab', false);
  }

  let stackRaf = 0;
  const stackObserver = new MutationObserver(() => { if (stackRaf) return; stackRaf = requestAnimationFrame(() => { stackRaf = 0; refreshStacks(); }); });
  ['.sidebar-nav', '.settings-nav', '#audio-tabs'].forEach((s) => { const n = document.querySelector(s); if (n) stackObserver.observe(n, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true }); });

  let navIndicatorTimer = 0;
  let navIndicatorReady = false;
  function navIndicatorRadius(active) {
    const r = getComputedStyle(active).borderRadius;
    if (r && parseFloat(r) > 0) return r;
    return getComputedStyle(document.documentElement).getPropertyValue('--stack-mid').trim() || '14px';
  }
  function updateNavIndicator(animate) {
    refreshStacks();
    const ind = el.navActiveIndicator;
    if (!ind) return;
    const active = document.querySelector('.sidebar-nav .nav-item.active');
    if (!active || !active.offsetParent) { ind.classList.add('is-hidden'); return; }
    const nav = active.closest('.sidebar-nav');
    const nr = nav.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    if (!r.height) return;
    const top = Math.round(r.top - nr.top + (r.height - 48) / 2);
    ind.classList.remove('is-hidden');
    clearTimeout(navIndicatorTimer);
    if (!animate || !navIndicatorReady) {
      ind.style.transition = 'opacity 0.2s ease';
      ind.style.height = '48px';
      ind.style.transform = `translateY(${top}px)`;
      ind.style.borderRadius = navIndicatorRadius(active);
      navIndicatorReady = true;
      return;
    }
    const curTop = new DOMMatrix(getComputedStyle(ind).transform).m42;
    const curH = ind.getBoundingClientRect().height || 48;
    const curBottom = curTop + curH;
    const newTop = Math.min(curTop, top);
    const newBottom = Math.max(curBottom, top + 48);
    ind.style.transition = 'transform 0.26s cubic-bezier(0.3, 0, 0.8, 0.15), height 0.26s cubic-bezier(0.3, 0, 0.8, 0.15), opacity 0.2s ease';
    ind.style.transform = `translateY(${newTop}px)`;
    ind.style.height = `${newBottom - newTop}px`;
    ind.style.borderRadius = '24px';
    navIndicatorTimer = setTimeout(() => {
      ind.style.transition = 'transform 0.34s cubic-bezier(0.2, 0, 0, 1), height 0.34s cubic-bezier(0.2, 0, 0, 1), border-radius 0.34s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease';
      ind.style.transform = `translateY(${top}px)`;
      ind.style.height = '48px';
      ind.style.borderRadius = navIndicatorRadius(active);
    }, 260);
  }

  window.addEventListener('resize', () => updateNavIndicator(false));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => updateNavIndicator(false));
  const sidebarNavElem = document.querySelector('.sidebar-nav');
  if (sidebarNavElem) {
    refreshStacks();
    new ResizeObserver(() => updateNavIndicator(false)).observe(sidebarNavElem);
  }

  function setPlayPauseState(playing, animate = true) {
    const btn = el.btnPlayPause;
    const tvkBtn = document.getElementById('btn-tvk-play');

    const tvkPlay = document.getElementById('tvk-play-icon');
    const tvkPause = document.getElementById('tvk-pause-icon');
    if (tvkPlay && tvkPlay.getAnimations) {
      try { tvkPlay.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (tvkPause && tvkPause.getAnimations) {
      try { tvkPause.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (el.playIcon && el.playIcon.getAnimations) {
      try { el.playIcon.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }
    if (el.pauseIcon && el.pauseIcon.getAnimations) {
      try { el.pauseIcon.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    }

    if (tvkBtn) {
      const isTvkPlaying = tvkBtn.classList.contains('playing');
      if (tvkBtn._morphAnim) {
        try { tvkBtn._morphAnim.cancel(); } catch (e) {}
        tvkBtn._morphAnim = null;
      }
      const H = 56;
      const pausedW = H;
      const pausedR = H / 2;
      const playingW = Math.round(H * 1.39);
      const playingR = 20;

      tvkBtn.classList.toggle('playing', !!playing);

      if (animate && isTvkPlaying !== !!playing) {
        const cs = window.getComputedStyle(tvkBtn);
        const curW = parseFloat(cs.width) || (isTvkPlaying ? playingW : pausedW);
        const curR = parseFloat(cs.borderRadius) || (isTvkPlaying ? playingR : pausedR);

        const targetW = playing ? playingW : pausedW;
        const targetR = playing ? playingR : pausedR;
        const mid1W = playing ? targetW * 1.10 : targetW * 0.90;
        const mid2W = playing ? targetW * 0.97 : targetW * 1.03;

        const keyframes = [
          { width: `${curW}px`, borderRadius: `${curR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
          { width: `${mid1W}px`, borderRadius: `${targetR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', offset: 0.45 },
          { width: `${mid2W}px`, borderRadius: `${targetR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', offset: 0.72 },
          { width: `${targetW}px`, borderRadius: `${targetR}px`, offset: 1 }
        ];

        tvkBtn._morphAnim = tvkBtn.animate(keyframes, { duration: 340, easing: 'linear' });
      }
    }

    if (!btn) return;
    const isCurrentlyPlaying = btn.classList.contains('playing');
    if (btn._morphAnim) {
      try { btn._morphAnim.cancel(); } catch (e) {}
      btn._morphAnim = null;
    }

    const H = 48;
    const pausedW = H;
    const pausedR = H / 2;
    const playingW = Math.round(H * 1.45);
    const playingR = Math.round(H * 0.38);

    btn.classList.toggle('playing', !!playing);

    if (animate && isCurrentlyPlaying !== !!playing) {
      const cs = window.getComputedStyle(btn);
      const curW = parseFloat(cs.width) || (isCurrentlyPlaying ? playingW : pausedW);
      const curR = parseFloat(cs.borderRadius) || (isCurrentlyPlaying ? playingR : pausedR);

      const targetW = playing ? playingW : pausedW;
      const targetR = playing ? playingR : pausedR;
      const mid1W = playing ? targetW * 1.10 : targetW * 0.90;
      const mid2W = playing ? targetW * 0.97 : targetW * 1.03;

      const keyframes = [
        { width: `${curW}px`, borderRadius: `${curR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
        { width: `${mid1W}px`, borderRadius: `${targetR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', offset: 0.45 },
        { width: `${mid2W}px`, borderRadius: `${targetR}px`, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', offset: 0.72 },
        { width: `${targetW}px`, borderRadius: `${targetR}px`, offset: 1 }
      ];

      btn._morphAnim = btn.animate(keyframes, { duration: 340, easing: 'linear' });
    }
  }

  function updatePlayPauseButton(isPlaying, isBuffering = false) {
    const actuallyPlaying = !!(isPlaying || (el.nativeAudio && !el.nativeAudio.paused && !el.nativeAudio.ended));
    const tvkBtn = document.getElementById('btn-tvk-play');
    const tvkPlayIcon = document.getElementById('tvk-play-icon');
    const tvkPauseIcon = document.getElementById('tvk-pause-icon');
    const tvkPlaySpinner = document.getElementById('tvk-play-spinner');
    if (tvkBtn) {
      if (isBuffering) {
        tvkBtn.classList.add('buffering');
        if (tvkPlaySpinner) tvkPlaySpinner.classList.remove('hidden');
        if (tvkPlayIcon) tvkPlayIcon.classList.add('hidden');
        if (tvkPauseIcon) tvkPauseIcon.classList.add('hidden');
      } else {
        tvkBtn.classList.remove('buffering');
        if (tvkPlaySpinner) tvkPlaySpinner.classList.add('hidden');
        if (tvkPlayIcon) tvkPlayIcon.classList.remove('hidden');
        if (tvkPauseIcon) tvkPauseIcon.classList.remove('hidden');
      }
    }
    if (isBuffering) {
      if (el.btnPlayPause) el.btnPlayPause.classList.add('buffering');
      if (el.playbarSpinner) el.playbarSpinner.classList.remove('hidden');
      if (el.playIcon) el.playIcon.classList.add('hidden');
      if (el.pauseIcon) el.pauseIcon.classList.add('hidden');
      setPlayPauseState(true, true);
    } else {
      if (el.btnPlayPause) el.btnPlayPause.classList.remove('buffering');
      if (el.playbarSpinner) el.playbarSpinner.classList.add('hidden');
      if (el.playIcon) el.playIcon.classList.remove('hidden');
      if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');
      setPlayPauseState(actuallyPlaying, true);
    }
  }

  setPlayPauseState(false, false);

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  if (el.btnResetVfx) {
    el.btnResetVfx.addEventListener('click', () => {
      state.vfx = { ...defaultVfx };
      localStorage.setItem('devsize_vfx', JSON.stringify(state.vfx));
      applyVisualEffects();
    });
  }

  if (window.electronAPI) {
    if (el.btnMinimize) el.btnMinimize.addEventListener('click', () => window.electronAPI.minimizeWindow());
    if (el.btnMaximize) el.btnMaximize.addEventListener('click', () => window.electronAPI.maximizeWindow());
    if (el.btnClose) el.btnClose.addEventListener('click', () => window.electronAPI.closeWindow());
  }

  if (el.navDiscover) el.navDiscover.addEventListener('click', () => switchView('discover'));
  if (el.navFavorites) el.navFavorites.addEventListener('click', () => switchView('favorites'));
  if (el.navAlbums) el.navAlbums.addEventListener('click', () => switchView('albums'));
  const navArtistsBtn = document.getElementById('nav-artists');
  if (navArtistsBtn) navArtistsBtn.addEventListener('click', () => switchView('artists'));
  if (el.navLocal) el.navLocal.addEventListener('click', () => switchView('local'));
  if (el.navHistory) el.navHistory.addEventListener('click', () => switchView('history'));
  if (el.navQueue) el.navQueue.addEventListener('click', () => switchView('queue'));
  if (el.navSettings) el.navSettings.addEventListener('click', () => switchView('settings'));

  if (el.btnAddLocalFiles) el.btnAddLocalFiles.addEventListener('click', () => importLocalFiles());
  // a whole folder (and its subfolders) at once: computers only, phones pick files
  const btnAddLocalFolder = document.getElementById('btn-add-local-folder');
  if (btnAddLocalFolder && !isPhoneApp && window.electronAPI && window.electronAPI.importAudioFiles) {
    btnAddLocalFolder.hidden = false;
    btnAddLocalFolder.addEventListener('click', () => importLocalFiles({ folder: true }));
  }
  if (el.btnAddLocalFilesEmpty) el.btnAddLocalFilesEmpty.addEventListener('click', () => importLocalFiles());

  if (el.btnAutoRemix) {
    el.btnAutoRemix.addEventListener('click', () => {
      state.isAutoRemix = !state.isAutoRemix;
      el.btnAutoRemix.classList.toggle('active', state.isAutoRemix);
    });
  }

  if (el.btnSavePresetDialog) {
    el.btnSavePresetDialog.addEventListener('click', () => {
      if (el.newPresetName) el.newPresetName.value = '';
      if (el.savePresetModal) openModal(el.savePresetModal);
      if (el.newPresetName) el.newPresetName.focus();
    });
  }

  if (el.btnCancelPreset) {
    el.btnCancelPreset.addEventListener('click', () => {
      if (el.savePresetModal) closeModal(el.savePresetModal);
    });
  }

  if (el.btnConfirmSavePreset) {
    el.btnConfirmSavePreset.addEventListener('click', () => {
      const name = el.newPresetName ? el.newPresetName.value : '';
      if (name.trim()) {
        saveCustomPreset(name);
        if (el.savePresetModal) closeModal(el.savePresetModal);
      }
    });
  }

  if (el.newPresetName) {
    el.newPresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmSavePreset) el.btnConfirmSavePreset.click();
      if (e.key === 'Escape' && el.btnCancelPreset) el.btnCancelPreset.click();
    });
  }

  if (el.btnCancelRenamePreset) {
    el.btnCancelRenamePreset.addEventListener('click', () => {
      if (el.renamePresetModal) closeModal(el.renamePresetModal);
    });
  }

  if (el.btnConfirmRenamePreset) {
    el.btnConfirmRenamePreset.addEventListener('click', () => {
      const name = el.renamePresetName ? el.renamePresetName.value : '';
      if (name.trim() && state.presetToRenameId) {
        renameCustomPreset(state.presetToRenameId, name);
        if (el.renamePresetModal) closeModal(el.renamePresetModal);
      }
    });
  }

  if (el.renamePresetName) {
    el.renamePresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmRenamePreset) el.btnConfirmRenamePreset.click();
      if (e.key === 'Escape' && el.btnCancelRenamePreset) el.btnCancelRenamePreset.click();
    });
  }

  const deletePresetModal = document.getElementById('delete-preset-modal');
  const btnCancelDeletePreset = document.getElementById('btn-cancel-delete-preset');
  const btnConfirmDeletePreset = document.getElementById('btn-confirm-delete-preset');

  if (btnCancelDeletePreset) {
    btnCancelDeletePreset.addEventListener('click', () => {
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  if (btnConfirmDeletePreset) {
    btnConfirmDeletePreset.addEventListener('click', () => {
      if (state.presetToDeleteId) {
        deleteCustomPreset(state.presetToDeleteId);
        state.presetToDeleteId = null;
      }
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  // Slide-over drawer: "Now playing" (cover + lyrics) and "Queue" tabs, closed by default.
  const btnToggleQueue = document.getElementById('btn-toggle-queue');
  const drawerTabs = document.querySelectorAll('.drawer-tab');
  function syncDrawerUI() {
    const open = state.isRightPanelOpen;
    if (open && !animationFrameId) { hasDrawnPausedFrame = false; startVisualizers(); }
    if (el.rightPanel) el.rightPanel.classList.toggle('hidden', !open);
    drawerTabs.forEach(t => t.classList.toggle('active', t.dataset.drawerTab === state.drawerTab));
    const now = document.getElementById('drawer-now');
    const queue = document.getElementById('drawer-queue');
    if (now) now.classList.toggle('hidden', state.drawerTab !== 'now');
    if (queue) queue.classList.toggle('hidden', state.drawerTab !== 'queue');
    if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.classList.toggle('active', open && state.drawerTab === 'now');
    if (btnToggleQueue) btnToggleQueue.classList.toggle('active', open && state.drawerTab === 'queue');
  }
  function openPanelDrawer(tab) {
    state.drawerTab = tab || state.drawerTab;
    state.isRightPanelOpen = true;
    if (state.drawerTab === 'queue') renderQueueView();
    syncDrawerUI();
    setTimeout(resizeCanvases, 150);
  }
  function closePanelDrawer() {
    state.isRightPanelOpen = false;
    syncDrawerUI();
  }
  function togglePanelDrawer(tab) {
    if (state.isRightPanelOpen && state.drawerTab === tab) closePanelDrawer(); else openPanelDrawer(tab);
  }
  if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.addEventListener('click', () => togglePanelDrawer('now'));
  if (btnToggleQueue) btnToggleQueue.addEventListener('click', () => togglePanelDrawer('queue'));
  if (el.btnCloseRightPanel) el.btnCloseRightPanel.addEventListener('click', closePanelDrawer);
  drawerTabs.forEach(t => t.addEventListener('click', () => openPanelDrawer(t.dataset.drawerTab)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.isRightPanelOpen && !document.querySelector('.modal-backdrop:not(.hidden)')) closePanelDrawer();
  });
  syncDrawerUI();

  (function initPanelResize() {
    const edge = document.getElementById('panel-resize-edge');
    const panel = el.rightPanel || document.getElementById('right-panel');
    if (!edge || !panel) return;

    const savedWidth = localStorage.getItem('muriel_right_panel_width');
    if (savedWidth) {
      const w = parseInt(savedWidth, 10);
      if (w >= 260 && w <= 720) {
        panel.style.width = `${w}px`;
        panel.style.setProperty('--right-panel-width', `${w}px`);
      }
    }

    let startX = 0;
    let startW = 0;
    let pendingW = 0;
    let raf = 0;

    const limits = () => ({ min: 260, max: Math.min(720, window.innerWidth - 300) });

    edge.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      edge.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      pendingW = Math.round(startW);
      edge.classList.add('dragging');
      document.body.classList.add('is-resizing-panel');
      e.preventDefault();
    });

    edge.addEventListener('pointermove', (e) => {
      if (!edge.hasPointerCapture(e.pointerId)) return;
      const { min, max } = limits();
      pendingW = Math.max(min, Math.min(max, Math.round(startW + (startX - e.clientX))));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          panel.style.width = `${pendingW}px`;
          panel.style.setProperty('--right-panel-width', `${pendingW}px`);
        });
      }
    });

    const stopDrag = (e) => {
      if (!edge.hasPointerCapture(e.pointerId)) return;
      try { edge.releasePointerCapture(e.pointerId); } catch (_) {}
      edge.classList.remove('dragging');
      document.body.classList.remove('is-resizing-panel');
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pendingW >= 260 && pendingW <= 720) {
        localStorage.setItem('muriel_right_panel_width', pendingW.toString());
      }
      if (typeof resizeCanvases === 'function') resizeCanvases();
    };

    edge.addEventListener('pointerup', stopDrag);
    edge.addEventListener('pointercancel', stopDrag);

    edge.addEventListener('dblclick', () => {
      panel.style.width = '340px';
      panel.style.setProperty('--right-panel-width', '340px');
      localStorage.setItem('muriel_right_panel_width', '340px');
      if (typeof resizeCanvases === 'function') resizeCanvases();
    });
  })();

  if (el.searchInput) {
    el.searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (window.MurielShare && window.MurielShare.payloadFrom(val)) { performSearch(val); return; }
      if (val && el.searchClearBtn) {
        el.searchClearBtn.classList.remove('hidden');
      } else if (el.searchClearBtn) {
        el.searchClearBtn.classList.add('hidden');
      }
      if (!val.trim()) {
        if (el.discoverEmpty) el.discoverEmpty.classList.remove('hidden');
        if (el.searchResultsContainer) el.searchResultsContainer.classList.add('hidden');
        const artistCardContainer = document.getElementById('search-artist-card-container');
        if (artistCardContainer) artistCardContainer.innerHTML = '';
        if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
      }
    });

    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = el.searchInput.value.trim();
        if (val) performSearch(val);
      } else if (e.key === 'Escape') {
        el.searchInput.value = '';
        if (el.searchClearBtn) el.searchClearBtn.classList.add('hidden');
        if (el.discoverEmpty) el.discoverEmpty.classList.remove('hidden');
        if (el.searchResultsContainer) el.searchResultsContainer.classList.add('hidden');
        const artistCardContainer = document.getElementById('search-artist-card-container');
        if (artistCardContainer) artistCardContainer.innerHTML = '';
        if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
      }
    });
  }

  if (el.searchIconBtn) {
    el.searchIconBtn.addEventListener('click', () => {
      const val = el.searchInput ? el.searchInput.value.trim() : '';
      if (val) performSearch(val);
    });
  }

  if (el.searchClearBtn) {
    el.searchClearBtn.addEventListener('click', () => {
      if (el.searchInput) el.searchInput.value = '';
      el.searchClearBtn.classList.add('hidden');
      if (el.discoverEmpty) el.discoverEmpty.classList.remove('hidden');
      if (el.searchResultsContainer) el.searchResultsContainer.classList.add('hidden');
      const artistCardContainer = document.getElementById('search-artist-card-container');
      if (artistCardContainer) artistCardContainer.innerHTML = '';
      if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
    });
  }


  function setPlatform(platform, triggerSearch = true) {
    if (!['youtube', 'ytmusic', 'soundcloud'].includes(platform)) platform = 'youtube';
    state.platform = platform;
    localStorage.setItem('muriel_platform', platform);

    if (el.platformYt) el.platformYt.classList.toggle('active', platform === 'youtube');
    if (el.platformYtm) el.platformYtm.classList.toggle('active', platform === 'ytmusic');
    if (el.platformSc) el.platformSc.classList.toggle('active', platform === 'soundcloud');

    const select = document.getElementById('select-engine-api');
    if (select) select.value = platform;
    const label = document.getElementById('engine-api-label');
    const nameMap = { youtube: 'YouTube', ytmusic: 'YouTube Music', soundcloud: 'SoundCloud' };
    if (label) label.textContent = nameMap[platform] || 'YouTube';
    const menu = document.getElementById('engine-api-menu');
    if (menu) {
      menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === platform);
      });
    }

    if (triggerSearch && el.searchInput && el.searchInput.value.trim()) {
      performSearch(el.searchInput.value);
    }
  }

  const savedPlatform = localStorage.getItem('muriel_platform') || 'youtube';
  setPlatform(savedPlatform, false);

  if (el.platformYt) el.platformYt.addEventListener('click', () => setPlatform('youtube'));
  if (el.platformYtm) el.platformYtm.addEventListener('click', () => setPlatform('ytmusic'));
  if (el.platformSc) el.platformSc.addEventListener('click', () => setPlatform('soundcloud'));

  const engineApiDropdown = document.getElementById('engine-api-dropdown');
  const engineApiTrigger = document.getElementById('engine-api-trigger');
  const engineApiMenu = document.getElementById('engine-api-menu');
  if (engineApiDropdown && engineApiTrigger && engineApiMenu) {
    engineApiTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      engineApiDropdown.classList.toggle('open');
    });

    engineApiMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        setPlatform(val);
        engineApiDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      engineApiDropdown.classList.remove('open');
    });
  }

  function updateEngineWidthVar() {
    const container = document.querySelector('.platform-switch-container');
    if (!container) return;
    const isHidden = document.body.classList.contains('hide-engine-btns');
    if (isHidden) {
      document.documentElement.style.setProperty('--engine-w', '0px');
      document.documentElement.style.setProperty('--engine-gap', '0px');
    } else {
      const isCompact = document.body.classList.contains('compact-engine-btns');
      const w = isCompact ? 124 : (container.offsetWidth || 435);
      if (w > 0) {
        document.documentElement.style.setProperty('--engine-w', `${w}px`);
        document.documentElement.style.setProperty('--engine-gap', '16px');
      }
    }
  }

  const btnCompactEngineBtns = document.getElementById('btn-compact-engine-btns');
  const isCompactEngine = localStorage.getItem('muriel_compact_engine_btns') === '1';
  document.body.classList.toggle('compact-engine-btns', isCompactEngine);
  if (btnCompactEngineBtns) {
    btnCompactEngineBtns.classList.toggle('active', isCompactEngine);
    btnCompactEngineBtns.addEventListener('click', () => {
      const next = !btnCompactEngineBtns.classList.contains('active');
      btnCompactEngineBtns.classList.toggle('active', next);
      document.body.classList.toggle('compact-engine-btns', next);
      localStorage.setItem('muriel_compact_engine_btns', next ? '1' : '0');
      updateEngineWidthVar();
      setTimeout(updateEngineWidthVar, 350);
    });
  }

  const btnHideEngineBtns = document.getElementById('btn-hide-engine-btns');
  const isHideEngine = localStorage.getItem('muriel_hide_engine_btns') === '1';
  document.body.classList.toggle('hide-engine-btns', isHideEngine);
  if (btnHideEngineBtns) {
    btnHideEngineBtns.classList.toggle('active', isHideEngine);
    btnHideEngineBtns.addEventListener('click', () => {
      const next = !btnHideEngineBtns.classList.contains('active');
      btnHideEngineBtns.classList.toggle('active', next);
      document.body.classList.toggle('hide-engine-btns', next);
      localStorage.setItem('muriel_hide_engine_btns', next ? '1' : '0');
      updateEngineWidthVar();
      setTimeout(updateEngineWidthVar, 350);
    });
  }

  const btnPersistSound = document.getElementById('btn-persist-sound-settings');
  if (btnPersistSound) {
    btnPersistSound.classList.toggle('active', soundPersistenceEnabled);
    btnPersistSound.addEventListener('click', () => {
      const next = !btnPersistSound.classList.contains('active');
      btnPersistSound.classList.toggle('active', next);
      soundPersistenceEnabled = next;
      localStorage.setItem('muriel_persist_sound_settings', next ? '1' : '0');
      if (next) persistSoundSettings();
    });
  }

  if (el.btnPlayPause) el.btnPlayPause.addEventListener('click', togglePlayPause);
  if (el.btnNext) el.btnNext.addEventListener('click', playNext);
  if (el.btnPrev) el.btnPrev.addEventListener('click', playPrev);

  function setShuffle(on) {
    state.isShuffle = !!on;
    localStorage.setItem('muriel_shuffle', state.isShuffle ? '1' : '0');
    if (el.btnShuffle) el.btnShuffle.classList.toggle('active', state.isShuffle);
    if (el.btnTvkShuffle) {
      el.btnTvkShuffle.classList.toggle('active', state.isShuffle);
      el.btnTvkShuffle.setAttribute('aria-pressed', String(state.isShuffle));
    }
    window.dispatchEvent(new Event('muriel:modes')); // the phone's lock-screen / Dynamic Island buttons follow
  }
  if (el.btnShuffle) {
    el.btnShuffle.classList.toggle('active', state.isShuffle);
    el.btnShuffle.addEventListener('click', () => setShuffle(!state.isShuffle));
  }
  if (el.btnTvkShuffle) {
    el.btnTvkShuffle.classList.toggle('active', state.isShuffle);
    el.btnTvkShuffle.setAttribute('aria-pressed', String(state.isShuffle));
    el.btnTvkShuffle.addEventListener('click', () => setShuffle(!state.isShuffle));
  }

  // one tap repeats the playlist, the next one the song (the icon gets a 1), the third turns repeat off
  const REPEAT_TITLES = { off: 'Repeat', all: 'Repeat: playlist', one: 'Repeat: this song' };
  function setRepeatMode(mode) {
    state.repeatMode = REPEAT_TITLES[mode] ? mode : 'off';
    state.isRepeat = state.repeatMode === 'one';
    localStorage.setItem('muriel_repeat', ({ off: '0', all: 'all', one: '1' })[state.repeatMode]);
    if (el.btnRepeat) {
      el.btnRepeat.classList.toggle('active', state.repeatMode !== 'off');
      el.btnRepeat.classList.toggle('repeat-one', state.isRepeat);
      el.btnRepeat.title = T(REPEAT_TITLES[state.repeatMode]);
      el.btnRepeat.setAttribute('aria-label', T(REPEAT_TITLES[state.repeatMode]));
    }
    if (el.btnTvkRepeat) {
      el.btnTvkRepeat.classList.toggle('active', state.repeatMode !== 'off');
      el.btnTvkRepeat.classList.toggle('repeat-one', state.isRepeat);
      el.btnTvkRepeat.title = T(REPEAT_TITLES[state.repeatMode]);
      el.btnTvkRepeat.setAttribute('aria-label', T(REPEAT_TITLES[state.repeatMode]));
      el.btnTvkRepeat.setAttribute('aria-pressed', String(state.repeatMode !== 'off'));
    }
    window.dispatchEvent(new Event('muriel:modes'));
  }
  setRepeatMode(state.repeatMode);
  if (el.btnRepeat) {
    el.btnRepeat.addEventListener('click', () => setRepeatMode(({ off: 'all', all: 'one', one: 'off' })[state.repeatMode]));
  }
  if (el.btnTvkRepeat) {
    el.btnTvkRepeat.addEventListener('click', () => setRepeatMode(({ off: 'all', all: 'one', one: 'off' })[state.repeatMode]));
  }

  window.toggleShuffle = () => el.btnShuffle && el.btnShuffle.click();
  window.toggleRepeat = () => el.btnRepeat && el.btnRepeat.click();

  function persistVolumeState() {
    try {
      localStorage.setItem('muriel_volume', String(state.volume));
      localStorage.setItem('muriel_muted', state.isMuted ? '1' : '0');
    } catch (e) {}
  }

  function syncVolumeControls() {
    if (el.volumeSlider) el.volumeSlider.value = String(state.volume);
    if (el.tvkVolumeSlider) el.tvkVolumeSlider.value = String(state.volume);
    if (el.volumeIcon) el.volumeIcon.classList.toggle('hidden', state.isMuted);
    if (el.volumeMutedIcon) el.volumeMutedIcon.classList.toggle('hidden', !state.isMuted);
  }

  function setVolumeFromSlider(slider) {
    const value = Number(slider && slider.value);
    if (!Number.isFinite(value)) return;
    state.volume = Math.max(0, Math.min(1, value));
    state.isMuted = false;
    syncVolumeControls();
    persistVolumeState();
    applyAudioSettings();
  }

  syncVolumeControls();
  if (el.volumeSlider) {
    el.volumeSlider.addEventListener('input', (e) => setVolumeFromSlider(e.currentTarget));
  }
  if (el.tvkVolumeSlider) {
    el.tvkVolumeSlider.addEventListener('input', (e) => setVolumeFromSlider(e.currentTarget));
  }

  if (el.btnVolumeMute) {
    el.btnVolumeMute.addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      syncVolumeControls();
      persistVolumeState();
      applyAudioSettings();
    });
  }

  if (el.btnToggleFav) {
    el.btnToggleFav.addEventListener('click', () => {
      if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
    });
  }

  if (el.btnClearHistory) {
    el.btnClearHistory.addEventListener('click', () => {
      state.history = [];
      localStorage.setItem('devsize_history', '[]');
      renderHistoryView();
    });
  }

  if (el.btnClearQueue) {
    el.btnClearQueue.addEventListener('click', () => {
      state.queue = [];
      state.queueIndex = -1;
      state.queueHistory = [];
      updateQueueBadge();
      renderQueueView();
    });
  }

  if (el.playlistSearchInput) {
    el.playlistSearchInput.addEventListener('input', () => {
      if (state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
    });
  }
  if (el.btnBackPlaylists) el.btnBackPlaylists.addEventListener('click', () => switchView('discover'));

  const deletePlaylistModal = document.getElementById('delete-playlist-modal');
  const deletePlaylistMsg = document.getElementById('delete-playlist-msg');
  const btnCancelDeletePlaylist = document.getElementById('btn-cancel-delete-playlist');
  const btnConfirmDeletePlaylist = document.getElementById('btn-confirm-delete-playlist');

  if (el.btnDeletePlaylist) {
    el.btnDeletePlaylist.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl) return;
      if (deletePlaylistMsg) I18N.text(deletePlaylistMsg, 'Delete playlist "{0}"? This action cannot be undone.', pl.name);
      if (deletePlaylistModal) openModal(deletePlaylistModal);
    });
  }

  if (btnCancelDeletePlaylist && deletePlaylistModal) {
    btnCancelDeletePlaylist.addEventListener('click', () => {
      closeModal(deletePlaylistModal);
    });
  }

  if (btnConfirmDeletePlaylist && deletePlaylistModal) {
    btnConfirmDeletePlaylist.addEventListener('click', () => {
      deleteCurrentPlaylist();
      closeModal(deletePlaylistModal);
      showToast(Tm('Playlist deleted'));
    });
  }



  // "Or import one" (the service buttons under Create) only when making an empty playlist
  const showCreateImportBar = (on) => { const bar = el.createPlaylistModal && el.createPlaylistModal.querySelector('.cpm-import-bar'); if (bar) bar.classList.toggle('hidden', !on); };

  if (el.btnNewPlaylist) {
    el.btnNewPlaylist.addEventListener('click', () => {
      tracksForNewPlaylist = null;
      if (el.newPlaylistInput) el.newPlaylistInput.value = '';
      showCreateImportBar(true);
      if (el.createPlaylistModal) openModal(el.createPlaylistModal);
      if (el.newPlaylistInput) el.newPlaylistInput.focus();
    });
  }

  if (el.btnCancelNewPlaylist) {
    el.btnCancelNewPlaylist.addEventListener('click', () => {
      tracksForNewPlaylist = null;
      if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
    });
  }

  if (el.btnConfirmNewPlaylist) {
    el.btnConfirmNewPlaylist.addEventListener('click', () => {
      const name = el.newPlaylistInput ? el.newPlaylistInput.value : '';
      if (!name.trim()) return;
      const pending = tracksForNewPlaylist;
      tracksForNewPlaylist = null;
      if (pending && pending.length) {
        // made from the add dialog: put the song(s) in and stay where the user was
        const seen = new Set();
        const pl = createPlaylist(name, pending.filter(t => t && t.id && !seen.has(t.id) && seen.add(t.id)), '', { open: false });
        if (pl) showToast(pl.tracks.length === 1 ? Tm('Added to "{0}"', pl.name) : Tm('Added {0} tracks to "{1}"', pl.tracks.length, pl.name), 'success');
      } else {
        createPlaylist(name);
      }
      if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
    });
  }

  if (el.newPlaylistInput) {
    el.newPlaylistInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmNewPlaylist) el.btnConfirmNewPlaylist.click();
      if (e.key === 'Escape' && el.btnCancelNewPlaylist) el.btnCancelNewPlaylist.click();
    });
  }

  if (el.btnCancelAddPlaylist) {
    el.btnCancelAddPlaylist.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
    });
  }

  const btnCloseAddPlaylist = document.getElementById('btn-close-add-playlist-modal');
  if (btnCloseAddPlaylist) {
    btnCloseAddPlaylist.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
    });
  }

  const btnCreatePlFromAdd = document.getElementById('btn-create-pl-from-add-modal');
  if (btnCreatePlFromAdd) {
    btnCreatePlFromAdd.addEventListener('click', () => {
      tracksForNewPlaylist = manyToAddToPlaylist ? manyToAddToPlaylist.slice() : (trackToAddToPlaylist ? [trackToAddToPlaylist] : null);
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
      if (el.createPlaylistModal) {
        if (el.newPlaylistInput) el.newPlaylistInput.value = '';
        showCreateImportBar(false);
        openModal(el.createPlaylistModal);
        if (el.newPlaylistInput) el.newPlaylistInput.focus();
      }
    });
  }

  document.querySelectorAll('.audio-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.audio-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.audio-panel').forEach((p) => p.classList.toggle('active', p.dataset.audioPanel === tab.dataset.audioTab));
    });
  });

  if (el.btnOpenSettings) {
    el.btnOpenSettings.addEventListener('click', () => {
      const tempoTab = document.querySelector('.audio-tab[data-audio-tab="tempo"]') || document.querySelector('.audio-tab');
      if (tempoTab) tempoTab.click();
      if (el.audioSettingsModal) openModal(el.audioSettingsModal);
      refreshStacks();
    });
  }

  if (el.btnCloseSettings) {
    el.btnCloseSettings.addEventListener('click', () => {
      if (el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  if (el.audioSettingsModal) {
    el.audioSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  if (el.btnOpenVisualSettings) {
    el.btnOpenVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) openModal(el.visualSettingsModal);
    });
  }

  if (el.btnCloseVisualSettings) {
    el.btnCloseVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.visualSettingsModal) {
    el.visualSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.btnToggleHqAudio) {
    el.btnToggleHqAudio.addEventListener('click', () => {
      state.hqEnabled = !state.hqEnabled;
      el.btnToggleHqAudio.classList.toggle('active', state.hqEnabled);
      
      if (el.hqPanelWrapper) {
        el.hqPanelWrapper.classList.toggle('expanded', state.hqEnabled);
        if (el.hqEnhancerCard) el.hqEnhancerCard.classList.toggle('is-expanded', state.hqEnabled);
      }
      initAudioContext();
      updateHqRouting();
      persistSoundSettings();
    });
  }

  if (el.hqPresetChips) {
    el.hqPresetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        el.hqPresetChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.hqSettings.preset = chip.dataset.preset;

        let v = 0, a = 0, b = 0;
        if (state.hqSettings.preset === 'studio') { v = 0; a = 0; b = 0; }
        else if (state.hqSettings.preset === 'vinyl') { v = 15; a = -15; b = 25; }
        else if (state.hqSettings.preset === 'concert') { v = -10; a = 30; b = 15; }

        if (el.sliderHqVocal) { el.sliderHqVocal.value = v; el.valHqVocal.textContent = (v > 0 ? '+' : '') + v + '%'; state.hqSettings.vocal = v; }
        if (el.sliderHqAir) { el.sliderHqAir.value = a; el.valHqAir.textContent = (a > 0 ? '+' : '') + a + '%'; state.hqSettings.air = a; }
        if (el.sliderHqBass) { el.sliderHqBass.value = b; el.valHqBass.textContent = (b > 0 ? '+' : '') + b + '%'; state.hqSettings.bass = b; }

        applyHqSettings();
      });
    });
  }

  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    const valDisplay = el[`valHq${type}`];
    if (slider) {
      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (valDisplay) valDisplay.textContent = (val > 0 ? '+' : '') + val + '%';
        state.hqSettings[type.toLowerCase()] = val;
        if (el.hqPresetChips) el.hqPresetChips.forEach(c => c.classList.remove('active'));
        applyHqSettings();
      });
    }
  });

  if (el.hqEngineSelect) {
    el.hqEngineSelect.addEventListener('change', (e) => {
      state.hqSettings.engine = e.target.value;
      applyHqSettings();
    });
  }

  const hqDropdown = document.getElementById('hq-engine-dropdown');
  const hqTrigger = document.getElementById('hq-engine-trigger');
  const hqLabel = document.getElementById('hq-engine-label');
  const hqMenu = document.getElementById('hq-engine-menu');

  if (hqTrigger && hqDropdown && hqMenu) {
    hqTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      hqDropdown.classList.toggle('open');
    });

    hqMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (hqLabel) hqLabel.textContent = opt.textContent;
        hqMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (el.hqEngineSelect) {
          el.hqEngineSelect.value = val;
          el.hqEngineSelect.dispatchEvent(new Event('change'));
        }
        hqDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      hqDropdown.classList.remove('open');
    });
  }

  if (el.sliderSpeed) {
    el.sliderSpeed.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      setTempoValues({ speed: val, speedPitch: 1.0 });
      if (el.sliderSpeedPitch) el.sliderSpeedPitch.value = 1.0;
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = '1.00x';
      if (el.valSpeed) el.valSpeed.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderSpeedPitch) {
    el.sliderSpeedPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseFloat(e.target.value);
      setTempoValues({ speedPitch: val, speed: 1.0 });
      if (el.sliderSpeed) el.sliderSpeed.value = 1.0;
      if (el.valSpeed) el.valSpeed.textContent = '1.00x';
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderPitch) {
    el.sliderPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      setTempoValues({ pitch: val });
      if (el.valPitch) el.valPitch.textContent = `${val > 0 ? '+' : ''}${val} st`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderReverb) {
    el.sliderReverb.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.reverb = val;
      if (el.valReverb) el.valReverb.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderDistortion) {
    el.sliderDistortion.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.distortion = val;
      if (el.valDistortion) el.valDistortion.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderGain) {
    el.sliderGain.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      setTempoValues({ volume: val / 100 });
      if (el.valGain) el.valGain.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderEcho) {
    el.sliderEcho.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.echo = val;
      if (el.valEcho) el.valEcho.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  ['low', 'mid', 'high'].forEach(band => {
    const cap = band.charAt(0).toUpperCase() + band.slice(1);
    const slider = el[`sliderEq${cap}`];
    const valEl = el[`valEq${cap}`];
    if (slider) {
      slider.addEventListener('input', (e) => {
        initAudioContext();
        const val = parseInt(e.target.value, 10);
        if (!state.audioSettings.eq) state.audioSettings.eq = { low: 0, mid: 0, high: 0 };
        state.audioSettings.eq[band] = val;
        if (valEl) valEl.textContent = `${val > 0 ? '+' : ''}${val} dB`;
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });
      slider.addEventListener('dblclick', () => {
        initAudioContext();
        slider.value = 0;
        if (!state.audioSettings.eq) state.audioSettings.eq = { low: 0, mid: 0, high: 0 };
        state.audioSettings.eq[band] = 0;
        if (valEl) valEl.textContent = '0 dB';
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });
    }
  });

  function init10BandEqUI() {
    if (!el.eqBands) return;

    el.eqBands.innerHTML = '';
    const currentBands = state.audioSettings.eqBands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    EQ_BAND_LABELS.forEach((freqLabel, i) => {
      const col = document.createElement('div');
      col.className = 'eq-band';

      const valSpan = document.createElement('span');
      valSpan.className = 'eq-band-val';
      const initialVal = currentBands[i] !== undefined ? currentBands[i] : 0;
      valSpan.textContent = `${initialVal > 0 ? '+' : ''}${initialVal} dB`;

      const sliderBox = document.createElement('div');
      sliderBox.className = 'eq-slider-box';

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'eq-band-range';
      input.min = '-12';
      input.max = '12';
      input.step = '1';
      input.value = String(initialVal);
      sliderBox.appendChild(input);

      const freqSpan = document.createElement('span');
      freqSpan.className = 'eq-band-freq';
      freqSpan.textContent = freqLabel;

      input.addEventListener('input', (e) => {
        initAudioContext();
        const val = parseInt(e.target.value, 10);
        if (!Array.isArray(state.audioSettings.eqBands)) {
          state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        state.audioSettings.eqBands[i] = val;
        valSpan.textContent = `${val > 0 ? '+' : ''}${val} dB`;
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });

      input.addEventListener('dblclick', () => {
        initAudioContext();
        input.value = '0';
        if (!Array.isArray(state.audioSettings.eqBands)) {
          state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        state.audioSettings.eqBands[i] = 0;
        valSpan.textContent = '0 dB';
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });

      col.appendChild(valSpan);
      col.appendChild(sliderBox);
      col.appendChild(freqSpan);
      el.eqBands.appendChild(col);
    });

    if (el.btnResetEqBands) {
      el.btnResetEqBands.addEventListener('click', () => {
        initAudioContext();
        state.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const inputs = el.eqBands.querySelectorAll('.eq-band-range');
        const valLabels = el.eqBands.querySelectorAll('.eq-band-val');
        inputs.forEach((input, i) => {
          input.value = '0';
          if (valLabels[i]) valLabels[i].textContent = '0 dB';
        });
        state.activePresetId = null;
        applyAudioSettings();
        renderPresets();
      });
    }
  }

  init10BandEqUI();

  if (el.themeModeBtns) {
    el.themeModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        state.themeMode = btn.dataset.themeMode;
        localStorage.setItem('muriel_theme_mode', state.themeMode);
        updateThemeFromState();
      });
    });
  }

  if (el.themeSwatches) {
    el.themeSwatches.forEach(sw => {
      sw.addEventListener('click', () => {
        state.themeAccent = sw.dataset.color;
        localStorage.setItem('muriel_theme_accent', state.themeAccent);
        if (state.themeMode === 'auto') {
          const targetMode = currentEffectiveMode || 'dark';
          state.themeMode = targetMode;
          localStorage.setItem('muriel_theme_mode', targetMode);
        }
        updateThemeFromState();
      });
    });
  }

  if (el.customColorInput) {
    // on change too, not only input: some color pickers send only change, so the color was never saved (Riff 43.1)
    const applyCustomAccent = (e) => {
      if (!/^#[0-9a-f]{6}$/i.test(e.target.value || '')) return;
      state.themeAccent = e.target.value.toLowerCase();
      localStorage.setItem('muriel_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('muriel_theme_mode', targetMode);
      }
      updateThemeFromState();
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    };
    el.customColorInput.addEventListener('input', applyCustomAccent);
    el.customColorInput.addEventListener('change', applyCustomAccent);
  }

  if (el.sliderHue) {
    el.sliderHue.addEventListener('input', (e) => {
      const h = parseInt(e.target.value, 10);
      if (el.valHue) el.valHue.textContent = h + '°';
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    });
    el.sliderHue.addEventListener('change', (e) => {
      const h = parseInt(e.target.value, 10);
      if (el.valHue) el.valHue.textContent = h + '°';
      state.themeAccent = hslToHex(h, 55, 50);
      localStorage.setItem('muriel_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('muriel_theme_mode', targetMode);
      }
      updateThemeFromState();
      if (el.themeSwatches) el.themeSwatches.forEach(sw => sw.classList.remove('active'));
    });
  }

  if (el.sliderIntensity) {
    el.sliderIntensity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valIntensity) el.valIntensity.textContent = val + '%';
    });
    el.sliderIntensity.addEventListener('change', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeIntensity = val;
      document.body.classList.toggle('intensity-zero', state.themeIntensity < 8);
      if (el.valIntensity) el.valIntensity.textContent = val + '%';
      localStorage.setItem('muriel_theme_intensity', val.toString());
      updateThemeFromState();
    });
  }
  if (el.sliderBrightness) {
    el.sliderBrightness.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valBrightness) el.valBrightness.textContent = val + '%';
    });
    el.sliderBrightness.addEventListener('change', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeBrightness = val;
      if (el.valBrightness) el.valBrightness.textContent = val + '%';
      localStorage.setItem('muriel_theme_brightness', val.toString());
      updateThemeFromState();
    });
  }

  if (el.sliderScale) {
    el.sliderScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
    });
    el.sliderScale.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
      localStorage.setItem('devsize_ui_scale', val.toString());
      requestAnimationFrame(() => {
        applyScale(val);
        requestAnimationFrame(resizeCanvases);
      });
    });
  }

  if (el.sliderFontScale) {
    el.sliderFontScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valFontScale) el.valFontScale.textContent = `${val}%`;
      document.documentElement.style.setProperty('--font-scale', ((val / 100) * 0.95 * 1.25).toString());
      localStorage.setItem('muriel_font_scale', val.toString());
      requestAnimationFrame(updateEngineWidthVar);
    });
  }

  const fontOptGoogle = document.getElementById('font-opt-google');
  const fontOptSf = document.getElementById('font-opt-sf');
  const fontOptSystem = document.getElementById('font-opt-system');

  [
    { btn: fontOptGoogle, key: 'google' },
    { btn: fontOptSf, key: 'sf' },
    { btn: fontOptSystem, key: 'system' }
  ].forEach(({ btn, key }) => {
    if (btn) {
      btn.addEventListener('click', () => {
        localStorage.setItem('muriel_font', key);
        applyFont(key);
      });
    }
  });
  applyFont(state.riffFont);

  function applySearchPos(pos) {
    if (!['left', 'middle', 'right'].includes(pos)) pos = 'middle';
    const topNav = document.querySelector('.top-nav');
    if (topNav) {
      topNav.classList.remove('search-pos-left', 'search-pos-middle', 'search-pos-right');
      topNav.classList.add(`search-pos-${pos}`);
    }
    const select = document.getElementById('select-search-pos');
    if (select) select.value = pos;
    const label = document.getElementById('search-pos-label');
    if (label) label.textContent = pos.charAt(0).toUpperCase() + pos.slice(1);
    const menu = document.getElementById('search-pos-menu');
    if (menu) {
      menu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === pos);
      });
    }
  }

  const savedSearchPos = localStorage.getItem('muriel_search_pos') || 'middle';
  applySearchPos(savedSearchPos);

  const searchPosDropdown = document.getElementById('search-pos-dropdown');
  const searchPosTrigger = document.getElementById('search-pos-trigger');
  const searchPosMenu = document.getElementById('search-pos-menu');
  if (searchPosDropdown && searchPosTrigger && searchPosMenu) {
    searchPosTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      searchPosDropdown.classList.toggle('open');
    });

    searchPosMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('muriel_search_pos', val);
        applySearchPos(val);
        searchPosDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      searchPosDropdown.classList.remove('open');
    });
  }

  let navResizeTimer = null;
  window.addEventListener('resize', () => {
    document.body.classList.add('is-window-resizing');
    clearTimeout(navResizeTimer);
    navResizeTimer = setTimeout(() => {
      document.body.classList.remove('is-window-resizing');
      updateEngineWidthVar();
    }, 120);
  });

  setTimeout(() => {
    updateEngineWidthVar();
    document.body.classList.remove('no-nav-transition');
  }, 50);

  if (el.sliderCornerRadius) {
    el.sliderCornerRadius.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valCornerRadius) el.valCornerRadius.textContent = val === 16 ? 'Default' : `${val}px`;
      document.documentElement.style.setProperty('--md-shape-corner-l', `${val}px`);
      document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, val - 4)}px`);
      localStorage.setItem('muriel_corner_radius', val.toString());
    });
  }

  if (el.sliderUiAlpha) {
    el.sliderUiAlpha.addEventListener('input', (e) => {
      const val = Math.max(20, Math.min(100, parseInt(e.target.value, 10) || 100));
      if (el.valUiAlpha) el.valUiAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--ui-alpha', `${val}%`);
      localStorage.setItem('muriel_ui_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.btnResetUiAlpha) {
    el.btnResetUiAlpha.addEventListener('click', () => {
      const val = 100;
      if (el.sliderUiAlpha) el.sliderUiAlpha.value = val;
      if (el.valUiAlpha) el.valUiAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--ui-alpha', `${val}%`);
      localStorage.setItem('muriel_ui_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.sliderTextAlpha) {
    el.sliderTextAlpha.addEventListener('input', (e) => {
      const val = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 100));
      if (el.valTextAlpha) el.valTextAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--text-alpha', `${val}%`);
      localStorage.setItem('muriel_text_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  if (el.btnResetTextAlpha) {
    el.btnResetTextAlpha.addEventListener('click', () => {
      const val = 100;
      if (el.sliderTextAlpha) el.sliderTextAlpha.value = val;
      if (el.valTextAlpha) el.valTextAlpha.textContent = `${val}%`;
      document.documentElement.style.setProperty('--text-alpha', `${val}%`);
      localStorage.setItem('muriel_text_alpha', val.toString());
      refreshCachedThemeColors();
    });
  }

  const btnChooseBannerMedia = document.getElementById('btn-choose-banner-media');
  const btnResetBannerMedia = document.getElementById('btn-reset-banner-media');

  if (btnChooseBannerMedia) {
    btnChooseBannerMedia.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          localStorage.setItem('muriel_banner_media', url);
          const thumb = getTrackThumbUrl(state.currentTrack);
          updateRightPanelBanner(thumb);
          updatePlaylistDetailBanner(thumb);
        }
      }
    });
  }

  if (btnResetBannerMedia) {
    btnResetBannerMedia.addEventListener('click', () => {
      localStorage.removeItem('muriel_banner_media');
      const thumb = getTrackThumbUrl(state.currentTrack);
      updateRightPanelBanner(thumb);
      updatePlaylistDetailBanner(thumb);
    });
  }

  const sliderBannerBlur = document.getElementById('slider-banner-blur');
  const valBannerBlur = document.getElementById('val-banner-blur');
  if (sliderBannerBlur) {
    sliderBannerBlur.value = savedBannerBlur;
    if (valBannerBlur) valBannerBlur.textContent = `${savedBannerBlur}px`;
    sliderBannerBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-blur', `${v}px`);
      if (valBannerBlur) valBannerBlur.textContent = `${v}px`;
      localStorage.setItem('muriel_banner_blur', v.toString());
    });
  }

  const sliderBannerOpacity = document.getElementById('slider-banner-opacity');
  const valBannerOpacity = document.getElementById('val-banner-opacity');
  if (sliderBannerOpacity) {
    sliderBannerOpacity.value = savedBannerOpacity;
    if (valBannerOpacity) valBannerOpacity.textContent = `${savedBannerOpacity}%`;
    sliderBannerOpacity.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-opacity', `${v / 100}`);
      if (valBannerOpacity) valBannerOpacity.textContent = `${v}%`;
      localStorage.setItem('muriel_banner_opacity', v.toString());
    });
  }

  const sliderBannerFade = document.getElementById('slider-banner-fade');
  const valBannerFade = document.getElementById('val-banner-fade');
  if (sliderBannerFade) {
    sliderBannerFade.value = savedBannerFade;
    if (valBannerFade) valBannerFade.textContent = `${savedBannerFade}%`;
    sliderBannerFade.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-fade-base', `${v}%`);
      document.documentElement.style.setProperty('--banner-fade-end', `${v}%`);
      const rightBanner = document.getElementById('right-panel-banner');
      if (rightBanner) {
        rightBanner.style.setProperty('--banner-fade-base', `${v}%`);
        rightBanner.style.setProperty('--banner-fade-end', `${v}%`);
      }
      if (valBannerFade) valBannerFade.textContent = `${v}%`;
      localStorage.setItem('muriel_banner_fade', v.toString());
    });
  }

  function applyBannerFit(fit) {
    const root = document.documentElement;
    const val = fit || 'zoom';
    if (val === 'fit') {
      root.style.setProperty('--banner-fit', 'contain');
      root.style.setProperty('--banner-object-fit', 'contain');
      root.style.setProperty('--banner-scale', 'none');
    } else if (val === 'stretch') {
      root.style.setProperty('--banner-fit', '100% 100%');
      root.style.setProperty('--banner-object-fit', 'fill');
      root.style.setProperty('--banner-scale', 'none');
    } else {
      root.style.setProperty('--banner-fit', 'cover');
      root.style.setProperty('--banner-object-fit', 'cover');
      root.style.setProperty('--banner-scale', 'scale(1.06)');
    }
  }

  const selectBannerFit = document.getElementById('select-banner-fit');
  const bannerFitDropdown = document.getElementById('banner-fit-dropdown');
  const bannerFitTrigger = document.getElementById('banner-fit-trigger');
  const bannerFitLabel = document.getElementById('banner-fit-label');
  const bannerFitMenu = document.getElementById('banner-fit-menu');

  if (selectBannerFit) {
    selectBannerFit.value = savedBannerFit;
  }

  if (bannerFitDropdown && bannerFitTrigger && bannerFitMenu) {
    const curFit = savedBannerFit || 'zoom';
    if (bannerFitLabel) {
      bannerFitLabel.textContent = curFit.charAt(0).toUpperCase() + curFit.slice(1);
    }
    bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === curFit);
    });

    bannerFitTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      bannerFitDropdown.classList.toggle('open');
    });

    bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('muriel_banner_fit', val);
        applyBannerFit(val);
        if (bannerFitLabel) bannerFitLabel.textContent = opt.textContent;
        bannerFitMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (selectBannerFit) selectBannerFit.value = val;
        bannerFitDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      bannerFitDropdown.classList.remove('open');
    });
  }

  const btnChooseCustomBg = document.getElementById('btn-choose-custom-bg');
  const btnRemoveCustomBg = document.getElementById('btn-remove-custom-bg');
  const sliderBgOpacity = document.getElementById('slider-bg-opacity');
  const valBgOpacity = document.getElementById('val-bg-opacity');
  const sliderBgBlur = document.getElementById('slider-bg-blur');
  const valBgBlur = document.getElementById('val-bg-blur');

  function syncBgVideoPlayback() {
    const v = document.querySelector('#custom-bg video');
    if (!v) return;
    const hidden = document.hidden || document.body.classList.contains('perf');
    if (hidden) v.pause(); else v.play().catch(() => {});
  }
  document.addEventListener('visibilitychange', syncBgVideoPlayback);
  if (window.electronAPI && window.electronAPI.onWindowVisibility) window.electronAPI.onWindowVisibility(() => syncBgVideoPlayback());

  function updateCustomBg() {
    const bgUrl = localStorage.getItem('muriel_bg_url') || '';
    const opacityVal = parseInt(localStorage.getItem('muriel_bg_opacity') ?? '100', 10);
    let blurVal = parseInt(localStorage.getItem('muriel_bg_blur') ?? '0', 10);
    const isVideo = /\.(mp4|webm)($|\?)/i.test(bgUrl);
    document.body.classList.toggle('has-video-bg', isVideo && !!bgUrl);

    if (sliderBgOpacity) sliderBgOpacity.value = opacityVal;
    if (valBgOpacity) valBgOpacity.textContent = `${opacityVal}%`;
    if (sliderBgBlur) sliderBgBlur.value = blurVal;
    if (valBgBlur) valBgBlur.textContent = `${blurVal}px`;

    const customBg = document.getElementById('custom-bg');
    if (!customBg) return;

    if (!bgUrl) {
      document.body.classList.remove('glass-lite');
      customBg.innerHTML = '';
      customBg.style.display = 'none';
      if (btnRemoveCustomBg) btnRemoveCustomBg.disabled = true;
      syncBgVideoPlayback();
      return;
    }

    if (btnRemoveCustomBg) btnRemoveCustomBg.disabled = false;
    customBg.style.display = 'block';
    customBg.style.opacity = (opacityVal / 100).toString();
    customBg.style.filter = 'none';

    const currentMedia = customBg.firstElementChild;
    const tag = isVideo ? 'VIDEO' : 'IMG';

    if (!currentMedia || currentMedia.tagName !== tag || currentMedia.src !== bgUrl) {
      customBg.innerHTML = '';
      if (isVideo) {
        const vid = document.createElement('video');
        vid.src = bgUrl;
        vid.preload = 'auto';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        vid.disablePictureInPicture = true;
        vid.setAttribute('disableRemotePlayback', '');
        vid.addEventListener('loadedmetadata', () => {
          if (vid.videoWidth * vid.videoHeight > 1920 * 1080 * 1.2) {
            showToast(Tm('This background video is larger than 1080p and may stutter. A 1080p file plays smoother.'), 'info');
          }
        }, { once: true });
        vid.play().catch(() => {});
        customBg.appendChild(vid);
      } else {
        const img = document.createElement('img');
        img.src = bgUrl;
        customBg.appendChild(img);
      }
    }

    // Glass over a moving background would re-blur every panel on every frame (~170 MB GPU).
    // "glass-lite" instead blurs the background once and leaves the panels plain see-through.
    const animatedBg = /\.(gif|mp4|webm)($|\?)/i.test(bgUrl);
    const glassLite = animatedBg && getAdv('glass_blur', false);
    document.body.classList.toggle('glass-lite', glassLite);
    if (glassLite) blurVal = Math.max(blurVal, parseInt(localStorage.getItem('muriel_glass_blur') || '16', 10) || 16);

    const media = customBg.firstElementChild;
    if (media) {
      const q = blurVal > 0 ? 4 : 1;
      media.style.width = `${100 / q}%`;
      media.style.height = `${100 / q}%`;
      media.style.transformOrigin = '0 0';
      media.style.transform = q > 1 ? `scale(${q * 1.06}) translate(-3%, -3%)` : 'none';
      media.style.filter = blurVal > 0 ? `blur(${blurVal / q}px)` : 'none';
    }
    syncBgVideoPlayback();
  }

  function currentUiAlpha() { return Number(document.getElementById('slider-ui-alpha').value); }
  function setUiAlphaViaSlider(v) { const s = document.getElementById('slider-ui-alpha'); if (!s) return; s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
  function backgroundActive() { return !!localStorage.getItem('muriel_bg_url') || getAdv('cover_bg', true); }
  function onBackgroundChanged(kind, enabled) {
    if (!getAdv('ui_alpha_auto', true)) return;
    if (enabled) {
      const now = currentUiAlpha();
      if (now > 50) { localStorage.setItem('muriel_ui_alpha_prev', String(now)); setUiAlphaViaSlider(50); localStorage.setItem('muriel_ui_alpha_auto', '50'); localStorage.setItem('muriel_ui_alpha_auto_kind', kind); }
    } else {
      // undo when the background that dimmed the interface goes away. Checking "no background at all" never
      // passed with the cover background on (the default), so removing a custom one left the UI at 50%.
      const autoKind = localStorage.getItem('muriel_ui_alpha_auto_kind');
      if (autoKind ? autoKind !== kind : backgroundActive()) return;
      const auto = localStorage.getItem('muriel_ui_alpha_auto'), prev = localStorage.getItem('muriel_ui_alpha_prev');
      if (auto !== null && prev !== null && currentUiAlpha() === Number(auto)) setUiAlphaViaSlider(Number(prev));
      localStorage.removeItem('muriel_ui_alpha_auto'); localStorage.removeItem('muriel_ui_alpha_prev'); localStorage.removeItem('muriel_ui_alpha_auto_kind');
    }
  }

  if (btnChooseCustomBg) {
    btnChooseCustomBg.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          localStorage.setItem('muriel_bg_url', url);
          updateCustomBg();
          onBackgroundChanged('custom', true);
        }
      }
    });
  }

  if (btnRemoveCustomBg) {
    btnRemoveCustomBg.addEventListener('click', () => {
      localStorage.removeItem('muriel_bg_url');
      updateCustomBg();
      onBackgroundChanged('custom', false);
    });
  }

  if (sliderBgOpacity) {
    sliderBgOpacity.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valBgOpacity) valBgOpacity.textContent = `${v}%`;
      localStorage.setItem('muriel_bg_opacity', String(v));
      const customBg = document.getElementById('custom-bg');
      if (customBg) customBg.style.opacity = (v / 100).toString();
    });
  }

  if (sliderBgBlur) {
    sliderBgBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valBgBlur) valBgBlur.textContent = `${v}px`;
      localStorage.setItem('muriel_bg_blur', String(v));
      const customBg = document.getElementById('custom-bg');
      if (customBg) {
        customBg.style.filter = 'none';
        const media = customBg.firstElementChild;
        if (media) {
          const q = v > 0 ? 4 : 1;
          media.style.width = `${100 / q}%`;
          media.style.height = `${100 / q}%`;
          media.style.transformOrigin = '0 0';
          media.style.transform = q > 1 ? `scale(${q * 1.06}) translate(-3%, -3%)` : 'none';
          media.style.filter = v > 0 ? `blur(${v / q}px)` : 'none';
        }
      }
    });
  }

  updateCustomBg();

  const sliderCoverBgBrightness = document.getElementById('slider-cover-bg-brightness');
  const valCoverBgBrightness = document.getElementById('val-cover-bg-brightness');
  if (sliderCoverBgBrightness) {
    const savedBrightness = parseInt(localStorage.getItem('muriel_cover_bg_brightness') ?? '45', 10);
    sliderCoverBgBrightness.value = savedBrightness;
    if (valCoverBgBrightness) valCoverBgBrightness.textContent = `${savedBrightness}%`;
    document.documentElement.style.setProperty('--cover-bg-brightness', (savedBrightness / 100).toString());

    sliderCoverBgBrightness.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valCoverBgBrightness) valCoverBgBrightness.textContent = `${v}%`;
      localStorage.setItem('muriel_cover_bg_brightness', String(v));
      document.documentElement.style.setProperty('--cover-bg-brightness', (v / 100).toString());
    });
  }

  setCoverBg(state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '');

  registerFx(document.getElementById('home-ambient'), 'ambient', document.getElementById('view-discover'));
  registerFx(document.getElementById('playlist-hero-fx'), 'hero', document.getElementById('view-playlist-detail'));
  registerFx(document.getElementById('album-hero-fx'), 'hero', document.getElementById('view-album'));
  registerFx(document.getElementById('artist-hero-backdrop'), 'hero', document.getElementById('view-artist'));
  document.body.classList.toggle('no-clip-fx', !getAdv('clip_fx', false));
  applyFxClip();

  const sliderMeshBrightness = document.getElementById('slider-mesh-brightness');
  const valMeshBrightness = document.getElementById('val-mesh-brightness');
  if (sliderMeshBrightness) {
    sliderMeshBrightness.value = state.meshBrightness;
    if (valMeshBrightness) valMeshBrightness.textContent = `${state.meshBrightness}%`;
    sliderMeshBrightness.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valMeshBrightness) valMeshBrightness.textContent = `${v}%`;
    });
    sliderMeshBrightness.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      state.meshBrightness = v;
      if (valMeshBrightness) valMeshBrightness.textContent = `${v}%`;
      localStorage.setItem('muriel_mesh_brightness', v.toString());
      updateThemeFromState();
    });
  }

  const DEFAULT_MESH_CFG = {
    p1: { x: 20, y: 0 },
    p2: { x: 85, y: 5 },
    speed: 0,
    blur: 0
  };

  let meshCfg = { ...DEFAULT_MESH_CFG };
  try {
    const raw = localStorage.getItem('muriel_mesh_cfg');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.p1 && parsed.p2) {
        meshCfg = {
          p1: { x: Math.max(0, Math.min(100, Number(parsed.p1.x) ?? 20)), y: Math.max(0, Math.min(100, Number(parsed.p1.y) ?? 0)) },
          p2: { x: Math.max(0, Math.min(100, Number(parsed.p2.x) ?? 85)), y: Math.max(0, Math.min(100, Number(parsed.p2.y) ?? 5)) },
          speed: Math.max(0, Math.min(100, Number(parsed.speed) || 0)),
          blur: Math.max(0, Math.min(60, Number(parsed.blur) || 0))
        };
      }
    }
  } catch (_) {}

  function applyMeshCfg(cfg, save = true) {
    meshCfg = cfg;
    const root = document.documentElement;
    root.style.setProperty('--mesh-p1x', `${cfg.p1.x}%`);
    root.style.setProperty('--mesh-p1y', `${cfg.p1.y}%`);
    root.style.setProperty('--mesh-p2x', `${cfg.p2.x}%`);
    root.style.setProperty('--mesh-p2y', `${cfg.p2.y}%`);
    const speedDur = cfg.speed > 0 ? `${(120 / (cfg.speed * 0.2 + 1)).toFixed(1)}s` : '0s';
    root.style.setProperty('--mesh-speed', speedDur);
    root.style.setProperty('--mesh-blur', `${cfg.blur}px`);

    const d1 = document.getElementById('mesh-dot-1');
    const d2 = document.getElementById('mesh-dot-2');
    if (d1) {
      d1.style.left = `${cfg.p1.x}%`;
      d1.style.top = `${cfg.p1.y}%`;
    }
    if (d2) {
      d2.style.left = `${cfg.p2.x}%`;
      d2.style.top = `${cfg.p2.y}%`;
    }

    const slSpeed = document.getElementById('slider-mesh-speed');
    const vlSpeed = document.getElementById('val-mesh-speed');
    if (slSpeed) slSpeed.value = cfg.speed;
    if (vlSpeed) vlSpeed.textContent = cfg.speed === 0 ? '0 (static)' : `${cfg.speed}`;

    const slBlur = document.getElementById('slider-mesh-blur');
    const vlBlur = document.getElementById('val-mesh-blur');
    if (slBlur) slBlur.value = cfg.blur;
    if (vlBlur) vlBlur.textContent = `${cfg.blur}px`;

    if (save) {
      localStorage.setItem('muriel_mesh_cfg', JSON.stringify(cfg));
    }
  }

  applyMeshCfg(meshCfg, false);

  const btnConfigureMesh = document.getElementById('btn-configure-mesh');
  const meshModal = document.getElementById('mesh-customizer-modal');
  const btnCloseMeshModal = document.getElementById('btn-close-mesh-modal');
  const btnResetMesh = document.getElementById('btn-reset-mesh');
  const sliderMeshSpeed = document.getElementById('slider-mesh-speed');
  const sliderMeshBlur = document.getElementById('slider-mesh-blur');

  function openMeshModal() {
    if (!meshModal) return;
    const card = meshModal.querySelector('.settings-card') || meshModal;
    const previewBg = document.getElementById('mesh-preview-bg');
    const meshA = document.getElementById('bg-mesh-a');
    const meshB = document.getElementById('bg-mesh-b');
    const curBg = (activeMeshLayer === 'a' ? meshB : meshA)?.style.background || meshA?.style.background;
    if (previewBg && curBg) previewBg.style.background = curBg;

    applyMeshCfg(meshCfg, false);
    meshModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      meshModal.classList.add('visible');
      if (window.LiquidMotion) {
        LiquidMotion.open(card, btnConfigureMesh, 'y');
      }
    });
  }

  function closeMeshModal() {
    if (!meshModal) return;
    const card = meshModal.querySelector('.settings-card') || meshModal;
    if (window.LiquidMotion) {
      LiquidMotion.close(card, () => {
        meshModal.classList.remove('visible');
        meshModal.classList.add('hidden');
      });
    } else {
      closeModal(meshModal);
    }
  }

  if (btnConfigureMesh) btnConfigureMesh.addEventListener('click', openMeshModal);
  if (btnCloseMeshModal) btnCloseMeshModal.addEventListener('click', closeMeshModal);
  if (meshModal) {
    meshModal.addEventListener('click', (e) => {
      if (e.target === meshModal) closeMeshModal();
    });
  }

  if (sliderMeshSpeed) {
    sliderMeshSpeed.addEventListener('input', (e) => {
      meshCfg.speed = parseInt(e.target.value, 10);
      applyMeshCfg(meshCfg, true);
    });
  }

  if (sliderMeshBlur) {
    sliderMeshBlur.addEventListener('input', (e) => {
      meshCfg.blur = parseInt(e.target.value, 10);
      applyMeshCfg(meshCfg, true);
    });
  }

  if (btnResetMesh) {
    btnResetMesh.addEventListener('click', () => {
      applyMeshCfg({
        p1: { x: 20, y: 0 },
        p2: { x: 85, y: 5 },
        speed: 0,
        blur: 0
      }, true);
    });
  }

  const previewBox = document.getElementById('mesh-preview-box');
  const dot1 = document.getElementById('mesh-dot-1');
  const dot2 = document.getElementById('mesh-dot-2');

  function attachDotDrag(dotEl, key) {
    if (!dotEl || !previewBox) return;
    let isDragging = false;

    dotEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isDragging = true;
      dotEl.setPointerCapture(e.pointerId);
      dotEl.style.cursor = 'grabbing';
      dotEl.focus();
    });

    dotEl.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const rect = previewBox.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
      const y = Math.max(0, Math.min(100, Math.round(((e.clientY - rect.top) / rect.height) * 100)));
      meshCfg[key] = { x, y };
      applyMeshCfg(meshCfg, true);
    });

    const endDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        try { dotEl.releasePointerCapture(e.pointerId); } catch (_) {}
        dotEl.style.cursor = 'grab';
      }
    };
    dotEl.addEventListener('pointerup', endDrag);
    dotEl.addEventListener('pointercancel', endDrag);

    dotEl.addEventListener('keydown', (e) => {
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -1;
      else if (e.key === 'ArrowRight') dx = 1;
      else if (e.key === 'ArrowUp') dy = -1;
      else if (e.key === 'ArrowDown') dy = 1;
      else return;
      e.preventDefault();
      const cur = meshCfg[key];
      const x = Math.max(0, Math.min(100, cur.x + dx));
      const y = Math.max(0, Math.min(100, cur.y + dy));
      meshCfg[key] = { x, y };
      applyMeshCfg(meshCfg, true);
    });
  }

  attachDotDrag(dot1, 'p1');
  attachDotDrag(dot2, 'p2');

  const paletteDropdown = document.getElementById('palette-style-dropdown');
  const paletteTrigger = document.getElementById('palette-style-trigger');
  const paletteLabel = document.getElementById('palette-style-trigger-label');
  const paletteMenu = document.getElementById('palette-style-menu');
  if (paletteDropdown && paletteTrigger && paletteMenu) {
    const currentStyle = state.paletteStyle || 'classic';
    const styleObj = PALETTE_STYLES[currentStyle] || PALETTE_STYLES.classic;
    if (paletteLabel) paletteLabel.textContent = styleObj.label;
    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === currentStyle);
    });

    paletteTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      paletteDropdown.classList.toggle('open');
    });

    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        state.paletteStyle = val;
        localStorage.setItem('muriel_palette_style', state.paletteStyle);
        if (paletteLabel) paletteLabel.textContent = opt.textContent;
        paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        paletteDropdown.classList.remove('open');
        updateThemeFromState();
      });
    });

    document.addEventListener('click', () => {
      paletteDropdown.classList.remove('open');
    });
  }

  document.body.classList.toggle('no-blur', !getAdv('blur_fx', true));

  const sliderGlassBlur = document.getElementById('slider-glass-blur');
  const valGlassBlur = document.getElementById('val-glass-blur');
  function applyGlass() {
    const on = getAdv('glass_blur', false);
    const px = Math.max(4, Math.min(40, parseInt(localStorage.getItem('muriel_glass_blur') || '16', 10) || 16));
    document.body.classList.toggle('glass', on);
    document.documentElement.style.setProperty('--glass-blur', `${px}px`);
    if (sliderGlassBlur) sliderGlassBlur.value = px;
    if (valGlassBlur) valGlassBlur.textContent = `${px}px`;
    const strengthRow = document.getElementById('setting-glass-strength');
    if (strengthRow) strengthRow.classList.toggle('is-disabled', !on);
    updateCustomBg();
  }
  if (sliderGlassBlur) sliderGlassBlur.addEventListener('input', () => {
    localStorage.setItem('muriel_glass_blur', sliderGlassBlur.value);
    applyGlass();
  });
  applyGlass();

  const fpsBtns = document.querySelectorAll('[data-fps-cap]');
  const syncFpsBtns = () => {
    const cur = localStorage.getItem('muriel_fps_cap') || '0';
    fpsBtns.forEach(b => b.classList.toggle('active', b.dataset.fpsCap === cur));
  };
  fpsBtns.forEach(b => b.addEventListener('click', () => { localStorage.setItem('muriel_fps_cap', b.dataset.fpsCap); syncFpsBtns(); }));
  syncFpsBtns();

  const btnHwAccel = document.getElementById('btn-hw-accel');
  if (btnHwAccel && window.electronAPI && window.electronAPI.getHwAccel) {
    window.electronAPI.getHwAccel().then(on => btnHwAccel.classList.toggle('active', on !== false));
    btnHwAccel.addEventListener('click', () => {
      const next = !btnHwAccel.classList.contains('active');
      btnHwAccel.classList.toggle('active', next);
      window.electronAPI.setHwAccel(next);
      showToast(Tm('Restart Muriel to apply'), 'info');
    });
  }

  const advButtons = document.querySelectorAll('.effect-switch-btn[data-adv]');
  advButtons.forEach(btn => {
    const key = btn.dataset.adv;
    const defaultVal = key === 'reduce_motion' ? systemPrefersReducedMotion() : (key === 'mesh_gradient' || key === 'glass_blur' || key === 'mesh_cover_color' || key === 'clip_fx') ? false : true;
    const currentVal = getAdv(key, defaultVal);
    btn.classList.toggle('active', currentVal);

    btn.addEventListener('click', () => {
      const newVal = !btn.classList.contains('active');
      document.querySelectorAll(`.effect-switch-btn[data-adv="${key}"]`).forEach(b => b.classList.toggle('active', newVal));
      setAdv(key, newVal);

      if (key === 'reduce_motion') {
        applyReducedMotionSetting();
      } else if (key === 'glass_blur') {
        applyGlass();
        // glass over a fully opaque UI does nothing, so make it see-through the first time
        if (newVal && parseInt(localStorage.getItem('muriel_ui_alpha') || '20', 10) >= 100) {
          localStorage.setItem('muriel_ui_alpha', '60');
          applyUiOpacity();
          showToast(Tm('Interface opacity set to 60% so the glass shows'), 'info');
        }
      } else if (key === 'blur_fx') {
        document.body.classList.toggle('no-blur', !newVal);
      } else if (key === 'light_thumbs') {
        document.querySelectorAll('.track-row-thumb[data-full], .quick-play-pill-img[data-full]').forEach(img => { img.src = listThumb(img.dataset.full) || img.dataset.full; });
      } else if (key === 'mesh_gradient') {
        updateThemeFromState();
      } else if (key === 'mesh_follow_intensity') {
        lastMeshKey = '';
        if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
      } else if (key === 'mesh_cover_color') {
        refreshMeshCover();
        lastMeshKey = '';
        if (lastMeshArgs) updateMeshGradient(...lastMeshArgs);
      } else if (key === 'cover_bg') {
        const thumb = state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '';
        setCoverBg(thumb);
        if (typeof onBackgroundChanged === 'function') onBackgroundChanged('cover', newVal);
      } else if (key === 'clip_fx') {
        document.body.classList.toggle('no-clip-fx', !newVal);
        applyFxClip();
      } else if (key === 'albums') {
        if (!newVal && state.currentView === 'album') {
          const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
          switchView(target);
        }
      } else if (key === 'my_wave' || key === 'jump_back') {
        initHomeHero();
        if (newVal) loadHomePage();
      } else if (key === 'my_wave_ambient') {
        const homeAmb = document.getElementById('home-ambient');
        if (homeAmb) homeAmb.style.display = newVal ? '' : 'none';
        const ambientEl = document.getElementById('my-wave-ambient-light');
        if (ambientEl) ambientEl.style.display = newVal ? '' : 'none';
        const jumpAmbient = document.getElementById('jump-ambient-light');
        if (jumpAmbient) jumpAmbient.style.display = newVal ? '' : 'none';
      } else if (key === 'banners' || key === 'track_banners') {
        const bannerR = document.getElementById('right-panel-banner');
        const bannerP = document.getElementById('playlist-header-banner');
        const showR = getAdv('banners', true) && getAdv('track_banners', true);
        const showP = getAdv('banners', true);
        if (bannerR) {
          bannerR.style.display = showR ? '' : 'none';
          if (!showR) {
            bannerR.style.opacity = '0';
            const vid = bannerR.querySelector('video.banner-video');
            if (vid) vid.remove();
          }
        }
        if (bannerP) {
          bannerP.style.display = showP ? '' : 'none';
          if (!showP) {
            bannerP.style.opacity = '0';
          }
        }
        if (showR && state.currentTrack) {
          updateRightPanelBanner(getTrackThumbUrl(state.currentTrack));
        }
        if (state.isTvKaraokeOpen) syncTvBanner();
      } else if (key === 'karaoke_words') {
        renderLyricsView();
      }
    });
  });

  const btnSearchArtists = document.getElementById('btn-search-artists');
  if (btnSearchArtists) {
    btnSearchArtists.classList.toggle('active', localStorage.getItem('muriel_search_artists') !== '0');
    btnSearchArtists.addEventListener('click', () => {
      const v = !btnSearchArtists.classList.contains('active');
      btnSearchArtists.classList.toggle('active', v);
      localStorage.setItem('muriel_search_artists', v ? '1' : '0');
    });
  }

  const btnSmooth = document.getElementById('btn-smooth-presets');
  if (btnSmooth) {
    btnSmooth.classList.toggle('active', localStorage.getItem('muriel_smooth_presets') !== 'false');
    btnSmooth.addEventListener('click', () => {
      const v = !btnSmooth.classList.contains('active');
      btnSmooth.classList.toggle('active', v);
      localStorage.setItem('muriel_smooth_presets', String(v));
    });
  }
  if (sidebarEl) {
    sidebarEl.classList.add('no-nav-anim');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sidebarEl.classList.remove('no-nav-anim');
      });
    });
  }

  const btnShowLocal = document.getElementById('btn-show-local');
  function updateShowLocalUI(animate = false) {
    const show = localStorage.getItem('muriel_show_local') !== 'false';
    if (el.navLocal) el.navLocal.classList.toggle('nav-collapsed', !show);
    if (btnShowLocal) btnShowLocal.classList.toggle('active', show);
    if (!show && state.currentView === 'local') {
      switchView('discover');
    }
    if (animate) {
      const t0 = performance.now();
      (function f() {
        refreshStacks();
        updateNavIndicator(false);
        if (performance.now() - t0 < 350) requestAnimationFrame(f);
      })();
    } else {
      refreshStacks();
      updateNavIndicator(false);
    }
  }
  if (btnShowLocal) {
    btnShowLocal.addEventListener('click', () => {
      const show = localStorage.getItem('muriel_show_local') !== 'false';
      localStorage.setItem('muriel_show_local', (!show) ? 'true' : 'false');
      updateShowLocalUI(true);
      refreshStacks();
    });
  }
  updateShowLocalUI(false);
  applyShowAlbums();
  updateAlbumsCount();

  // Settings > Tracks > Show explicit tag [E] on songs (on unless turned off)
  const toggleExplicitTag = document.getElementById('toggle-explicit-tag');
  function applyExplicitTag() {
    const on = localStorage.getItem('muriel_show_explicit') !== '0';
    document.body.classList.toggle('hide-explicit-badges', !on);
    if (toggleExplicitTag) toggleExplicitTag.classList.toggle('active', on);
  }
  if (toggleExplicitTag) {
    toggleExplicitTag.addEventListener('click', () => {
      localStorage.setItem('muriel_show_explicit', localStorage.getItem('muriel_show_explicit') === '0' ? '1' : '0');
      applyExplicitTag();
    });
  }
  applyExplicitTag();

  function applyNoHandCursor(on) {
    document.body.classList.toggle('no-hand-cursor', !!on);
  }
  const btnNoHandCursor = document.getElementById('btn-no-hand-cursor');
  const noHand = localStorage.getItem('muriel_no_hand_cursor') !== '0';
  applyNoHandCursor(noHand);
  if (btnNoHandCursor) {
    btnNoHandCursor.classList.toggle('active', noHand);
    btnNoHandCursor.addEventListener('click', () => {
      const next = !btnNoHandCursor.classList.contains('active');
      btnNoHandCursor.classList.toggle('active', next);
      localStorage.setItem('muriel_no_hand_cursor', next ? '1' : '0');
      applyNoHandCursor(next);
    });
  }

  function applyHighlightButtons(on) {
    document.body.classList.toggle('highlight-buttons', !!on);
  }
  const btnHighlightButtons = document.getElementById('btn-highlight-buttons');
  const initialHighlightButtons = localStorage.getItem('muriel_highlight_buttons') !== '0';
  applyHighlightButtons(initialHighlightButtons);
  if (btnHighlightButtons) {
    btnHighlightButtons.classList.toggle('active', initialHighlightButtons);
    btnHighlightButtons.addEventListener('click', () => {
      const next = !btnHighlightButtons.classList.contains('active');
      btnHighlightButtons.classList.toggle('active', next);
      localStorage.setItem('muriel_highlight_buttons', next ? '1' : '0');
      applyHighlightButtons(next);
    });
  }

  function watchSliderValue(input, onChange) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); onChange(); } });
    input.addEventListener('input', onChange);
  }
  function enhanceSliders(root) {
    (root || document).querySelectorAll('input[type="range"]:not(.sl-done):not(#slider-theme-hue)').forEach((input) => {
      if (input.closest('.eq-slider-box') || input.closest('.eq-slider-wrap') || input.closest('.hue-seg') || input.classList.contains('eq-band-range')) return;
      input.classList.add('sl-done');
      const wrap = document.createElement('div');
      wrap.className = 'sl';
      wrap.innerHTML = '<div class="sl-active"></div><div class="sl-inactive"></div>';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const sync = () => {
        const min = input.min === '' ? 0 : parseFloat(input.min);
        const max = input.max === '' ? 100 : parseFloat(input.max);
        wrap.style.setProperty('--v', max > min ? (parseFloat(input.value) - min) / (max - min) : 0);
      };
      watchSliderValue(input, sync);
      sync();
    });
  }
  enhanceSliders();
  let sliderRaf = 0;
  // text-only changes (the playbar clock, counters) can't add a slider or a switch: skip the document scan for them
  const addsElements = (muts) => muts.some((m) => Array.prototype.some.call(m.addedNodes, (n) => n.nodeType === 1));
  new MutationObserver((muts) => { if (sliderRaf || !addsElements(muts)) return; sliderRaf = requestAnimationFrame(() => { sliderRaf = 0; enhanceSliders(); }); }).observe(document.body, { childList: true, subtree: true });

  (function initHueSegments() {
    const input = document.getElementById('slider-theme-hue');
    const track = document.querySelector('.hue-seg-track');
    const host = document.getElementById('hue-seg');
    if (!input || !track || !host) return;
    for (let i = 0; i < 12; i++) {
      const seg = document.createElement('i');
      seg.style.background = `linear-gradient(90deg, hsl(${i * 30} 75% 55%), hsl(${(i + 1) * 30} 75% 55%))`;
      track.appendChild(seg);
    }
    const sync = () => {
      const min = input.min === '' ? 0 : parseFloat(input.min);
      const max = input.max === '' ? 360 : parseFloat(input.max);
      host.style.setProperty('--v', max > min ? (parseFloat(input.value) - min) / (max - min) : 0);
    };
    watchSliderValue(input, sync);
    sync();
  })();

  // Settings: Show on Discord (desktop only, where the presence bridge exists)
  const btnDiscordPresence = document.getElementById('btn-discord-presence');
  if (btnDiscordPresence && window.electronAPI && typeof window.electronAPI.discordPresenceUpdate === 'function') {
    document.getElementById('setting-discord-row').style.display = '';
    btnDiscordPresence.classList.toggle('active', discordPresenceOn());
    btnDiscordPresence.addEventListener('click', () => {
      const on = !discordPresenceOn();
      localStorage.setItem('muriel_discord_presence', on ? 'true' : 'false');
      btnDiscordPresence.classList.toggle('active', on);
      if (on) updateDiscordPresence();
      else if (window.electronAPI.discordPresenceClear) window.electronAPI.discordPresenceClear();
    });
  }

  const btnWavyProgress = document.getElementById('btn-wavy-progress');
  function updateWavyProgressUI() {
    const isWavy = localStorage.getItem('muriel_wavy_progress') !== 'false';
    const isPerf = document.body.classList.contains('perf');
    document.body.classList.toggle('no-wavy', isPerf ? true : !isWavy);
    if (btnWavyProgress) {
      btnWavyProgress.classList.toggle('active', isWavy);
    }
  }

  const btnProgressKnob = document.getElementById('btn-progress-knob');
  function updateProgressKnobUI() {
    const isHidden = localStorage.getItem('muriel_progress_knob') === 'false';
    document.body.classList.toggle('no-knob', isHidden);
    if (btnProgressKnob) {
      btnProgressKnob.classList.toggle('active', !isHidden);
    }
  }

  const btnProgressBg = document.getElementById('btn-progress-bg');
  function updateProgressBgUI() {
    const isHidden = localStorage.getItem('muriel_progress_bg') === 'false';
    document.body.classList.toggle('no-progress-bg', isHidden);
    if (btnProgressBg) {
      btnProgressBg.classList.toggle('active', !isHidden);
    }
  }

  const COVER_PX = 70;
  const CANVAS_PX = 120;
  const RING_GAP = 5;
  const RING_W = 2.4;

  const m3c = { canvas: null, ctx: null, img: new Image(), imgReady: false, from: 0, to: 0, start: 0, raf: 0, last: 0, phase: 0, hoverProgress: 0, isHovered: false };
  // phones keep the plain cover: the animated ring doesn't fit the mini player and its loop costs battery
  function m3cEnabled() { return !isPhoneApp && localStorage.getItem('muriel_m3_cover') !== '0' && !document.body.classList.contains('perf'); }
  function m3cInit() {
    m3c.canvas = document.getElementById('m3c-canvas');
    if (!m3c.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    m3c.canvas.width = CANVAS_PX * dpr;
    m3c.canvas.height = CANVAS_PX * dpr;
    m3c.ctx = m3c.canvas.getContext('2d');
    m3c.ctx.scale(dpr, dpr);
    m3c.ctx.imageSmoothingEnabled = true;
    m3c.ctx.imageSmoothingQuality = 'high';
    m3c.img.onload = () => { m3c.imgReady = true; m3cDraw(performance.now()); };
    if (el.playbarArtwork && el.playbarArtwork.src) {
      m3cSetImage(el.playbarArtwork.src);
    } else if (state.currentTrack) {
      m3cSetImage(getTrackThumbUrl(state.currentTrack));
    }
    const wrap = document.getElementById('playbar-artwork-wrapper');
    if (wrap && !wrap._m3cHoverBound) {
      wrap._m3cHoverBound = true;
      wrap.addEventListener('mouseenter', () => {
        m3c.isHovered = true;
        m3cStart();
      });
      wrap.addEventListener('mouseleave', () => {
        m3c.isHovered = false;
        m3cStart();
      });
    }
    applyM3Cover();
  }
  function m3cSetImage(url) {
    m3c.imgReady = false;
    if (url) m3c.img.src = url;
  }
  function m3cShapeRadii(now) {
    const S = window.RiffShapes;
    if (!S || !S.ready()) return null;
    if (!m3c.start) { m3c.start = now; m3c.from = 0; m3c.to = 0; }
    if (now - m3c.start >= S.HOLD_MS) { m3c.from = m3c.to; m3c.to = S.next(m3c.from); m3c.start = now; }
    const t = Math.min(1, (now - m3c.start) / S.MORPH_MS);
    return { a: S.profile(m3c.from), b: S.profile(m3c.to), e: S.ease(t) };
  }
  function m3cDraw(now) {
    const ctx = m3c.ctx;
    const S = window.RiffShapes;
    if (!ctx || !S) return;
    const sh = m3cShapeRadii(now);
    if (!sh) return;
    const K = S.K;
    const hoverScale = 1 + m3c.hoverProgress * 0.16;
    const hoverLift = m3c.hoverProgress * 4;
    const cx = CANVAS_PX / 2;
    const cy = CANVAS_PX / 2 - hoverLift;
    const currentCover = COVER_PX * hoverScale;
    const scale = (currentCover / 2) / 160 * 1.02;
    const rot = (now / 36000) * Math.PI * 2;
    const radiusAt = (shapeAngle) => {
      const f = ((shapeAngle + Math.PI) / (Math.PI * 2)) * K;
      const i0 = ((Math.floor(f) % K) + K) % K;
      const i1 = (i0 + 1) % K;
      const w = f - Math.floor(f);
      const r0 = sh.a[i0] + (sh.b[i0] - sh.a[i0]) * sh.e;
      const r1 = sh.a[i1] + (sh.b[i1] - sh.a[i1]) * sh.e;
      return (r0 + (r1 - r0) * w) * scale;
    };
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k <= K; k++) {
      const th = -Math.PI + (Math.PI * 2 * (k % K)) / K;
      const r = radiusAt(th);
      const x = cx + Math.cos(th + rot) * r;
      const y = cy + Math.sin(th + rot) * r;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    if (m3c.imgReady) {
      const iw = m3c.img.naturalWidth;
      const ih = m3c.img.naturalHeight;
      const side = Math.min(iw, ih);
      const imgSize = Math.ceil(currentCover * 1.06);
      ctx.drawImage(m3c.img, (iw - side) / 2, (ih - side) / 2, side, side, cx - imgSize / 2, cy - imgSize / 2, imgSize, imgSize);
    } else {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface-container-highest-solid') || '#444';
      ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    }
    ctx.restore();
    const audio = el.nativeAudio;
    const dur = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const p = dur ? Math.min(1, Math.max(0, audio.currentTime / dur)) : 0;
    // the theme color is cached and refreshed on theme changes, like the scrubber's: no style read per frame
    if (!cachedPrimaryColor) refreshCachedThemeColors();
    const primary = cachedPrimaryColor || '#d0bcff';
    const STEPS = 240;
    const ringPoint = (phi, wave) => {
      const r = radiusAt(phi - rot) + RING_GAP + RING_W / 2 + wave;
      return [cx + Math.cos(phi) * r, cy + Math.sin(phi) * r];
    };
    const startPhi = -Math.PI / 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = RING_W;
    ctx.setLineDash([0.1, 5.5]);
    ctx.strokeStyle = primary;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    const restFrom = Math.round(p * STEPS);
    for (let s = restFrom; s <= STEPS; s++) {
      const [x, y] = ringPoint(startPhi + (Math.PI * 2 * s) / STEPS, 0);
      if (s === restFrom) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (p > 0) {
      ctx.beginPath();
      const playedSteps = Math.max(2, Math.round(p * STEPS));
      for (let s = 0; s <= playedSteps; s++) {
        const phi = startPhi + (Math.PI * 2 * s) / STEPS;
        const [x, y] = ringPoint(phi, Math.sin(phi * 26 + m3c.phase) * 1.5);
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  function m3cLoop(now) {
    m3c.raf = 0;
    if (!m3cEnabled() || document.hidden) return;

    const targetHover = m3c.isHovered ? 1 : 0;
    const diff = targetHover - m3c.hoverProgress;
    const isHoverAnimating = Math.abs(diff) > 0.002;
    if (isHoverAnimating) {
      m3c.hoverProgress += diff * 0.2;
    } else {
      m3c.hoverProgress = targetHover;
    }

    if (!state.isPlaying && !isHoverAnimating) {
      m3cDraw(now);
      return;
    }

    if (now - m3c.last >= 24) {
      m3c.last = now;
      if (state.isPlaying) m3c.phase += 0.18;
      m3cDraw(now);
    }
    m3c.raf = requestAnimationFrame(m3cLoop);
  }
  function m3cStart() { if (!m3c.raf) m3c.raf = requestAnimationFrame(m3cLoop); }
  function applyM3Cover() {
    const on = m3cEnabled();
    document.body.classList.toggle('m3-cover-on', on);
    if (on) { m3cDraw(performance.now()); if (state.isPlaying || m3c.isHovered) m3cStart(); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) applyM3Cover(); });

  // auto battery saver: perf mode while a laptop runs on battery (the stored setting is left alone)
  let batterySaver = false;
  function storedPerfMode() { const v = localStorage.getItem('muriel_perf_mode'); return v === '1' || v === 'true'; }
  function applyPerfMode(on) {
    on = !!on || batterySaver;
    document.body.classList.toggle('perf', on);
    const isWavy = localStorage.getItem('muriel_wavy_progress') !== 'false';
    document.body.classList.toggle('no-wavy', on ? true : !isWavy);
    syncBgVideoPlayback();
    applyM3Cover();
  }
  const btnBarWave = document.getElementById('btn-bar-wave');
  const barWaveOn = localStorage.getItem('muriel_bar_wave') !== '0';
  function applyBarWave(on) {
    document.body.classList.toggle('bar-wave-off', !on);
    const vc = document.getElementById('visualizer-container');
    if (vc) {
      vc.style.display = on ? '' : 'none';
      vc.style.pointerEvents = on ? '' : 'none';
    }
    const canvas = document.getElementById('visualizer-canvas');
    if (canvas) {
      canvas.style.pointerEvents = on ? '' : 'none';
      if (!on) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    const needBassPulse = !!(state.vfx && state.vfx.bassPulse);
    if (!on) {
      if (audioEngine && audioEngine.setAnalyserEnabled && !needBassPulse) {
        audioEngine.setAnalyserEnabled(false);
      }
    } else {
      if (audioEngine && audioEngine.setAnalyserEnabled && state.isPlaying) {
        audioEngine.setAnalyserEnabled(true);
      }
      if (state.isPlaying) {
        startVisualizers();
      }
    }
  }
  applyBarWave(barWaveOn);
  if (btnBarWave) {
    btnBarWave.classList.toggle('active', barWaveOn);
    btnBarWave.addEventListener('click', () => {
      const next = !btnBarWave.classList.contains('active');
      btnBarWave.classList.toggle('active', next);
      localStorage.setItem('muriel_bar_wave', next ? '1' : '0');
      applyBarWave(next);
    });
  }

  const toggleM3Cover = document.getElementById('toggle-m3-cover');
  if (toggleM3Cover) {
    const saved = localStorage.getItem('muriel_m3_cover');
    const isM3On = saved !== '0';
    toggleM3Cover.classList.toggle('active', isM3On);
    toggleM3Cover.addEventListener('click', () => {
      const next = !toggleM3Cover.classList.contains('active');
      toggleM3Cover.classList.toggle('active', next);
      localStorage.setItem('muriel_m3_cover', next ? '1' : '0');
      applyM3Cover();
    });
  }

  updateTvkVisualizerSetting(localStorage.getItem('muriel_tvk_visualizer') !== 'false');
  updateTvkVisualizerLyricsSetting(localStorage.getItem('muriel_tvk_visualizer_lyrics') === 'true');
  updateTvkVisualizerOpacity(parseInt(localStorage.getItem('muriel_tvk_visualizer_opacity') || '85', 10));

  const btnPerfMode = document.getElementById('btn-perf-mode');
  const initialPerfMode = localStorage.getItem('muriel_perf_mode') === '1' || localStorage.getItem('muriel_perf_mode') === 'true';
  applyPerfMode(initialPerfMode);
  // the battery saver had no switch: on battery it forced performance mode with no way back
  const btnBatterySaver = document.getElementById('btn-battery-saver');
  const batterySaverWanted = () => localStorage.getItem('muriel_battery_saver') !== '0';
  let batteryRef = null;
  const syncBatterySaver = () => {
    const next = !!(batteryRef && batteryRef.charging === false && batterySaverWanted());
    if (next === batterySaver) return;
    batterySaver = next;
    applyPerfMode(storedPerfMode());
  };
  if (btnBatterySaver) {
    btnBatterySaver.classList.toggle('active', batterySaverWanted());
    btnBatterySaver.addEventListener('click', () => {
      const next = !btnBatterySaver.classList.contains('active');
      btnBatterySaver.classList.toggle('active', next);
      localStorage.setItem('muriel_battery_saver', next ? '1' : '0');
      syncBatterySaver();
    });
  }
  if (!isPhoneApp && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((b) => {
      batteryRef = b;
      syncBatterySaver();
      b.addEventListener('chargingchange', syncBatterySaver);
    }).catch(() => {});
  } else {
    const row = document.getElementById('setting-battery-saver');
    if (row) row.style.display = 'none';
  }
  if (btnPerfMode) {
    btnPerfMode.classList.toggle('active', initialPerfMode);
    btnPerfMode.addEventListener('click', () => {
      const next = !btnPerfMode.classList.contains('active');
      btnPerfMode.classList.toggle('active', next);
      localStorage.setItem('muriel_perf_mode', next ? '1' : '0');
      applyPerfMode(next);
    });
  }

  if (btnWavyProgress) {
    btnWavyProgress.addEventListener('click', () => {
      const isWavy = localStorage.getItem('muriel_wavy_progress') !== 'false';
      const next = !isWavy;
      localStorage.setItem('muriel_wavy_progress', next ? 'true' : 'false');
      updateWavyProgressUI();
      hasDrawnPausedFrame = false;
    });
  }

  if (btnProgressKnob) {
    btnProgressKnob.addEventListener('click', () => {
      const isKnob = localStorage.getItem('muriel_progress_knob') !== 'false';
      const next = !isKnob;
      localStorage.setItem('muriel_progress_knob', next ? 'true' : 'false');
      updateProgressKnobUI();
      hasDrawnPausedFrame = false;
      if (!animationFrameId && typeof startVisualizers === 'function') startVisualizers();
    });
  }

  if (btnProgressBg) {
    btnProgressBg.addEventListener('click', () => {
      const isBg = localStorage.getItem('muriel_progress_bg') !== 'false';
      const next = !isBg;
      localStorage.setItem('muriel_progress_bg', next ? 'true' : 'false');
      updateProgressBgUI();
      hasDrawnPausedFrame = false;
      if (!animationFrameId && typeof startVisualizers === 'function') startVisualizers();
    });
  }

  updateWavyProgressUI();
  updateProgressKnobUI();
  updateProgressBgUI();

  const btnTrayOnClose = document.getElementById('btn-tray-on-close');
  const storedTrayOnClose = localStorage.getItem('muriel_tray_on_close');
  const savedTrayOnClose = storedTrayOnClose !== null
    ? storedTrayOnClose === 'true'
    : /Windows|Mac/.test(navigator.userAgent);
  if (btnTrayOnClose) {
    btnTrayOnClose.classList.toggle('active', savedTrayOnClose);
    btnTrayOnClose.addEventListener('click', () => {
      const next = !btnTrayOnClose.classList.contains('active');
      btnTrayOnClose.classList.toggle('active', next);
      localStorage.setItem('muriel_tray_on_close', next ? 'true' : 'false');
      if (window.electronAPI && window.electronAPI.setTrayOnClose) {
        window.electronAPI.setTrayOnClose(next);
      }
    });
  }
  if (window.electronAPI && window.electronAPI.setTrayOnClose) {
    window.electronAPI.setTrayOnClose(savedTrayOnClose);
  }

  // Settings navigation. Wide windows: the category list on the left, one category on the right. Phones (and
  // narrow windows): the list of categories with their names, tap one to open it, back (the arrow, or Android's
  // back button) returns to the list. The search field filters every row of every category by the text shown on
  // screen, so it works in any UI language.
  const settingsView = document.getElementById('view-settings');
  const settingsNarrow = window.matchMedia('(max-width: 760px)');
  const settingsSearchInput = document.getElementById('settings-search');
  const settingsSearchClear = document.getElementById('settings-search-clear');
  const settingsSearchEmpty = document.getElementById('settings-search-empty');
  let settingsCat = 'interface';
  function settingsCatLabel(cat) {
    const b = document.querySelector(`#settings-nav .settings-nav-btn[data-cat="${cat}"] span`);
    return b ? b.textContent.trim() : '';
  }
  function showSettingsCategory(cat) {
    if (cat === 'appearance' || !cat) cat = 'interface';
    // a remembered category that no longer exists (a plugin's, a removed one): start at Interface
    if (!document.querySelector(`#view-settings .settings-section[data-cat="${cat}"]`)) cat = 'interface';
    settingsCat = cat;
    if (settingsSearchInput && settingsSearchInput.value) clearSettingsSearch(true);
    if (settingsView) settingsView.classList.remove('settings-at-list');
    document.querySelectorAll('#view-settings .settings-section').forEach(s => s.classList.toggle('cat-hidden', s.dataset.cat !== cat));
    document.querySelectorAll('#settings-nav .settings-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    const title = document.getElementById('settings-pane-title'); if (title) title.textContent = settingsCatLabel(cat);
    syncSettingsGroupTitles();
    // after the frame's style work, so it doesn't force a second layout of the whole settings page
    const pane = document.querySelector('#view-settings .settings-pane'); if (pane) requestAnimationFrame(() => { if (pane.scrollTop) pane.scrollTop = 0; });
    settingsScrollTop();
    try { localStorage.setItem('muriel_settings_cat', cat); } catch (e) {}
    if (cat === 'custom-themes' && typeof renderThemeCards === 'function') renderThemeCards();
    if (cat === 'plugins' && typeof reloadPluginsList === 'function') reloadPluginsList();
    refreshStacks();
  }
  window.showSettingsCategory = showSettingsCategory;
  // a group whose rows are all hidden here (desktop-only rows on a phone, Windows-only rows) hides its title too
  function syncSettingsGroupTitles() {
    document.querySelectorAll('#view-settings .settings-group-title').forEach((t) => {
      const g = t.nextElementSibling;
      if (!g || !g.classList.contains('m3-group')) return;
      const any = [...g.children].some((r) => !r.classList.contains('gs-retired') && !r.classList.contains('hidden') && r.style.display !== 'none');
      t.classList.toggle('group-empty', !any);
      g.classList.toggle('group-empty', !any);
    });
  }
  function settingsScrollTop() {
    let n = settingsView && settingsView.parentElement;
    while (n && n !== document.body) { if (n.scrollTop) n.scrollTop = 0; n = n.parentElement; }
  }
  // phones: back to the list of categories (the last one stays marked)
  function showSettingsList() {
    if (settingsSearchInput && settingsSearchInput.value) clearSettingsSearch(true);
    if (settingsView) settingsView.classList.add('settings-at-list');
    settingsScrollTop();
  }
  // opening Settings: wide windows show the last category, phones the list
  function enterSettings() {
    let last = 'interface'; try { last = localStorage.getItem('muriel_settings_cat') || 'interface'; } catch (e) {}
    showSettingsCategory(last);
    if (settingsNarrow.matches) showSettingsList();
  }
  // Android back: leave the search, then the open category, before leaving Settings. true = handled
  window.MurielSettingsBack = function () {
    if (!settingsView || !settingsView.classList.contains('active')) return false;
    if (settingsSearchInput && settingsSearchInput.value) { clearSettingsSearch(); return true; }
    if (settingsNarrow.matches && !settingsView.classList.contains('settings-at-list')) { showSettingsList(); return true; }
    return false;
  };
  settingsNarrow.addEventListener('change', () => { if (!settingsNarrow.matches && settingsView) settingsView.classList.remove('settings-at-list'); });

  const settingsNav = document.getElementById('settings-nav');
  if (settingsNav) {
    settingsNav.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-nav-btn');
      if (btn && btn.dataset.cat) {
        showSettingsCategory(btn.dataset.cat);
      }
    });
  }
  const btnSettingsBack = document.getElementById('btn-settings-back');
  if (btnSettingsBack) btnSettingsBack.addEventListener('click', showSettingsList);

  // ---- search: rows of every category whose shown text has every typed word ----
  const SEARCH_SKIP = 'select, option, script, style, svg, input, textarea, [data-no-i18n]';
  const searchNorm = (t) => String(t || '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  function shownText(el) {
    let out = '';
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest(SEARCH_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    while (walk.nextNode()) out += ' ' + walk.currentNode.nodeValue;
    return searchNorm(out);
  }
  function clearSearchMarks() {
    document.querySelectorAll('#view-settings .ss-miss').forEach((n) => n.classList.remove('ss-miss'));
    document.querySelectorAll('#view-settings .settings-search-cat').forEach((n) => n.remove());
  }
  const rowShown = (r) => !r.classList.contains('gs-retired') && !r.classList.contains('hidden') && r.style.display !== 'none';
  function runSettingsSearch() {
    const q = searchNorm(settingsSearchInput.value).trim();
    if (settingsSearchClear) settingsSearchClear.classList.toggle('hidden', !q);
    clearSearchMarks();
    if (!q) {
      settingsView.classList.remove('settings-searching');
      if (settingsSearchEmpty) settingsSearchEmpty.classList.add('hidden');
      document.querySelectorAll('#view-settings .settings-section').forEach(s => s.classList.toggle('cat-hidden', s.dataset.cat !== settingsCat));
      refreshStacks();
      return;
    }
    settingsView.classList.add('settings-searching');
    const words = q.split(' ').filter(Boolean);
    const hit = (t) => words.every((w) => t.includes(w));
    // results follow the order of the category list, each under its category's name
    const order = [...document.querySelectorAll('#settings-nav .settings-nav-btn')].map((b) => b.dataset.cat);
    const rank = (c) => { const i = order.indexOf(c); return i < 0 ? 99 : i; };
    const sections = [...document.querySelectorAll('#view-settings .settings-section')].sort((x, y) => rank(x.dataset.cat) - rank(y.dataset.cat));
    let total = 0;
    for (const sec of sections) {
      const label = settingsCatLabel(sec.dataset.cat);
      const rows = [...sec.querySelectorAll('.setting-item')].filter((r) => !r.parentElement.closest('.setting-item'));
      // a section without rows (Plugins, About) or whose own name matches is shown whole
      const whole = (!rows.length && hit(shownText(sec))) || (!!label && hit(searchNorm(label)));
      const matched = whole ? [] : rows.filter((r) => rowShown(r) && hit(shownText(r)));
      const count = whole ? 1 : matched.length;
      sec.style.order = String(rank(sec.dataset.cat));
      sec.classList.toggle('cat-hidden', !count);
      if (!count) continue;
      total += count;
      if (!whole) {
        const keep = new Set(matched);
        const prune = (el) => {
          for (const c of el.children) {
            if (keep.has(c)) continue;
            if (matched.some((r) => c.contains(r))) prune(c); else c.classList.add('ss-miss');
          }
        };
        prune(sec);
      }
      const head = document.createElement('div');
      head.className = 'settings-search-cat';
      head.textContent = label;
      sec.insertBefore(head, sec.firstChild);
    }
    if (settingsSearchEmpty) settingsSearchEmpty.classList.toggle('hidden', total > 0);
    refreshStacks();
  }
  function clearSettingsSearch(silent) {
    if (!settingsSearchInput) return;
    settingsSearchInput.value = '';
    if (silent) {
      clearSearchMarks();
      settingsView.classList.remove('settings-searching');
      if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
      if (settingsSearchEmpty) settingsSearchEmpty.classList.add('hidden');
    } else runSettingsSearch();
  }
  if (settingsSearchInput && settingsView) {
    let searchTimer = 0;
    settingsSearchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSettingsSearch, 80); });
    settingsSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsSearchInput.value) { e.preventDefault(); e.stopPropagation(); clearSettingsSearch(); } });
    if (settingsSearchClear) settingsSearchClear.addEventListener('click', () => { clearSettingsSearch(); settingsSearchInput.focus(); });
  }

  let customThemes = [];
  let appCssCache = null;

  function applyCustomStyles() {
    document.querySelectorAll('style[data-muriel-custom]').forEach((n) => n.remove());
    customThemes.filter((t) => t.enabled).forEach((t) => {
      const s = document.createElement('style');
      s.dataset.murielCustom = 'theme';
      s.dataset.themeId = t.id;
      s.textContent = t.css;
      document.head.appendChild(s);
    });
    const userCss = localStorage.getItem('muriel_custom_css') || '';
    if (userCss.trim()) {
      const s = document.createElement('style');
      s.dataset.murielCustom = 'user';
      s.textContent = userCss;
      document.head.appendChild(s);
    }
    if (typeof refreshCachedThemeColors === 'function') refreshCachedThemeColors();
  }

  function resetCustomStyling() {
    const userCss = localStorage.getItem('muriel_custom_css') || '';
    if (userCss.trim()) localStorage.setItem('muriel_custom_css_backup', userCss);
    localStorage.removeItem('muriel_custom_css');
    customThemes.forEach((t) => { t.enabled = false; });
    if (window.electronAPI && window.electronAPI.disableAllThemes) window.electronAPI.disableAllThemes();
    if (typeof cssEditorInstance !== 'undefined' && cssEditorInstance) cssEditorInstance.setValue('');
    if (window.electronAPI && window.electronAPI.disableAllPlugins) window.electronAPI.disableAllPlugins();
    pluginsCache.forEach((p) => { p.enabled = false; stopPlugin(p, true); });
    renderPluginCards();
    applyCustomStyles();
    renderThemeCards();
    showToast(Tm('Custom CSS, themes and plugins reset (Ctrl+Shift+R)'), 'info');
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      e.stopPropagation();
      resetCustomStyling();
    }
  }, true);

  async function mountThemePreview(host, themeCss) {
    if (!window.electronAPI || !window.electronAPI.getAppCss) return;
    if (appCssCache === null) appCssCache = (await window.electronAPI.getAppCss()) || '';
    const rewrite = (css) => css
      .replace(/:root/g, ':host')
      .replace(/(^|[\s,{};])html(?![\w-])/g, '$1:host')
      .replace(/(^|[\s,{};])body(?![\w-])/g, '$1.ct-mini');
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.textContent = '';
    const addStyle = (css) => {
      const styleEl = document.createElement('style');
      styleEl.textContent = css;
      root.appendChild(styleEl);
    };
    addStyle('.ct-mini{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;}');
    addStyle(rewrite(appCssCache));
    addStyle(rewrite(themeCss));
    const mini = document.createElement('div');
    mini.className = `ct-mini ${document.body.className}`;
    mini.style.width = `${window.innerWidth}px`;
    mini.style.height = `${window.innerHeight}px`;
    [...document.body.children].forEach((n) => {
      if (/^(SCRIPT|STYLE|LINK)$/.test(n.tagName) || n.classList.contains('modal-backdrop') || n.id === 'css-editor' || n.id === 'custom-bg') return;
      mini.appendChild(n.cloneNode(true));
    });
    mini.querySelectorAll('video, audio, canvas, iframe').forEach((n) => n.remove());
    root.appendChild(mini);
    const fit = () => { const w = host.clientWidth; if (w) mini.style.transform = `scale(${w / window.innerWidth})`; };
    new ResizeObserver(fit).observe(host);
    fit();
  }

  function renderThemeCards() {
    const list = document.getElementById('custom-themes-list');
    if (!list) return;
    list.innerHTML = '';
    if (!customThemes.length) {
      const empty = document.createElement('div');
      empty.className = 'ct-empty';
      empty.textContent = 'No themes yet. Click Add and choose a .css file.';
      empty.dataset.i18n = '';
      list.appendChild(empty);
      return;
    }
    customThemes.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'ct-card';
      card.innerHTML = '<div class="ct-preview"></div><div class="ct-info"><div class="ct-name"></div><div class="ct-meta"></div></div><button class="btn-icon-pill ct-remove" title="Remove" data-i18n-attr="title"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button><button class="effect-switch-btn"><span class="thumb"></span></button>';
      card.querySelector('.ct-name').textContent = t.name;
      card.querySelector('.ct-meta').textContent = [t.author && `by ${t.author}`, t.description].filter(Boolean).join(' · ');
      const preview = card.querySelector('.ct-preview');
      preview.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`;
      const toggle = card.querySelector('.effect-switch-btn');
      toggle.classList.toggle('active', !!t.enabled);
      toggle.addEventListener('click', () => {
        t.enabled = !t.enabled;
        toggle.classList.toggle('active', t.enabled);
        window.electronAPI.setThemeEnabled(t.id, t.enabled);
        applyCustomStyles();
      });
      card.querySelector('.ct-remove').addEventListener('click', () => {
        window.electronAPI.removeTheme(t.id);
        customThemes = customThemes.filter((x) => x.id !== t.id);
        applyCustomStyles();
        renderThemeCards();
        showToast(Tm('Theme removed'), 'info');
      });
      list.appendChild(card);
      mountThemePreview(preview, t.css);
    });
  }

  async function loadCustomThemes() {
    if (!window.electronAPI || !window.electronAPI.listThemes) {
      applyCustomStyles();
      return;
    }
    customThemes = await window.electronAPI.listThemes();
    applyCustomStyles();
    renderThemeCards();
  }

  const btnAddTheme = document.getElementById('btn-add-theme');
  if (btnAddTheme && window.electronAPI && window.electronAPI.importThemes) {
    btnAddTheme.addEventListener('click', async () => {
      const added = await window.electronAPI.importThemes();
      if (!added.length) return;
      customThemes.push(...added);
      renderThemeCards();
      showToast(added.length > 1 ? Tm('Added {0} themes. Turn one on to try it', added.length) : Tm('Added 1 theme. Turn it on to try it'), 'info');
    });
  }

  const loadedPlugins = new Map();
  const pluginListeners = [];
  function emitPluginEvent(event, data) {
    pluginListeners.filter((l) => l.event === event).forEach((l) => { try { l.cb(data); } catch (e) { reportPluginError(l.file, e); } });
  }
  function reportPluginError(file, e) {
    console.error('[plugin ' + file + ']', e);
    showToast(Tm('Plugin {0} failed: {1}', file, e && e.message ? e.message : e), 'error');
  }
  function createPluginApi(p) {
    const prefix = `muriel_plugin_${p.file}_`;
    return {
      plugin: { file: p.file, name: p.name, author: p.author, version: p.version },
      on(event, cb) {
        const l = { event, cb, file: p.file };
        pluginListeners.push(l);
        return () => { const i = pluginListeners.indexOf(l); if (i >= 0) pluginListeners.splice(i, 1); };
      },
      toast: (message, type) => showToast(String(message), type || 'info'),
      addStyle(css) {
        const s = document.createElement('style');
        s.dataset.murielCustom = 'plugin';
        s.dataset.plugin = p.file;
        s.textContent = css;
        document.head.appendChild(s);
        return () => s.remove();
      },
      storage: {
        get: (k, d) => { const v = localStorage.getItem(prefix + k); return v === null ? d : JSON.parse(v); },
        set: (k, v) => localStorage.setItem(prefix + k, JSON.stringify(v))
      },
      getTrack: () => state.currentTrack,
      isPlaying: () => state.isPlaying,
      audio: () => el.nativeAudio,
      query: (sel) => document.querySelector(sel)
    };
  }
  function runPlugin(p) {
    if (loadedPlugins.has(p.file)) return;
    try {
      const api = createPluginApi(p);
      const fn = new Function('Muriel', 'plugin', `${p.code}\n//# sourceURL=muriel-plugin-${p.file}`);
      const result = fn(api, api.plugin);
      loadedPlugins.set(p.file, { stop: result && typeof result.stop === 'function' ? result.stop : null });
    } catch (e) { reportPluginError(p.file, e); }
  }
  function stopPlugin(p, silent) {
    const entry = loadedPlugins.get(p.file);
    try { if (entry && entry.stop) entry.stop(); } catch (e) { reportPluginError(p.file, e); }
    for (let i = pluginListeners.length - 1; i >= 0; i--) if (pluginListeners[i].file === p.file) pluginListeners.splice(i, 1);
    document.querySelectorAll(`style[data-plugin="${p.file}"]`).forEach((n) => n.remove());
    const hadStop = !!(entry && entry.stop);
    loadedPlugins.delete(p.file);
    if (!silent && !hadStop) showToast(Tm('Restart Muriel to fully unload "{0}"', p.name), 'info');
  }
  let pluginsCache = [];
  function renderPluginCards() {
    const list = document.getElementById('plugins-list');
    if (!list) return;
    list.innerHTML = '';
    if (!pluginsCache.length) {
      const empty = document.createElement('div');
      empty.className = 'ct-empty';
      empty.textContent = 'No plugins. Put .js files into the plugins folder or click Add.';
      empty.dataset.i18n = '';
      list.appendChild(empty);
      return;
    }
    pluginsCache.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'ct-card plugin-card';
      card.innerHTML = '<div class="ct-info"><div class="ct-name"></div><div class="ct-meta"></div></div><button class="btn-icon-pill ct-remove" title="Delete file" data-i18n-attr="title"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button><button class="effect-switch-btn"><span class="thumb"></span></button>';
      card.querySelector('.ct-name').textContent = `${p.name}${p.version ? ' v' + p.version : ''}`;
      card.querySelector('.ct-meta').textContent = [p.author && `by ${p.author}`, p.description, p.file].filter(Boolean).join(' · ');
      const toggle = card.querySelector('.effect-switch-btn');
      toggle.classList.toggle('active', !!p.enabled);
      toggle.addEventListener('click', () => {
        p.enabled = !p.enabled;
        toggle.classList.toggle('active', p.enabled);
        window.electronAPI.setPluginEnabled(p.file, p.enabled);
        if (p.enabled) runPlugin(p); else stopPlugin(p, false);
      });
      card.querySelector('.ct-remove').addEventListener('click', () => {
        stopPlugin(p, true);
        window.electronAPI.removePlugin(p.file);
        pluginsCache = pluginsCache.filter((x) => x.file !== p.file);
        renderPluginCards();
        showToast(Tm('Plugin file deleted'), 'info');
      });
      list.appendChild(card);
    });
  }
  async function loadPlugins() {
    if (!window.electronAPI || !window.electronAPI.listPlugins) return;
    pluginsCache = await window.electronAPI.listPlugins();
    pluginsCache.filter((p) => p.enabled).forEach(runPlugin);
    renderPluginCards();
  }
  const pluginsApi = window.electronAPI;
  async function reloadPluginsList() {
    if (pluginsApi && pluginsApi.listPlugins) {
      pluginsCache = await pluginsApi.listPlugins();
      const present = new Set(pluginsCache.map((x) => x.file));
      [...loadedPlugins.keys()].filter((f) => !present.has(f)).forEach((f) => stopPlugin({ file: f, name: f }, true));
    }
    renderPluginCards();
  }
  if (pluginsApi && pluginsApi.listPlugins) {
    document.getElementById('btn-plugins-folder').addEventListener('click', () => pluginsApi.openPluginsFolder());
    document.getElementById('btn-plugins-reload').addEventListener('click', reloadPluginsList);
    document.getElementById('btn-add-plugin').addEventListener('click', async () => {
      const added = await pluginsApi.importPlugins();
      if (!added) return;
      pluginsCache = await pluginsApi.listPlugins();
      renderPluginCards();
      showToast(added > 1 ? Tm('Added {0} plugins. Turn one on to run it', added) : Tm('Added 1 plugin. Turn it on to run it'), 'info');
    });
  }

  let cssEditorInstance = null;
  let cssEditorLoading = null;

  function loadMonaco() {
    if (window.monaco) return Promise.resolve(window.monaco);
    if (cssEditorLoading) return cssEditorLoading;
    cssEditorLoading = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'vendor/monaco/vs/editor/editor.main.css';
      document.head.appendChild(link);
      const s = document.createElement('script');
      s.src = 'vendor/monaco/vs/loader.js';
      s.onload = () => {
        window.require.config({ paths: { vs: 'vendor/monaco/vs' } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return cssEditorLoading;
  }

  function defineRiffMonacoTheme(monaco) {
    const cs = getComputedStyle(document.documentElement);
    const hex = (name, fallback) => { const v = cs.getPropertyValue(name).trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback; };
    const bg = hex('--md-sys-color-surface-container-lowest-solid', '#141218');
    const high = hex('--md-sys-color-surface-container-high-solid', '#2b2930');
    const primary = hex('--md-sys-color-primary', '#d0bcff');
    const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
    monaco.editor.defineTheme('muriel', { base: lum(bg) < 0.5 ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: { 'editor.background': bg, 'editorGutter.background': bg, 'minimap.background': bg, 'editor.lineHighlightBackground': high, 'editorCursor.foreground': primary, 'editor.selectionBackground': primary + '55' } });
    monaco.editor.setTheme('muriel');
  }

  async function openCssEditor() {
    const overlay = document.getElementById('css-editor');
    overlay.classList.remove('hidden');
    let monaco;
    try { monaco = await loadMonaco(); } catch (e) { overlay.classList.add('hidden'); showToast(Tm('Could not load the CSS editor'), 'error'); return; }
    defineRiffMonacoTheme(monaco);
    if (cssEditorInstance) { cssEditorInstance.focus(); return; }
    cssEditorInstance = monaco.editor.create(document.getElementById('css-editor-host'), {
      value: localStorage.getItem('muriel_custom_css') || '/* Your CSS goes here. Example:\n.btn-pill-primary { border-radius: 8px; }\n*/\n',
      language: 'css',
      theme: 'riff',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontLigatures: true,
      roundedSelection: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 12 },
      tabSize: 2,
      wordWrap: 'on',
      bracketPairColorization: { enabled: true },
      colorDecorators: true
    });
    let saveTimer = 0;
    cssEditorInstance.onDidChangeModelContent(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        localStorage.setItem('muriel_custom_css', cssEditorInstance.getValue());
        applyCustomStyles();
      }, 350);
    });
    cssEditorInstance.focus();
  }

  const btnOpenCssEditor = document.getElementById('btn-open-css-editor');
  if (btnOpenCssEditor) btnOpenCssEditor.addEventListener('click', openCssEditor);
  const btnCssClose = document.getElementById('btn-css-close');
  if (btnCssClose) btnCssClose.addEventListener('click', () => document.getElementById('css-editor').classList.add('hidden'));
  const btnCssClear = document.getElementById('btn-css-clear');
  if (btnCssClear) btnCssClear.addEventListener('click', () => {
    const current = localStorage.getItem('muriel_custom_css') || '';
    if (current.trim()) localStorage.setItem('muriel_custom_css_backup', current);
    if (cssEditorInstance) cssEditorInstance.setValue('');
    else { localStorage.removeItem('muriel_custom_css'); applyCustomStyles(); }
  });
  const btnCssRestore = document.getElementById('btn-css-restore');
  if (btnCssRestore) btnCssRestore.addEventListener('click', () => {
    const backup = localStorage.getItem('muriel_custom_css_backup');
    if (!backup) { showToast(Tm('Nothing to restore'), 'info'); return; }
    if (cssEditorInstance) cssEditorInstance.setValue(backup);
    else { localStorage.setItem('muriel_custom_css', backup); applyCustomStyles(); }
  });

  function addSliderTicks(input) {
    const item = input.closest('.setting-item') || input.parentElement;
    const hints = item ? item.querySelector('.setting-hints') : null;
    const spans = hints ? [...hints.querySelectorAll('span')].map(s => s.textContent) : [];
    const min = +input.min, max = +input.max, step = +input.step || 1;
    const def = +input.getAttribute('value');
    const labels = {};
    if (spans.length === 3) { labels[min] = spans[0]; labels[def] = spans[1]; labels[max] = spans[2]; }
    else if (spans.length === 2) { labels[min] = spans[0]; labels[max] = spans[1]; }
    const wrap = document.createElement('div'); wrap.className = 'slider-ticks';
    for (let v = min; v <= max; v += step) {
      const t = document.createElement('i'); t.style.setProperty('--p', (v - min) / (max - min));
      if (labels[v] != null) { t.className = 'major'; const s = document.createElement('span'); s.textContent = labels[v]; s.dataset.i18n = ''; t.appendChild(s); }
      wrap.appendChild(t);
    }
    const host = input.closest('.sl') || input;
    host.insertAdjacentElement('afterend', wrap);
    if (hints) hints.remove();
  }

  const scaleInput = document.getElementById('settings-slider-scale');
  if (scaleInput) addSliderTicks(scaleInput);
  document.querySelectorAll('#view-settings .pill-range').forEach(input => {
    if (input === scaleInput) return;
    const item = input.closest('.setting-item') || input.parentElement;
    const hints = item ? item.querySelector('.setting-hints') : null;
    if (!hints) return;
    const min = +input.min, max = +input.max, step = +input.step || 1;
    if ((max - min) / step <= 20) {
      addSliderTicks(input);
    }
  });

  function decorateSwitches() {
    document.querySelectorAll('.effect-switch-btn .thumb:not(.has-icon)').forEach((t) => {
      t.classList.add('has-icon');
      t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sw-icon"/></svg>';
    });
  }
  let swRaf = 0;
  new MutationObserver((muts) => { if (swRaf || !addsElements(muts)) return; swRaf = requestAnimationFrame(() => { swRaf = 0; decorateSwitches(); }); }).observe(document.body, { childList: true, subtree: true });
  decorateSwitches();

  const settingWinMediaKeys = document.getElementById('setting-win-media-keys');
  const btnWinMediaKeys = document.getElementById('btn-win-media-keys');
  const isWindows = (window.electronAPI && typeof window.electronAPI.isWindows === 'boolean')
    ? window.electronAPI.isWindows
    : (navigator.userAgent.includes('Windows') || (navigator.platform && navigator.platform.includes('Win')));

  if (settingWinMediaKeys) {
    settingWinMediaKeys.style.display = isWindows ? '' : 'none';
  }

  // a new key, off by default: the old one was on for everyone, which hid Muriel from the Windows media overlay
  const savedWinMediaKeys = localStorage.getItem('muriel_win_global_media_keys') === 'true';
  if (btnWinMediaKeys) {
    btnWinMediaKeys.classList.toggle('active', savedWinMediaKeys);
    btnWinMediaKeys.addEventListener('click', () => {
      const next = !btnWinMediaKeys.classList.contains('active');
      btnWinMediaKeys.classList.toggle('active', next);
      localStorage.setItem('muriel_win_global_media_keys', next ? 'true' : 'false');
      if (window.electronAPI && window.electronAPI.setMediaKeys) {
        window.electronAPI.setMediaKeys(next);
      }
    });
  }
  if (window.electronAPI && window.electronAPI.setMediaKeys) {
    window.electronAPI.setMediaKeys(savedWinMediaKeys);
  }

  if (window.electronAPI && window.electronAPI.onMediaCommand) {
    window.electronAPI.onMediaCommand((cmd) => handleMediaCommand(cmd, 'ipc'));
  }
  function applyWelcomeResult(d) {
    if (!d) return;
    function setSwitch(btn, on) { if (btn && btn.classList.contains('active') !== !!on) btn.click(); }
    if (d.theme) {
      const modeBtn = document.querySelector(`.theme-mode-btn[data-theme-mode="${d.theme.b < 50 ? 'dark' : 'light'}"]`);
      if (modeBtn) modeBtn.click();
      const sH = document.getElementById('slider-theme-hue');
      // the sliders apply and save on 'change'; firing only 'input' moved the knob and kept the default theme
      const fire = (sl) => { sl.dispatchEvent(new Event('input', { bubbles: true })); sl.dispatchEvent(new Event('change', { bubbles: true })); };
      if (sH && d.theme.h !== undefined) { sH.value = d.theme.h; fire(sH); }
      const sB = document.getElementById('slider-theme-brightness');
      if (sB && d.theme.b !== undefined) {
        sB.value = Math.min(Math.max(d.theme.b, Number(sB.min) || 0), Number(sB.max) || 100);
        fire(sB);
      }
    }
    if (d.toggles) {
      setSwitch(document.getElementById('btn-show-local'), d.toggles.muriel_show_local);
      setSwitch(document.getElementById('btn-search-artists'), d.toggles.muriel_search_artists);
      setSwitch(document.getElementById('btn-no-hand-cursor'), d.toggles.muriel_no_hand_cursor);
      setSwitch(document.getElementById('btn-perf-mode'), d.toggles.muriel_perf_mode);
      if (d.toggles.muriel_custom_bg_enabled && d.background) {
        localStorage.setItem('muriel_bg_url', d.background);
        if (typeof updateCustomBg === 'function') updateCustomBg();
        if (typeof onBackgroundChanged === 'function') onBackgroundChanged('custom', true);
      }
    }
    if (d.spotify && d.spotify.url) {
      const btnOpen = document.getElementById('btn-open-spotify-import');
      if (btnOpen) btnOpen.click();
      const urlInput = document.getElementById('spotify-import-url');
      if (urlInput) urlInput.value = d.spotify.url;
      const targetInput = document.getElementById('spotify-import-target');
      if (targetInput) targetInput.value = 'new';
      const btnConfirm = document.getElementById('btn-confirm-spotify-import');
      if (btnConfirm) btnConfirm.click();
    }
    showToast(Tm('Welcome to Muriel!'), 'info');
  }
  if (window.electronAPI && window.electronAPI.onWelcomeResult) window.electronAPI.onWelcomeResult((d) => applyWelcomeResult(d));

  function checkCompactLayout() {
    // the tiny desktop mini-player window; phones get their own layout instead
    const isMini = window.innerWidth <= 520 && !(window.electronAPI && window.electronAPI.isMobile);
    document.body.classList.toggle('mini', isMini);
  }
  window.addEventListener('resize', checkCompactLayout);
  checkCompactLayout();

  async function toggleMiniWindow() {
    if (window.electronAPI && window.electronAPI.toggleMiniWindow) {
      const isNowMini = await window.electronAPI.toggleMiniWindow();
      // lyrics under the mini player (Riff 43): the window opens tall enough for them
      if (isNowMini && localStorage.getItem('muriel_mini_lyrics') === '1' && window.electronAPI.setMiniLyrics) {
        try { await window.electronAPI.setMiniLyrics(true); } catch (e) {}
      }
    }
  }
  window.toggleMiniWindow = toggleMiniWindow;

  const btnMiniPlayer = document.getElementById('btn-mini-player');
  if (btnMiniPlayer) {
    btnMiniPlayer.addEventListener('click', () => {
      toggleMiniWindow();
    });
  }

  const sliderCrossfade = document.getElementById('slider-crossfade');
  const valCrossfade = document.getElementById('val-crossfade');
  if (sliderCrossfade) {
    const cf = parseInt(localStorage.getItem('muriel_crossfade') || '0', 10);
    sliderCrossfade.value = cf;
    if (valCrossfade) valCrossfade.textContent = cf > 0 ? `${cf}s` : 'Off';
    sliderCrossfade.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valCrossfade) valCrossfade.textContent = v > 0 ? `${v}s` : 'Off';
      localStorage.setItem('muriel_crossfade', String(v));
    });
  }

  if (el.btnTrEnabled) {
    el.btnTrEnabled.addEventListener('click', () => {
      state.trEnabled = !state.trEnabled;
      localStorage.setItem('muriel_tr_enabled', String(state.trEnabled));
      updateLyricsTranslationUI();
      if (!state.trEnabled) {
        state.trActive = false;
        state.currentTranslations = null;
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      } else if (state.trAuto) {
        state.trActive = true;
        updateLyricsTranslationUI();
        fetchAndApplyTranslation();
      }
    });
  }

  const trLangDropdown = document.getElementById('tr-lang-dropdown');
  const trLangTrigger = document.getElementById('tr-lang-trigger');
  const trLangLabel = document.getElementById('tr-lang-label');
  const trLangMenu = document.getElementById('tr-lang-menu');
  const trLangList = document.getElementById('tr-lang-list');
  const trLangSearch = document.getElementById('tr-lang-search');

  if (trLangDropdown && trLangTrigger && trLangMenu) {
    const curLang = state.trLang || 'en';
    if (trLangList) {
      trLangList.innerHTML = '';
      const frag = document.createDocumentFragment();
      TRANSLATION_LANGUAGES.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'm3-dropdown-option';
        btn.dataset.value = item.code;
        const text = `${item.flag} ${item.name} (${item.code})`;
        btn.textContent = text;
        if (item.code === curLang) {
          btn.classList.add('selected');
          if (trLangLabel) trLangLabel.textContent = text;
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.trLang = item.code;
          localStorage.setItem('muriel_tr_lang', state.trLang);
          if (trLangLabel) trLangLabel.textContent = text;
          trLangMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
          btn.classList.add('selected');
          if (el.selectTrLang) el.selectTrLang.value = item.code;
          trLangDropdown.classList.remove('open');
          if (state.trActive) {
            fetchAndApplyTranslation();
          }
        });
        frag.appendChild(btn);
      });
      trLangList.appendChild(frag);

      if (el.selectTrLang) {
        el.selectTrLang.innerHTML = '';
        TRANSLATION_LANGUAGES.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.code;
          opt.textContent = `${item.flag} ${item.name} (${item.code})`;
          el.selectTrLang.appendChild(opt);
        });
        el.selectTrLang.value = curLang;
      }
    }

    if (trLangSearch) {
      trLangSearch.addEventListener('click', (e) => e.stopPropagation());
      trLangSearch.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        if (!trLangList) return;
        trLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => {
          const text = (opt.textContent || '').toLowerCase();
          const code = (opt.dataset.value || '').toLowerCase();
          opt.style.display = (!q || text.includes(q) || code.includes(q)) ? '' : 'none';
        });
      });
      trLangSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          trLangDropdown.classList.remove('open');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = trLangList ? trLangList.querySelector('.m3-dropdown-option:not([style*="display: none"])') : null;
          if (firstVisible) firstVisible.click();
        }
      });
    }

    trLangTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = trLangDropdown.classList.toggle('open');
      if (isOpen && trLangSearch) {
        trLangSearch.value = '';
        if (trLangList) {
          trLangList.querySelectorAll('.m3-dropdown-option').forEach(opt => opt.style.display = '');
        }
        setTimeout(() => trLangSearch.focus(), 50);
      }
    });

    document.addEventListener('click', () => {
      trLangDropdown.classList.remove('open');
    });
  }

  // ---- Settings → Interface → Language (i18n.js translates; this is only the picker) ----
  // The list stays in English names with flags and is never translated, so the way back is always readable.
  const uiLangDropdown = document.getElementById('ui-lang-dropdown');
  const uiLangTrigger = document.getElementById('ui-lang-trigger');
  const uiLangLabel = document.getElementById('ui-lang-label');
  const uiLangMenu = document.getElementById('ui-lang-menu');
  const uiLangList = document.getElementById('ui-lang-list');
  const uiLangSearch = document.getElementById('ui-lang-search');
  const uiLangText = (item) => `${item.flag} ${item.name} (${item.code})`;

  if (uiLangDropdown && uiLangTrigger && uiLangMenu && uiLangList) {
    const showUiLang = (code) => {
      const found = TRANSLATION_LANGUAGES.find((l) => l.code === code) || TRANSLATION_LANGUAGES.find((l) => l.code === 'en');
      if (uiLangLabel && found) uiLangLabel.textContent = uiLangText(found);
      uiLangList.querySelectorAll('.m3-dropdown-option').forEach((o) => o.classList.toggle('selected', o.dataset.value === code));
    };
    let uiLangPick = 0;
    const frag = document.createDocumentFragment();
    TRANSLATION_LANGUAGES.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'm3-dropdown-option';
      btn.dataset.value = item.code;
      btn.textContent = uiLangText(item);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        uiLangDropdown.classList.remove('open');
        if (item.code === I18N.lang) return;
        const pick = ++uiLangPick;
        showUiLang(item.code);
        // the arrow turns while the words are on their way
        uiLangTrigger.classList.add('is-busy');
        const ok = await I18N.setLang(item.code);
        if (pick !== uiLangPick) return;
        uiLangTrigger.classList.remove('is-busy');
        if (!ok) showToast(Tm("Couldn't reach the translation service. What is missing stays in English for now."), 'warning');
      });
      frag.appendChild(btn);
    });
    uiLangList.appendChild(frag);
    showUiLang(I18N.lang);
    // also when something else switched (window.applyI18n from a plugin)
    window.addEventListener('muriel:i18n', () => showUiLang(I18N.lang));

    if (uiLangSearch) {
      uiLangSearch.addEventListener('click', (e) => e.stopPropagation());
      uiLangSearch.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        uiLangList.querySelectorAll('.m3-dropdown-option').forEach((opt) => {
          const text = (opt.textContent || '').toLowerCase();
          const code = (opt.dataset.value || '').toLowerCase();
          opt.style.display = (!q || text.includes(q) || code.includes(q)) ? '' : 'none';
        });
      });
      uiLangSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          uiLangDropdown.classList.remove('open');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = uiLangList.querySelector('.m3-dropdown-option:not([style*="display: none"])');
          if (firstVisible) firstVisible.click();
        }
      });
    }

    uiLangTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = uiLangDropdown.classList.toggle('open');
      if (isOpen && uiLangSearch) {
        uiLangSearch.value = '';
        uiLangList.querySelectorAll('.m3-dropdown-option').forEach((opt) => { opt.style.display = ''; });
        const sel = uiLangList.querySelector('.m3-dropdown-option.selected');
        if (sel) uiLangList.scrollTop = Math.max(0, sel.getBoundingClientRect().top - uiLangList.getBoundingClientRect().top - uiLangList.clientHeight / 2);
        setTimeout(() => uiLangSearch.focus(), 50);
      }
    });

    document.addEventListener('click', () => {
      uiLangDropdown.classList.remove('open');
    });
  }

  if (el.btnTrAuto) {
    el.btnTrAuto.addEventListener('click', () => {
      state.trAuto = !state.trAuto;
      localStorage.setItem('muriel_tr_auto', String(state.trAuto));
      updateLyricsTranslationUI();
      if (state.trEnabled && state.trAuto && !state.trActive) {
        state.trActive = true;
        updateLyricsTranslationUI();
        fetchAndApplyTranslation();
      }
    });
  }

  const lyricsEaseDropdown = document.getElementById('lyrics-ease-dropdown');
  const lyricsEaseTrigger = document.getElementById('lyrics-ease-trigger');
  const lyricsEaseLabel = document.getElementById('lyrics-ease-label');
  const lyricsEaseMenu = document.getElementById('lyrics-ease-menu');

  if (lyricsEaseDropdown && lyricsEaseTrigger && lyricsEaseMenu) {
    const curEase = getLyricsEase();
    lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curEase;
      opt.classList.toggle('selected', isSel);
      if (isSel && lyricsEaseLabel) lyricsEaseLabel.textContent = opt.textContent;
    });

    lyricsEaseTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      lyricsEaseDropdown.classList.toggle('open');
    });

    lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('muriel_lyrics_ease', val);
        if (lyricsEaseLabel) lyricsEaseLabel.textContent = opt.textContent;
        lyricsEaseMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        applyLyricsEase();
        lyricsEaseDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      lyricsEaseDropdown.classList.remove('open');
    });
  }

  const sliderLyricsSpeed = document.getElementById('slider-lyrics-speed');
  const valLyricsSpeed = document.getElementById('val-lyrics-speed');
  if (sliderLyricsSpeed && valLyricsSpeed) {
    const currentSpeed = getLyricsSpeed();
    sliderLyricsSpeed.value = Math.round(currentSpeed * 10);
    valLyricsSpeed.textContent = `${currentSpeed.toFixed(1)}x`;

    sliderLyricsSpeed.addEventListener('input', () => {
      const val = parseInt(sliderLyricsSpeed.value, 10) / 10;
      valLyricsSpeed.textContent = `${val.toFixed(1)}x`;
      localStorage.setItem('muriel_lyrics_speed', val.toString());
      applyLyricsEase();
    });
  }

  const lyricsWordStyleDropdown = document.getElementById('lyrics-wordstyle-dropdown');
  const lyricsWordStyleTrigger = document.getElementById('lyrics-wordstyle-trigger');
  const lyricsWordStyleLabel = document.getElementById('lyrics-wordstyle-label');
  const lyricsWordStyleMenu = document.getElementById('lyrics-wordstyle-menu');

  if (lyricsWordStyleDropdown && lyricsWordStyleTrigger && lyricsWordStyleMenu) {
    const curStyle = getLyricsWordStyle();
    lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const isSel = opt.dataset.value === curStyle;
      opt.classList.toggle('selected', isSel);
      if (isSel && lyricsWordStyleLabel) lyricsWordStyleLabel.textContent = opt.textContent;
    });

    lyricsWordStyleTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      lyricsWordStyleDropdown.classList.toggle('open');
    });

    lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        localStorage.setItem('muriel_lyrics_word_style', val);
        if (lyricsWordStyleLabel) lyricsWordStyleLabel.textContent = opt.textContent;
        lyricsWordStyleMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
        lyricsWordStyleDropdown.classList.remove('open');
        renderLyricsView();
        if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
      });
    });

    document.addEventListener('click', () => {
      lyricsWordStyleDropdown.classList.remove('open');
    });
  }

  const sliderLyricsTightness = document.getElementById('slider-lyrics-tightness');
  const valLyricsTightness = document.getElementById('val-lyrics-tightness');
  if (sliderLyricsTightness && valLyricsTightness) {
    const currentTightness = getLyricsGradientTightness();
    sliderLyricsTightness.value = currentTightness;
    valLyricsTightness.textContent = `${currentTightness}%`;

    sliderLyricsTightness.addEventListener('input', () => {
      const val = parseInt(sliderLyricsTightness.value, 10);
      valLyricsTightness.textContent = `${val}%`;
      localStorage.setItem('muriel_lyrics_gradient_tightness', val.toString());
      localStorage.setItem('muriel_gradient_tight', val.toString());
      applyLyricsGradientTightness();
      updateActiveGradient();
    });
  }

  if (el.btnResetAudio) {
    el.btnResetAudio.addEventListener('click', () => {
      state.activePresetId = 'p_default';
      state.audioSettings = { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
      state.hqSettings = { engine: 'hqmusic-3', preset: 'studio', vocal: 0, air: 0, bass: 0 };
      state.hqEnabled = false;
      syncSettingsSlidersToState();
      applyAudioSettings();
      applyHqSettings();
      renderPresets();
      showToast(Tm('Audio settings reset'), 'info');
    });
  }

  const toggleNormalize = document.getElementById('toggle-normalize');
  if (toggleNormalize) {
    const isNorm = localStorage.getItem('muriel_audio_normalize') === '1';
    toggleNormalize.classList.toggle('active', isNorm);
    toggleNormalize.addEventListener('click', () => {
      const active = !toggleNormalize.classList.contains('active');
      toggleNormalize.classList.toggle('active', active);
      localStorage.setItem('muriel_audio_normalize', active ? '1' : '0');
      if (!active) resetLevelWatcher();
    });
  }

  if (window.electronAPI && window.electronAPI.getAppVersion) {
    window.electronAPI.getAppVersion().then((v) => {
      const a = document.getElementById('about-version'); if (a) a.textContent = 'Version ' + v;
      const t = document.querySelector('.settings-version-tag'); if (t) t.textContent = 'v' + v;
    }).catch(() => {});
  }

  function isTextInput(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
  }

  function adjustVolume(delta) {
    state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 100) / 100));
    state.isMuted = false;
    syncVolumeControls();
    persistVolumeState();
    applyAudioSettings();
  }

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isTextInput(e.target)) {
      e.preventDefault();
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    // Encore (full-screen) handles its own keys; shortcuts here acted on the app hidden behind it
    if (document.querySelector('.encore')) return;
    const inInput = isTextInput(e.target);

    if (e.code === 'Escape' || e.key === 'Escape') {
      const openModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)'));
      if (openModals.length > 0) {
        e.preventDefault();
        closeModal(openModals[openModals.length - 1]);
        return;
      }
      const tvkPanel = document.getElementById('tvk-panel');
      if (state.isTvKaraokeOpen && tvkPanel && tvkPanel.classList.contains('open')) {
        e.preventDefault();
        tvkPanel.classList.remove('open');
        const btnSettings = document.getElementById('btn-tvk-settings');
        if (btnSettings) btnSettings.classList.remove('open');
        resetTvIdleTimer();
        return;
      }
      if (state.isTvKaraokeOpen && typeof closeTvKaraoke === 'function') {
        e.preventDefault();
        closeTvKaraoke();
        return;
      }
      if (inInput) {
        e.preventDefault();
        e.target.blur();
        return;
      }
      if (state.currentView === 'album') {
        e.preventDefault();
        const target = (state.previousView && state.previousView !== 'album') ? state.previousView : 'discover';
        switchView(target);
        return;
      }
      if (state.currentView === 'artist') {
        e.preventDefault();
        const target = (state.previousView && state.previousView !== 'artist') ? state.previousView : 'discover';
        switchView(target);
        return;
      }
      return;
    }

    if (inInput) {
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        return;
      }
    }

    if (e.code === 'Space') {
      e.preventDefault();
      if (syncState && syncState.active && syncState.currentIndex < syncState.lines.length) {
        handleSyncLineClick(syncState.currentIndex);
      } else {
        togglePlayPause();
      }
      return;
    }

    if ((e.code === 'KeyK' && (e.ctrlKey || e.metaKey)) || (!inInput && (e.code === 'Slash' || e.key === '/'))) {
      e.preventDefault();
      if (el.searchInput) {
        el.searchInput.focus();
        el.searchInput.select();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        e.preventDefault();
        playNext();
        return;
      }
      if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        e.preventDefault();
        playPrev();
        return;
      }
      if (e.code === 'ArrowUp' || e.key === 'ArrowUp') {
        e.preventDefault();
        adjustVolume(0.05);
        return;
      }
      if (e.code === 'ArrowDown' || e.key === 'ArrowDown') {
        e.preventDefault();
        adjustVolume(-0.05);
        return;
      }
    }

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (el.nativeAudio) el.nativeAudio.currentTime = Math.min(el.nativeAudio.duration || 0, el.nativeAudio.currentTime + 5);
        return;
      }
      if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (el.nativeAudio) el.nativeAudio.currentTime = Math.max(0, el.nativeAudio.currentTime - 5);
        return;
      }
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (el.btnVolumeMute) el.btnVolumeMute.click();
        return;
      }
      if (e.code === 'KeyH') {
        e.preventDefault();
        if (typeof window.toggleShuffle === 'function') window.toggleShuffle();
        return;
      }
      if (e.code === 'KeyR') {
        e.preventDefault();
        if (typeof window.toggleRepeat === 'function') window.toggleRepeat();
        return;
      }
      if (e.code === 'KeyL') {
        e.preventDefault();
        if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.click();
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        if (typeof openTvKaraoke === 'function') openTvKaraoke();
        return;
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        if (typeof toggleMiniWindow === 'function') toggleMiniWindow();
        return;
      }
    }
  }, true);

  function createWavyProgress(container) {
    const W = 240, H = 12, WL = 16; let d = `M0 ${H/2}`;
    for (let x = 0; x < W; x += WL) d += ` q ${WL/4} ${-H/2} ${WL/2} 0 t ${WL/2} 0`;
    container.innerHTML = `<svg class="wavy" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="wavy-track" pathLength="100" d="${d}"/><path class="wavy-fill" pathLength="100" d="${d}"/></svg>`;
    const fill = container.querySelector('.wavy-fill'); fill.style.strokeDasharray = '100'; fill.style.strokeDashoffset = '100';
    return { set(p) { fill.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, p))); } };
  }
  window.createWavyProgress = createWavyProgress;

  async function pool(items, n, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur], cur);
      }
    }
    const workers = Array.from({ length: Math.min(n, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  function normalizeImportText(str) {
    if (!str) return '';
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*[\(\[](?:feat|ft)\.?\s+[^)\]]+[)\]]/gi, '')
      .replace(/\s*-\s*remaster(?:ed)?\b.*/gi, '')
      .replace(/[\(\[][^)\]]*remaster(?:ed)?[^)\]]*[)\]]/gi, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toSeconds(dur) {
    if (typeof dur === 'string') {
      const trimmed = dur.trim();
      if (/^\d+(:\d{1,2}){1,2}$/.test(trimmed)) {
        return trimmed.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
      }
      const num = Number(trimmed);
      if (!Number.isNaN(num) && num > 0) {
        return num > 1000 ? Math.round(num / 1000) : Math.round(num);
      }
      return 0;
    }
    if (typeof dur === 'number' && dur > 0) {
      return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
    }
    return 0;
  }

  function splitArtists(artistStr) {
    if (!artistStr) return [];
    const clean = String(artistStr).replace(/\u00a0/g, ' ');
    return clean
      .split(/[,;&]|(?:\bfeat\.?\b)|(?:\bft\.?\b)|(?:\s+[xX]\s+)/i)
      .map(a => normalizeImportText(a))
      .filter(Boolean);
  }

  const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
  function normalizeForMatch(s) {
    return String(s || '').toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/\b(feat|ft|remaster(ed)?|remix|version|official|audio|video|lyrics?)\b.*$/g, ' ')
      .split('').map((c) => (CYR[c] !== undefined ? CYR[c] : c)).join('')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // the artist has to match as well as the title, covers / live / sped-up uploads lose (#18; track-match.js)
  const pickBestMatch = (sp, results) => window.trackMatch.pickBestMatch(sp, results);

  async function matchSpotifyTracks(list, onProgress) {
    const total = Array.isArray(list) ? list.length : 0;
    let completed = 0;
    let errorCount = 0;
    let nomatchCount = 0;
    let aborted = false;
    const errorMap = {};

    if (typeof onProgress === 'function') onProgress(0, total);

    async function searchCandidates(q, plat = state.platform || 'youtube') {
      const sRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(q)}&platform=${plat}&limit=8`);
      const sData = await sRes.json();
      if (sData && sData.success && Array.isArray(sData.tracks)) {
        return sData.tracks.slice(0, 8);
      }
      throw new Error((sData && sData.error) || `Status ${sRes.status}`);
    }

    const results = await pool(list || [], 6, async (t) => {
      if (aborted) return null;
      let matched = null;
      let lastErr = null;
      let hadCandidates = false;

      // YouTube Music's song results (artist-tagged official audio) first, then the chosen source
      const plat = state.platform || 'youtube';
      const platforms = plat === 'soundcloud' ? ['soundcloud'] : Array.from(new Set(['ytmusic', plat]));
      const queries = window.trackMatch.matchQueries(t);
      const q1 = queries[0] || '';
      outer: for (const p of platforms) {
        for (const q of queries) {
          if (aborted) break outer;
          try {
            const r = await searchCandidates(q, p);
            hadCandidates = true;
            matched = pickBestMatch(t, r);
            if (matched) break outer;
          } catch (e) {
            lastErr = e.message || String(e);
          }
        }
      }

      const fullText = `${t.artist || ''} ${t.title || ''}`;
      if (!matched && !aborted && /[а-яёіїєґ]/i.test(fullText)) {
        const q3 = normalizeForMatch(fullText);
        if (q3 && q3 !== q1) {
          try {
            const r3 = await searchCandidates(q3);
            hadCandidates = true;
            matched = pickBestMatch(t, r3);
          } catch (e) {
            lastErr = e.message || String(e);
          }
        }
      }

      completed++;
      if (!matched) {
        if (!hadCandidates && lastErr) {
          errorCount++;
          errorMap[lastErr] = (errorMap[lastErr] || 0) + 1;
        } else {
          nomatchCount++;
        }
      }

      if (completed <= 8 && completed === errorCount) {
        if (completed === 8) {
          aborted = true;
        }
      }

      if (typeof onProgress === 'function') onProgress(completed, total);
      return matched;
    });

    if (aborted) {
      throw new Error('search_unresponsive');
    }

    let commonError = '';
    let maxErrCount = 0;
    for (const [k, v] of Object.entries(errorMap)) {
      if (v > maxErrCount) {
        maxErrCount = v;
        commonError = k;
      }
    }

    const matchedTracks = results.filter(Boolean);
    matchedTracks.failStats = {
      errors: errorCount,
      nomatch: nomatchCount,
      commonError
    };
    return matchedTracks;
  }

  const spotifyModal = document.getElementById('spotify-import-modal');
  const btnOpenSpotifyImport = document.getElementById('btn-open-spotify-import');
  const btnCancelSpotifyImport = document.getElementById('btn-cancel-spotify-import');
  const btnConfirmSpotifyImport = document.getElementById('btn-confirm-spotify-import');
  const spotifyImportUrl = document.getElementById('spotify-import-url');
  const spotifyImportTarget = document.getElementById('spotify-import-target');
  const spotifyTargetDropdown = document.getElementById('spotify-target-dropdown');
  const spotifyTargetTrigger = document.getElementById('spotify-target-trigger');
  const spotifyTargetLabel = document.getElementById('spotify-target-label');
  const spotifyTargetMenu = document.getElementById('spotify-target-menu');
  const spotifyProgressWrap = document.getElementById('spotify-import-progress-wrap');
  const spotifyWavyContainer = document.getElementById('spotify-import-wavy-container');
  const spotifyProgressLabel = document.getElementById('spotify-import-progress-label');
  const spotifyStatus = document.getElementById('spotify-import-status');
  const spotifyLinkError = document.getElementById('spotify-link-error');
  const spotifyBtnIcon = document.getElementById('spotify-import-btn-icon');
  const spotifyBtnText = document.getElementById('spotify-import-btn-text');

  const spModesContainer = document.getElementById('sp-modes');
  const btnSpPickFiles = document.getElementById('btn-sp-pick-files');
  const spFileInput = document.getElementById('sp-file-input');
  const spFileInfo = document.getElementById('sp-file-info');
  const spChkLikes = document.getElementById('sp-chk-likes');
  const spChkPlaylists = document.getElementById('sp-chk-playlists');
  const spClientIdInput = document.getElementById('sp-client-id');
  const btnSpLogin = document.getElementById('btn-sp-login');
  const spRedirectUri = document.getElementById('sp-redirect-uri');
  const spLoginStatus = document.getElementById('sp-login-status');
  const spChkLikes2 = document.getElementById('sp-chk-likes-2');
  const spChkPlaylists2 = document.getElementById('sp-chk-playlists-2');
  let currentSpotifyImportMode = 'link';
  let parsedSpotifyExport = { likes: [], playlists: [] };
  let spLoginPollTimer = null;
  let spotifyConnected = false;
  const spotifyHeaders = { 'X-Muriel-Token': window.electronAPI?.serverToken || '' };

  async function checkSpotifyAuthStatus() {
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-status`, { headers: spotifyHeaders });
      const data = await res.json();
      spotifyConnected = !!data.connected;
      if (spLoginStatus) {
        if (spotifyConnected) {
          spLoginStatus.textContent = data.error ? `Connected · ${data.error}` : 'Connected';
          spLoginStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
        } else {
          spLoginStatus.textContent = data.error || 'Not connected';
          spLoginStatus.style.color = data.error ? 'var(--md-sys-color-error, #ba1a1a)' : 'var(--md-sys-color-outline)';
        }
      }
      if (currentSpotifyImportMode === 'login' && btnConfirmSpotifyImport && btnConfirmSpotifyImport.dataset.action !== 'done') {
        btnConfirmSpotifyImport.disabled = !spotifyConnected;
      }
    } catch (e) {}
  }

  function classifyImportError(provider, statusOrError, body) {
    let status = typeof statusOrError === 'number' ? statusOrError : 0;
    let rawMsg = '';
    if (statusOrError instanceof Error) {
      rawMsg = statusOrError.message || String(statusOrError);
    }
    if (typeof body === 'string') {
      rawMsg = rawMsg ? `${rawMsg} ${body}` : body;
    } else if (body && typeof body === 'object') {
      if (body.status && !status) status = Number(body.status);
      if (body.error) rawMsg = rawMsg ? `${rawMsg} ${body.error}` : String(body.error);
    }
    const msg = (rawMsg || '').toLowerCase();

    const lockIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
    const searchIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    const clockIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const networkIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
    const restrictedIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
    const unknownIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

    if (body && typeof body === 'object') {
      if (body.code === 'spotify_incomplete') {
        return { code: 'spotify_incomplete', title: 'Spotify returned only part of this playlist', hint: 'Connect your account or use Export files', icon: restrictedIcon };
      }
      if (body.code === 'spotify_forbidden' || (provider === 'spotify' && status === 403)) {
        return { code: 'spotify_forbidden', title: 'Spotify refused this playlist request (403)', hint: 'Try connecting an authorized account or use Export files', icon: restrictedIcon };
      }
      if (body.code === 'spotify_rate_limited' || (provider === 'spotify' && status === 429)) {
        return { code: 'spotify_rate_limited', title: 'Spotify is rate limiting requests. Wait a minute and try again.', hint: '', icon: clockIcon };
      }
      if (body.code === 'spotify_not_found' || (provider === 'spotify' && status === 404)) {
        return { code: 'spotify_not_found', title: 'Playlist not found. Is it public?', hint: '', icon: searchIcon };
      }
      if (body.code === 'yandex_region') {
        return { code: 'yandex_region', title: "Yandex Music isn't available where you are", hint: 'Yandex only serves some countries', icon: restrictedIcon };
      }
      if (body.code === 'yandex_private') {
        return { code: 'yandex_private', title: "Yandex Music didn't share this playlist", hint: 'Make it public in Yandex Music, or use its older link: music.yandex.ru/users/NAME/playlists/NUMBER', icon: lockIcon };
      }
      if (body.code === 'yandex_failed') {
        return { code: 'yandex_failed', title: "Couldn't read this playlist from Yandex Music", hint: 'Try again later, or use Export files', icon: unknownIcon };
      }
    }

    if (!navigator.onLine || msg.includes('network') || msg.includes('fetch') || msg.includes('dns') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('offline') || msg.includes('etimedout')) {
      return { code: 'network', title: "Can't reach the service", hint: 'Check your connection', icon: networkIcon };
    }
    if (status === 429 || msg.includes('429') || msg.includes('too many requests')) {
      let hint = 'Try again in a minute';
      const mRetry = msg.match(/retry-after:?\s*(\d+)/i) || msg.match(/try again in\s*(\d+)/i);
      if (mRetry) hint = `Try again in ${mRetry[1]}s`;
      return { code: 'rate_limit', title: 'Too many requests', hint, icon: clockIcon };
    }
    if (status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('deleted') || msg.includes('does not exist') || msg.includes('incomplete youtube id') || msg.includes('unsupported link') || msg.includes('invalid spotify playlist url') || msg.includes('invalid apple music playlist url')) {
      return { code: 'not_found', title: 'Playlist not found', hint: 'Check the link', icon: searchIcon };
    }
    if (msg.includes('private') || msg.includes('isprivate') || msg.includes('sign in') || msg.includes('signin') || status === 401 || (provider !== 'spotify' && (status === 403 || msg.includes('403')))) {
      return { code: 'private', title: 'Your playlist is private', hint: 'Make it public and try again', icon: lockIcon };
    }
    if (status === 403 || msg.includes('403') || msg.includes('forbidden') || msg.includes('restricted') || msg.includes('refused')) {
      return { code: 'restricted', title: provider === 'spotify' ? "Spotify doesn't allow reading this playlist" : "This service doesn't allow reading this playlist", hint: 'Try the Export files method', icon: restrictedIcon };
    }
    return { code: 'unknown', title: "Couldn't read this playlist", hint: (provider === 'spotify' || provider === 'apple') ? 'Try the Export files method' : 'Check the link', icon: unknownIcon };
  }

  function showImportError(containerEl, errInfo) {
    if (!containerEl) return;
    containerEl.innerHTML = `
      <div class="import-error-icon">${errInfo.icon}</div>
      <div class="import-error-content">
        <div class="import-error-title">${escapeHtml(T(errInfo.title))}</div>
        <div class="import-error-hint">${escapeHtml(errInfo.hint ? T(errInfo.hint) : '')}</div>
      </div>
    `;
    containerEl.classList.remove('hidden');
  }

  function clearImportError(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    containerEl.classList.add('hidden');
  }

  function setSpotifyImportMode(mode) {
    currentSpotifyImportMode = mode || 'link';
    if (spModesContainer) {
      spModesContainer.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentSpotifyImportMode);
      });
    }
    clearImportError(spotifyLinkError);
    if (spotifyModal) {
      spotifyModal.querySelectorAll('.sp-pane').forEach(pane => {
        pane.classList.toggle('hidden', pane.dataset.mode !== currentSpotifyImportMode);
      });
    }
    if (spotifyStatus) {
      spotifyStatus.classList.add('hidden');
      spotifyStatus.textContent = '';
      spotifyStatus.style.color = '';
    }
    if (currentSpotifyImportMode === 'login') {
      checkSpotifyAuthStatus();
    } else {
      if (btnConfirmSpotifyImport && btnConfirmSpotifyImport.dataset.action !== 'done') {
        btnConfirmSpotifyImport.disabled = false;
      }
    }
  }

  if (spModesContainer) {
    spModesContainer.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        setSpotifyImportMode(btn.dataset.mode);
      });
    });
  }

  if (spClientIdInput) {
    const savedId = localStorage.getItem('muriel_spotify_client_id') || '';
    spClientIdInput.value = savedId;
    if (btnSpLogin) {
      btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(savedId.trim());
    }
    spClientIdInput.addEventListener('input', () => {
      const val = spClientIdInput.value.trim();
      localStorage.setItem('muriel_spotify_client_id', val);
      if (btnSpLogin) {
        btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(val);
      }
    });
  }

  if (btnSpLogin) {
    btnSpLogin.addEventListener('click', async () => {
      const clientId = spClientIdInput ? spClientIdInput.value.trim() : '';
      if (!/^[a-f0-9]{32}$/i.test(clientId)) {
        if (spLoginStatus) {
          spLoginStatus.textContent = 'Invalid Client ID';
          spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        }
        return;
      }

      if (spLoginStatus) {
        spLoginStatus.textContent = 'Starting login...';
        spLoginStatus.style.color = 'var(--md-sys-color-on-surface-variant)';
      }

      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-auth-start?clientId=${encodeURIComponent(clientId)}`, { headers: spotifyHeaders });
        const data = await res.json();
        if (!data.success) {
          if (spLoginStatus) {
            spLoginStatus.textContent = data.error || 'Failed to start auth';
            spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          }
          return;
        }

        if (spRedirectUri && data.redirectUri) {
          spRedirectUri.textContent = data.redirectUri;
        }

        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
          window.electronAPI.openExternal(data.url);
        } else {
          window.open(data.url, '_blank');
        }

        if (spLoginStatus) {
          spLoginStatus.textContent = 'Waiting for login in browser...';
          spLoginStatus.style.color = 'var(--md-sys-color-on-surface-variant)';
        }

        if (spLoginPollTimer) clearInterval(spLoginPollTimer);
        let elapsed = 0;
        spLoginPollTimer = setInterval(async () => {
          elapsed += 2000;
          if (elapsed > 180000) {
            clearInterval(spLoginPollTimer);
            spLoginPollTimer = null;
            if (spLoginStatus) {
              spLoginStatus.textContent = 'Login timed out';
              spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
            }
            return;
          }
          try {
            const sRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-status`, { headers: spotifyHeaders });
            const sData = await sRes.json();
            if (sData.connected) {
              clearInterval(spLoginPollTimer);
              spLoginPollTimer = null;
              spotifyConnected = true;
              if (spLoginStatus) {
                spLoginStatus.textContent = sData.error ? `Connected · ${sData.error}` : 'Connected';
                spLoginStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
              }
              if (currentSpotifyImportMode === 'login' && btnConfirmSpotifyImport) {
                btnConfirmSpotifyImport.disabled = false;
              }
            } else if (sData.error) {
              clearInterval(spLoginPollTimer);
              spLoginPollTimer = null;
              if (spLoginStatus) {
                spLoginStatus.textContent = sData.error;
                spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
              }
              return;
            }
          } catch (e) {}
        }, 2000);
      } catch (err) {
        if (spLoginStatus) {
          spLoginStatus.textContent = err.message || 'Error connecting to server';
          spLoginStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        }
      }
    });
  }

  if (btnSpPickFiles && spFileInput) {
    btnSpPickFiles.addEventListener('click', () => spFileInput.click());
    spFileInput.addEventListener('change', async () => {
      parsedSpotifyExport = { likes: [], playlists: [] };
      const files = Array.from(spFileInput.files || []);
      if (!files.length) {
        if (spFileInfo) spFileInfo.textContent = 'No files selected';
        return;
      }
      const names = [];
      for (const file of files) {
        names.push(file.name);
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          const rawTracks = Array.isArray(json?.tracks) ? json.tracks : (Array.isArray(json) ? json : null);
          if (rawTracks) {
            for (const item of rawTracks) {
              const title = item.track || item.trackName;
              const artist = item.artist || item.artistName;
              // msPlayed (streaming history) is how long it was listened to, not how long the song is
              const durMs = item.durationMs || item.duration_ms;
              const duration = durMs ? Math.round(durMs / 1000) : undefined;
              if (title && artist) {
                parsedSpotifyExport.likes.push({ title: String(title).trim(), artist: String(artist).trim(), duration });
              }
            }
          }
          const rawPlaylists = Array.isArray(json?.playlists) ? json.playlists : (Array.isArray(json) && json[0]?.items ? json : null);
          if (rawPlaylists) {
            for (const pl of rawPlaylists) {
              const plName = pl.name || 'Imported Playlist';
              const plTracks = [];
              const items = Array.isArray(pl.items) ? pl.items : [];
              for (const it of items) {
                if (!it || !it.track) continue;
                const title = it.track.trackName || it.track.track;
                const artist = it.track.artistName || it.track.artist;
                const durMs = it.track.durationMs || it.track.duration_ms;
                const duration = durMs ? Math.round(durMs / 1000) : undefined;
                if (title && artist) {
                  plTracks.push({ title: String(title).trim(), artist: String(artist).trim(), duration });
                }
              }
              if (plTracks.length) {
                parsedSpotifyExport.playlists.push({ name: plName, tracks: plTracks });
              }
            }
          }
        } catch (e) {}
      }
      // a streaming-history file lists a song once per play: 60 plays of 3 songs meant 60 searches
      const seenLikes = new Set();
      parsedSpotifyExport.likes = parsedSpotifyExport.likes.filter((t) => {
        const k = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}`;
        if (seenLikes.has(k)) return false;
        seenLikes.add(k);
        return true;
      });
      if (spFileInfo) spFileInfo.textContent = names.join(', ');
    });
  }

  if (spotifyTargetTrigger && spotifyTargetDropdown) {
    spotifyTargetTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      spotifyTargetDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      spotifyTargetDropdown.classList.remove('open');
    });
  }

  function openSpotifyImportModal() {
    if (!spotifyModal) return;
    if (spLoginPollTimer) { clearInterval(spLoginPollTimer); spLoginPollTimer = null; }
    setSpotifyImportMode('link');
    parsedSpotifyExport = { likes: [], playlists: [] };
    if (spFileInput) spFileInput.value = '';
    if (spFileInfo) spFileInfo.textContent = 'No files selected';
    if (spChkLikes) { spChkLikes.checked = true; spChkLikes.disabled = false; }
    if (spChkPlaylists) { spChkPlaylists.checked = true; spChkPlaylists.disabled = false; }
    if (spChkLikes2) { spChkLikes2.checked = true; spChkLikes2.disabled = false; }
    if (spChkPlaylists2) { spChkPlaylists2.checked = true; spChkPlaylists2.disabled = false; }
    if (btnSpPickFiles) btnSpPickFiles.disabled = false;
    const savedId = localStorage.getItem('muriel_spotify_client_id') || '';
    if (spClientIdInput) spClientIdInput.value = savedId;
    if (btnSpLogin) btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(savedId.trim());
    if (spRedirectUri) spRedirectUri.textContent = `http://127.0.0.1:${state.serverPort || 38472}/api/spotify-callback`;
    if (spotifyImportUrl) {
      spotifyImportUrl.value = '';
      spotifyImportUrl.disabled = false;
    }
    clearImportError(spotifyLinkError);
    if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = false;
    if (spotifyImportTarget) {
      spotifyImportTarget.disabled = false;
      spotifyImportTarget.innerHTML = '<option value="new">New playlist (Spotify name)</option>';
      state.playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        spotifyImportTarget.appendChild(opt);
      });
      spotifyImportTarget.value = 'new';
    }
    if (spotifyTargetMenu) {
      spotifyTargetMenu.innerHTML = '<button class="m3-dropdown-option selected" data-value="new" type="button">New playlist (Spotify name)</button>';
      if (spotifyTargetLabel) spotifyTargetLabel.textContent = 'New playlist (Spotify name)';
      state.playlists.forEach(p => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'm3-dropdown-option';
        opt.dataset.value = p.id;
        opt.textContent = p.name || 'untitled';
        spotifyTargetMenu.appendChild(opt);
      });
      spotifyTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          if (spotifyImportTarget) spotifyImportTarget.value = val;
          if (spotifyTargetLabel) spotifyTargetLabel.textContent = opt.textContent;
          spotifyTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          if (spotifyTargetDropdown) spotifyTargetDropdown.classList.remove('open');
        });
      });
    }
    if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
    if (spotifyWavyContainer) spotifyWavyContainer.innerHTML = '';
    if (spotifyStatus) {
      spotifyStatus.classList.add('hidden');
      spotifyStatus.textContent = '';
      spotifyStatus.style.color = '';
    }
    if (btnConfirmSpotifyImport) {
      btnConfirmSpotifyImport.disabled = false;
      if (spotifyBtnIcon) spotifyBtnIcon.classList.remove('hidden');
      if (spotifyBtnText) spotifyBtnText.textContent = 'Import from Spotify';
      btnConfirmSpotifyImport.dataset.action = 'import';
    }
    if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    openModal(spotifyModal);
    if (spotifyImportUrl) spotifyImportUrl.focus();
  }

  function closeSpotifyImportModal() {
    if (spLoginPollTimer) { clearInterval(spLoginPollTimer); spLoginPollTimer = null; }
    if (spotifyModal) closeModal(spotifyModal);
  }

  const importErrorText = (err, fallback = 'Failed to import tracks') => (err && err.message === 'search_unresponsive'
    ? 'Search is not responding, so the import stopped. Try again later; nothing gets added twice. If it keeps happening, open Settings -> About -> Copy diagnostics and send it with your report.'
    : (err && err.message) || fallback);

  // adds the songs that aren't favorites yet (one pass with a Set; comparing every pair froze big imports)
  function mergeIntoFavorites(tracks) {
    const have = new Set(state.favorites.map(getTrackCanonicalId));
    let added = 0;
    for (const track of tracks || []) {
      const id = getTrackCanonicalId(track);
      if (have.has(id)) continue;
      have.add(id);
      state.favorites.push(stampAddedAt(track));
      added++;
    }
    return added;
  }

  async function runSpotifyImport({ likes = [], playlists = [], skippedPlaylists = [] }) {
    const likesToImport = likes || [];
    const playlistsToImport = playlists || [];
    const totalItemsCount = likesToImport.length + playlistsToImport.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);

    if (totalItemsCount === 0) {
      if (spotifyStatus) {
        spotifyStatus.textContent = 'No tracks found to import';
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      return;
    }

    if (spotifyStatus) spotifyStatus.classList.add('hidden');
    if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = true;
    if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = true;
    if (btnSpPickFiles) btnSpPickFiles.disabled = true;
    if (btnSpLogin) btnSpLogin.disabled = true;
    if (spChkLikes) spChkLikes.disabled = true;
    if (spChkPlaylists) spChkPlaylists.disabled = true;
    if (spChkLikes2) spChkLikes2.disabled = true;
    if (spChkPlaylists2) spChkPlaylists2.disabled = true;

    if (spotifyProgressWrap) spotifyProgressWrap.classList.remove('hidden');
    if (spotifyProgressLabel) spotifyProgressLabel.textContent = `0 / ${totalItemsCount}`;
    const wavy = spotifyWavyContainer ? createWavyProgress(spotifyWavyContainer) : { set() {} };
    wavy.set(0);

    if (totalItemsCount > 2000 && spotifyStatus) {
      spotifyStatus.textContent = `This will take a while (${totalItemsCount} tracks)`;
      spotifyStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
      spotifyStatus.classList.remove('hidden');
    }

    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');

    let globalCompleted = 0;
    let totalFoundCount = 0;
    try {
      if (likesToImport.length > 0) {
        const foundLikes = await matchSpotifyTracks(likesToImport, (completed) => {
          const cur = globalCompleted + completed;
          wavy.set(Math.round((cur / totalItemsCount) * 100));
          if (spotifyProgressLabel) spotifyProgressLabel.textContent = `${cur} / ${totalItemsCount}`;
        });
        globalCompleted += likesToImport.length;
        totalFoundCount += foundLikes.length;
        const addedFav = mergeIntoFavorites(foundLikes) > 0;
        if (addedFav) {
          localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
          updateFavoritesBadge();
          updateFavoriteIcon();
          if (state.currentView === 'favorites') renderFavoritesView();
        }
      }

      if (playlistsToImport.length > 0) {
        // match every playlist before creating any: a failure half way left some behind, and a retry made them twice
        const matched = [];
        for (const pl of playlistsToImport) {
          const found = await matchSpotifyTracks(pl.tracks || [], (completed) => {
            const cur = globalCompleted + completed;
            wavy.set(Math.round((cur / totalItemsCount) * 100));
            if (spotifyProgressLabel) spotifyProgressLabel.textContent = `${cur} / ${totalItemsCount}`;
          });
          globalCompleted += (pl.tracks || []).length;
          totalFoundCount += found.length;
          matched.push([pl, found]);
        }
        matched.forEach(([pl, found]) => createPlaylist(pl.name, found, pl.cover || ''));
      }

      const notFound = totalItemsCount - totalFoundCount;
      if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
      const finishMsg = (notFound > 0
        ? `Imported ${totalFoundCount} tracks (${notFound} skipped)`
        : `Imported ${totalFoundCount} tracks`) + (skippedPlaylists.length ? `; ${skippedPlaylists.length} Spotify playlists unavailable` : '');
      if (spotifyStatus) {
        spotifyStatus.textContent = finishMsg;
        spotifyStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
        spotifyStatus.classList.remove('hidden');
      }
      if (typeof showToast === 'function') showToast(finishMsg, 'success');

      if (btnConfirmSpotifyImport) {
        btnConfirmSpotifyImport.disabled = false;
        if (spotifyBtnIcon) spotifyBtnIcon.classList.add('hidden');
        if (spotifyBtnText) spotifyBtnText.textContent = 'Done';
        btnConfirmSpotifyImport.dataset.action = 'done';
      }
      if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    } catch (err) {
      if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
      if (spotifyStatus) {
        spotifyStatus.textContent = importErrorText(err);
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
      if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    } finally {
      if (btnSpPickFiles) btnSpPickFiles.disabled = false;
      if (btnSpLogin && spClientIdInput) btnSpLogin.disabled = !/^[a-f0-9]{32}$/i.test(spClientIdInput.value.trim());
      if (spChkLikes) spChkLikes.disabled = false;
      if (spChkPlaylists) spChkPlaylists.disabled = false;
      if (spChkLikes2) spChkLikes2.disabled = false;
      if (spChkPlaylists2) spChkPlaylists2.disabled = false;
      if (hasBusy && typeof endBusy === 'function') endBusy('import');
    }
  }

  async function handleSpotifyFileImport() {
    const doLikes = !!(spChkLikes && spChkLikes.checked);
    const doPlaylists = !!(spChkPlaylists && spChkPlaylists.checked);

    if (!doLikes && !doPlaylists) {
      if (spotifyStatus) {
        spotifyStatus.textContent = 'Select at least Liked songs or Playlists';
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      return;
    }

    const likesToImport = doLikes ? (parsedSpotifyExport.likes || []) : [];
    const playlistsToImport = doPlaylists ? (parsedSpotifyExport.playlists || []) : [];
    if (!likesToImport.length && !playlistsToImport.length) {
      if (spotifyStatus) {
        spotifyStatus.textContent = 'No tracks found in the selected files';
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      return;
    }
    await runSpotifyImport({ likes: likesToImport, playlists: playlistsToImport });
  }

  async function handleSpotifyLoginImport() {
    const doLikes = !!(spChkLikes2 && spChkLikes2.checked);
    const doPlaylists = !!(spChkPlaylists2 && spChkPlaylists2.checked);

    if (!doLikes && !doPlaylists) {
      if (spotifyStatus) {
        spotifyStatus.textContent = 'Select at least Liked songs or Playlists';
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      return;
    }

    if (spotifyStatus) {
      spotifyStatus.textContent = 'Fetching Spotify library...';
      spotifyStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
      spotifyStatus.classList.remove('hidden');
    }
    if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = true;
    if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = true;

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-library?likes=${doLikes ? 1 : 0}&playlists=${doPlaylists ? 1 : 0}`, { headers: spotifyHeaders });
      const data = await res.json();
      if (!data.success) {
        if (spotifyStatus) {
          spotifyStatus.textContent = data.error || 'Failed to fetch Spotify library';
          spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          spotifyStatus.classList.remove('hidden');
        }
        if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
        if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
        return;
      }

      if (!(data.likes?.length || data.playlists?.some(pl => pl.tracks?.length))) {
        if (spotifyStatus) {
          spotifyStatus.textContent = data.partial
            ? `No available tracks to import. ${(data.skippedPlaylists || []).map(pl => `${pl.name}: ${pl.error}`).join('; ')}`
            : 'No tracks found in your Spotify library';
          spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          spotifyStatus.classList.remove('hidden');
        }
        if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
        if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
        return;
      }
      if (data.partial) {
        const skipped = data.skippedPlaylists || [];
        const details = skipped.map(pl => `• ${pl.name}: ${pl.error}`).join('\n');
        if (!window.confirm(`${skipped.length} Spotify playlist(s) could not be read:\n${details}\n\nImport the available tracks only?`)) {
          if (spotifyStatus) {
            spotifyStatus.textContent = 'Partial import cancelled';
            spotifyStatus.classList.remove('hidden');
          }
          if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
          if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
          return;
        }
      }
      await runSpotifyImport({ likes: data.likes || [], playlists: data.playlists || [], skippedPlaylists: data.skippedPlaylists || [] });
    } catch (err) {
      if (spotifyStatus) {
        spotifyStatus.textContent = err.message || 'Failed to fetch Spotify library';
        spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
        spotifyStatus.classList.remove('hidden');
      }
      if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
      if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    }
  }

  async function handleSpotifyImportAction() {
    if (btnConfirmSpotifyImport && btnConfirmSpotifyImport.dataset.action === 'done') {
      closeSpotifyImportModal();
      return;
    }

    if (currentSpotifyImportMode === 'file') {
      return handleSpotifyFileImport();
    }

    if (currentSpotifyImportMode === 'login') {
      return handleSpotifyLoginImport();
    }

    const url = spotifyImportUrl ? spotifyImportUrl.value.trim() : '';
    if (!url) {
      const errInfo = classifyImportError('spotify', 404, 'invalid spotify playlist url');
      showImportError(spotifyLinkError, errInfo);
      return;
    }

    clearImportError(spotifyLinkError);
    if (spotifyStatus) {
      spotifyStatus.classList.add('hidden');
      spotifyStatus.textContent = '';
    }
    if (spotifyImportUrl) spotifyImportUrl.disabled = true;
    if (spotifyImportTarget) spotifyImportTarget.disabled = true;
    if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = true;
    if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = true;
    if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = true;

    if (spotifyProgressWrap) spotifyProgressWrap.classList.remove('hidden');
    if (spotifyProgressLabel) spotifyProgressLabel.textContent = '0 / 0';
    const wavy = spotifyWavyContainer ? createWavyProgress(spotifyWavyContainer) : { set() {} };
    wavy.set(0);

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-import?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
        const errInfo = classifyImportError('spotify', res.status, data);
        showImportError(spotifyLinkError, errInfo);
        if (spotifyImportUrl) spotifyImportUrl.disabled = false;
        if (spotifyImportTarget) spotifyImportTarget.disabled = false;
        if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = false;
        if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
        if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
        return;
      }

      const tracks = data.tracks;
      const total = tracks.length;
      if (spotifyProgressLabel) spotifyProgressLabel.textContent = `0 / ${total}`;

      let foundTracks;
      try {
        foundTracks = await matchSpotifyTracks(tracks, (completed, tot) => {
          wavy.set(Math.round((completed / tot) * 100));
          if (spotifyProgressLabel) spotifyProgressLabel.textContent = `${completed} / ${tot}`;
        });
      } catch (err) {
        if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
        const msg = importErrorText(err, 'Import failed');
        if (spotifyStatus) {
          spotifyStatus.textContent = msg;
          spotifyStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          spotifyStatus.classList.remove('hidden');
        }
        if (typeof showToast === 'function') showToast(msg, 'error');
        if (spotifyImportUrl) spotifyImportUrl.disabled = false;
        if (spotifyImportTarget) spotifyImportTarget.disabled = false;
        if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = false;
        if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
        if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
        return;
      }
      const notFound = total - foundTracks.length;

      const targetVal = spotifyImportTarget ? spotifyImportTarget.value : 'new';
      if (targetVal === 'new') {
        createPlaylist(data.name || 'Spotify Playlist', foundTracks, data.cover || '');
      } else {
        const pl = state.playlists.find(p => p.id === targetVal);
        if (pl) {
          if (!pl.cover && data.cover) pl.cover = data.cover;
          const existingIds = new Set(pl.tracks.map(t => t.id));
          const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
          pl.tracks.push(...newTracks.map(stampAddedAt));
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          renderPlaylistsList();
        }
      }

      if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
      let finishMsg = `Imported ${foundTracks.length} tracks.`;
      if (notFound > 0) {
        finishMsg = `Imported ${foundTracks.length} tracks. ${notFound} not found.`;
        const fs = foundTracks.failStats || {};
        if (fs.errors > notFound / 2 && fs.commonError) {
          finishMsg += ` Search errors: ${fs.commonError}`;
        }
      }
      if (window.__riffLogError) window.__riffLogError('INFO', 'Import summary: ' + finishMsg);
      if (spotifyStatus) {
        spotifyStatus.textContent = finishMsg;
        spotifyStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
        spotifyStatus.classList.remove('hidden');
      }
      if (typeof showToast === 'function') showToast(finishMsg, 'success');

      if (btnConfirmSpotifyImport) {
        btnConfirmSpotifyImport.disabled = false;
        if (spotifyBtnIcon) spotifyBtnIcon.classList.add('hidden');
        if (spotifyBtnText) spotifyBtnText.textContent = 'Done';
        btnConfirmSpotifyImport.dataset.action = 'done';
      }
      if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    } catch (err) {
      if (spotifyProgressWrap) spotifyProgressWrap.classList.add('hidden');
      const errInfo = classifyImportError('spotify', err, err.message);
      showImportError(spotifyLinkError, errInfo);
      if (spotifyImportUrl) spotifyImportUrl.disabled = false;
      if (spotifyImportTarget) spotifyImportTarget.disabled = false;
      if (spotifyTargetTrigger) spotifyTargetTrigger.disabled = false;
      if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.disabled = false;
      if (btnCancelSpotifyImport) btnCancelSpotifyImport.disabled = false;
    }
  }

  if (btnOpenSpotifyImport) btnOpenSpotifyImport.addEventListener('click', openSpotifyImportModal);
  if (btnCancelSpotifyImport) btnCancelSpotifyImport.addEventListener('click', closeSpotifyImportModal);
  if (btnConfirmSpotifyImport) btnConfirmSpotifyImport.addEventListener('click', handleSpotifyImportAction);
  if (spotifyImportUrl) {
    spotifyImportUrl.addEventListener('input', () => clearImportError(spotifyLinkError));
    spotifyImportUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSpotifyImportAction();
      }
    });
  }

  const appleModal = document.getElementById('apple-import-modal');
  const btnOpenAppleImport = document.getElementById('btn-open-apple-import');
  const btnCancelAppleImport = document.getElementById('btn-cancel-apple-import');
  const btnConfirmAppleImport = document.getElementById('btn-confirm-apple-import');
  const appleImportUrl = document.getElementById('apple-import-url');
  const appleLinkError = document.getElementById('apple-link-error');
  const appleImportTarget = document.getElementById('apple-import-target');
  const appleTargetDropdown = document.getElementById('apple-target-dropdown');
  const appleTargetTrigger = document.getElementById('apple-target-trigger');
  const appleTargetLabel = document.getElementById('apple-target-label');
  const appleTargetMenu = document.getElementById('apple-target-menu');
  const appleModesContainer = document.getElementById('apple-modes');
  const btnApplePickFiles = document.getElementById('btn-apple-pick-files');
  const appleFileInput = document.getElementById('apple-file-input');
  const appleFileInfo = document.getElementById('apple-file-info');
  const appleChkContainer = document.getElementById('apple-chk-container');
  const appleChkLikes = document.getElementById('apple-chk-likes');
  const appleChkPlaylists = document.getElementById('apple-chk-playlists');
  const appleFileSummary = document.getElementById('apple-file-summary');
  const appleProgressWrap = document.getElementById('apple-import-progress-wrap');
  const appleWavyContainer = document.getElementById('apple-import-wavy-container');
  const appleProgressLabel = document.getElementById('apple-import-progress-label');
  const appleStatus = document.getElementById('apple-import-status');
  const appleBtnIcon = document.getElementById('apple-import-btn-icon');
  const appleBtnText = document.getElementById('apple-import-btn-text');

  let currentAppleImportMode = 'link';
  let parsedAppleExport = { likes: [], playlists: [] };

  function parseAppleDuration(val) {
    if (val == null) return undefined;
    const s = String(val).trim();
    if (!s) return undefined;
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.some(isNaN)) return undefined;
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    const n = Number(s);
    if (!isNaN(n)) return n > 1000 ? Math.round(n / 1000) : Math.round(n);
    return undefined;
  }

  function parseAppleCSV(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { headers: [], rows: [] };
    const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
    function splitRow(row) {
      const res = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (c === '"') {
          if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (c === delim && !inQuotes) {
          res.push(cur.trim());
          cur = '';
        } else cur += c;
      }
      res.push(cur.trim());
      return res;
    }
    const headers = splitRow(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = splitRow(lines[i]);
      const row = {};
      for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] || '';
      rows.push(row);
    }
    return { headers, rows };
  }

  function parseAppleExportCSV(text) {
    const { headers, rows } = parseAppleCSV(text);
    const titleCol = headers.find(h => /^(title|name|track\s*name|song(\s*name)?|track\s*description)$/i.test(h)) || headers.find(h => /(title|song|track)/i.test(h));
    const artistCol = headers.find(h => /^(artist(\s*name)?|artist\(s\)|creator|uploader)$/i.test(h)) || headers.find(h => /artist/i.test(h));
    const durCol = headers.find(h => /(duration|time|length)/i.test(h));
    const plCol = headers.find(h => /(playlist(\s*name)?|container(\s*description|\s*name)?)/i.test(h));

    const likes = [];
    const playlistsMap = new Map();

    for (const r of rows) {
      const title = titleCol ? r[titleCol] : '';
      const artist = artistCol ? r[artistCol] : '';
      if (!title || !artist) continue;
      const dur = durCol ? parseAppleDuration(r[durCol]) : undefined;
      const pl = plCol ? r[plCol].trim() : '';
      const track = { title: title.trim(), artist: artist.trim(), duration: dur };
      if (pl) {
        if (!playlistsMap.has(pl)) playlistsMap.set(pl, []);
        playlistsMap.get(pl).push(track);
      } else {
        likes.push(track);
      }
    }
    const playlists = [];
    for (const [name, tracks] of playlistsMap.entries()) playlists.push({ name, tracks });
    return { likes, playlists };
  }

  function parseAppleExportJSON(json) {
    const likes = [];
    const playlistsMap = new Map();

    function walk(node, currentPl = '') {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, currentPl);
        return;
      }
      // Apple's own export writes "Title", "Artist", "Track Duration": also look keys up in lower case, like the CSV path
      const lowered = {};
      for (const [k, v] of Object.entries(node)) { lowered[k] = v; const lk = k.toLowerCase(); if (!(lk in lowered)) lowered[lk] = v; }
      node = lowered;

      let pl = currentPl;
      if (node.playlistName || node.playlist || node['playlist name']) {
        pl = node.playlistName || node.playlist || node['playlist name'];
      }

      if (Array.isArray(node.tracks) && (node.name || node.title)) {
        const pName = node.name || node.title;
        for (const t of node.tracks) walk(t, pName);
        return;
      }
      if (Array.isArray(node.items) && (node.name || node.title)) {
        const pName = node.name || node.title;
        for (const t of node.items) walk(t, pName);
        return;
      }

      const title = String(node.title || node.name || node.trackName || node.song || node['track name'] || node['song name'] || '').trim();
      const artist = String(node.artistName || node.artist || node.artist_name || node['artist name'] || '').trim();
      const durRaw = node.durationInMillis || node.duration || node.duration_ms || node.time || node.trackDuration || node['track duration'];
      const duration = parseAppleDuration(durRaw);

      if (title && artist && (node.type === 'song' || node.type === 'songs' || duration || pl || node.contentDescriptor)) {
        const track = { title, artist, duration };
        if (pl) {
          if (!playlistsMap.has(pl)) playlistsMap.set(pl, []);
          playlistsMap.get(pl).push(track);
        } else {
          likes.push(track);
        }
        return;
      }

      for (const k of Object.keys(node)) {
        walk(node[k], pl);
      }
    }

    walk(json);
    const playlists = [];
    for (const [name, tracks] of playlistsMap.entries()) playlists.push({ name, tracks });
    return { likes, playlists };
  }

  function setAppleImportMode(mode) {
    currentAppleImportMode = mode || 'link';
    if (appleModesContainer) {
      appleModesContainer.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentAppleImportMode);
      });
    }
    clearImportError(appleLinkError);
    if (appleModal) {
      appleModal.querySelectorAll('.sp-pane').forEach(pane => {
        pane.classList.toggle('hidden', pane.dataset.mode !== currentAppleImportMode);
      });
    }
    if (appleStatus) {
      appleStatus.classList.add('hidden');
      appleStatus.textContent = '';
      appleStatus.style.color = '';
    }
    if (btnConfirmAppleImport && btnConfirmAppleImport.dataset.action !== 'done') {
      btnConfirmAppleImport.disabled = false;
    }
  }

  if (appleModesContainer) {
    appleModesContainer.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        setAppleImportMode(btn.dataset.mode);
      });
    });
  }

  if (btnApplePickFiles && appleFileInput) {
    btnApplePickFiles.addEventListener('click', () => {
      appleFileInput.click();
    });

    appleFileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      parsedAppleExport = { likes: [], playlists: [] };
      const names = [];
      for (const file of files) {
        names.push(file.name);
        try {
          const text = await file.text();
          if (file.name.toLowerCase().endsWith('.json')) {
            const json = JSON.parse(text);
            const res = parseAppleExportJSON(json);
            parsedAppleExport.likes.push(...res.likes);
            parsedAppleExport.playlists.push(...res.playlists);
          } else {
            const res = parseAppleExportCSV(text);
            parsedAppleExport.likes.push(...res.likes);
            parsedAppleExport.playlists.push(...res.playlists);
          }
        } catch (err) {}
      }
      if (appleFileInfo) appleFileInfo.textContent = names.join(', ');

      const hasLikes = parsedAppleExport.likes.length > 0;
      const hasPlaylists = parsedAppleExport.playlists.length > 0;

      if (hasLikes && hasPlaylists) {
        if (appleChkContainer) appleChkContainer.classList.remove('hidden');
        if (appleChkLikes) { appleChkLikes.checked = true; appleChkLikes.disabled = false; }
        if (appleChkPlaylists) { appleChkPlaylists.checked = true; appleChkPlaylists.disabled = false; }
        if (appleFileSummary) {
          appleFileSummary.classList.remove('hidden');
          appleFileSummary.textContent = `Found ${parsedAppleExport.likes.length} liked songs and ${parsedAppleExport.playlists.length} playlists`;
        }
      } else {
        if (appleChkContainer) appleChkContainer.classList.add('hidden');
        if (appleFileSummary) {
          appleFileSummary.classList.remove('hidden');
          if (hasPlaylists) {
            const totalTracks = parsedAppleExport.playlists.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);
            appleFileSummary.textContent = `Found ${parsedAppleExport.playlists.length} playlists (${totalTracks} tracks)`;
          } else if (hasLikes) {
            appleFileSummary.textContent = `Found ${parsedAppleExport.likes.length} liked tracks`;
          } else {
            appleFileSummary.textContent = 'No tracks found in selected files';
          }
        }
      }
    });
  }

  if (appleTargetTrigger && appleTargetDropdown) {
    appleTargetTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      appleTargetDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      appleTargetDropdown.classList.remove('open');
    });
  }

  function openAppleImportModal() {
    if (!appleModal) return;
    setAppleImportMode('link');
    parsedAppleExport = { likes: [], playlists: [] };
    if (appleFileInput) appleFileInput.value = '';
    if (appleFileInfo) appleFileInfo.textContent = 'No files selected';
    if (appleChkContainer) appleChkContainer.classList.add('hidden');
    if (appleChkLikes) { appleChkLikes.checked = true; appleChkLikes.disabled = false; }
    if (appleChkPlaylists) { appleChkPlaylists.checked = true; appleChkPlaylists.disabled = false; }
    if (appleFileSummary) { appleFileSummary.classList.add('hidden'); appleFileSummary.textContent = ''; }
    if (btnApplePickFiles) btnApplePickFiles.disabled = false;
    if (appleImportUrl) {
      appleImportUrl.value = '';
      appleImportUrl.disabled = false;
    }
    clearImportError(appleLinkError);
    if (appleTargetTrigger) appleTargetTrigger.disabled = false;
    if (appleImportTarget) {
      appleImportTarget.disabled = false;
      appleImportTarget.innerHTML = '<option value="new">New playlist (Apple Music name)</option>';
      state.playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        appleImportTarget.appendChild(opt);
      });
      appleImportTarget.value = 'new';
    }
    if (appleTargetMenu) {
      appleTargetMenu.innerHTML = '<button class="m3-dropdown-option selected" data-value="new" type="button">New playlist (Apple Music name)</button>';
      if (appleTargetLabel) appleTargetLabel.textContent = 'New playlist (Apple Music name)';
      state.playlists.forEach(p => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'm3-dropdown-option';
        opt.dataset.value = p.id;
        opt.textContent = p.name || 'untitled';
        appleTargetMenu.appendChild(opt);
      });
      appleTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          if (appleImportTarget) appleImportTarget.value = val;
          if (appleTargetLabel) appleTargetLabel.textContent = opt.textContent;
          appleTargetMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          if (appleTargetDropdown) appleTargetDropdown.classList.remove('open');
        });
      });
    }
    if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
    if (appleWavyContainer) appleWavyContainer.innerHTML = '';
    if (appleStatus) {
      appleStatus.classList.add('hidden');
      appleStatus.textContent = '';
      appleStatus.style.color = '';
    }
    if (btnConfirmAppleImport) {
      btnConfirmAppleImport.disabled = false;
      if (appleBtnIcon) appleBtnIcon.classList.remove('hidden');
      if (appleBtnText) appleBtnText.textContent = 'Import from Apple Music';
      btnConfirmAppleImport.dataset.action = 'import';
    }
    if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
    openModal(appleModal);
    if (appleImportUrl) appleImportUrl.focus();
  }

  function closeAppleImportModal() {
    if (appleModal) closeModal(appleModal);
  }

  async function handleAppleImportAction() {
    if (btnConfirmAppleImport && btnConfirmAppleImport.dataset.action === 'done') {
      closeAppleImportModal();
      return;
    }

    if (currentAppleImportMode === 'file') {
      const hasLikes = parsedAppleExport.likes.length > 0;
      const hasPlaylists = parsedAppleExport.playlists.length > 0;
      let likesToImport = [];
      let playlistsToImport = [];

      if (hasLikes && hasPlaylists) {
        if (appleChkLikes && appleChkLikes.checked) likesToImport = parsedAppleExport.likes;
        if (appleChkPlaylists && appleChkPlaylists.checked) playlistsToImport = parsedAppleExport.playlists;
      } else if (hasPlaylists) {
        playlistsToImport = parsedAppleExport.playlists;
      } else if (hasLikes) {
        likesToImport = parsedAppleExport.likes;
      }

      const totalItemsCount = likesToImport.length + playlistsToImport.reduce((acc, p) => acc + (p.tracks ? p.tracks.length : 0), 0);
      if (totalItemsCount === 0) {
        if (appleStatus) {
          appleStatus.textContent = 'No tracks selected or found to import';
          appleStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          appleStatus.classList.remove('hidden');
        }
        return;
      }

      if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = true;
      if (btnCancelAppleImport) btnCancelAppleImport.disabled = true;
      if (btnApplePickFiles) btnApplePickFiles.disabled = true;
      if (appleChkLikes) appleChkLikes.disabled = true;
      if (appleChkPlaylists) appleChkPlaylists.disabled = true;

      if (appleProgressWrap) appleProgressWrap.classList.remove('hidden');
      if (appleProgressLabel) appleProgressLabel.textContent = `0 / ${totalItemsCount}`;
      const wavy = appleWavyContainer ? createWavyProgress(appleWavyContainer) : { set() {} };
      wavy.set(0);

      const hasBusy = typeof beginBusy === 'function';
      if (hasBusy) beginBusy('import');

      let globalCompleted = 0;
      let totalFoundCount = 0;
      try {
        if (likesToImport.length > 0) {
          const foundLikes = await matchSpotifyTracks(likesToImport, (completed) => {
            const cur = globalCompleted + completed;
            wavy.set(Math.round((cur / totalItemsCount) * 100));
            if (appleProgressLabel) appleProgressLabel.textContent = `${cur} / ${totalItemsCount}`;
          });
          globalCompleted += likesToImport.length;
          totalFoundCount += foundLikes.length;
          const addedFav = mergeIntoFavorites(foundLikes) > 0;
          if (addedFav) {
            localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
            updateFavoritesBadge();
            updateFavoriteIcon();
            if (state.currentView === 'favorites') renderFavoritesView();
          }
        }

        if (playlistsToImport.length > 0) {
          // match every playlist before creating any (see the Spotify import)
          const matched = [];
          for (const pl of playlistsToImport) {
            const found = await matchSpotifyTracks(pl.tracks || [], (completed) => {
              const cur = globalCompleted + completed;
              wavy.set(Math.round((cur / totalItemsCount) * 100));
              if (appleProgressLabel) appleProgressLabel.textContent = `${cur} / ${totalItemsCount}`;
            });
            globalCompleted += (pl.tracks || []).length;
            totalFoundCount += found.length;
            matched.push([pl, found]);
          }
          matched.forEach(([pl, found]) => createPlaylist(pl.name, found, pl.cover || ''));
        }

        const notFound = totalItemsCount - totalFoundCount;
        if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
        const finishMsg = notFound > 0
          ? `Imported ${totalFoundCount} tracks (${notFound} skipped)`
          : `Imported ${totalFoundCount} tracks`;
        if (appleStatus) {
          appleStatus.textContent = finishMsg;
          appleStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
          appleStatus.classList.remove('hidden');
        }
        if (typeof showToast === 'function') showToast(finishMsg, 'success');

        if (btnConfirmAppleImport) {
          btnConfirmAppleImport.disabled = false;
          if (appleBtnIcon) appleBtnIcon.classList.add('hidden');
          if (appleBtnText) appleBtnText.textContent = 'Done';
          btnConfirmAppleImport.dataset.action = 'done';
        }
        if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
      } catch (err) {
        if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
        if (appleStatus) {
          appleStatus.textContent = importErrorText(err);
          appleStatus.style.color = 'var(--md-sys-color-error, #ba1a1a)';
          appleStatus.classList.remove('hidden');
        }
        if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = false;
        if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
      } finally {
        if (btnApplePickFiles) btnApplePickFiles.disabled = false;
        if (appleChkLikes) appleChkLikes.disabled = false;
        if (appleChkPlaylists) appleChkPlaylists.disabled = false;
        if (hasBusy && typeof endBusy === 'function') endBusy('import');
      }
      return;
    }

    const url = appleImportUrl ? appleImportUrl.value.trim() : '';
    if (!url) {
      const errInfo = classifyImportError('apple', 404, 'invalid apple music playlist url');
      showImportError(appleLinkError, errInfo);
      return;
    }

    clearImportError(appleLinkError);
    if (appleStatus) {
      appleStatus.classList.add('hidden');
      appleStatus.textContent = '';
    }
    if (appleImportUrl) appleImportUrl.disabled = true;
    if (appleImportTarget) appleImportTarget.disabled = true;
    if (appleTargetTrigger) appleTargetTrigger.disabled = true;
    if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = true;
    if (btnCancelAppleImport) btnCancelAppleImport.disabled = true;

    if (appleProgressWrap) appleProgressWrap.classList.remove('hidden');
    if (appleProgressLabel) appleProgressLabel.textContent = '0 / 0';
    const wavy = appleWavyContainer ? createWavyProgress(appleWavyContainer) : { set() {} };
    wavy.set(0);

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/apple-import?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
        const errInfo = classifyImportError('apple', res.status, data);
        showImportError(appleLinkError, errInfo);
        if (appleImportUrl) appleImportUrl.disabled = false;
        if (appleImportTarget) appleImportTarget.disabled = false;
        if (appleTargetTrigger) appleTargetTrigger.disabled = false;
        if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = false;
        if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
        return;
      }

      const tracks = data.tracks;
      const total = tracks.length;
      if (appleProgressLabel) appleProgressLabel.textContent = `0 / ${total}`;

      const foundTracks = await matchSpotifyTracks(tracks, (completed, tot) => {
        wavy.set(Math.round((completed / tot) * 100));
        if (appleProgressLabel) appleProgressLabel.textContent = `${completed} / ${tot}`;
      });
      const notFound = total - foundTracks.length;

      const targetVal = appleImportTarget ? appleImportTarget.value : 'new';
      if (targetVal === 'new') {
        createPlaylist(data.name || 'Apple Music Playlist', foundTracks, data.cover || '');
      } else {
        const pl = state.playlists.find(p => p.id === targetVal);
        if (pl) {
          if (!pl.cover && data.cover) pl.cover = data.cover;
          const existingIds = new Set(pl.tracks.map(t => t.id));
          const newTracks = foundTracks.filter(t => !existingIds.has(t.id));
          pl.tracks.push(...newTracks.map(stampAddedAt));
          localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
          renderPlaylistsList();
        }
      }

      if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
      let finishMsg = notFound > 0
        ? `Imported ${foundTracks.length} tracks (${notFound} skipped)`
        : `Imported ${foundTracks.length} tracks`;
      if (data.hasMore) {
        finishMsg += `. Imported the first ${tracks.length} tracks. Use Export files to import everything.`;
      }
      if (appleStatus) {
        appleStatus.textContent = finishMsg;
        appleStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
        appleStatus.classList.remove('hidden');
      }
      if (typeof showToast === 'function') showToast(finishMsg, 'success');

      if (btnConfirmAppleImport) {
        btnConfirmAppleImport.disabled = false;
        if (appleBtnIcon) appleBtnIcon.classList.add('hidden');
        if (appleBtnText) appleBtnText.textContent = 'Done';
        btnConfirmAppleImport.dataset.action = 'done';
      }
      if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
    } catch (err) {
      if (appleProgressWrap) appleProgressWrap.classList.add('hidden');
      const errInfo = classifyImportError('apple', err, err.message);
      showImportError(appleLinkError, errInfo);
      if (appleImportUrl) appleImportUrl.disabled = false;
      if (appleImportTarget) appleImportTarget.disabled = false;
      if (appleTargetTrigger) appleTargetTrigger.disabled = false;
      if (btnConfirmAppleImport) btnConfirmAppleImport.disabled = false;
      if (btnCancelAppleImport) btnCancelAppleImport.disabled = false;
    }
  }

  if (btnOpenAppleImport) btnOpenAppleImport.addEventListener('click', openAppleImportModal);
  if (btnCancelAppleImport) btnCancelAppleImport.addEventListener('click', closeAppleImportModal);
  if (btnConfirmAppleImport) btnConfirmAppleImport.addEventListener('click', handleAppleImportAction);
  if (appleImportUrl) {
    appleImportUrl.addEventListener('input', () => clearImportError(appleLinkError));
    appleImportUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAppleImportAction();
      }
    });
  }

  const linkImportModal = document.getElementById('link-import-modal');
  const btnOpenLinkImport = document.getElementById('btn-open-link-import');
  const btnCancelLinkImport = document.getElementById('btn-cancel-link-import');
  const btnConfirmLinkImport = document.getElementById('btn-confirm-link-import');
  const linkImportUrl = document.getElementById('link-import-url');
  const linkImportStatus = document.getElementById('link-import-status');
  const linkImportError = document.getElementById('link-import-error');
  const linkImportTitle = document.getElementById('link-import-title');
  const linkModesContainer = document.getElementById('link-modes');
  const linkImportProgressWrap = document.getElementById('link-import-progress-wrap');
  const linkImportProgressLabel = document.getElementById('link-import-progress-label');
  const linkImportWavyContainer = document.getElementById('link-import-wavy-container');
  const btnGoogleLogin = document.getElementById('btn-google-login');
  const btnGoogleLogout = document.getElementById('btn-google-logout');
  const googleLoginStatus = document.getElementById('google-login-status');
  const googleChkLikes = document.getElementById('google-chk-likes');
  const googleChkPlaylists = document.getElementById('google-chk-playlists');
  let currentLinkImportMode = 'link';
  let currentLinkImportPlatform = '';
  let googleConnected = false;
  // YouTube / YouTube Music "Log in" (desktop): the Google login lives in its own browser storage in main.js
  // (google-library.js), one per profile; this page only learns whether it is logged in and gets the songs back
  const googleApi = () => (window.electronAPI && typeof window.electronAPI.googleImportLibrary === 'function' && !window.electronAPI.isMobile ? window.electronAPI : null);
  const googleProfile = () => (window.MurielProfiles && window.MurielProfiles.id) || 'default';

  function setLinkStatus(text, isError) {
    if (!linkImportStatus) return;
    linkImportStatus.textContent = text || '';
    linkImportStatus.style.color = isError ? 'var(--md-sys-color-error, #ba1a1a)' : 'var(--md-sys-color-primary, #6750A4)';
    linkImportStatus.classList.toggle('hidden', !text);
  }

  function setLinkImportBusy(busy, label) {
    if (linkImportUrl) linkImportUrl.disabled = busy;
    if (btnConfirmLinkImport) {
      btnConfirmLinkImport.disabled = busy || (currentLinkImportMode === 'login' && !googleConnected);
      btnConfirmLinkImport.textContent = label || (busy ? 'Loading…' : 'Import');
    }
    if (btnCancelLinkImport) btnCancelLinkImport.disabled = busy;
    ['link-target-trigger', 'google-target-trigger', 'btn-google-login', 'btn-google-logout'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = busy; });
  }

  // "Import into": a new playlist, or one of yours (the hidden <select> holds the choice)
  function fillImportTarget(prefix, newLabel) {
    const sel = document.getElementById(`${prefix}-import-target`);
    const menu = document.getElementById(`${prefix}-target-menu`);
    const label = document.getElementById(`${prefix}-target-label`);
    const drop = document.getElementById(`${prefix}-target-dropdown`);
    const trigger = document.getElementById(`${prefix}-target-trigger`);
    if (!sel || !menu) return;
    sel.innerHTML = '';
    menu.innerHTML = '';
    const add = (value, text, selected) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm3-dropdown-option' + (selected ? ' selected' : '');
      b.dataset.value = value;
      b.textContent = text;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.value = value;
        if (label) label.textContent = text;
        menu.querySelectorAll('.m3-dropdown-option').forEach((o) => o.classList.toggle('selected', o === b));
        if (drop) drop.classList.remove('open');
      });
      menu.appendChild(b);
    };
    add('new', newLabel, true);
    state.playlists.forEach((p) => add(p.id, p.name || 'untitled', false));
    sel.value = 'new';
    if (label) label.textContent = newLabel;
    if (trigger && drop && !trigger._targetBound) {
      trigger._targetBound = true;
      trigger.addEventListener('click', (e) => { e.stopPropagation(); drop.classList.toggle('open'); });
      document.addEventListener('click', () => drop.classList.remove('open'));
    }
  }

  // songs into the playlist picked under "Import into" (or a new one, opened unless several come in a row);
  // returns how many went in
  function addImportedTracks(targetId, name, tracks, cover, open = true) {
    const target = targetId && targetId !== 'new' ? state.playlists.find((p) => p.id === targetId) : null;
    if (!target) {
      const pl = createPlaylist(name || 'Imported playlist', tracks, cover || '', { open });
      return pl ? pl.tracks.length : 0;
    }
    if (!target.cover && cover) target.cover = cover;
    const fresh = tracks.filter((t) => !target.tracks.some((x) => isSameTrack(x, t)));
    target.tracks.push(...fresh.map(stampAddedAt));
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    renderPlaylistsList();
    if (state.currentView === 'playlist-detail' && state.currentPlaylistId === target.id) openPlaylistDetail(target.id);
    return fresh.length;
  }

  function updateGoogleAuthUI() {
    if (googleLoginStatus) {
      googleLoginStatus.textContent = googleConnected ? 'Connected' : 'Not connected';
      googleLoginStatus.style.color = googleConnected ? 'var(--md-sys-color-primary, #6750A4)' : 'var(--md-sys-color-outline)';
    }
    if (btnGoogleLogin) btnGoogleLogin.textContent = googleConnected ? 'Switch account' : 'Log in with Google';
    if (btnGoogleLogout) btnGoogleLogout.classList.toggle('hidden', !googleConnected);
    if (currentLinkImportMode === 'login' && btnConfirmLinkImport && btnConfirmLinkImport.dataset.action !== 'done') btnConfirmLinkImport.disabled = !googleConnected;
  }

  async function checkGoogleAuthStatus() {
    const api = googleApi();
    try { googleConnected = !!(api && (await api.googleAuthStatus(googleProfile())).loggedIn); } catch (e) { googleConnected = false; }
    updateGoogleAuthUI();
  }

  function setLinkImportMode(mode) {
    currentLinkImportMode = mode === 'login' && googleApi() ? 'login' : 'link';
    if (linkModesContainer) linkModesContainer.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === currentLinkImportMode));
    if (linkImportModal) linkImportModal.querySelectorAll('.link-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.mode !== currentLinkImportMode));
    clearImportError(linkImportError);
    setLinkStatus('');
    if (btnConfirmLinkImport && btnConfirmLinkImport.dataset.action !== 'done') {
      btnConfirmLinkImport.textContent = 'Import';
      btnConfirmLinkImport.disabled = currentLinkImportMode === 'login' && !googleConnected;
    }
    if (currentLinkImportMode === 'login') checkGoogleAuthStatus();
  }

  if (linkModesContainer) linkModesContainer.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setLinkImportMode(b.dataset.mode)));

  if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener('click', async () => {
      const api = googleApi();
      if (!api) return;
      if (googleLoginStatus) { googleLoginStatus.textContent = 'Logging in…'; googleLoginStatus.style.color = 'var(--md-sys-color-on-surface-variant)'; }
      try { googleConnected = !!(await api.googleLogin(googleProfile())).loggedIn; } catch (e) {}
      updateGoogleAuthUI();
      // Google often refuses sign-ins inside an app window ("This browser or app may not be secure", #10):
      // say so, and point to what still works without a login
      if (!googleConnected && googleLoginStatus) {
        googleLoginStatus.textContent = T('Not connected. If Google said this browser or app may not be secure, it blocks sign-ins inside apps: import your public playlists with their link instead.');
      }
    });
  }
  if (btnGoogleLogout) {
    btnGoogleLogout.addEventListener('click', async () => {
      const api = googleApi();
      try { if (api) await api.googleLogout(googleProfile()); } catch (e) {}
      googleConnected = false;
      updateGoogleAuthUI();
    });
  }

  function openLinkImportModal(platform = '') {
    if (!linkImportModal) return;
    currentLinkImportPlatform = platform || '';
    clearImportError(linkImportError);
    const titles = { youtube: 'Import from YouTube', ytmusic: 'Import from YouTube Music', soundcloud: 'Import from SoundCloud', yandex: 'Import from Yandex Music' };
    if (linkImportTitle) linkImportTitle.textContent = T(titles[platform] || 'Import from link');
    // logging in to Google works for YouTube and YouTube Music, and only in the desktop app
    if (linkModesContainer) linkModesContainer.classList.toggle('hidden', !(googleApi() && (platform === 'youtube' || platform === 'ytmusic')));
    if (linkImportUrl) {
      linkImportUrl.value = '';
      linkImportUrl.disabled = false;
      if (platform === 'youtube') {
        linkImportUrl.placeholder = T('Paste a YouTube playlist or video link');
      } else if (platform === 'ytmusic') {
        linkImportUrl.placeholder = T('Paste a YouTube Music link');
      } else if (platform === 'soundcloud') {
        linkImportUrl.placeholder = T('Paste a SoundCloud playlist or track link');
      } else if (platform === 'yandex') {
        linkImportUrl.placeholder = T('Paste a Yandex Music playlist, album or song link');
      } else {
        linkImportUrl.placeholder = T('Paste a YouTube, YouTube Music, SoundCloud or Yandex Music link');
      }
    }
    fillImportTarget('link', T('New playlist'));
    fillImportTarget('google', T('Separate playlists'));
    if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
    if (linkImportWavyContainer) linkImportWavyContainer.innerHTML = '';
    if (btnConfirmLinkImport) btnConfirmLinkImport.dataset.action = 'import';
    setLinkImportMode('link');
    setLinkImportBusy(false);
    openModal(linkImportModal);
    if (linkImportUrl) linkImportUrl.focus();
  }

  function closeLinkImportModal() {
    if (linkImportModal) closeModal(linkImportModal);
  }

  function linkImportDone(message) {
    if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
    setLinkImportBusy(false, 'Done');
    if (btnConfirmLinkImport) { btnConfirmLinkImport.disabled = false; btnConfirmLinkImport.dataset.action = 'done'; }
    setLinkStatus(message);
    showToast(message, 'success');
  }

  function linkImportProgress() {
    if (linkImportProgressWrap) linkImportProgressWrap.classList.remove('hidden');
    if (linkImportProgressLabel) linkImportProgressLabel.textContent = '0 / 0';
    const wavy = linkImportWavyContainer ? createWavyProgress(linkImportWavyContainer) : { set() {} };
    wavy.set(0);
    return (done, total) => {
      wavy.set(total ? Math.round((done / total) * 100) : 0);
      if (linkImportProgressLabel) linkImportProgressLabel.textContent = `${done} / ${total}`;
    };
  }

  // Yandex Music: the server reads the playlist (titles and artists), then each song is found on YouTube
  async function handleYandexLinkImport(url) {
    const progress = linkImportProgress();
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/yandex-import?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !Array.isArray(data.tracks) || !data.tracks.length) {
      if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
      showImportError(linkImportError, classifyImportError('link', res.status, data));
      setLinkImportBusy(false);
      return;
    }
    progress(0, data.tracks.length);
    let found;
    try {
      found = await matchSpotifyTracks(data.tracks, progress);
    } catch (err) {
      if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
      setLinkStatus(importErrorText(err, 'Import failed'), true);
      setLinkImportBusy(false);
      return;
    }
    const target = document.getElementById('link-import-target');
    const added = addImportedTracks(target ? target.value : 'new', data.name || 'Yandex Music playlist', found, data.cover || '');
    const missing = data.tracks.length - found.length;
    linkImportDone(missing > 0 ? `Imported ${added} tracks. ${missing} not found on YouTube.` : `Imported ${added} tracks.`);
  }

  async function handleGoogleLoginImport() {
    const api = googleApi();
    if (!api) return;
    const doLikes = !!(googleChkLikes && googleChkLikes.checked);
    const doPlaylists = !!(googleChkPlaylists && googleChkPlaylists.checked);
    if (!doLikes && !doPlaylists) { setLinkStatus('Pick liked songs, playlists or both', true); return; }
    clearImportError(linkImportError);
    setLinkImportBusy(true);
    setLinkStatus('Reading your library…');
    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');
    try {
      const res = await api.googleImportLibrary({ profile: googleProfile(), platform: currentLinkImportPlatform === 'ytmusic' ? 'ytmusic' : 'youtube', doLikes, doPlaylists });
      if (!res || !res.success) {
        const loggedOut = !!(res && res.code === 'not_logged_in');
        if (loggedOut) googleConnected = false;
        setLinkImportBusy(false);
        updateGoogleAuthUI();
        setLinkStatus(loggedOut ? 'Google logged Muriel out. Log in again.' : `Couldn't read your library: ${(res && res.error) || 'try again later'}`, true);
        return;
      }
      const likes = Array.isArray(res.likes) ? res.likes : [];
      const playlists = Array.isArray(res.playlists) ? res.playlists : [];
      const total = likes.length + playlists.reduce((n, p) => n + (Array.isArray(p.tracks) ? p.tracks.length : 0), 0);
      if (!total) { setLinkStatus('No songs found to import', true); setLinkImportBusy(false); return; }
      const progress = linkImportProgress();
      let done = 0;
      // liked songs become favorites of the open profile
      let newFavorites = 0;
      for (const t of likes) {
        if (!state.favorites.some((f) => isSameSong(f, t))) { state.favorites.push(stampAddedAt(t)); newFavorites++; }
        progress(++done, total);
      }
      if (newFavorites) {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
        updateFavoritesBadge();
        updateFavoriteIcon();
        if (state.currentView === 'favorites') renderFavoritesView();
        window.dispatchEvent(new Event('muriel:library'));
      }
      const target = document.getElementById('google-import-target');
      const targetId = target ? target.value : 'new';
      let added = 0;
      for (const pl of playlists) {
        const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
        if (tracks.length) added += addImportedTracks(targetId, pl.name, tracks, pl.cover || '', false);
        done += tracks.length;
        progress(done, total);
      }
      const parts = [];
      if (doLikes) parts.push(`${newFavorites} new favorite${newFavorites === 1 ? '' : 's'}`);
      if (doPlaylists) parts.push(`${playlists.length} playlist${playlists.length === 1 ? '' : 's'} (${added} tracks)`);
      linkImportDone(`Imported ${parts.join(' and ')}.`);
    } catch (err) {
      if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
      setLinkImportBusy(false);
      setLinkStatus("Couldn't read your library. Check your connection and try again.", true);
    } finally {
      if (hasBusy && typeof endBusy === 'function') endBusy('import');
    }
  }

  async function handleLinkImportAction() {
    if (btnConfirmLinkImport && btnConfirmLinkImport.dataset.action === 'done') { closeLinkImportModal(); return; }
    if (currentLinkImportMode === 'login') { await handleGoogleLoginImport(); return; }
    clearImportError(linkImportError);
    const url = linkImportUrl ? linkImportUrl.value.trim() : '';
    if (window.MurielShare && window.MurielShare.payloadFrom(url)) { closeLinkImportModal(); importSharedPlaylist(url); return; }
    if (!url) {
      const errInfo = classifyImportError('link', 404, 'unsupported link');
      showImportError(linkImportError, errInfo);
      return;
    }

    setLinkStatus('');
    setLinkImportBusy(true);

    const hasBusy = typeof beginBusy === 'function';
    if (hasBusy) beginBusy('import');
    try {
      if (/^https?:\/\/(?:[\w-]+\.)*music\.yandex\./i.test(url) || (currentLinkImportPlatform === 'yandex' && /yandex\./i.test(url))) {
        await handleYandexLinkImport(url);
        return;
      }
      if (url.includes('soundcloud.com')) setPlatform('soundcloud', false);
      else if (url.includes('music.youtube.com')) setPlatform('ytmusic', false);
      else if (url.includes('youtube.com') || url.includes('youtu.be')) setPlatform('youtube', false);

      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/playlist-import?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || !data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        const errInfo = classifyImportError('link', res.status, data);
        showImportError(linkImportError, errInfo);
        setLinkImportBusy(false);
        return;
      }
      const target = document.getElementById('link-import-target');
      const targetId = target ? target.value : 'new';
      const added = addImportedTracks(targetId, data.name, data.tracks, data.cover || '');
      showToast(`Imported ${added} tracks`, 'success');
      closeLinkImportModal();
    } catch (err) {
      if (linkImportProgressWrap) linkImportProgressWrap.classList.add('hidden');
      const errInfo = classifyImportError('link', err, err.message);
      showImportError(linkImportError, errInfo);
      setLinkImportBusy(false);
    } finally {
      if (hasBusy && typeof endBusy === 'function') {
        endBusy('import');
      }
    }
  }

  const linkImportBtns = document.querySelectorAll('.btn-open-link-import, #btn-open-link-import');
  linkImportBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // the round buttons in "Create playlist" open the importer in its place
      if (el.createPlaylistModal && el.createPlaylistModal.contains(btn)) closeModal(el.createPlaylistModal);
      if (btn.dataset.platform && btn.dataset.platform !== 'yandex') setPlatform(btn.dataset.platform, false);
      openLinkImportModal(btn.dataset.platform || '');
    });
  });
  // "Create playlist" → import from Spotify / Apple Music: the same dialogs as in Settings → Integrations
  [['btn-cpm-spotify', 'btn-open-spotify-import'], ['btn-cpm-apple', 'btn-open-apple-import']].forEach(([from, to]) => {
    const b = document.getElementById(from);
    if (b) b.addEventListener('click', () => {
      if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
      const target = document.getElementById(to);
      if (target) target.click();
    });
  });
  if (btnCancelLinkImport) btnCancelLinkImport.addEventListener('click', closeLinkImportModal);
  if (btnConfirmLinkImport) btnConfirmLinkImport.addEventListener('click', handleLinkImportAction);
  if (linkImportUrl) {
    linkImportUrl.addEventListener('input', () => clearImportError(linkImportError));
    linkImportUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLinkImportAction();
      }
    });
  }

  let trackToDownload = null;
  let downloadBatch = null;
  let selectedFormat = localStorage.getItem('muriel_download_format') || 'mp3';
  let selectedQuality = '0';

  function updateDownloadBtnLabel() {
    if (!el.downloadBtnText) return;
    if (downloadBatch) {
      const count = downloadBatch.tracks.length;
      el.downloadBtnText.textContent = downloadBatch.retry ? Tf('Retry failed ({0})', count) : `Download ${count} track${count === 1 ? '' : 's'}`;
    } else {
      el.downloadBtnText.textContent = `Download ${selectedFormat.toUpperCase()}`;
    }
  }

  function updateLosslessQualityState() {
    const isLossless = selectedFormat === 'flac' || selectedFormat === 'wav';
    const qualityGrid = document.getElementById('quality-chips-grid');
    if (qualityGrid) {
      qualityGrid.classList.toggle('disabled', isLossless);
    }
  }

  async function updateDownloadCaptionPath() {
    const elPath = document.getElementById('download-caption-path');
    if (!elPath) return;
    try {
      if (window.electronAPI && window.electronAPI.getDownloadDir) {
        const info = await window.electronAPI.getDownloadDir();
        if (info && info.dir) {
          elPath.textContent = info.dir;
          return;
        }
      }
    } catch (e) {
      console.warn('getDownloadDir failed', e);
    }
    elPath.textContent = '~/Downloads';
  }

  function openDownloadModal(track) {
    if (!track || !el.downloadModal) return;
    trackToDownload = track;
    downloadBatch = null;
    el.downloadModal.classList.remove('batch-mode');
    const modalTitle = document.getElementById('download-modal-title');
    if (modalTitle) modalTitle.textContent = 'Download track';
    if (el.downloadPreviewTitle) el.downloadPreviewTitle.textContent = track.title || 'untitled';
    if (el.downloadPreviewArtist) el.downloadPreviewArtist.textContent = track.artist || 'unknown artist';

    const trimStartEl = document.getElementById('trim-start');
    const trimEndEl = document.getElementById('trim-end');
    if (trimStartEl) trimStartEl.value = '0:00';
    if (trimEndEl) {
      const dur = (isSameTrack(track, state.currentTrack) && el.nativeAudio && Number.isFinite(el.nativeAudio.duration) && el.nativeAudio.duration > 0)
        ? Math.round(el.nativeAudio.duration)
        : (track.duration && Number(track.duration) > 0 ? Math.round(Number(track.duration)) : null);
      trimEndEl.value = dur ? formatDuration(dur) : '';
    }
    prepareTrimPane(track);

    if (track.thumbnail) {
      if (el.downloadPreviewThumb) {
        el.downloadPreviewThumb.src = track.thumbnail;
        el.downloadPreviewThumb.style.display = 'block';
      }
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'none';
    } else {
      if (el.downloadPreviewThumb) el.downloadPreviewThumb.style.display = 'none';
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'flex';
    }

    updateDownloadBtnLabel();
    updateLosslessQualityState();
    updateDownloadCaptionPath();

    const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
    if (btnDeleteOfflineTrack) {
      btnDeleteOfflineTrack.classList.add('hidden');
      if (track && track.id) {
        fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(track.id)}`)
          .then(r => r.json())
          .then(res => {
            if (res.cached) {
              btnDeleteOfflineTrack.classList.remove('hidden');
            }
          })
          .catch(() => {});
      }
    }

    openModal(el.downloadModal);
  }

  // a playlist, all favorites or the selected songs: { name, tracks }
  function openDownloadAllModal(playlist, title = 'Download playlist') {
    if (!el.downloadModal) return;
    const tracks = (playlist && Array.isArray(playlist.tracks) ? playlist.tracks : []).filter(t => t.platform !== 'local');
    if (!tracks.length) {
      showToast(Tm('No songs to download here (songs from your own files are already on this device)'), 'info');
      return;
    }
    trackToDownload = null;
    downloadBatch = { name: playlist.name || 'Playlist', tracks, resolve: playlist.resolve, onProgress: playlist.onProgress, onDone: playlist.onDone };
    el.downloadModal.classList.add('batch-mode');
    showDownloadPane('download');
    const modalTitle = document.getElementById('download-modal-title');
    if (modalTitle) modalTitle.textContent = title;
    if (el.downloadPreviewTitle) el.downloadPreviewTitle.textContent = playlist.name || 'Playlist';
    if (el.downloadPreviewArtist) I18N.text(el.downloadPreviewArtist, tracks.length === 1 ? '1 track' : '{0} tracks', tracks.length);
    if (el.downloadPreviewThumb) el.downloadPreviewThumb.style.display = 'none';
    if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'none';
    updateDownloadBtnLabel();
    updateLosslessQualityState();
    updateDownloadCaptionPath();
    openModal(el.downloadModal);
  }

  function setDownloadFormat(fmt) {
    selectedFormat = fmt || 'mp3';
    localStorage.setItem('muriel_download_format', selectedFormat);
    document.querySelectorAll('.format-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.format === selectedFormat);
    });
    updateDownloadBtnLabel();
    updateLosslessQualityState();
  }

  document.querySelectorAll('.format-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      setDownloadFormat(chip.dataset.format);
    });
  });

  setDownloadFormat(selectedFormat);

  document.querySelectorAll('.quality-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.quality-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedQuality = chip.dataset.quality;
    });
  });

  let downloadAbort = null;

  function cancelCurrentDownload() {
    if (downloadAbort) {
      try { downloadAbort.abort(); } catch (_) {}
      downloadAbort = null;
      const curSpinner = el.downloadSpinner || document.getElementById('download-spinner');
      if (curSpinner) curSpinner.innerHTML = '';
      if (el.btnConfirmDownload) {
        el.btnConfirmDownload.style.display = '';
        el.btnConfirmDownload.disabled = false;
      }
      updateDownloadBtnLabel();
      showToast(Tm('Download cancelled'), 'info');
      if (el.downloadModal) closeModal(el.downloadModal);
      return true;
    }
    return false;
  }

  if (el.btnCloseDownloadModal) {
    el.btnCloseDownloadModal.addEventListener('click', () => {
      if (!cancelCurrentDownload()) {
        if (el.downloadModal) closeModal(el.downloadModal);
      }
    });
  }

  if (el.btnCancelDownload) {
    el.btnCancelDownload.addEventListener('click', () => {
      if (!cancelCurrentDownload()) {
        if (el.downloadModal) closeModal(el.downloadModal);
      }
    });
  }

  if (el.btnPlaybarMore) {
    el.btnPlaybarMore.addEventListener('click', () => {
      if (state.currentTrack) {
        openDownloadModal(state.currentTrack);
      } else {
        showToast(Tm('No track currently playing'), 'info');
      }
    });
  }

  function parseTimeInputToSeconds(str) {
    if (!str || typeof str !== 'string') return null;
    const s = str.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const val = parseFloat(s);
      return isNaN(val) ? null : Math.max(0, val);
    }
    const parts = s.split(':').map(p => p.trim());
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const sec = parseFloat(parts[1]);
      if (!isNaN(m) && !isNaN(sec) && m >= 0 && sec >= 0) {
        return m * 60 + sec;
      }
    } else if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const sec = parseFloat(parts[2]);
      if (!isNaN(h) && !isNaN(m) && !isNaN(sec) && h >= 0 && m >= 0 && sec >= 0) {
        return h * 3600 + m * 60 + sec;
      }
    }
    return null;
  }

  function trimAudioBuffer(ctx, buffer, startSec, endSec) {
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const totalDuration = buffer.duration;
    const start = Math.max(0, Math.min(startSec || 0, totalDuration));
    const end = (endSec !== null && endSec !== undefined && endSec > start)
      ? Math.min(endSec, totalDuration)
      : totalDuration;

    if (start <= 0 && end >= totalDuration) {
      return buffer;
    }

    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.floor(end * sampleRate);
    const length = Math.max(1, endSample - startSample);

    const trimmed = ctx.createBuffer(numChannels, length, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = buffer.getChannelData(ch);
      const dstData = trimmed.getChannelData(ch);
      dstData.set(srcData.subarray(startSample, startSample + length));
    }
    return trimmed;
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const length = buffer.length;
    const dataSize = length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  // which of `tracks` are already in the Downloads folder (the offline cache doesn't count): an array of booleans
  async function downloadedInFolder(tracks) {
    const out = [];
    for (let i = 0; i < tracks.length; i += 500) {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/downloaded-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filesOnly: true, tracks: tracks.slice(i, i + 500).map((t) => ({ title: t.title || '', artist: t.artist || '', id: String(t.id || '') })) }),
      });
      const data = await res.json();
      if (!data || !data.success || !Array.isArray(data.downloaded)) throw new Error('downloaded-status failed');
      out.push(...data.downloaded.map(Boolean));
    }
    return out;
  }

  if (el.btnConfirmDownload) {
    el.btnConfirmDownload.addEventListener('click', async () => {
      if (downloadBatch) {
        const batch = downloadBatch;
        el.btnConfirmDownload.disabled = true;
        let lastDir = null;
        // Cancel/X used to only hide the dialog while every song kept downloading
        const batchAbort = new AbortController();
        downloadAbort = batchAbort;
        const total = batch.tracks.length;
        // songs already in the Downloads folder aren't downloaded again (#29)
        const present = await downloadedInFolder(batch.tracks).catch(() => null);
        const tracks = present ? batch.tracks.filter((_, i) => !present[i]) : batch.tracks;
        const skipped = total - tracks.length;
        const setProgress = (p) => {
          if (el.downloadBtnText) el.downloadBtnText.textContent = Tf('Downloading {0}/{1}', Math.min(tracks.length, p.done + p.failed + 1), tracks.length) + (p.failed ? ` · ${Tf('{0} failed', p.failed)}` : '');
          if (typeof batch.onProgress === 'function') batch.onProgress(p.done + p.failed, tracks.length);
        };
        setProgress({ done: 0, failed: 0 });
        const downloadOne = async (t, { fresh }) => {
          // an album's songs are found on YouTube first (the file keeps the album's title and artist)
          let src = t;
          if (typeof batch.resolve === 'function') {
            const found = await batch.resolve(t).catch(() => null);
            if (found && found.url) src = { ...t, url: found.url, id: found.id || t.id };
          }
          const downloadUrl = `http://127.0.0.1:${state.serverPort}/api/download?url=${encodeURIComponent(src.url || '')}&id=${encodeURIComponent(src.id || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=${selectedFormat}&quality=${selectedQuality}${fresh ? '&fresh=1' : ''}`;
          const res = await fetch(downloadUrl, { signal: batchAbort.signal });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch (e) { throw Object.assign(new Error(text || 'server error'), { status: res.status }); }
          if (!data.success) throw Object.assign(new Error(data.error || 'Failed to download'), { status: res.status });
          if (data.directory) lastDir = data.directory;
        };
        const result = tracks.length ? await window.MurielDownloadBatch.runDownloadBatch(tracks, downloadOne, {
          concurrency: 2, signal: batchAbort.signal, onProgress: setProgress,
        }) : { done: [], failed: [], aborted: batchAbort.signal.aborted };
        for (const f of result.failed) console.error('Download failed:', f.item.title || f.item.url || '', f.error && f.error.message);
        const done = result.done.length;
        const failedTracks = result.failed.map((f) => f.item);
        el.btnConfirmDownload.disabled = false;
        if (downloadAbort === batchAbort) downloadAbort = null;
        if (typeof batch.onDone === 'function') batch.onDone(done + skipped, total);
        // on phones the server answers with the app's internal path (/data/Downloads); name the real folder
        if (isPhoneApp && lastDir) {
          try { lastDir = (await window.electronAPI.getDownloadDir()).dir || lastDir; } catch (e) {}
        }
        if (batchAbort.signal.aborted) {
          // cancelCurrentDownload already closed the dialog; another one may be open by now
          if (done) showToast(lastDir ? Tm('Stopped. {0} of {1} songs were downloaded to {2}', done, tracks.length, lastDir) : Tm('Stopped. {0} of {1} songs were downloaded', done, tracks.length), 'info');
          return;
        }
        const summary = [Tf('{0} downloaded', done)];
        if (skipped) summary.push(Tf('{0} already downloaded', skipped));
        if (failedTracks.length) summary.push(Tf('{0} failed', failedTracks.length));
        if (failedTracks.length) {
          // the dialog stays open with the summary; its button now retries just the failed songs
          downloadBatch = { ...batch, tracks: failedTracks, retry: true };
          if (el.downloadPreviewArtist) el.downloadPreviewArtist.textContent = summary.join(' · ');
          updateDownloadBtnLabel();
          showToast(Tm('Downloaded {0}/{1} ({2} failed)', done + skipped, total, failedTracks.length), 'error');
          return;
        }
        downloadBatch = null;
        if (el.downloadModal) closeModal(el.downloadModal);
        showToast(lastDir ? Tm('Downloaded {0} tracks to {1}', done, lastDir) + (skipped ? ` (${summary.slice(1).join(', ')})` : '') : summary.join(' · '), 'success');
        return;
      }
      if (!trackToDownload) return;
      const t = trackToDownload;

      const trimStartEl = document.getElementById('trim-start');
      const trimEndEl = document.getElementById('trim-end');
      const rawStart = trimStartEl ? trimStartEl.value.trim() : '';
      const rawEnd = trimEndEl ? trimEndEl.value.trim() : '';

      const parsedStart = parseTimeInputToSeconds(rawStart);
      const startSec = (parsedStart !== null && parsedStart >= 0) ? parsedStart : 0;
      const endSec = rawEnd ? parseTimeInputToSeconds(rawEnd) : null;

      if (endSec !== null && endSec <= startSec) {
        showToast(Tm('Trim end must be after start'), 'error');
        return;
      }

      if (el.btnConfirmDownload) {
        el.btnConfirmDownload.disabled = true;
        el.btnConfirmDownload.style.display = 'none';
      }
      const spinnerEl = el.downloadSpinner || document.getElementById('download-spinner');
      if (spinnerEl) {
        spinnerEl.innerHTML = `
          <div class="m3-spinner-container" style="width: 32px; height: 32px; padding: 4px; background: transparent;">
            <svg class="m3-circular-progress" viewBox="0 0 48 48" style="width: 24px; height: 24px;">
              <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
              <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4" stroke="var(--md-sys-color-primary)"></circle>
            </svg>
          </div>
        `;
      }

      showToast(Tm('Downloading: {0}', `${t.title || T('Track')} (.${selectedFormat})`), 'info');
      downloadAbort = new AbortController();

      try {
        // Phones have no audio rendering pipeline or ffmpeg: the server saves the song file as it is
        // (the decode-and-encode path below always ended in "Download failed" there)
        if (isPhoneApp) {
          if (t.platform === 'local') throw new Error('This song is already on your phone');
          const r = await fetch(`http://127.0.0.1:${state.serverPort}/api/download?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=${selectedFormat}&quality=${selectedQuality}`, { signal: downloadAbort.signal });
          const d = await r.json();
          if (!d.success) throw new Error(d.error || 'Download failed');
          showToast(Tm('Download complete: saved as {0}', d.filename), 'info');
          if (el.downloadModal) closeModal(el.downloadModal);
          return;
        }
        let audioSourceUrl = null;
        const isCurrent = isSameTrack(t, state.currentTrack);
        if (isCurrent && el.nativeAudio && el.nativeAudio.src && !el.nativeAudio.src.startsWith('blob:')) {
          audioSourceUrl = el.nativeAudio.src;
        }

        if (!audioSourceUrl && t.platform === 'local' && t.id) {
          audioSourceUrl = `http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(t.id)}`;
        }

        if (!audioSourceUrl && t.id) {
          try {
            const checkRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(t.id)}`, { signal: downloadAbort.signal });
            const checkData = await checkRes.json();
            if (checkData && checkData.cached) {
              audioSourceUrl = `http://127.0.0.1:${state.serverPort}/api/local-track?id=${encodeURIComponent(t.id)}`;
            }
          } catch (_) {}
        }

        if (!audioSourceUrl) {
          const streamInfoUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(t.url || '')}&id=${encodeURIComponent(t.id || '')}&platform=${t.platform || 'youtube'}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&duration=${encodeURIComponent(t.duration || 0)}`;
          const streamRes = await fetch(streamInfoUrl, { signal: downloadAbort.signal });
          const streamData = await streamRes.json();
          if (!streamData || !streamData.success || (!streamData.streamUrl && !streamData.proxyUrl)) {
            throw new Error((streamData && streamData.error) || 'Failed to locate track audio stream');
          }
          audioSourceUrl = streamData.isLocal ? streamData.streamUrl : (streamData.proxyUrl || streamData.streamUrl);
        }

        let fetchUrl = audioSourceUrl;
        const isLoopback = fetchUrl.startsWith('http://127.0.0.1') || fetchUrl.startsWith('http://localhost');
        if (!isLoopback) {
          fetchUrl = `http://127.0.0.1:${state.serverPort}/api/audio-proxy?url=${encodeURIComponent(audioSourceUrl)}`;
        }

        const resFile = await fetch(fetchUrl, { signal: downloadAbort.signal });
        if (!resFile.ok) throw new Error(`Failed to load audio (${resFile.status})`);
        const arrayBuffer = await resFile.arrayBuffer();

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const decodeCtx = audioEngine.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const decodedBuffer = await new Promise((resolve, reject) => {
          decodeCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        });

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let bufferToProcess = decodedBuffer;
        if (startSec > 0 || (endSec !== null && endSec < decodedBuffer.duration)) {
          bufferToProcess = trimAudioBuffer(decodeCtx, decodedBuffer, startSec, endSec);
        }

        const applyEffects = Boolean(document.getElementById('download-apply-effects')?.checked);
        let finalBuffer = bufferToProcess;
        if (applyEffects) {
          const currentSettings = {
            ...state.audioSettings,
            volume: 1.0,
            eq: { ...(state.audioSettings.eq || {}) },
            eqBands: Array.isArray(state.audioSettings.eqBands) ? [...state.audioSettings.eqBands] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
          };
          finalBuffer = await audioEngine.renderOffline(bufferToProcess, currentSettings);
        }

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const wavBlob = audioBufferToWav(finalBuffer);

        if (downloadAbort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const encodeUrl = `http://127.0.0.1:${state.serverPort}/api/encode?title=${encodeURIComponent(t.title || 'untitled')}&artist=${encodeURIComponent(t.artist || 'unknown artist')}&format=${selectedFormat}&quality=${selectedQuality}`;
        const resEncode = await fetch(encodeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wavBlob,
          signal: downloadAbort.signal
        });
        const textEncode = await resEncode.text();
        let dataEncode;
        try {
          dataEncode = JSON.parse(textEncode);
        } catch (e) {
          throw new Error(textEncode || 'Server error');
        }
        if (!dataEncode.success) throw new Error(dataEncode.error || 'Failed to encode');

        showToast(Tm('Download complete: saved to {0}', `${dataEncode.directory ? dataEncode.directory + '/' : ''}${dataEncode.filename}`), 'info');
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Download error:', err);
        showToast(Tm('Download failed: {0}', err.message), 'error');
      } finally {
        downloadAbort = null;
        const curSpinner = el.downloadSpinner || document.getElementById('download-spinner');
        if (curSpinner) curSpinner.innerHTML = '';
        if (el.btnConfirmDownload) {
          el.btnConfirmDownload.style.display = '';
          el.btnConfirmDownload.disabled = false;
        }
        updateDownloadBtnLabel();
      }
    });
  }

  const btnDownloadPlaylist = document.getElementById('btn-download-playlist');
  if (btnDownloadPlaylist) {
    btnDownloadPlaylist.addEventListener('click', () => {
      const pl = (state.playlists || []).find(p => p.id === state.currentPlaylistId);
      openDownloadAllModal(pl);
    });
  }
  // downloaded songs play straight from the device: no waiting for them to load
  const btnDownloadFavorites = document.getElementById('btn-download-favorites');
  if (btnDownloadFavorites) {
    btnDownloadFavorites.addEventListener('click', () => {
      openDownloadAllModal({ name: 'Favorites', tracks: sortTracksFor('favorites', state.favorites || []) }, 'Download favorites');
    });
  }
  const btnMultiDownload = document.getElementById('multi-select-download');
  if (btnMultiDownload) {
    btnMultiDownload.addEventListener('click', () => {
      const tracks = [...multiSel.tracks.values()];
      if (!tracks.length) return;
      openDownloadAllModal({ name: multiSel.context === 'favorites' ? 'Favorites' : ((state.playlists || []).find(p => p.id === state.currentPlaylistId) || {}).name || 'Songs', tracks },
        `Download ${tracks.length} song${tracks.length === 1 ? '' : 's'}`);
    });
  }

  updateFavoritesBadge();
  fetch(`http://127.0.0.1:${state.serverPort}/api/library`).then(r => r.json()).then(data => {
    state.localTracks = data;
    updateLocalBadge();
  }).catch(() => {});
  renderPlaylistsList();
  renderPresets();
  syncSettingsSlidersToState();
  applyVisualEffects();

  const analysisCache = new Map();
  let myWaveCurrentTracks = [];
  let jumpBackCurrentTracks = [];
  let homeMode = localStorage.getItem('muriel_home_pane') === 'recent' ? 'recent' : 'wave';
  let isExtendingMyWave = false;

  function getCachedTrackAnalysis(trackId) {
    if (!trackId) return null;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (analysisCache.has(cleanId)) return analysisCache.get(cleanId);
    try {
      const stored = localStorage.getItem(`muriel_audio_analysis_${cleanId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        analysisCache.set(cleanId, parsed);
        capMap(analysisCache, 300);
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function setCachedTrackAnalysis(trackId, analysis) {
    if (!trackId || !analysis) return;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    analysisCache.set(cleanId, analysis);
    capMap(analysisCache, 300);
    try {
      localStorage.setItem(`muriel_audio_analysis_${cleanId}`, JSON.stringify(analysis));
      fetch(`http://127.0.0.1:${state.serverPort}/api/track-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cleanId, analysis })
      }).catch(() => {});
    } catch (e) {}
  }

  function getTrackNormalizedKey(artist, title) {
    let a = String(artist || '').toLowerCase();
    let t = String(title || '').toLowerCase();
    t = t.replace(/\s*\([^)]*official[^)]*\)/gi, '')
         .replace(/\s*\[[^\]]*\]/gi, '')
         .replace(/\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)/gi, '');
    t = t.replace(/\s*(feat\.?|ft\.?)\s+[^(\[-]+/gi, '')
         .replace(/\s*\((feat\.?|ft\.?)[^)]*\)/gi, '');
    a = a.replace(/\s*(feat\.?|ft\.?)\s+.*$/gi, '');
    a = a.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return `${a}::${t}`;
  }

  const WAVE_SKIPS_KEY = 'muriel_wave_skips';

  function normalizeArtistName(name) {
    return String(name || '')
      .replace(/\b(official|vevo|records|topic)\b/gi, '')
      .replace(/[^\w\s&-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getWaveSkips() {
    try {
      const raw = localStorage.getItem(WAVE_SKIPS_KEY);
      return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function recordWaveSkip(track) {
    if (!track) return;
    const key = (typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(track.artist, track.title) : '';
    const artist = (track.artist || '').trim();
    if (!key && !artist) return;
    const skips = getWaveSkips();
    skips.push({ key, artist, t: Date.now() });
    if (skips.length > 200) {
      skips.splice(0, skips.length - 200);
    }
    try {
      localStorage.setItem(WAVE_SKIPS_KEY, JSON.stringify(skips));
    } catch (e) {}
  }

  function getWaveAvoid() {
    const skips = getWaveSkips();
    const keys = [];
    const artistCounts = {};
    const artistDisplay = {};

    for (const s of skips) {
      if (s && s.key) {
        keys.push(s.key);
      }
      if (s && s.artist) {
        const a = s.artist.trim();
        const normA = normalizeArtistName(a);
        if (normA) {
          artistCounts[normA] = (artistCounts[normA] || 0) + 1;
          if (!artistDisplay[normA]) {
            artistDisplay[normA] = a;
          }
        }
      }
    }

    const artists = Object.entries(artistCounts)
      .filter(([_, count]) => count >= 3)
      .map(([normA]) => artistDisplay[normA]);

    // what a thumbs down on a Daily Mix keeps out (library-pages.js)
    const disliked = Lib.feedbackAvoid(getMixFeedback());
    keys.push(...disliked.keys);
    disliked.artists.forEach((a) => { if (!artists.includes(a)) artists.push(a); });
    // and blocked artists and songs
    const blocks = getBlocks();
    blocks.artists.forEach((a) => { if (!artists.includes(a)) artists.push(a); });
    blocks.songs.forEach((t) => keys.push(getTrackNormalizedKey(t.artist, t.title)));

    return {
      keys: Array.from(new Set(keys)),
      artists
    };
  }

  async function computeTasteProfile(maxSeeds = 8) {
    const favs = Array.isArray(state.favorites) ? state.favorites : [];
    const hist = Array.isArray(state.history) ? state.history : [];

    let cyrillicCount = 0;
    const durations = [];
    const allTracks = [...favs, ...hist];

    allTracks.forEach(track => {
      if (!track) return;
      if (track.title && /[\u0400-\u04FF]/.test(track.title)) {
        cyrillicCount++;
      }
      if (track.duration > 0) {
        durations.push(track.duration);
      }
    });

    const seenHistCanIds = new Set();
    const canIdRepeatBonus = new Map();
    const canIdRecency = new Map();

    hist.forEach((track, index) => {
      if (!track) return;
      const rawCanId = String(track.id || track.url || track.key || (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || '').trim();
      const normKey = (track.artist && track.title && typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(track.artist, track.title) : '';
      const effectiveCanId = rawCanId || normKey;
      if (!effectiveCanId) return;

      if (!seenHistCanIds.has(effectiveCanId)) {
        seenHistCanIds.add(effectiveCanId);
        let recency;
        const ts = Number(track.playedAt || track.timestamp || track.date || track.time);
        if (ts && !isNaN(ts) && ts > 0) {
          const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
          recency = Math.pow(0.5, ageDays / 21);
        } else {
          recency = Math.pow(0.97, index);
        }
        canIdRecency.set(effectiveCanId, recency);
      } else {
        const curBonus = canIdRepeatBonus.get(effectiveCanId) || 0;
        if (curBonus < 2.0) {
          canIdRepeatBonus.set(effectiveCanId, Math.min(2.0, curBonus + 0.5));
        }
      }
    });

    const mergedMap = new Map();

    function getOrCreateEntry(track) {
      if (!track || !track.artist || !track.title) return null;
      const artist = String(track.artist).trim();
      const title = String(track.title).trim();
      if (!artist || !title) return null;
      const normKey = (typeof getTrackNormalizedKey === 'function') ? getTrackNormalizedKey(artist, title) : '';
      if (!normKey || normKey === '::') return null;

      if (!mergedMap.has(normKey)) {
        mergedMap.set(normKey, {
          artist,
          title,
          id: track.id || '',
          platform: track.platform || state.platform || 'youtube',
          weight: 0,
          seenHistCanIds: new Set(),
          favAdded: false
        });
      }
      const entry = mergedMap.get(normKey);
      if (!entry.id && track.id) {
        entry.id = track.id;
        entry.platform = track.platform || state.platform || 'youtube';
      }
      return { entry, normKey };
    }

    favs.forEach(track => {
      const res = getOrCreateEntry(track);
      if (!res) return;
      const { entry } = res;
      if (!entry.favAdded) {
        entry.weight += 3;
        entry.favAdded = true;
      }
    });

    hist.forEach(track => {
      const res = getOrCreateEntry(track);
      if (!res) return;
      const { entry, normKey } = res;
      const rawCanId = String(track.id || track.url || track.key || (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(track) : '') || '').trim();
      const effectiveCanId = rawCanId || normKey;

      if (!entry.seenHistCanIds.has(effectiveCanId)) {
        entry.seenHistCanIds.add(effectiveCanId);
        const recency = canIdRecency.get(effectiveCanId) || 0;
        const repeatBonus = canIdRepeatBonus.get(effectiveCanId) || 0;
        entry.weight += (recency + repeatBonus);
      }
    });

    // songs from Daily Mixes you gave a thumbs up count like favourites, their artists a bit more
    const mixFeedback = getMixFeedback();
    mixFeedback.likedTracks.forEach(track => {
      const res = getOrCreateEntry(track);
      if (res) res.entry.weight += 3;
    });

    const artistWeights = {};
    const artistDisplayNames = {};
    mergedMap.forEach(item => {
      if (item.artist) {
        const a = item.artist.trim();
        const normArtist = normalizeArtistName(a);
        if (normArtist) {
          artistWeights[normArtist] = (artistWeights[normArtist] || 0) + item.weight;
          if (!artistDisplayNames[normArtist]) {
            artistDisplayNames[normArtist] = a;
          }
        }
      }
    });
    mixFeedback.likedArtists.forEach(a => {
      const normArtist = normalizeArtistName(a);
      if (!normArtist) return;
      artistWeights[normArtist] = (artistWeights[normArtist] || 0) + 4;
      if (!artistDisplayNames[normArtist]) artistDisplayNames[normArtist] = a.trim();
    });

    const sortedArtists = Object.entries(artistWeights)
      .sort((a, b) => b[1] - a[1])
      .map(([normArtist]) => artistDisplayNames[normArtist]);

    const seeds = Array.from(mergedMap.values())
      .filter(s => s.artist && s.title && s.artist.trim() && s.title.trim())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxSeeds)
      .map(s => ({
        artist: s.artist,
        title: s.title,
        id: s.id,
        platform: s.platform || 'youtube',
        weight: Math.round(s.weight * 1000) / 1000
      }));

    const dominantScript = cyrillicCount > (allTracks.length ? allTracks.length * 0.35 : 0) ? 'Cyrillic' : 'Latin';
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    return {
      trackCount: Math.max(mergedMap.size, favs.length),
      topArtists: sortedArtists.slice(0, 5),
      dominantScript,
      avgDuration,
      bpmLabel: null,
      energyLabel: null,
      seeds
    };
  }

  function renderMyWaveChips(profile) {
    const chipsContainer = document.getElementById('my-wave-chips');
    if (chipsContainer) chipsContainer.innerHTML = '';
  }

  const dominantColorsCache = new Map();

  function getCoverDominantColors(url) {
    if (!url) return Promise.resolve(['rgb(80, 80, 120)', 'rgb(120, 80, 100)']);
    if (dominantColorsCache.has(url)) {
      return Promise.resolve(dominantColorsCache.get(url));
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;

          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness < 30 || brightness > 230) continue;

            const qr = Math.round(r / 32) * 32;
            const qg = Math.round(g / 32) * 32;
            const qb = Math.round(b / 32) * 32;
            const key = `${qr},${qg},${qb}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }

          const sorted = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
          const c1 = sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(80, 100, 140)';
          const c2 = sorted[1] ? `rgb(${sorted[1][0]})` : sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(140, 80, 100)';

          const result = [c1, c2];
          dominantColorsCache.set(url, result);
          capMap(dominantColorsCache, 300);
          canvas.width = 0;
          canvas.height = 0;
          img.onload = null;
          img.onerror = null;
          img.src = '';
          resolve(result);
        } catch (e) {
          const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
          dominantColorsCache.set(url, fallback);
          img.onload = null;
          img.onerror = null;
          resolve(fallback);
        }
      };
      img.onerror = () => {
        if (img.crossOrigin) {
          img.crossOrigin = null;
          img.src = url;
          return;
        }
        const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
        dominantColorsCache.set(url, fallback);
        img.onload = null;
        img.onerror = null;
        resolve(fallback);
      };
      img.src = url;
    });
  }

  function updateTextFade(el) {
    if (!el) return;
    el.classList.toggle('fade-end', el.scrollWidth > el.clientWidth);
  }

  window.addEventListener('resize', () => {
    ['my-wave-focused-title', 'my-wave-focused-artist', 'jump-focused-title', 'jump-focused-artist'].forEach(id => {
      const el = document.getElementById(id);
      if (el) updateTextFade(el);
    });
  });

  let ambientIdx = 0;
  let currentAmbientUrl = null;
  async function setHomeAmbient(url) {
    const box = document.getElementById('home-ambient');
    if (!box) return;
    const layers = box.querySelectorAll('.home-ambient-layer');
    if (!url) {
      currentAmbientUrl = null;
      layers.forEach(l => {
        l.classList.remove('on');
        l.style.background = '';
      });
      return;
    }
    currentAmbientUrl = url;
    try {
      const [c1, c2] = await getCoverDominantColors(url);
      if (currentAmbientUrl !== url) return;
      const next = layers[ambientIdx ^ 1];
      const prev = layers[ambientIdx];
      const gradient = `radial-gradient(circle 550px at 28% 35%, ${c1} 0%, transparent 68%), radial-gradient(circle 550px at 72% 65%, ${c2} 0%, transparent 68%)`;
      if (next) {
        next.style.backgroundImage = 'none';
        next.style.background = gradient;
        next.classList.add('on');
      }
      if (prev) {
        prev.classList.remove('on');
      }
      ambientIdx ^= 1;
    } catch (e) {
      console.warn('Ambient error:', e);
    }
  }

  function syncHomeAmbientVisibility() {
    const ambient = document.getElementById('home-ambient');
    if (!ambient) return;
    const isDiscoverActive = state.currentView === 'discover' && el.viewDiscover && el.viewDiscover.classList.contains('active');
    const isSearchShowing = el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden');
    const isDiscoverEmptyShowing = el.discoverEmpty && !el.discoverEmpty.classList.contains('hidden');
    const hasModes = typeof availableModes === 'function' ? availableModes().length > 0 : true;
    const isAmbientEnabled = getAdv('my_wave_ambient', true);

    const shouldShow = isDiscoverActive && !isSearchShowing && isDiscoverEmptyShowing && hasModes && isAmbientEnabled;
    ambient.classList.toggle('ambient-hidden', !shouldShow);
    ambient.style.display = shouldShow ? '' : 'none';
  }

  async function updateAmbientLight(ambientEl, thumbnailUrl) {
    let url = '';
    if (typeof thumbnailUrl === 'string') {
      url = thumbnailUrl;
    } else if (typeof ambientEl === 'string') {
      if (ambientEl === 'my-wave-ambient-light' || ambientEl === 'jump-ambient-light') {
        url = typeof thumbnailUrl === 'string' ? thumbnailUrl : '';
      } else {
        url = ambientEl;
      }
    } else if (ambientEl && typeof ambientEl === 'object' && typeof thumbnailUrl === 'string') {
      url = thumbnailUrl;
    }

    syncHomeAmbientVisibility();
    setHomeAmbient(url);
  }

  let currentWaveFocusedIndex = 0;

  // a second caller (Next pressed at the end while the background top-up runs) waits for the same top-up
  // instead of getting false and doing nothing
  let myWaveExtending = null;
  function extendMyWaveQueue() {
    if (!state.myWaveActive) return Promise.resolve(false);
    if (!myWaveExtending) myWaveExtending = extendMyWaveQueueOnce().finally(() => { myWaveExtending = null; });
    return myWaveExtending;
  }

  async function extendMyWaveQueueOnce() {
    if (isExtendingMyWave) return false;
    isExtendingMyWave = true;
    try {
      const profile = await computeTasteProfile();
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: (state.history || []).slice(0, 30),
          favorites: (state.favorites || []).slice(0, 25),
          platform: 'youtube',
          limit: 8,
          clientProfile: profile,
          seeds: profile.seeds,
          avoid: getWaveAvoid()
        })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.tracks) && data.tracks.length > 0) {
        const existingIds = new Set(state.queue.map(t => getTrackCanonicalId(t)));
        const existingKeys = new Set(state.queue.map(t => getTrackNormalizedKey(t.artist, t.title)));
        const newTracks = data.tracks.filter(t => {
          const cid = getTrackCanonicalId(t);
          const nkey = getTrackNormalizedKey(t.artist, t.title);
          return !existingIds.has(cid) && !existingKeys.has(nkey) && !isBlocked(t);
        });
        if (newTracks.length > 0) {
          state.queue.push(...newTracks);
          updateQueueBadge();
          renderQueueView();
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      isExtendingMyWave = false;
    }
  }

  const btnPlayMyWave = document.getElementById('btn-play-my-wave');
  if (btnPlayMyWave) {
    btnPlayMyWave.addEventListener('click', async () => {
      if (!myWaveCurrentTracks || myWaveCurrentTracks.length === 0) {
        const profile = await computeTasteProfile();
        if (profile.trackCount < 5) {
          showToast(Tm('Save at least 5 tracks to tune My Wave'));
          return;
        }
        await loadHomePage();
      }
      if (myWaveCurrentTracks && myWaveCurrentTracks.length > 0) {
        state.myWaveActive = true;
        const startIdx = (currentWaveFocusedIndex >= 0 && currentWaveFocusedIndex < myWaveCurrentTracks.length) ? currentWaveFocusedIndex : 0;
        playTrack(myWaveCurrentTracks[startIdx], [...myWaveCurrentTracks], startIdx);
        showToast(Tm('Playing My Wave'));
      }
    });
  }

  if (el.btnRefreshVibe) {
    el.btnRefreshVibe.addEventListener('click', async () => {
      const btn = el.btnRefreshVibe;
      if (btn.classList.contains('loading')) return;

      const wrapper = document.querySelector('#section-my-wave .my-wave-carousel-wrapper');
      btn.classList.add('loading');
      if (wrapper) wrapper.classList.add('loading');

      let spinner = wrapper ? wrapper.querySelector('.my-wave-carousel-spinner') : null;
      if (!spinner && wrapper) {
        spinner = document.createElement('div');
        spinner.className = 'my-wave-carousel-spinner';
        spinner.innerHTML = `
          <div class="m3-spinner-container">
            <svg class="m3-circular-progress" viewBox="0 0 48 48">
              <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
              <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
            </svg>
          </div>
        `;
        wrapper.appendChild(spinner);
      }
      if (spinner) spinner.style.display = 'flex';

      try {
        const ok = await loadHomePage(true);
        if (!ok) {
          showToast(Tm('Could not refresh'), 'error');
        }
      } catch (err) {
        showToast(Tm('Could not refresh'), 'error');
      } finally {
        btn.classList.remove('loading');
        if (wrapper) wrapper.classList.remove('loading');
        if (spinner) spinner.style.display = 'none';
      }
    });
  }

  function scrollCarouselTo(row, idx) {
    if (!row) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;
    const clampedIdx = Math.max(0, Math.min(cards.length - 1, idx));
    row._targetIndex = clampedIdx;
    let step = 304;
    if (cards.length > 1) {
      step = cards[1].offsetLeft - cards[0].offsetLeft;
    } else if (cards.length === 1) {
      step = cards[0].offsetWidth + 24;
    }
    const maxScroll = Math.max(0, row.scrollWidth - row.clientWidth);
    const target = Math.max(0, Math.min(maxScroll, clampedIdx * step));
    row.scrollTo({ left: target, behavior: 'smooth' });
  }

  function updateCoverflowCards(row, titleEl, artistEl, ambientEl, tracks) {
    if (!row) row = document.getElementById('home-vibe-grid');
    if (!row) return;
    if (!tracks) {
      tracks = (row.id === 'home-vibe-grid')
        ? (homeMode === 'recent' ? jumpBackCurrentTracks : myWaveCurrentTracks)
        : jumpBackCurrentTracks;
    }
    if (!tracks || tracks.length === 0) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;

    if (!titleEl) titleEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-focused-title' : 'jump-focused-title');
    if (!artistEl) artistEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-focused-artist' : 'jump-focused-artist');
    if (!ambientEl) ambientEl = document.getElementById(row.id === 'home-vibe-grid' ? 'my-wave-ambient-light' : 'jump-ambient-light');

    let step = 304;
    if (cards.length > 1) {
      step = cards[1].offsetLeft - cards[0].offsetLeft;
    } else if (cards.length === 1) {
      step = cards[0].offsetWidth + 24;
    }
    if (!step || step <= 0) step = 304;

    const floatIndex = row.scrollLeft / step;
    const newFocused = Math.max(0, Math.min(cards.length - 1, Math.round(floatIndex)));
    if (typeof row._targetIndex === 'number' && Math.abs(row.scrollLeft - (row._targetIndex * step)) < 12) {
      row._targetIndex = undefined;
    }

    cards.forEach((card, j) => {
      const dist = Math.abs(j - newFocused);
      card.classList.remove('near', 'far');
      if (dist === 0) {
        card.style.zIndex = '10';
      } else if (dist === 1) {
        card.classList.add('near');
        card.style.zIndex = '5';
      } else {
        card.classList.add('far');
        card.style.zIndex = '1';
      }
    });

    const prevFocused = (typeof row._focusedIndex === 'number') ? row._focusedIndex : -1;
    if (newFocused !== prevFocused && tracks[newFocused]) {
      row._focusedIndex = newFocused;
      if (row.id === 'home-vibe-grid') {
        currentWaveFocusedIndex = newFocused;
      }
      const track = tracks[newFocused];
      if (titleEl && artistEl) {
        titleEl.textContent = track.title || 'Untitled';
        artistEl.textContent = track.artist || 'Unknown';
        updateTextFade(titleEl);
        updateTextFade(artistEl);
      }
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || track.image || '';
      updateAmbientLight(ambientEl, thumb);
    }
  }

  function getJumpBackTracks() {
    const raw = Array.isArray(state.history) ? state.history : [];
    const seen = new Set();
    const tracks = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const canId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(t) : '') || t.id || `${t.artist || ''}::${t.title || ''}`;
      if (seen.has(canId)) continue;
      seen.add(canId);
      const thumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(t) : '') || t.thumbnail || t.cover || t.image || t.localThumbnail || '';
      tracks.push({
        ...t,
        thumbnail: thumb,
        title: t.title || 'Untitled',
        artist: t.artist || t.uploader || 'Unknown artist'
      });
      if (tracks.length >= 15) break;
    }
    return tracks;
  }

  function buildHomeCard(track, mode, idx) {
    const card = document.createElement('div');
    card.className = 'my-wave-track-card';
    if (typeof idx === 'number') card.dataset.index = String(idx);
    const thumbUrl = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(track) : '') || track.thumbnail || track.cover || track.image || '';
    card.innerHTML = `
      <div class="my-wave-track-cover-wrap">
        <img class="my-wave-track-cover" loading="lazy" decoding="async" src="${escapeHtml(thumbUrl)}" alt="" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'280\\' height=\\'280\\' fill=\\'%23555\\'><rect width=\\'100%\\' height=\\'100%\\'/></svg>'">
        <div class="my-wave-track-play-overlay">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      const row = document.getElementById('home-vibe-grid');
      const curIdx = (typeof idx === 'number') ? idx : parseInt(card.dataset.index, 10);
      const focusedIndex = (row && typeof row._focusedIndex === 'number') ? row._focusedIndex : 0;
      if (curIdx === focusedIndex) {
        if (mode === 'wave') {
          state.myWaveActive = true;
          const waveQueue = [...myWaveCurrentTracks];
          playTrack(track, waveQueue, curIdx);
        } else {
          state.myWaveActive = false;
          const recentTracks = jumpBackCurrentTracks.length > 0 ? jumpBackCurrentTracks : getJumpBackTracks();
          playTrack(track, [...recentTracks], curIdx);
        }
      } else if (row) {
        scrollCarouselTo(row, curIdx);
      }
    });

    return card;
  }

  function getWaveSpinnerHtml() {
    return `
      <div class="m3-spinner-container" style="margin: auto;">
        <svg class="m3-circular-progress" viewBox="0 0 48 48">
          <circle class="m3-spinner-track" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
          <circle class="m3-spinner-head" cx="24" cy="24" r="18" fill="none" stroke-width="4"></circle>
        </svg>
      </div>
    `;
  }

  function renderHomeCarousel(mode) {
    if (!mode) mode = homeMode || 'wave';
    homeMode = mode;

    const headerLabel = document.querySelector('#section-my-wave .home-pane-label');
    if (headerLabel) {
      const waveLabel = (state.isHotPicks && state.hotPicksTitle) ? state.hotPicksTitle : 'My Wave';
      if (mode === 'recent' || waveLabel === 'My Wave') I18N.text(headerLabel, mode === 'recent' ? 'Jump back in' : 'My Wave');
      else headerLabel.textContent = waveLabel;
      headerLabel.style.cursor = availableModes().length > 1 ? 'pointer' : 'default';
      headerLabel.style.pointerEvents = 'auto';
      if (!headerLabel._hasToggleListener) {
        headerLabel._hasToggleListener = true;
        headerLabel.addEventListener('click', () => {
          const avail = availableModes();
          if (avail.length > 1) {
            const nextMode = homeMode === 'wave' ? 'recent' : 'wave';
            const curIdx = avail.indexOf(homeMode);
            const nextIdx = avail.indexOf(nextMode);
            if (nextIdx !== -1) {
              switchHomeMode(nextIdx - curIdx);
            }
          }
        });
      }
    }
    const actions = document.querySelector('#section-my-wave .my-wave-actions');
    if (actions) {
      actions.style.display = (mode === 'wave') ? '' : 'none';
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');
    if (!vibeGrid) return;

    if (mode === 'recent') {
      jumpBackCurrentTracks = getJumpBackTracks();
    }
    const source = (mode === 'recent') ? jumpBackCurrentTracks : myWaveCurrentTracks;

    vibeGrid.innerHTML = '';

    if (!source || source.length === 0) {
      if (focusedMeta) focusedMeta.innerHTML = '';
      if (mode === 'recent') {
        vibeGrid.innerHTML = `<div class="vibe-empty-hint" data-i18n>Play some tracks to see them here</div>`;
      } else {
        vibeGrid.innerHTML = getWaveSpinnerHtml();
      }
      updateAmbientLight('my-wave-ambient-light', '');
      return;
    }

    const fragment = document.createDocumentFragment();
    source.forEach((track, idx) => {
      fragment.appendChild(buildHomeCard(track, mode, idx));
    });
    vibeGrid.appendChild(fragment);

    const firstThumb = (typeof getTrackThumbUrl === 'function' ? getTrackThumbUrl(source[0]) : '') || source[0].thumbnail || source[0].cover || source[0].image || '';

    if (focusedMeta && source[0]) {
      focusedMeta.innerHTML = `
        <div class="my-wave-focused-title" id="my-wave-focused-title">${escapeHtml(source[0].title || 'Untitled')}</div>
        <div class="my-wave-focused-artist" id="my-wave-focused-artist">${escapeHtml(source[0].artist || 'Unknown')}</div>
      `;
      const titleEl = document.getElementById('my-wave-focused-title');
      const artistEl = document.getElementById('my-wave-focused-artist');
      if (titleEl) updateTextFade(titleEl);
      if (artistEl) updateTextFade(artistEl);
      updateAmbientLight('my-wave-ambient-light', firstThumb);
    }

    vibeGrid.scrollLeft = 0;
    vibeGrid._focusedIndex = -1;
    updateCoverflowCards(vibeGrid, document.getElementById('my-wave-focused-title'), document.getElementById('my-wave-focused-artist'), document.getElementById('my-wave-ambient-light'), source);
  }


  function availableModes() {
    const modes = [];
    if (getAdv('my_wave', true)) modes.push('wave');
    if (getAdv('jump_back', true)) modes.push('recent');
    return modes;
  }

  function updateHomeDots() {
    const dotsContainer = document.getElementById('home-hero-dots');
    if (!dotsContainer) return;
    const avail = availableModes();
    if (avail.length <= 1) {
      dotsContainer.style.display = 'none';
      dotsContainer.innerHTML = '';
      return;
    }
    dotsContainer.style.display = '';
    dotsContainer.innerHTML = '';
    avail.forEach(m => {
      const btn = document.createElement('button');
      const label = m === 'recent' ? 'Jump back in' : 'My Wave';
      btn.setAttribute('aria-label', T(label));
      btn.title = T(label);
      if (m === homeMode) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (m !== homeMode) {
          const curIdx = avail.indexOf(homeMode);
          const targetIdx = avail.indexOf(m);
          switchHomeMode(targetIdx - curIdx);
        }
      });
      dotsContainer.appendChild(btn);
    });
  }

  function switchHomeMode(dir) {
    const avail = availableModes();
    if (avail.length <= 1) return;
    const curIdx = avail.indexOf(homeMode);
    if (curIdx === -1) return;
    const targetIdx = curIdx + dir;
    if (targetIdx < 0 || targetIdx >= avail.length) return;
    const newMode = avail[targetIdx];
    if (newMode === homeMode) return;

    homeMode = newMode;
    localStorage.setItem('muriel_home_pane', newMode);
    updateHomeDots();

    const isPerf = document.body.classList.contains('perf') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (isPerf) {
      renderHomeCarousel(newMode);
      return;
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');
    const animTargets = [vibeGrid, focusedMeta].filter(Boolean);

    const shiftOut = dir > 0 ? '-16px' : '16px';
    const shiftIn = dir > 0 ? '16px' : '-16px';

    animTargets.forEach(el => {
      el.style.setProperty('--home-shift', shiftOut);
      el.classList.remove('home-in');
      el.classList.add('home-out');
    });

    setTimeout(() => {
      renderHomeCarousel(newMode);
      const newVibeGrid = document.getElementById('home-vibe-grid');
      const newFocusedMeta = document.getElementById('my-wave-focused-meta');
      const newTargets = [newVibeGrid, newFocusedMeta].filter(Boolean);
      newTargets.forEach(el => {
        el.style.setProperty('--home-in-shift', shiftIn);
        el.classList.remove('home-out');
        el.classList.add('home-in');
        setTimeout(() => {
          el.classList.remove('home-in');
        }, 260);
      });
    }, 180);
  }

  function initHomeHero() {
    const avail = availableModes();
    const hero = document.getElementById('home-hero') || document.querySelector('#view-discover .discover-content');
    const dots = document.getElementById('home-hero-dots');

    if (avail.length === 0) {
      if (hero) hero.style.display = 'none';
      if (dots) dots.style.display = 'none';
      const homeAmbient = document.getElementById('home-ambient');
      if (homeAmbient) homeAmbient.style.display = 'none';
      return;
    }

    if (hero) hero.style.display = '';

    if (!avail.includes(homeMode)) {
      homeMode = avail[0];
      localStorage.setItem('muriel_home_pane', homeMode);
    }

    updateHomeDots();
    renderHomeCarousel(homeMode);
    syncHomeAmbientVisibility();
  }

  function stepCarouselFocus(delta) {
    const row = document.getElementById('home-vibe-grid');
    if (!row) return;
    const cards = row.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;
    const base = (typeof row._targetIndex === 'number')
      ? row._targetIndex
      : ((typeof row._focusedIndex === 'number') ? row._focusedIndex : 0);
    const next = Math.max(0, Math.min(cards.length - 1, base + delta));
    scrollCarouselTo(row, next);
  }

  function isDiscoverActive() {
    const view = document.getElementById('view-discover');
    return !!(view && view.classList.contains('active'));
  }

  function isFormInputFocused() {
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    const tag = activeEl.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || activeEl.isContentEditable;
  }

  let isWheelModeLocked = false;
  let isCarouselWheelLocked = false;

  const viewDiscoverEl = document.getElementById('view-discover');
  if (viewDiscoverEl) {
    viewDiscoverEl.addEventListener('wheel', (e) => {
      if (!isDiscoverActive() || isFormInputFocused()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.target.closest('#search-results-container')) return;
      // the home page scrolls (recommendations below the card): only sideways scrolling, or scrolling
      // over the card row itself, flips cards
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!sideways && !e.target.closest('.my-wave-carousel-wrapper')) return;
      const delta = sideways ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 8) return;
      if (isCarouselWheelLocked) return;
      e.preventDefault();
      isCarouselWheelLocked = true;
      setTimeout(() => { isCarouselWheelLocked = false; }, 85);
      stepCarouselFocus(delta > 0 ? 1 : -1);
    }, { passive: false });

    let touchStartY = 0;
    let touchStartX = 0;
    viewDiscoverEl.addEventListener('touchstart', (e) => {
      if (!isDiscoverActive()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.touches.length > 0) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
      }
    }, { passive: true });

    viewDiscoverEl.addEventListener('touchend', (e) => {
      if (!isDiscoverActive()) return;
      if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
      if (e.changedTouches.length > 0) {
        const touchEndY = e.changedTouches[0].clientY;
        const touchEndX = e.changedTouches[0].clientX;
        const diffY = touchStartY - touchEndY;
        const diffX = touchStartX - touchEndX;
        // vertical swipes scroll the page; sideways swipes flip cards
        if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY)) {
          stepCarouselFocus(diffX > 0 ? 1 : -1);
        }
      }
    }, { passive: true });
  }

  window.addEventListener('keydown', (e) => {
    if (!isDiscoverActive() || isFormInputFocused()) return;
    if (el.searchResultsContainer && !el.searchResultsContainer.classList.contains('hidden')) return;
    // Up/Down scroll the (now scrolling) Home page; nothing behind an open dialog or Encore moves
    if (document.querySelector('.encore, .modal-backdrop.visible:not(.hidden)')) return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepCarouselFocus(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepCarouselFocus(1);
    }
  });


  // "For you": genres, similar artists and picks from /api/discover (iTunes genres + Deezer related/charts)
  let forYouSig = '';
  async function loadForYou(force) {
    const box = document.getElementById('section-for-you');
    if (!box || !state.serverPort) return;
    const sig = `${state.history.length}:${state.favorites.length}:${state.history[0] ? state.history[0].id : ''}`;
    if (!force && sig === forYouSig) return;
    forYouSig = sig;
    let data = null;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/discover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: state.history.slice(0, 60), favorites: state.favorites.slice(0, 60) }),
      });
      data = await res.json();
    } catch (e) {}
    // forget the signature on a failed (or offline, empty) load, or "For you" stayed empty until the history changed
    const empty = !data || !data.success || (!(data.genres || []).length && !(data.sections || []).some((x) => (x.items || x.tracks || []).length));
    if (empty) { if (forYouSig === sig) forYouSig = ''; return; }
    box.innerHTML = '';
    const section = (title) => {
      const block = document.createElement('div');
      block.className = 'section-block fy-section';
      block.innerHTML = `<div class="section-header-inline"><h3 class="section-title">${escapeHtml(title)}</h3></div>`;
      box.appendChild(block);
      return block;
    };
    if (data.genres && data.genres.length) {
      const chips = document.createElement('div');
      chips.className = 'suggestion-chips fy-genres';
      data.genres.slice(0, 6).forEach((g) => {
        const c = document.createElement('button');
        c.className = 'chip-btn';
        c.textContent = g;
        c.addEventListener('click', () => { if (el.searchInput) el.searchInput.value = `${g} music`; performSearch(`${g} music`); });
        chips.appendChild(c);
      });
      section('Your genres').appendChild(chips);
    }
    // blocked artists and songs stay out of For you; so do the songs you played just now
    const blockedArtists = getBlocks().artists;
    const recentKeys = new Set((state.history || []).slice(0, 30).map(t => getTrackNormalizedKey(t.artist, t.title)));
    for (const raw of data.sections || []) {
      const sec = raw.type === 'artists'
        ? { ...raw, items: (raw.items || []).filter(a => a && !Lib.isArtistBlocked(blockedArtists, a.name)) }
        : { ...raw, tracks: (raw.tracks || []).filter(t => t && !isBlocked(t) && !recentKeys.has(getTrackNormalizedKey(t.artist, t.title))) };
      if (!(sec.items || sec.tracks || []).length) continue;
      const row = document.createElement('div');
      row.className = 'fy-row';
      if (sec.type === 'artists') {
        sec.items.forEach((a) => {
          const b = document.createElement('button');
          b.className = 'fy-artist';
          b.innerHTML = `<img src="${escapeHtml(a.picture || '')}" alt="" loading="lazy" decoding="async"><span>${escapeHtml(a.name)}</span>`;
          b.addEventListener('click', () => openArtistProfile(a.name));
          row.appendChild(b);
        });
      } else {
        sec.tracks.forEach((t, i) => {
          const b = document.createElement('button');
          b.className = 'fy-card';
          b.innerHTML = `<img src="${escapeHtml(listThumb(getTrackThumbUrl(t)) || '')}" data-art="${escapeHtml(JSON.stringify(trackArtCandidates(t)))}" alt="" loading="lazy" decoding="async" onerror="${THUMB_FALLBACK}"><span class="fy-title">${escapeHtml(t.title)}</span><span class="fy-artist-name">${escapeHtml(t.artist)}</span>`;
          b.addEventListener('click', () => playTrack(t, sec.tracks, i));
          row.appendChild(b);
        });
      }
      section(sec.title).appendChild(row);
    }
  }

  // ---- Home layout: Muriel (the carousel; the default) or Spotify-style rows (Settings > Advanced > Home layout) ----
  // The Spotify layout trades the carousel for quick picks (Liked songs, what you played last), "Made for you"
  // (My Wave and up to five Daily Mixes, new every day), Trending now and the artists you follow. Sync invite,
  // Your playlists, On repeat and For you stay below in both layouts.
  // (var: switchView can render Home before this block has run)
  var spHomeReady = false;
  function isSpotifyHome() {
    try { return (localStorage.getItem('muriel_home_layout') || 'spotify') === 'spotify'; } catch (e) { return false; }
  }
  const DAILY_MIXES_KEY = 'muriel_daily_mixes';
  const TRENDING_CACHE_KEY = 'muriel_trending_cache';
  const spThumb = (t) => (t && (getTrackThumbUrl(t) || t.thumbnail || t.cover)) || '';

  function spCoverPlaceholder(wrap) {
    if (wrap.querySelector('.sp-cover-note')) return;
    wrap.insertAdjacentHTML('beforeend', '<svg class="sp-cover-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>');
  }

  function spCard({ cover, gridCovers, title, sub, explicit, round, onClick }) {
    const card = document.createElement('div');
    card.className = 'sp-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const coverWrap = document.createElement('div');
    coverWrap.className = round ? 'sp-card-cover round' : 'sp-card-cover';
    if (Array.isArray(gridCovers) && gridCovers.length >= 4) {
      const grid = document.createElement('div');
      grid.className = 'sp-grid-cover';
      gridCovers.slice(0, 4).forEach((c) => {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = c || '';
        grid.appendChild(img);
      });
      coverWrap.appendChild(grid);
    } else if (cover) {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
      // a music note instead of the broken-image icon when the cover doesn't load (from Riff 43.2)
      img.addEventListener('error', () => { img.remove(); spCoverPlaceholder(coverWrap); }, { once: true });
      img.src = cover;
      coverWrap.appendChild(img);
    } else if (!round) {
      spCoverPlaceholder(coverWrap);
    }
    const titleEl = document.createElement('div');
    titleEl.className = 'sp-card-title sp-fade';
    titleEl.textContent = title || '';
    const subEl = document.createElement('div');
    subEl.className = 'sp-card-sub sp-fade';
    if (explicit) subEl.insertAdjacentHTML('afterbegin', '<span class="explicit-badge" title="Explicit">E</span>');
    subEl.appendChild(document.createTextNode(sub || ''));
    card.append(coverWrap, titleEl, subEl);
    if (onClick) {
      card.addEventListener('click', onClick);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
    }
    return card;
  }
  function spSpinnerCard(title) {
    const card = spCard({ title });
    card.classList.add('sp-card-loading');
    card.querySelector('.sp-card-cover').innerHTML = '<svg class="g-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>';
    return card;
  }
  function finishRow(row) {
    bindHorizontalWheel(row);
    requestAnimationFrame(() => updateRowFade(row));
  }

  // Liked songs and the last songs you played (your playlists fill up the grid when there are few)
  function renderQuickAccess() {
    const sec = document.getElementById('sp-quick-sec');
    const box = document.getElementById('sp-quick');
    if (!sec || !box) return;
    sec.hidden = !getAdv('jump_back', true);
    if (sec.hidden) return;
    box.innerHTML = '';
    const tile = (cls, title, sub, onClick) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = `sp-tile ${cls}`;
      t.innerHTML = `<span class="sp-tile-art"></span><span class="sp-tile-text"><span class="sp-tile-title sp-fade"></span><span class="sp-tile-sub sp-fade"></span></span>`;
      t.querySelector('.sp-tile-title').textContent = title;
      t.querySelector('.sp-tile-sub').textContent = sub || '';
      t.addEventListener('click', onClick);
      box.appendChild(t);
      return t.querySelector('.sp-tile-art');
    };
    const favs = (state.favorites || []).length;
    tile('sp-tile-liked', 'Liked songs', `${favs} song${favs === 1 ? '' : 's'}`, () => switchView('favorites'))
      .innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
    const seen = new Set();
    const recent = [];
    for (const t of state.history || []) {
      const k = t && (getTrackCanonicalId(t) || `${t.artist}::${t.title}`);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      recent.push(t);
      if (recent.length >= 5) break;
    }
    recent.forEach((t, i) => {
      const art = tile('', t.title || 'Untitled', t.artist || '', () => { state.myWaveActive = false; playTrack(t, [...recent], i); });
      art.innerHTML = `<img loading="lazy" decoding="async" alt="" src="${escapeHtml(listThumb(spThumb(t)) || spThumb(t))}">`;
    });
    (state.playlists || []).slice(0, Math.max(0, 5 - recent.length)).forEach((pl) => {
      const n = (pl.tracks || []).length;
      const art = tile('', pl.name || 'Untitled', `${n} song${n === 1 ? '' : 's'}`, () => openPlaylistDetail(pl.id));
      renderPlaylistCover(art, pl, 64);
    });
  }

  // ---- Daily Mixes: a few of the artists you play most each, with songs like theirs (library-pages.js) ----
  const readDailyMixes = () => {
    const v = safeJson(DAILY_MIXES_KEY, null);
    return v && v.day === Lib.localDay() && Array.isArray(v.mixes) ? v : null;
  };
  function mixCovers(mix) {
    const out = [];
    for (const t of mix.tracks || []) {
      const c = spThumb(t);
      if (c && !out.includes(c)) out.push(c);
      if (out.length === 4) break;
    }
    return out;
  }
  let mixesBusy = false;
  let plannedMixes = 0;
  async function generateDailyMixes(force = false) {
    if (mixesBusy || !getAdv('my_wave', true) || !isSpotifyHome()) return;
    if (!force && readDailyMixes()) return;
    mixesBusy = true;
    const day = Lib.localDay();
    const mixes = [];
    try {
      const profile = await computeTasteProfile(40);
      const plans = Lib.planMixes(profile.seeds, { day, normalize: normalizeArtistName });
      plannedMixes = plans.length;
      renderMadeForYou();
      for (const plan of plans) {
        try {
          const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              history: (state.history || []).slice(0, 30),
              favorites: (state.favorites || []).slice(0, 25),
              platform: 'youtube',
              limit: 20,
              clientProfile: profile,
              seeds: plan.seeds,
              avoid: getWaveAvoid()
            })
          });
          const data = await res.json();
          // a mix of a handful of songs is not much of a mix
          const mixTracks = data && data.success && Array.isArray(data.tracks) ? data.tracks.filter(t => !isBlocked(t)) : [];
          if (mixTracks.length >= 8) {
            mixes.push({ id: plan.id, title: `Daily Mix ${mixes.length + 1}`, artists: plan.artists, tracks: mixTracks });
            try { localStorage.setItem(DAILY_MIXES_KEY, JSON.stringify({ day, mixes })); } catch (e) {}
            renderMadeForYou();
          }
        } catch (e) {
          break;
        }
      }
    } catch (e) {
    } finally {
      mixesBusy = false;
      plannedMixes = 0;
      // an empty day is remembered too, so a failed try doesn't run again on every visit to Home
      try { localStorage.setItem(DAILY_MIXES_KEY, JSON.stringify({ day, mixes })); } catch (e) {}
      renderMadeForYou();
    }
  }

  let mixesTimer = 0;
  function renderMadeForYou() {
    const sec = document.getElementById('sp-made-sec');
    const row = document.getElementById('sp-made');
    if (!sec || !row) return;
    if (!getAdv('my_wave', true)) { sec.hidden = true; return; }
    const cached = readDailyMixes();
    const mixes = cached ? cached.mixes : [];
    if (!cached && !mixesBusy && !mixesTimer) {
      // not straight away: the home page's own recommendations go first; and not while nobody sees the
      // window (each mix runs yt-dlp several times, #16): the home page asks again when it's shown
      mixesTimer = setTimeout(() => { mixesTimer = 0; if (!document.hidden && state.isWindowVisible !== false) generateDailyMixes(false); }, 3000);
    }
    const wave = Array.isArray(myWaveCurrentTracks) ? myWaveCurrentTracks : [];
    if (!wave.length && !mixes.length && !mixesBusy) { sec.hidden = true; return; }
    sec.hidden = false;
    row.innerHTML = '';
    const playWave = () => { const b = document.getElementById('btn-play-my-wave'); if (b) b.click(); };
    row.appendChild(wave.length
      ? spCard({ cover: spThumb(wave[0]), title: state.isHotPicks ? (state.hotPicksTitle || 'Hot picks') : 'My Wave', sub: state.isHotPicks ? 'Popular right now' : 'Based on your taste', onClick: playWave })
      : spSpinnerCard('My Wave'));
    mixes.forEach((mix, i) => {
      const covers = mixCovers(mix);
      row.appendChild(spCard({
        cover: covers[0] || '',
        gridCovers: covers.length >= 4 ? covers : null,
        title: mix.title || `Daily Mix ${i + 1}`,
        sub: (mix.artists || []).join(', '),
        onClick: () => openAlbum({
          id: mix.id,
          title: mix.title || `Daily Mix ${i + 1}`,
          type: 'Daily Mix',
          artist: (mix.artists || []).join(', ') || 'Daily Mix',
          mixArtists: mix.artists || [],
          trackCount: (mix.tracks || []).length,
          tracks: [...(mix.tracks || [])],
          gridCovers: covers.length >= 4 ? covers : null,
          cover: covers[0] || ''
        })
      }));
    });
    if (mixesBusy) {
      for (let n = mixes.length + 1; n <= Math.max(mixes.length + 1, plannedMixes); n++) row.appendChild(spSpinnerCard(`Daily Mix ${n}`));
    }
    finishRow(row);
  }
  const btnRegenMixes = document.getElementById('btn-regen-mixes');
  if (btnRegenMixes) {
    btnRegenMixes.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mixesBusy) return;
      try { localStorage.removeItem(DAILY_MIXES_KEY); } catch (err) {}
      generateDailyMixes(true);
    });
  }

  // ---- Trending now: Apple Music's most played songs in your country (or Deezer's chart), from /api/trending ----
  let trendingLoadedAt = 0;
  function renderTrendingCards(row, tracks) {
    row.innerHTML = '';
    tracks.forEach((t, i) => row.appendChild(spCard({
      cover: spThumb(t),
      title: t.title || 'Untitled',
      sub: t.artist || '',
      explicit: Lib.isTrackExplicit(t),
      onClick: () => { state.myWaveActive = false; playTrack(t, [...tracks], i); }
    })));
    finishRow(row);
  }
  async function renderTrending() {
    const sec = document.getElementById('sp-trend-sec');
    const row = document.getElementById('sp-trend');
    if (!sec || !row) return;
    if (!getAdv('my_wave', true)) { sec.hidden = true; return; }
    const cached = safeJson(TRENDING_CACHE_KEY, null);
    const hasCached = !!(cached && Array.isArray(cached.tracks) && cached.tracks.length);
    if (hasCached) {
      sec.hidden = false;
      if (!row.children.length) renderTrendingCards(row, cached.tracks);
    }
    // the chart changes slowly: once an hour is plenty
    if (Date.now() - trendingLoadedAt < 3600e3 && hasCached) return;
    trendingLoadedAt = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/trending`);
      const data = await res.json();
      if (data && data.success && Array.isArray(data.tracks) && data.tracks.length) {
        try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ at: Date.now(), tracks: data.tracks })); } catch (e) {}
        sec.hidden = false;
        renderTrendingCards(row, data.tracks);
        return;
      }
    } catch (e) {}
    if (!hasCached) { sec.hidden = true; trendingLoadedAt = 0; }
  }

  // ---- the artists you follow: "Your artists" (both layouts), Play and Profile on each ----
  function artistPlays(name) {
    const k = Lib.nameKey(name);
    return (state.history || []).filter((t) => t && Lib.nameKey(String(t.artist || '').split(/\s*(?:,|&|\bfeat\.|\bft\.)\s*/i)[0]) === k).length;
  }
  async function playFollowedArtist(a) {
    try {
      const q = `name=${encodeURIComponent(a.name)}${a.id ? `&id=${encodeURIComponent(a.id)}` : ''}`;
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?${q}`);
      const data = await res.json();
      const tracks = (data && data.success && data.artist && data.artist.tracks) || [];
      if (!tracks.length) { showToast(`No songs found for ${a.name}`, 'warning'); return; }
      state.myWaveActive = false;
      playTrack(tracks[0], [...tracks], 0);
    } catch (e) {
      showToast(`Couldn't play ${a.name}`, 'error');
    }
  }
  function followedArtistCard(a) {
    const card = document.createElement('div');
    card.className = 'fav-artist-card';
    const plays = artistPlays(a.name);
    const badge = plays > 0 ? `${compactCount(plays)} play${plays === 1 ? '' : 's'}` : (a.fans > 0 ? `${compactCount(a.fans)} fans` : '');
    card.innerHTML = `
      <div class="fav-artist-circle">
        ${a.avatar ? `<img class="fav-artist-img" loading="lazy" decoding="async" alt="" src="${escapeHtml(a.avatar)}" onerror="this.style.visibility='hidden'">` : '<svg class="fav-artist-placeholder" width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>'}
        ${badge ? `<div class="fav-artist-plays"><svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg><span>${escapeHtml(badge)}</span></div>` : ''}
        <div class="fav-artist-hover">
          <button type="button" class="fav-artist-action-btn primary btn-play-fav" title="Play ${escapeHtml(a.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Play</span></button>
          <button type="button" class="fav-artist-action-btn btn-view-fav" title="Open ${escapeHtml(a.name)}">Profile</button>
        </div>
      </div>
      <div class="fav-artist-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>`;
    const open = () => openArtistProfile(a.name, { id: a.id || '' });
    card.querySelector('.btn-play-fav').addEventListener('click', (e) => { e.stopPropagation(); playFollowedArtist(a); });
    card.querySelector('.btn-view-fav').addEventListener('click', (e) => { e.stopPropagation(); open(); });
    card.addEventListener('click', (e) => { if (!e.target.closest('.fav-artist-action-btn')) open(); });
    return card;
  }
  // followed before their page was opened (or on another device): their picture, once per session
  const followedMetaTried = new Set();
  async function fetchFollowedMeta(list) {
    const todo = list.filter((a) => !a.avatar && !followedMetaTried.has(a.id || Lib.nameKey(a.name))).slice(0, 8);
    let changed = false;
    let followed = getFollowedArtists();
    for (const a of todo) {
      followedMetaTried.add(a.id || Lib.nameKey(a.name));
      try {
        const q = `name=${encodeURIComponent(a.name)}${a.id ? `&id=${encodeURIComponent(a.id)}` : ''}`;
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?${q}`);
        const data = await res.json();
        const info = data && data.success && data.artist;
        if (!info) continue;
        // a page by name only can't say which namesake it is: it lends the picture, never a channel
        const r = Lib.refreshFollowed(followed, { name: a.name, id: a.id ? (info.id || a.id) : '', ids: info.ids || [], avatar: info.avatar || '', fans: info.fans || 0 });
        if (r.changed) { followed = r.list; changed = true; }
      } catch (e) {}
    }
    if (changed) setFollowedArtists(followed);
  }
  function renderFollowedArtists() {
    const list = getFollowedArtists().filter((a) => a && a.name);
    const on = getAdv('fav_artists', true) && list.length > 0;
    const sp = isSpotifyHome();
    const spSec = document.getElementById('sp-artists-sec');
    const spRow = document.getElementById('sp-artists');
    if (spSec) spSec.hidden = !(on && sp);
    if (spRow && on && sp) {
      spRow.innerHTML = '';
      list.forEach((a) => spRow.appendChild(followedArtistCard(a)));
      finishRow(spRow);
    }
    const box = document.getElementById('section-home-artists');
    if (box) {
      box.hidden = !(on && !sp);
      if (on && !sp) {
        box.innerHTML = '<div class="onrepeat-head"><h3 class="section-title">Your artists</h3></div><div class="sp-row fav-artists-row" id="home-artists-row"></div>';
        const row = box.querySelector('.sp-row');
        list.forEach((a) => row.appendChild(followedArtistCard(a)));
        finishRow(row);
      } else {
        box.innerHTML = '';
      }
    }
    if (on && state.serverPort) fetchFollowedMeta(list);
    updateArtistsCount();
    if (state.currentView === 'artists') renderArtistsTab();
  }

  // ---- the Artists tab (#10): the artists you follow, like the Albums tab; Settings > Tracks > Show Artists tab ----
  function updateArtistsCount() {
    const n = getFollowedArtists().filter((a) => a && a.name).length;
    const badge = document.getElementById('artists-count');
    if (badge) badge.textContent = n;
    const sub = document.getElementById('artists-subtitle');
    if (sub) sub.textContent = n === 1 ? T('1 artist followed') : Tf('{0} artists followed', n);
  }
  function renderArtistsTab() {
    const grid = document.getElementById('followed-artists-grid');
    if (!grid) return;
    const list = getFollowedArtists().filter((a) => a && a.name);
    updateArtistsCount();
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = `<div class="empty-hint">${escapeHtml(T('No artists yet. Open an artist and tap Follow to see them here.'))}</div>`;
      return;
    }
    sortedLibrary('artists', list).forEach((a) => grid.appendChild(followedArtistCard(a)));
    if (state.serverPort) fetchFollowedMeta(list);
  }
  const btnShowArtists = document.getElementById('btn-show-artists');
  function applyShowArtists() {
    const show = localStorage.getItem('muriel_show_artists') === '1';
    document.body.classList.toggle('hide-artists-tab', !show);
    const nav = document.getElementById('nav-artists');
    if (nav) nav.classList.toggle('nav-collapsed', !show);
    if (btnShowArtists) btnShowArtists.classList.toggle('active', show);
    if (!show && state.currentView === 'artists') switchView('discover');
    updateArtistsCount();
    refreshStacks();
    updateNavIndicator(false);
  }
  if (btnShowArtists) {
    btnShowArtists.addEventListener('click', () => {
      localStorage.setItem('muriel_show_artists', localStorage.getItem('muriel_show_artists') === '1' ? '0' : '1');
      applyShowArtists();
    });
  }
  applyShowArtists();

  function renderSpotifyHome() {
    if (!spHomeReady || !isSpotifyHome()) return;
    renderQuickAccess();
    renderMadeForYou();
    renderTrending();
    renderFollowedArtists();
  }

  function applyHomeLayout() {
    const sp = isSpotifyHome();
    document.body.classList.toggle('home-spotify', sp);
    const btnSp = document.getElementById('home-layout-spotify');
    const btnMu = document.getElementById('home-layout-riff');
    if (btnSp) btnSp.classList.toggle('active', sp);
    if (btnMu) btnMu.classList.toggle('active', !sp);
    renderFollowedArtists();
    if (sp) renderSpotifyHome();
    if (typeof syncHomeAmbientVisibility === 'function') syncHomeAmbientVisibility();
  }
  document.querySelectorAll('#home-layout-toggle .theme-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      try { localStorage.setItem('muriel_home_layout', btn.dataset.layout === 'spotify' ? 'spotify' : 'muriel'); } catch (e) {}
      applyHomeLayout();
    });
  });
  // the home toggles of Settings > Advanced also switch rows of this layout on and off
  document.querySelectorAll('.effect-switch-btn[data-adv="fav_artists"], .effect-switch-btn[data-adv="my_wave"], .effect-switch-btn[data-adv="jump_back"]').forEach((btn) => {
    btn.addEventListener('click', () => setTimeout(() => { renderFollowedArtists(); renderSpotifyHome(); }, 0));
  });
  spHomeReady = true;
  applyHomeLayout();

  async function loadHomePage(isRefresh = false) {
    loadForYou();
    const jumpSection = document.getElementById('section-jump-back');
    if (jumpSection) {
      jumpSection.style.display = 'none';
    }

    const waveSection = document.getElementById('section-my-wave');
    if (waveSection) {
      waveSection.style.display = '';
    }

    if (!isRefresh) {
      jumpBackCurrentTracks = getJumpBackTracks();
      initHomeHero();
    }
    if (availableModes().length === 0) return false;

    if (!getAdv('my_wave', true)) {
      if (homeMode === 'recent') {
        renderHomeCarousel('recent');
      }
      return false;
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');

    if (!isRefresh && focusedMeta && homeMode === 'wave' && myWaveCurrentTracks.length === 0) {
      focusedMeta.innerHTML = `
        <div class="my-wave-skeleton-title-bar skeleton-shimmer"></div>
        <div class="my-wave-skeleton-artist-bar skeleton-shimmer"></div>
      `;
    }

    if (!isRefresh && vibeGrid && homeMode === 'wave' && myWaveCurrentTracks.length === 0) {
      vibeGrid.style.opacity = '1';
      vibeGrid.innerHTML = getWaveSpinnerHtml();
    }

    try {
      const profile = await computeTasteProfile();
      const vibePayload = {
        history: (state.history || []).slice(0, 30),
        favorites: (state.favorites || []).slice(0, 25),
        platform: 'youtube',
        limit: 10,
        clientProfile: profile,
        seeds: profile.seeds,
        avoid: getWaveAvoid()
      };
      if (isRefresh) {
        vibePayload.refresh = true;
      }
      let uniqueTracks = [];
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vibePayload)
        });

        const data = await res.json();
        if (data && data.success && Array.isArray(data.tracks)) {
          const seenIds = new Set();
          const seenKeys = new Set();
          for (const t of data.tracks) {
            const cid = getTrackCanonicalId(t);
            const nkey = getTrackNormalizedKey(t.artist, t.title);
            if (!seenIds.has(cid) && !seenKeys.has(nkey)) {
              seenIds.add(cid);
              seenKeys.add(nkey);
              uniqueTracks.push(t);
            }
          }
        }
      } catch (_) {}

      state.isHotPicks = false;
      state.hotPicksTitle = '';

      if (uniqueTracks.length < 5) {
        try {
          const hotRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/hot?limit=12`);
          const hotData = await hotRes.json();
          if (hotData && hotData.success && Array.isArray(hotData.tracks) && hotData.tracks.length > 0) {
            uniqueTracks = hotData.tracks;
            state.isHotPicks = true;
            state.hotPicksTitle = hotData.title || `Hot picks ${new Date().getFullYear()}`;
          }
        } catch (_) {}
      }

      if (uniqueTracks.length === 0) {
        if (!isRefresh) {
          myWaveCurrentTracks = [];
          if (homeMode === 'wave') {
            if (focusedMeta) focusedMeta.innerHTML = '';
            if (vibeGrid) {
              vibeGrid.innerHTML = `
                <div class="my-wave-retry-container" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin: auto; padding: 24px; color: var(--md-sys-color-on-surface-variant); font-size: 14px;">
                  <span data-i18n>Couldn't load recommendations</span>
                  <button class="btn-icon-pill" id="btn-retry-vibe" title="Retry" aria-label="Retry" data-i18n-attr="title aria-label" style="width: 32px; height: 32px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                  </button>
                </div>
              `;
              const retryBtn = vibeGrid.querySelector('#btn-retry-vibe');
              if (retryBtn) {
                retryBtn.addEventListener('click', () => {
                  if (el.btnRefreshVibe) el.btnRefreshVibe.click();
                  else loadHomePage(true);
                });
              }
            }
            updateAmbientLight('my-wave-ambient-light', '');
          }
        }
        return false;
      }

      // blocked artists and songs never make it into My Wave (the server leaves them out too; this is the safety net)
      myWaveCurrentTracks = uniqueTracks.filter(t => !isBlocked(t));
      if (!myWaveCurrentTracks.length) myWaveCurrentTracks = uniqueTracks;
      currentWaveFocusedIndex = 0;
      if (spHomeReady && isSpotifyHome()) renderMadeForYou();
      if (homeMode === 'wave') {
        if (vibeGrid) {
          vibeGrid.style.transition = 'none';
          vibeGrid.style.opacity = '0';
        }
        renderHomeCarousel('wave');
        currentWaveFocusedIndex = 0;
        if (vibeGrid) {
          vibeGrid.scrollLeft = 0;
          vibeGrid._focusedIndex = 0;
          const firstCard = vibeGrid.querySelector('.my-wave-track-card');
          if (firstCard && document.activeElement && document.activeElement.closest('#home-vibe-grid')) {
            firstCard.focus();
          }
          vibeGrid.offsetHeight;
          vibeGrid.style.transition = 'opacity 250ms ease';
          vibeGrid.style.opacity = '1';
        }
      }
      return true;
    } catch (err) {
      if (!isRefresh) {
        myWaveCurrentTracks = [];
        if (homeMode === 'wave') {
          if (focusedMeta) focusedMeta.innerHTML = '';
          if (vibeGrid) {
            vibeGrid.innerHTML = `
              <div class="my-wave-retry-container" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin: auto; padding: 24px; color: var(--md-sys-color-on-surface-variant); font-size: 14px;">
                <span data-i18n>Couldn't load recommendations</span>
                <button class="btn-icon-pill" id="btn-retry-vibe" title="Retry" aria-label="Retry" data-i18n-attr="title aria-label" style="width: 32px; height: 32px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
              </div>
            `;
            const retryBtn = vibeGrid.querySelector('#btn-retry-vibe');
            if (retryBtn) {
              retryBtn.addEventListener('click', () => {
                if (el.btnRefreshVibe) el.btnRefreshVibe.click();
                else loadHomePage(true);
              });
            }
          }
          updateAmbientLight('my-wave-ambient-light', '');
        }
      }
      return false;
    }
  }

  const vibeGridEl = document.getElementById('home-vibe-grid');
  if (vibeGridEl) {
    vibeGridEl.addEventListener('scroll', () => {
      const curTracks = (homeMode === 'recent') ? jumpBackCurrentTracks : myWaveCurrentTracks;
      updateCoverflowCards(vibeGridEl, document.getElementById('my-wave-focused-title'), document.getElementById('my-wave-focused-artist'), document.getElementById('my-wave-ambient-light'), curTracks);
    }, { passive: true });
  }

  const quickRowEl = document.getElementById('home-quick-play-row');
  if (quickRowEl) {
    quickRowEl.addEventListener('scroll', () => {
      updateCoverflowCards(quickRowEl, document.getElementById('jump-focused-title'), document.getElementById('jump-focused-artist'), document.getElementById('jump-ambient-light'), jumpBackCurrentTracks);
    }, { passive: true });
  }

  const cacheModal = document.getElementById('cache-modal');
  const cacheModalCard = document.querySelector('.cache-modal-card');
  const btnCancelCache = document.getElementById('btn-cancel-cache');
  const btnConfirmClearCache = document.getElementById('btn-confirm-clear-cache');
  const cacheAudioSize = document.getElementById('cache-audio-size');
  const cacheWebSize = document.getElementById('cache-web-size');

  const CACHE_BAR_MAX_BYTES = 4 * 1024 * 1024 * 1024;
  const CACHE_BAR_SAFE_STOP = 0.25;
  const CACHE_BAR_DANGER_STOP = 0.75;
  const CACHE_BAR_MIN_VISIBLE_PX = 4;

  const cacheBars = {
    audio: { canvas: document.getElementById('cache-audio-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 },
    web: { canvas: document.getElementById('cache-web-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 }
  };
  let cacheRafId = 0;
  let cachePhase = 0;
  let cacheSpeed = 0.06;
  let cacheTargetSpeed = 0.06;
  let cacheBusy = false;
  let cacheColors = { primary: '#6750A4', dim: '#E6E0E9', warn: '#F9A825', error: '#B3261E' };

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      obj.textContent = formatBytes(Math.floor(progress * (end - start) + start));
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }

  const cacheWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readCacheColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      primary: rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4',
      dim: rootStyle.getPropertyValue('--md-sys-color-surface-container-highest-solid').trim() || '#E6E0E9',
      warn: '#F9A825',
      error: rootStyle.getPropertyValue('--md-sys-color-error').trim() || '#B3261E'
    };
  }

  function setCacheBarTarget(bar, bytes, duration) {
    bar.from = bar.current;
    bar.to = bytes;
    bar.t0 = performance.now();
    bar.dur = duration;
  }

  function drawCacheBar(canvas, bytes, phase) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const lineW = 6;
    const pad = lineW / 2;
    const centerY = h / 2;
    const usable = Math.max(1, w - lineW);

    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pad, centerY);
    ctx.lineTo(w - pad, centerY);
    ctx.strokeStyle = cacheColors.dim;
    ctx.stroke();

    if (bytes <= 0) return;
    const frac = Math.min(1, Math.max(0, bytes / CACHE_BAR_MAX_BYTES));
    const fillW = Math.max(frac * usable, CACHE_BAR_MIN_VISIBLE_PX);
    const endX = pad + fillW;

    const grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
    grad.addColorStop(0, cacheColors.primary);
    grad.addColorStop(CACHE_BAR_SAFE_STOP, cacheColors.primary);
    grad.addColorStop((CACHE_BAR_SAFE_STOP + CACHE_BAR_DANGER_STOP) / 2, cacheColors.warn);
    grad.addColorStop(CACHE_BAR_DANGER_STOP, cacheColors.error);
    grad.addColorStop(1, cacheColors.error);

    const amplitude = 4;
    const freq = 0.12;
    ctx.beginPath();
    for (let x = pad; x <= endX; x++) {
      const distFromEnd = endX - x;
      const damping = Math.min(1, distFromEnd / 14);
      const distFromStart = x - pad;
      const startDamping = Math.min(1, distFromStart / 14);
      const snakeWave = Math.sin(x * freq - phase) + 0.4 * Math.sin(x * freq * 0.5 - phase * 1.5);
      const y = centerY + snakeWave * (amplitude * damping * startDamping);
      if (x === pad) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

  function cacheFrame(now) {
    if (document.hidden || !state.isWindowVisible || !cacheModal || !cacheModal.classList.contains('visible')) {
      cacheRafId = 0;
      return;
    }
    cacheSpeed += (cacheTargetSpeed - cacheSpeed) * 0.08;
    cachePhase += cacheSpeed;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      if (bar.dur > 0) {
        const p = Math.min(1, (now - bar.t0) / bar.dur);
        const ease = 1 - Math.pow(1 - p, 3);
        bar.current = bar.from + (bar.to - bar.from) * ease;
        if (p >= 1) bar.dur = 0;
      }
      drawCacheBar(bar.canvas, bar.current, cachePhase);
    });
    cacheRafId = requestAnimationFrame(cacheFrame);
  }

  function closeCacheModal() {
    if (!cacheModal) return;
    cacheModal.classList.remove('visible');
    setTimeout(() => {
      if (cacheModal.classList.contains('visible')) return;
      cacheModal.classList.add('hidden');
      if (cacheRafId) {
        cancelAnimationFrame(cacheRafId);
        cacheRafId = 0;
      }
      if (cacheModalCard) cacheModalCard.classList.remove('cleaning', 'finishing', 'done');
      if (btnConfirmClearCache) btnConfirmClearCache.disabled = false;
      if (btnCancelCache) btnCancelCache.disabled = false;
    }, 200);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#btn-open-clear-cache');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (!cacheModal || cacheBusy) return;

    cacheColors = readCacheColors();
    cacheSpeed = 0.06;
    cacheTargetSpeed = 0.06;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      bar.current = 0;
      bar.from = 0;
      bar.to = 0;
      bar.dur = 0;
    });
    if (cacheAudioSize) { cacheAudioSize.textContent = 'calculating...'; cacheAudioSize.dataset.val = '0'; }
    if (cacheWebSize) { cacheWebSize.textContent = 'calculating...'; cacheWebSize.dataset.val = '0'; }

    cacheModal.classList.remove('hidden');
    requestAnimationFrame(() => cacheModal.classList.add('visible'));
    if (!cacheRafId) cacheRafId = requestAnimationFrame(cacheFrame);

    let sizes = { audio: 0, web: 0 };
    try {
      if (window.electronAPI && window.electronAPI.getCacheSize) {
        sizes = await window.electronAPI.getCacheSize();
      }
    } catch (err) {
      console.warn('getCacheSize failed', err);
    }
    if (cacheAudioSize) { cacheAudioSize.textContent = formatBytes(sizes.audio); cacheAudioSize.dataset.val = String(sizes.audio); }
    if (cacheWebSize) { cacheWebSize.textContent = formatBytes(sizes.web); cacheWebSize.dataset.val = String(sizes.web); }
    setCacheBarTarget(cacheBars.audio, sizes.audio, 900);
    setCacheBarTarget(cacheBars.web, sizes.web, 900);
  });

  if (btnCancelCache) {
    btnCancelCache.addEventListener('click', () => {
      if (cacheBusy) return;
      closeCacheModal();
    });
  }

  if (btnConfirmClearCache) {
    btnConfirmClearCache.addEventListener('click', async () => {
      if (cacheBusy) return;
      cacheBusy = true;
      btnConfirmClearCache.disabled = true;
      if (btnCancelCache) btnCancelCache.disabled = true;

      cacheModalCard.classList.add('cleaning');
      cacheTargetSpeed = 0.2;

      const startAudio = parseInt(cacheAudioSize.dataset.val || '0', 10);
      const startWeb = parseInt(cacheWebSize.dataset.val || '0', 10);
      animateValue(cacheAudioSize, startAudio, 0, 1500);
      animateValue(cacheWebSize, startWeb, 0, 1500);
      setCacheBarTarget(cacheBars.audio, 0, 1500);
      setCacheBarTarget(cacheBars.web, 0, 1500);

      const startedAt = Date.now();
      try {
        await window.electronAPI.clearCache();
      } catch (err) {
        console.warn('clearCache failed', err);
      }
      await cacheWait(Math.max(0, 1500 - (Date.now() - startedAt)));

      cacheModalCard.classList.add('finishing');
      cacheTargetSpeed = 0;
      await cacheWait(350);

      cacheModalCard.classList.remove('cleaning', 'finishing');
      cacheModalCard.classList.add('done');
      cacheAudioSize.dataset.val = '0';
      cacheWebSize.dataset.val = '0';
      await cacheWait(1200);

      cacheBusy = false;
      closeCacheModal();
    });
  }

  async function updateOfflineStorageUI() {
    const elSize = document.getElementById('offline-library-size');
    if (!elSize) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-library`);
      const data = await res.json();
      if (data && data.success) {
        elSize.textContent = `${data.count} track${data.count === 1 ? '' : 's'} (${formatBytes(data.totalBytes)})`;
      } else {
        elSize.textContent = '0 tracks (0 B)';
      }
    } catch (e) {
      elSize.textContent = 'Unavailable';
    }
  }

  async function updateMusicFolderUI() {
    const elPath = document.getElementById('music-folder-path');
    if (!elPath) return;
    try {
      if (window.electronAPI && window.electronAPI.getDataDir) {
        const info = await window.electronAPI.getDataDir();
        if (info && info.dir) {
          elPath.textContent = info.isCustom ? info.dir : `${info.dir} (default)`;
          return;
        }
      }
    } catch (e) {
      console.warn('getDataDir failed', e);
    }
    elPath.textContent = T('Unavailable');
  }

  const btnChangeMusicFolder = document.getElementById('btn-change-music-folder');
  if (btnChangeMusicFolder) {
    btnChangeMusicFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.pickDataDir) return;
      if (btnChangeMusicFolder.disabled) return;
      let info = null;
      try { info = await window.electronAPI.getDataDir(); } catch (e) {}
      const dir = await window.electronAPI.pickDataDir();
      if (!dir) return;
      if (info && info.dir && dir === info.dir) {
        showToast(Tm('This is already the music folder'));
        return;
      }
      const move = window.confirm(
        T('Move your existing music to the new folder?') + '\n\n' +
        T('OK: move all downloaded and imported files, then restart Muriel.') + '\n' +
        T('Cancel: switch to the new folder without moving (files stay in the old one).')
      );
      btnChangeMusicFolder.disabled = true;
      const originalLabel = btnChangeMusicFolder.textContent;
      btnChangeMusicFolder.textContent = move ? 'Moving...' : 'Switching...';
      showToast(move ? Tm('Moving your music, this may take a while...') : Tm('Switching music folder...'));
      let res = null;
      try {
        res = await window.electronAPI.setDataDir(dir, move);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      if (!res || !res.ok) {
        showToast((res && res.error) || Tm('Could not change the music folder'), 'error');
        btnChangeMusicFolder.disabled = false;
        btnChangeMusicFolder.textContent = originalLabel;
        return;
      }
      btnChangeMusicFolder.textContent = 'Restarting...';
      showToast(Tm('Restarting Muriel...'));
      setTimeout(() => { if (window.electronAPI.restartApp) window.electronAPI.restartApp(); }, 400);
    });
  }

  async function updateDownloadFolderUI() {
    const elPath = document.getElementById('download-folder-path');
    const btnReset = document.getElementById('btn-reset-download-folder');
    if (elPath) {
      try {
        if (window.electronAPI && window.electronAPI.getDownloadDir) {
          const info = await window.electronAPI.getDownloadDir();
          if (info && info.dir) {
            elPath.textContent = info.isCustom ? info.dir : `${info.dir} (default)`;
            if (btnReset) btnReset.classList.toggle('hidden', !info.isCustom);
            return;
          }
        }
      } catch (e) {
        console.warn('getDownloadDir failed', e);
      }
      elPath.textContent = T('Unavailable');
    }
    if (btnReset) btnReset.classList.add('hidden');
  }

  const btnChangeDownloadFolder = document.getElementById('btn-change-download-folder');
  if (btnChangeDownloadFolder) {
    btnChangeDownloadFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.pickDownloadDir) return;
      if (btnChangeDownloadFolder.disabled) return;
      let info = null;
      try { info = await window.electronAPI.getDownloadDir(); } catch (e) {}
      const dir = await window.electronAPI.pickDownloadDir();
      if (!dir) return;
      if (info && info.dir && dir === info.dir) {
        showToast(Tm('This is already the download folder'));
        return;
      }
      btnChangeDownloadFolder.disabled = true;
      let res = null;
      try {
        res = await window.electronAPI.setDownloadDir(dir);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      btnChangeDownloadFolder.disabled = false;
      if (!res || !res.ok) {
        showToast((res && res.error) || Tm('Could not change the download folder'), 'error');
        return;
      }
      updateDownloadFolderUI();
      updateDownloadCaptionPath();
      showToast(Tm('Downloads will be saved to {0}', res.dir));
    });
  }

  const btnResetDownloadFolder = document.getElementById('btn-reset-download-folder');
  if (btnResetDownloadFolder) {
    btnResetDownloadFolder.addEventListener('click', async () => {
      if (!window.electronAPI || !window.electronAPI.resetDownloadDir) return;
      if (btnResetDownloadFolder.disabled) return;
      btnResetDownloadFolder.disabled = true;
      let res = null;
      try {
        res = await window.electronAPI.resetDownloadDir();
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      btnResetDownloadFolder.disabled = false;
      if (!res || !res.ok) {
        showToast((res && res.error) || Tm('Could not reset the download folder'), 'error');
        return;
      }
      updateDownloadFolderUI();
      showToast(Tm('Download folder reset to default'));
    });
  }

  const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
  if (btnDeleteOfflineTrack) {
    btnDeleteOfflineTrack.addEventListener('click', async () => {
      if (!trackToDownload || !trackToDownload.id) return;
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-delete?id=${encodeURIComponent(trackToDownload.id)}`, { method: 'POST' });
        showToast(Tm('Track removed from offline cache'));
        updateOfflineStorageUI();
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (e) {
        showToast(Tm('Failed to delete offline track'));
      }
    });
  }

  const btnClearOffline = document.getElementById('btn-clear-offline');
  const clearOfflineModal = document.getElementById('clear-offline-modal');
  const btnCancelClearOffline = document.getElementById('btn-cancel-clear-offline');
  const btnConfirmClearOffline = document.getElementById('btn-confirm-clear-offline');

  if (btnClearOffline && clearOfflineModal) {
    btnClearOffline.addEventListener('click', () => {
      openModal(clearOfflineModal);
    });
  }
  if (btnCancelClearOffline && clearOfflineModal) {
    btnCancelClearOffline.addEventListener('click', () => {
      closeModal(clearOfflineModal);
    });
  }
  if (btnConfirmClearOffline && clearOfflineModal) {
    btnConfirmClearOffline.addEventListener('click', async () => {
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/clear-offline-library`, { method: 'POST' });
        showToast(Tm('Offline library cleared'));
        updateOfflineStorageUI();
      } catch (e) {
        showToast(Tm('Failed to clear offline library'));
      }
      closeModal(clearOfflineModal);
    });
  }

  let toolsPollInterval = null;
  let toolsWavyYt = null;
  let toolsWavyFf = null;

  const STATUS_ICONS = {
    pending: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--md-sys-color-outline);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    downloading: '<svg class="g-spinner" style="width: 18px; height: 18px;" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>',
    done: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #4cd964;"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--md-sys-color-error, #ff5449);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  };

  function updateToolsUI(data) {
    const statusText = document.getElementById('tools-status-text');
    const btnInstall = document.getElementById('btn-install-tools');
    if (!data) return;

    const prog = data.progress || {};
    const status = prog.status || 'idle';
    const tool = prog.tool || '';
    const pct = typeof prog.percent === 'number' ? prog.percent : 0;
    const errorMsg = prog.error || '';

    let ytdlpStatus = 'pending';
    let ffmpegStatus = 'pending';
    let activeTool = null;
    let activePercent = 0;

    if (status === 'done' || (data.ytDlp && data.ffmpeg)) {
      ytdlpStatus = 'done';
      ffmpegStatus = 'done';
    } else if (status === 'error') {
      if (tool === 'yt-dlp') {
        ytdlpStatus = 'error';
        ffmpegStatus = 'pending';
      } else if (tool === 'ffmpeg') {
        ytdlpStatus = 'done';
        ffmpegStatus = 'error';
      } else {
        ytdlpStatus = data.ytDlp ? 'done' : 'error';
        ffmpegStatus = data.ffmpeg ? 'done' : 'error';
      }
    } else if (status === 'downloading') {
      if (tool === 'yt-dlp') {
        ytdlpStatus = 'downloading';
        ffmpegStatus = 'pending';
        activeTool = 'yt-dlp';
        activePercent = pct;
      } else if (tool === 'ffmpeg') {
        ytdlpStatus = 'done';
        ffmpegStatus = 'downloading';
        activeTool = 'ffmpeg';
        activePercent = pct;
      }
    } else {
      ytdlpStatus = data.ytDlp ? 'done' : 'pending';
      ffmpegStatus = data.ffmpeg ? 'done' : 'pending';
    }

    const iconYt = document.getElementById('tools-icon-ytdlp');
    const iconFf = document.getElementById('tools-icon-ffmpeg');
    if (iconYt) iconYt.innerHTML = STATUS_ICONS[ytdlpStatus] || STATUS_ICONS.pending;
    if (iconFf) iconFf.innerHTML = STATUS_ICONS[ffmpegStatus] || STATUS_ICONS.pending;

    const pctYt = document.getElementById('tools-pct-ytdlp');
    const pctFf = document.getElementById('tools-pct-ffmpeg');
    if (pctYt) {
      pctYt.textContent = ytdlpStatus === 'downloading' ? `${activePercent}%` : (ytdlpStatus === 'done' ? 'Ready' : (ytdlpStatus === 'error' ? 'Failed' : ''));
    }
    if (pctFf) {
      pctFf.textContent = ffmpegStatus === 'downloading' ? `${activePercent}%` : (ffmpegStatus === 'done' ? 'Ready' : (ffmpegStatus === 'error' ? 'Failed' : ''));
    }

    const wrapYt = document.getElementById('tools-wavy-ytdlp');
    const wrapFf = document.getElementById('tools-wavy-ffmpeg');
    if (activeTool === 'yt-dlp') {
      if (wrapYt) {
        wrapYt.style.display = 'block';
        wrapYt.style.setProperty('--tools-progress', activePercent.toString());
        if (!toolsWavyYt && typeof createWavyProgress === 'function') toolsWavyYt = createWavyProgress(wrapYt);
        if (toolsWavyYt) toolsWavyYt.set(activePercent);
      }
      if (wrapFf) wrapFf.style.display = 'none';
    } else if (activeTool === 'ffmpeg') {
      if (wrapYt) wrapYt.style.display = 'none';
      if (wrapFf) {
        wrapFf.style.display = 'block';
        wrapFf.style.setProperty('--tools-progress', activePercent.toString());
        if (!toolsWavyFf && typeof createWavyProgress === 'function') toolsWavyFf = createWavyProgress(wrapFf);
        if (toolsWavyFf) toolsWavyFf.set(activePercent);
      }
    } else {
      if (wrapYt) wrapYt.style.display = 'none';
      if (wrapFf) wrapFf.style.display = 'none';
    }

    const errEl = document.getElementById('tools-error-msg');
    const btnDownload = document.getElementById('btn-confirm-install-tools');
    const btnRetry = document.getElementById('btn-retry-tools');
    const btnDismiss = document.getElementById('btn-dismiss-tools-modal');

    if (errEl) {
      if (status === 'error' && errorMsg) {
        errEl.textContent = errorMsg;
        errEl.style.display = 'block';
      } else {
        errEl.style.display = 'none';
      }
    }

    if (status === 'error') {
      if (btnRetry) btnRetry.style.display = 'inline-flex';
      if (btnDownload) btnDownload.style.display = 'none';
      if (btnDismiss) btnDismiss.textContent = 'Close';
    } else if (status === 'downloading') {
      if (btnRetry) btnRetry.style.display = 'none';
      if (btnDownload) {
        btnDownload.style.display = 'inline-flex';
        btnDownload.disabled = true;
        btnDownload.textContent = 'Downloading...';
      }
      if (btnDismiss) btnDismiss.textContent = 'Not now';
    } else if (status === 'done' || (data.ytDlp && data.ffmpeg)) {
      if (btnRetry) btnRetry.style.display = 'none';
      if (btnDownload) btnDownload.style.display = 'none';
      if (btnDismiss) btnDismiss.textContent = 'Close';
    } else {
      if (btnRetry) btnRetry.style.display = 'none';
      if (btnDownload) {
        btnDownload.style.display = 'inline-flex';
        btnDownload.disabled = false;
        btnDownload.textContent = 'Download';
      }
      if (btnDismiss) btnDismiss.textContent = 'Not now';
    }

    if (statusText) {
      if (status === 'downloading') {
        statusText.textContent = `Downloading ${tool || 'tools'} ${pct}%`;
        if (btnInstall) {
          btnInstall.classList.remove('hidden');
          btnInstall.disabled = true;
        }
      } else if (data.ytDlp && data.ffmpeg) {
        statusText.textContent = 'Installed';
        if (btnInstall) {
          btnInstall.classList.add('hidden');
          btnInstall.disabled = false;
        }
      } else {
        const missing = [];
        if (!data.ytDlp) missing.push('yt-dlp');
        if (!data.ffmpeg) missing.push('ffmpeg');
        statusText.textContent = `Missing: ${missing.join(', ')}`;
        if (btnInstall) {
          btnInstall.classList.remove('hidden');
          btnInstall.disabled = false;
        }
      }
    }
  }

  function pollToolsStatus() {
    if (toolsPollInterval) return;
    toolsPollInterval = setInterval(async () => {
      if (document.hidden || !state.isWindowVisible) return;
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools-status`);
        const data = await res.json();
        updateToolsUI(data);
        if (data.progress && (data.progress.status === 'done' || data.progress.status === 'error')) {
          clearInterval(toolsPollInterval);
          toolsPollInterval = null;
          // on a fresh install the home page loaded before yt-dlp existed and is showing its retry button
          const retryHome = data.progress.status === 'done' && document.getElementById('btn-retry-vibe');
          if (retryHome) retryHome.click();
        }
      } catch (e) {}
    }, 1000);
  }

  function startToolsInstall() {
    const btnInstall = document.getElementById('btn-install-tools');
    if (btnInstall) btnInstall.disabled = true;

    const modal = document.getElementById('tools-install-modal');
    if (modal) openModal(modal);

    const errEl = document.getElementById('tools-error-msg');
    if (errEl) errEl.style.display = 'none';
    const btnRetry = document.getElementById('btn-retry-tools');
    if (btnRetry) btnRetry.style.display = 'none';
    const btnDownload = document.getElementById('btn-confirm-install-tools');
    if (btnDownload) {
      btnDownload.style.display = 'inline-flex';
      btnDownload.disabled = true;
      btnDownload.textContent = 'Downloading...';
    }

    fetch(`http://127.0.0.1:${state.serverPort}/api/tools-install`, { method: 'POST' }).catch(() => {});
    pollToolsStatus();
  }

  async function checkToolsStatus(promptUser = false) {
    if (!state.serverPort) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools-status`);
      const data = await res.json();
      updateToolsUI(data);

      if (data.progress && data.progress.status === 'downloading') {
        pollToolsStatus();
      } else if (promptUser && (!data.ytDlp || !data.ffmpeg)) {
        if (!sessionStorage.getItem('muriel_tools_prompt_dismissed')) {
          const modal = document.getElementById('tools-install-modal');
          if (modal) openModal(modal);
        }
      }
    } catch (e) {}
  }

  const btnInstallTools = document.getElementById('btn-install-tools');
  if (btnInstallTools) {
    btnInstallTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  const toolsModal = document.getElementById('tools-install-modal');
  const btnConfirmInstallTools = document.getElementById('btn-confirm-install-tools');
  const btnDismissToolsModal = document.getElementById('btn-dismiss-tools-modal');
  const btnCloseToolsModal = document.getElementById('btn-close-tools-modal');
  const btnRetryTools = document.getElementById('btn-retry-tools');

  if (btnConfirmInstallTools) {
    btnConfirmInstallTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  if (btnRetryTools) {
    btnRetryTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  if (btnDismissToolsModal && toolsModal) {
    btnDismissToolsModal.addEventListener('click', () => {
      sessionStorage.setItem('muriel_tools_prompt_dismissed', '1');
      closeModal(toolsModal);
    });
  }

  if (btnCloseToolsModal && toolsModal) {
    btnCloseToolsModal.addEventListener('click', () => {
      sessionStorage.setItem('muriel_tools_prompt_dismissed', '1');
      closeModal(toolsModal);
    });
  }



  const btnOpenShortcuts = document.getElementById('btn-open-shortcuts');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const btnCloseShortcutsModal = document.getElementById('btn-close-shortcuts-modal');
  if (btnOpenShortcuts && shortcutsModal) btnOpenShortcuts.addEventListener('click', () => openModal(shortcutsModal));
  if (btnCloseShortcutsModal && shortcutsModal) btnCloseShortcutsModal.addEventListener('click', () => closeModal(shortcutsModal));

  const btnCopyDiagnostics = document.getElementById('btn-copy-diagnostics');
  if (btnCopyDiagnostics) {
    btnCopyDiagnostics.addEventListener('click', async () => {
      const api = window.electronAPI || {};
      let text = '';
      try {
        if (typeof api.getDiagnostics === 'function') text = await api.getDiagnostics();
        else {
          // phones: no main process to ask, so the app's own details and its error log
          text = [`Muriel ${(window.MURIEL_BUILD && window.MURIEL_BUILD.version) || ''} (${(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web'})`,
            navigator.userAgent, `Language ${navigator.language}`, '--- log ---', window.MurielLog ? window.MurielLog.text() : 'no log'].join('\n');
        }
      } catch (e) { text = `Diagnostics failed: ${e && e.message}`; }
      if (await copyText(text)) showToast(Tm('Diagnostics copied. Paste it into your report'), 'info');
      else showToast(Tm("Couldn't copy the diagnostics"), 'error');
    });
  }

  const btnOpenLogs = document.getElementById('btn-open-logs');
  if (btnOpenLogs) {
    btnOpenLogs.addEventListener('click', async () => {
      const api = window.electronAPI || {};
      if (typeof api.openLogsFolder === 'function') api.openLogsFolder();
      // phones have no folder to open: share the log instead
      else if (typeof api.shareText === 'function') {
        const res = await api.shareText('Muriel error log', window.MurielLog ? window.MurielLog.text() : 'no log');
        if (res === 'copied') showToast(Tm('Log copied to clipboard'), 'info');
      }
    });
  }

  // the clipboard: the desktop app's own (always allowed), else the page's, else the old select-and-copy
  async function copyText(text) {
    const api = window.electronAPI || {};
    try { if (typeof api.copyText === 'function') { await api.copyText(text); return true; } } catch (e) {}
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  let trackArtCurrentTrack = null;

  function onTrackArtUpdated(track) {
    if (!track) return;

    const currentCover = getTrackThumbUrl(track);
    if (currentCover) coverAnalysisCache.delete(currentCover);
    if (track.thumbnail) coverAnalysisCache.delete(track.thumbnail);
    const art = getTrackArt(track);
    if (art.cover) coverAnalysisCache.delete(art.cover);

    if (track.id) {
      const cleanId = String(track.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (typeof analysisCache !== 'undefined' && analysisCache.delete) {
        analysisCache.delete(cleanId);
      }
    }

    if (state.currentTrack && isSameTrack(state.currentTrack, track)) {
      const thumb = getTrackThumbUrl(state.currentTrack);
      if (thumb) {
        if (el.playbarArtwork) {
          el.playbarArtwork.src = thumb;
          if (typeof m3cSetImage === 'function') m3cSetImage(thumb);
          el.playbarArtwork.style.display = 'block';
        }
        if (el.artworkFallback) el.artworkFallback.style.display = 'none';
        if (el.rightPanelCover) {
          el.rightPanelCover.src = thumb;
          el.rightPanelCover.style.display = 'block';
        }
        if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'none';
      }
      updateRightPanelBanner(thumb);
      if (state.isTvKaraokeOpen) syncTvBanner();
      updateMediaSession();
      updateThemeFromState();
    }

    const canonical = getTrackCanonicalId(track);
    document.querySelectorAll('.track-row').forEach(row => {
      if (row.dataset && row.dataset.canonicalId === canonical) {
        const img = row.querySelector('.track-row-thumb');
        if (img) { const full = getTrackThumbUrl(track); img.dataset.full = full; img.src = listThumb(full); }
      }
    });
  }

  function renderTrackArtModal() {
    if (!trackArtCurrentTrack) return;
    const t = trackArtCurrentTrack;
    const titleEl = document.getElementById('track-art-modal-title');
    if (titleEl) I18N.text(titleEl, 'Art: {0}', t.title || T('Untitled'));

    const art = getTrackArt(t);

    const coverImg = document.getElementById('track-art-cover-img');
    const coverPh = document.getElementById('track-art-cover-placeholder');
    const coverStatus = document.getElementById('track-art-cover-status');
    const activeCover = getTrackThumbUrl(t);
    if (coverImg) {
      coverImg.dataset.art = JSON.stringify(trackArtCandidates(t));
      coverImg.__artTried = null;
      coverImg.onerror = () => { if (!nextTrackArt(coverImg)) { coverImg.style.display = 'none'; if (coverPh) coverPh.style.display = 'block'; } };
    }
    if (activeCover) {
      if (coverImg) {
        coverImg.src = activeCover;
        coverImg.style.display = 'block';
      }
      if (coverPh) coverPh.style.display = 'none';
    } else {
      if (coverImg) coverImg.style.display = 'none';
      if (coverPh) coverPh.style.display = 'block';
    }
    if (coverStatus) coverStatus.textContent = art.cover ? 'Custom cover' : 'Default art';

    const bannerImg = document.getElementById('track-art-banner-img');
    const bannerVid = document.getElementById('track-art-banner-vid');
    const bannerPh = document.getElementById('track-art-banner-placeholder');
    const bannerStatus = document.getElementById('track-art-banner-status');
    const activeBanner = art.banner || localStorage.getItem('muriel_banner_media') || activeCover;
    const isVideo = activeBanner && /\.(mp4|webm)($|\?)/i.test(activeBanner);

    if (activeBanner) {
      if (isVideo) {
        if (bannerImg) bannerImg.style.display = 'none';
        if (bannerVid) {
          bannerVid.src = activeBanner;
          bannerVid.style.display = 'block';
        }
      } else {
        if (bannerVid) bannerVid.style.display = 'none';
        if (bannerImg) {
          bannerImg.src = activeBanner;
          bannerImg.style.display = 'block';
        }
      }
      if (bannerPh) bannerPh.style.display = 'none';
    } else {
      if (bannerImg) bannerImg.style.display = 'none';
      if (bannerVid) bannerVid.style.display = 'none';
      if (bannerPh) bannerPh.style.display = 'block';
    }
    if (bannerStatus) bannerStatus.textContent = art.banner ? 'Custom banner' : (localStorage.getItem('muriel_banner_media') ? 'Global banner' : 'Default art');
    renderTrackBannerFxControls(t, art);
  }

  function openTrackArtModal(track, triggerEl = null) {
    if (!track) return;
    trackArtCurrentTrack = track;
    const modal = document.getElementById('track-art-modal');
    if (!modal) return;
    resetCoverPicker();
    renderTrackArtModal();
    const card = modal.querySelector('.dialog-card') || modal;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      modal.classList.add('visible');
      if (window.LiquidMotion) {
        LiquidMotion.open(card, triggerEl, 'y');
      }
    });
  }
  window.openTrackArtModal = openTrackArtModal;

  function closeTrackArtModal() {
    const modal = document.getElementById('track-art-modal');
    if (!modal) return;
    const card = modal.querySelector('.dialog-card') || modal;
    if (window.LiquidMotion) {
      LiquidMotion.close(card, () => {
        modal.classList.remove('visible');
        modal.classList.add('hidden');
      });
    } else {
      closeModal(modal);
    }
  }

  const trackArtModal = document.getElementById('track-art-modal');
  const btnCloseTrackArtModal = document.getElementById('btn-close-track-art-modal');
  const btnChooseTrackCover = document.getElementById('btn-choose-track-cover');
  const btnResetTrackCover = document.getElementById('btn-reset-track-cover');
  const btnChooseTrackBanner = document.getElementById('btn-choose-track-banner');
  const btnResetTrackBanner = document.getElementById('btn-reset-track-banner');
  const btnRightPanelArt = document.getElementById('btn-right-panel-art');

  if (btnRightPanelArt) {
    btnRightPanelArt.addEventListener('click', () => {
      if (state.currentTrack) {
        openTrackArtModal(state.currentTrack, btnRightPanelArt);
      }
    });
  }

  if (btnCloseTrackArtModal) {
    btnCloseTrackArtModal.addEventListener('click', closeTrackArtModal);
  }

  if (trackArtModal) {
    trackArtModal.addEventListener('click', (e) => {
      if (e.target === trackArtModal) closeTrackArtModal();
    });
  }

  const isImageFile = (u) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(u);
  const isMediaFile = (u) => /\.(png|jpe?g|webp|gif|mp4|webm)($|\?)/i.test(u);

  if (btnChooseTrackCover) {
    btnChooseTrackCover.addEventListener('click', async () => {
      if (!trackArtCurrentTrack) return;
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          if (!isImageFile(url)) {
            showToast(Tm('Cover must be an image (PNG, JPG, WebP, GIF)'));
            return;
          }
          setTrackArt(trackArtCurrentTrack, { cover: url });
          onTrackArtUpdated(trackArtCurrentTrack);
          renderTrackArtModal();
        }
      }
    });
  }

  if (btnResetTrackCover) {
    btnResetTrackCover.addEventListener('click', () => {
      if (!trackArtCurrentTrack) return;
      setTrackArt(trackArtCurrentTrack, { cover: undefined });
      onTrackArtUpdated(trackArtCurrentTrack);
      renderTrackArtModal();
    });
  }

  // Cover picker (#18): the song's own covers in several sizes, the first YouTube results for artist + title,
  // and Apple Music (iTunes) album covers through the app's existing album search. Picking one saves it as the
  // song's custom cover; Reset goes back to the default.
  const coverPickerGrid = document.getElementById('track-art-picker-grid');
  const coverPickerStatus = document.getElementById('track-art-picker-status');
  const btnFindTrackCover = document.getElementById('btn-find-track-cover');
  let coverPickerRun = 0;

  function resetCoverPicker() {
    coverPickerRun++;
    if (coverPickerGrid) { coverPickerGrid.innerHTML = ''; coverPickerGrid.hidden = true; }
    if (coverPickerStatus) I18N.text(coverPickerStatus, 'Pick one from YouTube and Apple Music');
    if (btnFindTrackCover) btnFindTrackCover.disabled = false;
  }

  async function coverCandidatesFor(track) {
    const out = [];
    const seen = new Set();
    const add = (url, source) => {
      if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
      const key = url.replace(YT_THUMB, 'yt:$1/').replace(/\?.*$/, '');
      if (seen.has(url) || seen.has(key)) return;
      seen.add(url); seen.add(key);
      out.push({ url, source });
    };
    // the same frame in smaller sizes isn't a choice
    const own = trackArtCandidates(track).filter((u) => /^https?:\/\//.test(u) && !u.startsWith('http://127.0.0.1') && !/ytimg\.com\/vi\/[^/]+\/(mq)?default\.jpg/.test(u));
    const ytId = trackYoutubeId(track);
    own.forEach((u) => add(u, YT_THUMB.test(u) ? 'YouTube' : T('Current')));
    if (ytId) ['maxresdefault', 'sddefault'].forEach((s) => add(`https://i.ytimg.com/vi/${ytId}/${s}.jpg`, 'YouTube'));
    const q = [track.artist, track.title].filter(Boolean).join(' ').trim();
    if (!q || !state.serverPort) return out;
    const base = `http://127.0.0.1:${state.serverPort}`;
    const [yt, albums] = await Promise.all([
      fetch(`${base}/api/search?q=${encodeURIComponent(q)}&platform=youtube&limit=6`).then((r) => r.json()).catch(() => null),
      fetch(`${base}/api/albums/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => null),
    ]);
    ((albums && albums.albums) || []).slice(0, 8).forEach((a) => add(a.cover, a.title ? `Apple Music · ${a.title}` : 'Apple Music'));
    ((yt && yt.tracks) || []).slice(0, 6).forEach((t) => add(t.thumbnail || (t.id ? `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg` : ''), t.title ? `YouTube · ${t.title}` : 'YouTube'));
    return out;
  }

  if (btnFindTrackCover && coverPickerGrid) {
    btnFindTrackCover.addEventListener('click', async () => {
      const track = trackArtCurrentTrack;
      if (!track) return;
      const run = ++coverPickerRun;
      btnFindTrackCover.disabled = true;
      if (coverPickerStatus) I18N.text(coverPickerStatus, 'Looking for covers…');
      const list = await coverCandidatesFor(track);
      if (run !== coverPickerRun) return;
      btnFindTrackCover.disabled = false;
      const current = getTrackThumbUrl(track);
      coverPickerGrid.innerHTML = '';
      list.forEach(({ url, source }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'track-art-choice' + (url === current ? ' selected' : '');
        b.title = source;
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        // a size YouTube doesn't have comes back as an error (or a 120px grey frame): leave it out
        img.onerror = () => b.remove();
        img.onload = () => { if (img.naturalWidth <= 120 && /ytimg\.com\/vi\/[^/]+\/(maxres|sd)default/.test(url)) b.remove(); };
        img.src = url;
        const tag = document.createElement('span');
        tag.className = 'track-art-choice-src';
        tag.textContent = source;
        b.append(img, tag);
        b.addEventListener('click', () => {
          setTrackArt(track, { cover: url });
          onTrackArtUpdated(track);
          renderTrackArtModal();
          coverPickerGrid.querySelectorAll('.track-art-choice').forEach((x) => x.classList.toggle('selected', x === b));
        });
        coverPickerGrid.appendChild(b);
      });
      coverPickerGrid.hidden = !list.length;
      if (coverPickerStatus) I18N.text(coverPickerStatus, list.length ? 'Tap a cover to use it for this song' : 'No covers found');
    });
  }

  if (btnChooseTrackBanner) {
    btnChooseTrackBanner.addEventListener('click', async () => {
      if (!trackArtCurrentTrack) return;
      if (window.electronAPI && window.electronAPI.pickMedia) {
        const url = await window.electronAPI.pickMedia();
        if (url) {
          if (!isMediaFile(url)) {
            showToast(Tm('Banner must be image or video (PNG, JPG, WebP, GIF, MP4, WebM)'));
            return;
          }
          setTrackArt(trackArtCurrentTrack, { banner: url });
          onTrackArtUpdated(trackArtCurrentTrack);
          renderTrackArtModal();
        }
      }
    });
  }

  if (btnResetTrackBanner) {
    btnResetTrackBanner.addEventListener('click', () => {
      if (!trackArtCurrentTrack) return;
      setTrackArt(trackArtCurrentTrack, { banner: undefined });
      onTrackArtUpdated(trackArtCurrentTrack);
      renderTrackArtModal();
    });
  }

  // Search results: All / Songs / Artists / Albums (from Riff 43.1). Only shows or hides the sections, so the
  // choice stays for the next search.
  (function initSearchFilterChips() {
    const box = el.searchResultsContainer;
    const chips = document.getElementById('search-filter-chips');
    if (!box || !chips) return;
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip-btn[data-filter]');
      if (!chip) return;
      box.dataset.filter = chip.dataset.filter;
      chips.querySelectorAll('.chip-btn').forEach((c) => {
        const on = c === chip;
        c.classList.toggle('active', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    });
  })();

  // The mouse's back button goes back like the page's own Back button (from Riff 43.1; computers)
  (function initMouseBack() {
    if (isPhoneApp) return;
    const back = (e) => {
      if (e.button !== 3) return;
      e.preventDefault();
      if (e.type !== 'mouseup') return;
      if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
      const btn = ['btn-back-artist', 'btn-back-album', 'btn-back-playlists', 'btn-settings-back']
        .map((id) => document.getElementById(id)).find((b) => b && b.offsetParent !== null && b.closest('.content-view.active'));
      if (btn) { btn.click(); return; }
      if (state.previousView && state.previousView !== state.currentView && state.currentView !== 'discover') switchView(state.previousView);
    };
    window.addEventListener('mousedown', back, true);
    window.addEventListener('mouseup', back, true);
  })();

  loadPlugins();
  loadHomePage();
  initHomeHero();
  resizeCanvases();
  updateOfflineStorageUI();
  updateMusicFolderUI();
  updateDownloadFolderUI();
  checkToolsStatus(false);
  setLyricsEmpty(true);
  updateLyricsTranslationUI();
  loadCustomThemes();
  applyCustomStyles();
  enterSettings();
  refreshStacks();
  requestAnimationFrame(() => requestAnimationFrame(refreshStacks));
  initTvk();
  if (typeof m3cInit === 'function') m3cInit();
  requestAnimationFrame(() => requestAnimationFrame(() => updateNavIndicator(false)));

  if (localStorage.getItem('muriel_perf_mode') === null && window.electronAPI && window.electronAPI.getGpuCompositing) {
    window.electronAPI.getGpuCompositing().then((status) => {
      if (status && !status.startsWith('enabled')) {
        localStorage.setItem('muriel_perf_mode', '1');
        applyPerfMode(true);
        if (btnPerfMode) btnPerfMode.classList.add('active');
        showToast(Tm('Performance mode enabled: no GPU acceleration detected. You can turn it off in Settings'));
      }
    }).catch(() => {});
  }

  let sleepTimerInterval = null;

  function syncSleepTimerButtons(value) {
    if (!el.sleepTimerStatus) return;
    const panel = el.sleepTimerStatus.closest('.audio-panel');
    if (!panel) return;
    panel.querySelectorAll('[data-sleep-minutes]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sleepMinutes === value);
    });
  }

  function updateSleepTimerUI() {
    if (!el.sleepTimerStatus) return;
    if (!state.sleepTimer) {
      el.sleepTimerStatus.textContent = 'Off';
      el.sleepTimerStatus.classList.remove('active');
      syncSleepTimerButtons(null);
      return;
    }
    el.sleepTimerStatus.classList.add('active');
    if (state.sleepTimer.mode === 'end') {
      el.sleepTimerStatus.textContent = 'End of track';
      syncSleepTimerButtons('end');
      return;
    }
    syncSleepTimerButtons(String(state.sleepTimer.minutes));
    const left = Math.max(0, state.sleepTimer.endsAt - Date.now());
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    el.sleepTimerStatus.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function fadeOutAndPause() {
    const from = state.isMuted ? 0 : state.volume;
    // nobody hears a fade in the background, and background timers run late: stop right away
    if (!from || !audioEngine || !audioEngine.setVolume || document.hidden) {
      pauseSmooth();
      return;
    }
    // timer steps, not animation frames: a minimized window or a locked phone gets no frames, so the fade
    // never finished and the music played on after the timer said "Off"
    const started = Date.now();
    const step = () => {
      const k = Math.min(1, (Date.now() - started) / 4000);
      audioEngine.setVolume(from * (1 - k), false);
      if (k < 1) {
        setTimeout(step, 50);
        return;
      }
      pauseSmooth();
      audioEngine.setVolume(state.volume, state.isMuted);
    };
    step();
  }

  function setSleepTimer(value) {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    if (value === 'off') {
      state.sleepTimer = null;
      updateSleepTimerUI();
      return;
    }
    if (value === 'end') {
      state.sleepTimer = { mode: 'end' };
      updateSleepTimerUI();
      showToast(Tm('Sleep timer: end of track'));
      return;
    }
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    state.sleepTimer = { mode: 'minutes', minutes, endsAt: Date.now() + minutes * 60000 };
    updateSleepTimerUI();
    showToast(Tm('Sleep timer: {0} min', minutes));
    sleepTimerInterval = setInterval(() => {
      if (!state.sleepTimer || state.sleepTimer.mode !== 'minutes') return;
      if (state.sleepTimer.endsAt > Date.now()) {
        if (!document.hidden) updateSleepTimerUI();
        return;
      }
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
      state.sleepTimer = null;
      updateSleepTimerUI();
      fadeOutAndPause();
    }, 1000);
  }

  if (el.sleepTimerStatus) {
    const sleepPanel = el.sleepTimerStatus.closest('.audio-panel');
    if (sleepPanel) {
      sleepPanel.querySelectorAll('[data-sleep-minutes]').forEach((btn) => {
        btn.addEventListener('click', () => setSleepTimer(btn.dataset.sleepMinutes));
      });
    }
  }

  let queueSaveTimer = null;

  function saveQueueState() {
    if (!state._queueRestored) return;
    try {
      const position = el.nativeAudio && Number.isFinite(el.nativeAudio.currentTime) ? el.nativeAudio.currentTime : 0;
      localStorage.setItem('muriel_queue_state', JSON.stringify({
        queue: state.queue,
        queueIndex: state.queueIndex,
        currentTrack: state.currentTrack,
        position
      }));
    } catch (e) {}
  }

  function scheduleQueueSave() {
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(saveQueueState, 600);
  }

  function restoreQueueState() {
    state._queueRestored = true;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('muriel_queue_state') || 'null');
    } catch (e) {}
    if (!saved || !Array.isArray(saved.queue) || saved.queue.length === 0) return;
    if (state.currentTrack) return;
    state.queue = saved.queue;
    state.queueIndex = Number.isInteger(saved.queueIndex) && saved.queueIndex >= 0 && saved.queueIndex < saved.queue.length
      ? saved.queueIndex
      : 0;
    state.queueHistory = [state.queueIndex];
    const track = saved.currentTrack && typeof saved.currentTrack === 'object' ? saved.currentTrack : state.queue[state.queueIndex];
    state.queueRestorePosition = Number(saved.position) || 0;
    state.currentTrack = track || null;
    if (state.currentTrack) updateNowPlayingUI(state.currentTrack);
    onTrackAudioTrackChange();
    updateQueueBadge();
    if (el.queueCount) {
      el.queueCount.classList.remove('restored');
      void el.queueCount.offsetWidth;
      el.queueCount.classList.add('restored');
    }
    renderQueueView();
  }

  window.addEventListener('beforeunload', saveQueueState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveQueueState();
  });

  function openAudioTab(name) {
    const tab = document.querySelector(`.audio-tab[data-audio-tab="${name}"]`);
    if (tab) tab.click();
    if (el.audioSettingsModal) openModal(el.audioSettingsModal);
    refreshStacks();
  }

  function paletteActions() {
    return [
      { label: 'Open favorites', hint: 'View', run: () => switchView('favorites') },
      { label: 'Open local library', hint: 'View', run: () => switchView('local') },
      { label: 'Open queue', hint: 'View', run: () => switchView('queue') },
      { label: 'Open history', hint: 'View', run: () => switchView('history') },
      { label: 'Muriel Encore', hint: 'Your stats', run: () => window.MurielEncore && window.MurielEncore.open('month') },
      { label: 'Open discover', hint: 'View', run: () => switchView('discover') },
      { label: 'Open settings', hint: 'View', run: () => switchView('settings') },
      { label: 'Audio settings', hint: 'Audio', run: () => openAudioTab('tempo') },
      { label: 'Sleep timer', hint: 'Audio', run: () => openAudioTab('sleep') }
    ];
  }

  function buildCommandPaletteRows(query) {
    const q = normalizeSearch(query);
    const rows = [];
    // actions are found by their name in the UI language or in English
    const actions = paletteActions().filter(a => !q || normalizeSearch(a.label).includes(q) || normalizeSearch(T(a.label)).includes(q));
    for (const action of actions) rows.push({ group: 'Actions', label: T(action.label), hint: T(action.hint), run: action.run });
    if (state.playlists.length) {
      const playlists = state.playlists
        .filter(p => p && typeof p.name === 'string' && (!q || normalizeSearch(p.name).includes(q)))
        .slice(0, q ? 5 : 3);
      for (const pl of playlists) {
        rows.push({ group: 'Playlists', label: pl.name, hint: Tf('{0} tracks', (pl.tracks || []).length), run: () => openPlaylistDetail(pl.id) });
      }
    }
    const seen = new Set();
    const playlistTracks = [];
    for (const pl of state.playlists) {
      if (pl && Array.isArray(pl.tracks)) playlistTracks.push(...pl.tracks);
    }
    const sources = [
      { group: 'Favorites', tracks: state.favorites },
      { group: 'In playlists', tracks: playlistTracks },
      { group: 'Queue', tracks: state.queue },
      { group: 'History', tracks: state.history },
      { group: 'Library', tracks: state.localTracks }
    ];
    for (const source of sources) {
      if (!Array.isArray(source.tracks)) continue;
      for (const track of source.tracks) {
        if (!track) continue;
        if (q && !matchesTrackQuery(track, q)) continue;
        const id = getTrackCanonicalId(track) || track.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        rows.push({ group: source.group, label: track.title || 'Untitled', hint: track.artist || '', run: () => playTrack(track) });
        if (rows.length >= 24) break;
      }
      if (rows.length >= 24) break;
    }
    const trimmed = query.trim();
    if (trimmed) {
      rows.push({
        group: 'Online',
        label: Tf('Search for "{0}"', trimmed),
        hint: T('Discover'),
        run: () => {
          if (el.searchInput) el.searchInput.value = trimmed;
          performSearch(trimmed);
        }
      });
    }
    return rows;
  }

  function setPaletteIndex(index) {
    const rows = state.paletteRows || [];
    if (!rows.length) return;
    state.paletteIndex = Math.max(0, Math.min(rows.length - 1, index));
    const buttons = el.commandPaletteResults.querySelectorAll('.command-palette-row');
    buttons.forEach((btn, i) => btn.classList.toggle('active', i === state.paletteIndex));
    const active = buttons[state.paletteIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function runPaletteRow(index) {
    const rows = state.paletteRows || [];
    const row = rows[index];
    if (!row) return;
    closeModal(el.commandPalette);
    if (typeof row.run === 'function') row.run();
  }

  function renderCommandPalette(query) {
    if (!el.commandPaletteResults) return;
    const rows = buildCommandPaletteRows(query);
    state.paletteRows = rows;
    state.paletteIndex = 0;
    if (!rows.length) {
      el.commandPaletteResults.innerHTML = '<div class="command-palette-empty" data-i18n>No results</div>';
      return;
    }
    let html = '';
    let group = '';
    rows.forEach((row, i) => {
      const delay = Math.min(i, 10);
      if (row.group !== group) {
        group = row.group;
        html += `<div class="command-palette-group" style="--row-i:${delay}">${escapeHtml(T(group))}</div>`;
      }
      html += `<button type="button" class="command-palette-row${i === 0 ? ' active' : ''}" data-palette-index="${i}" style="--row-i:${delay}">
        <span class="command-palette-label">${escapeHtml(row.label)}</span>
        <span class="command-palette-hint">${escapeHtml(row.hint || '')}</span>
      </button>`;
    });
    el.commandPaletteResults.innerHTML = html;
    el.commandPaletteResults.querySelectorAll('[data-palette-index]').forEach((btn) => {
      btn.addEventListener('click', () => runPaletteRow(Number(btn.dataset.paletteIndex)));
      btn.addEventListener('mousemove', () => setPaletteIndex(Number(btn.dataset.paletteIndex)));
    });
  }

  async function loadPaletteLibrary() {
    if (Array.isArray(state.localTracks) && state.localTracks.length) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/library`);
      const tracks = await res.json();
      if (!Array.isArray(tracks)) return;
      state.localTracks = tracks;
      updateLocalBadge();
    } catch (e) {}
  }

  function openCommandPalette() {
    if (!el.commandPalette) return;
    el.commandPaletteInput.value = '';
    if (el.commandPaletteResults) el.commandPaletteResults.classList.add('entering');
    renderCommandPalette('');
    openModal(el.commandPalette);
    setTimeout(() => el.commandPaletteInput.focus(), 30);
    setTimeout(() => {
      if (el.commandPaletteResults) el.commandPaletteResults.classList.remove('entering');
    }, 420);
    loadPaletteLibrary().then(() => {
      if (el.commandPalette.classList.contains('visible')) renderCommandPalette(el.commandPaletteInput.value);
    });
  }

  if (el.commandPaletteInput) {
    el.commandPaletteInput.addEventListener('input', () => renderCommandPalette(el.commandPaletteInput.value));
    el.commandPaletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex((state.paletteIndex || 0) + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex((state.paletteIndex || 0) - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPaletteRow(state.paletteIndex || 0);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(el.commandPalette);
      }
    });
  }

  if (el.commandPalette) {
    el.commandPalette.addEventListener('mousedown', (e) => {
      if (e.target === el.commandPalette) closeModal(el.commandPalette);
    });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      if (el.commandPalette && el.commandPalette.classList.contains('visible')) closeModal(el.commandPalette);
      else openCommandPalette();
    }
  }, true);

  function renderPlaylistDuplicateButton(pl) {
    if (!el.btnDedupePlaylist || !pl) return;
    const duplicates = pl.tracks.length - dedupeTracks(pl.tracks, isSameTrack, getTrackCanonicalId).length;
    el.btnDedupePlaylist.classList.toggle('hidden', duplicates === 0);
    if (el.btnDedupePlaylistLabel) {
      el.btnDedupePlaylistLabel.textContent = duplicates === 1 ? 'Remove 1 duplicate' : `Remove ${duplicates} duplicates`;
    }
  }

  function removePlaylistDuplicates() {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (!pl) return;
    const before = pl.tracks.length;
    pl.tracks = dedupeTracks(pl.tracks, isSameTrack, getTrackCanonicalId);
    const removed = before - pl.tracks.length;
    if (!removed) return;
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    openPlaylistDetail(pl.id);
    renderPlaylistsList();
    showToast(removed === 1 ? Tm('Removed 1 duplicate') : Tm('Removed {0} duplicates', removed));
  }

  if (el.btnDedupePlaylist) el.btnDedupePlaylist.addEventListener('click', removePlaylistDuplicates);

  // ======================= Riff 43: player & look =======================
  // Everything below is from Riff 43, fitted to Muriel. Variables are `var` because code above (lyrics, the
  // player events) can call these functions before this part of the file has run.

  // ---- hide the titlebar (desktop): it slides down when the pointer touches the top edge ----
  (function setupHideTitlebar() {
    const btn = document.getElementById('btn-hide-titlebar');
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    const zone = document.createElement('div');
    zone.id = 'titlebar-reveal-zone';
    document.body.appendChild(zone);
    let hideTimer = null;
    const peek = (on) => {
      clearTimeout(hideTimer);
      if (on) document.body.classList.add('titlebar-peek');
      else hideTimer = setTimeout(() => document.body.classList.remove('titlebar-peek'), 350);
    };
    zone.addEventListener('mouseenter', () => peek(true));
    zone.addEventListener('mouseleave', () => peek(false));
    titlebar.addEventListener('mouseenter', () => peek(true));
    titlebar.addEventListener('mouseleave', () => peek(false));
    const apply = (on) => {
      document.body.classList.toggle('hide-titlebar', on && !isPhoneApp);
      if (!on) document.body.classList.remove('titlebar-peek');
      if (btn) btn.classList.toggle('active', on);
    };
    apply(localStorage.getItem('muriel_hide_titlebar') === '1');
    if (btn) btn.addEventListener('click', () => {
      const next = !btn.classList.contains('active');
      localStorage.setItem('muriel_hide_titlebar', next ? '1' : '0');
      apply(next);
    });
  })();

  // ---- "Apply intensity to background" (generateM3Palette reads it) ----
  (function setupIntensityBg() {
    const btn = document.getElementById('btn-intensity-bg');
    if (!btn) return;
    btn.classList.toggle('active', getAdv('intensity_bg', false));
    btn.addEventListener('click', () => {
      const next = !btn.classList.contains('active');
      btn.classList.toggle('active', next);
      setAdv('intensity_bg', next);
      updateThemeFromState();
    });
  })();

  // ---- icon packs: other shapes for the rail and the player controls ----
  var REPEAT_ONE_MARK = '<polyline class="repeat-one-mark" points="10.5 10.5 12.5 9 12.5 15" stroke-linecap="round" stroke-linejoin="round"></polyline>';
  var ICON_PACKS = {
    sf: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="9.5"></circle><polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" fill="currentColor"></polygon>',
      '#nav-favorites svg': '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="3.2"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle>',
      '#nav-local svg': '<path d="M2.5 7A2.5 2.5 0 0 1 5 4.5h4.2c.8 0 1.5.4 1.9 1l1.2 1.8c.4.6 1.1 1 1.9 1H19A2.5 2.5 0 0 1 21.5 11v6.5a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5V7z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 6.5 12 12 15.5 14"></polyline>',
      '#nav-queue svg': '<path d="M4 6.5h16M4 12h16M4 17.5h16" stroke-linecap="round"></path>',
      '#nav-settings svg': '<circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
      '#btn-shuffle svg': '<path d="M16 4h4v4M4 20l16-16M16 20h4v-4M4 4l5 5m6 6l5 5"></path>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-repeat svg': '<path d="M17 2l4 4-4 4M21 6H7a4 4 0 0 0-4 4v2M7 22l-4-4 4-4M3 18h14a4 4 0 0 0 4-4v-2"></path>' + REPEAT_ONE_MARK,
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13M9 9l12-2"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"></path>'
    },
    lucide: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>',
      '#nav-favorites svg': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="1"></circle>',
      '#nav-local svg': '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
      '#nav-queue svg': '<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="14" y2="17"></line>',
      '#nav-settings svg': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle>',
      '#btn-shuffle svg': '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.6-8.6c.8-1.1 2-1.7 3.3-1.7H22"></path><path d="m18 2 4 4-4 4"></path><path d="M2 6h1.4c1.3 0 2.5.6 3.3 1.7l1.7 2.2"></path><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"></path><path d="m18 14 4 4-4 4"></path>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"></line>',
      '#btn-repeat svg': '<path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>' + REPEAT_ONE_MARK,
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="2" y1="14" x2="6" y2="14"></line><line x1="10" y1="8" x2="14" y2="8"></line><line x1="18" y1="16" x2="22" y2="16"></line>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>'
    },
    solar: {
      '#nav-discover svg': '<circle cx="12" cy="12" r="9.5"></circle><polygon points="16 8 13.8 13.8 8 16 10.2 10.2 16 8"></polygon>',
      '#nav-favorites svg': '<path d="M12.62 20.89c-.38.14-.86.14-1.24 0C8.48 19.82 2 15.69 2 8.69A5.69 5.69 0 0 1 7.69 3c1.64 0 3.12.7 4.31 1.83A6.05 6.05 0 0 1 16.31 3 5.69 5.69 0 0 1 22 8.69c0 7-6.48 11.13-9.38 12.2z"></path>',
      '#nav-albums svg': '<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="12" r="3"></circle>',
      '#nav-local svg': '<path d="M2 11c0-2.83 0-4.24.88-5.12C3.76 5 5.17 5 8 5h.5c.78 0 1.43 0 1.98.24.54.23.97.66 1.52 1.48L13 8h3c2.83 0 4.24 0 5.12.88C22 9.76 22 11.17 22 14v2c0 2.83 0 4.24-.88 5.12C20.24 22 18.83 22 16 22H8c-2.83 0-4.24 0-5.12-.88C2 20.24 2 18.83 2 16v-5z"></path>',
      '#nav-history svg': '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 7 12 12 15 13.5"></polyline>',
      '#nav-queue svg': '<path d="M4 7h16M4 12h16M4 17h11"></path>',
      '#nav-settings svg': '<circle cx="12" cy="12" r="3.5"></circle><path d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07-1.41 1.41M8.34 17.66l-1.41 1.41m12.14 0-1.41-1.41M8.34 6.34 6.93 4.93"></path>',
      '#btn-shuffle svg': '<polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line>',
      '#btn-prev svg': '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-next svg': '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line>',
      '#btn-repeat svg': '<path d="M17 1l4 4-4 4H7a4 4 0 0 0-4 4v1M7 23l-4-4 4-4h10a4 4 0 0 0 4-4v-1"></path>' + REPEAT_ONE_MARK,
      '#btn-toggle-lyrics-panel svg': '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
      '#btn-open-settings svg': '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"></path>',
      '#volume-icon': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>'
    }
  };
  var ICON_PACK_LABELS = { material: 'Google Symbols (Default)', sf: 'iOS / SF Symbols', lucide: 'Lucide Crisp', solar: 'Solar Duotone' };
  function applyIconPack(pack) {
    if (!ICON_PACK_LABELS[pack]) pack = 'material';
    document.body.setAttribute('data-icon-pack', pack);
    const selectors = new Set([...Object.keys(ICON_PACKS.sf), ...Object.keys(ICON_PACKS.lucide), ...Object.keys(ICON_PACKS.solar)]);
    selectors.forEach((sel) => {
      const svg = document.querySelector(sel);
      if (!svg) return;
      if (svg.dataset.origSvg === undefined) svg.dataset.origSvg = svg.innerHTML;
      const shape = pack === 'material' ? svg.dataset.origSvg : (ICON_PACKS[pack] && ICON_PACKS[pack][sel]);
      if (shape !== undefined && svg.innerHTML !== shape) svg.innerHTML = shape;
    });
    const label = document.getElementById('icon-pack-label');
    if (label) label.textContent = ICON_PACK_LABELS[pack];
    document.querySelectorAll('#icon-pack-menu .m3-dropdown-option').forEach((o) => o.classList.toggle('selected', o.dataset.value === pack));
  }
  // a Settings dropdown (trigger + menu of .m3-dropdown-option) that saves its value under `key`
  function wireSettingDropdown(id, key, fallback, onPick) {
    const dd = document.getElementById(`${id}-dropdown`);
    const trigger = document.getElementById(`${id}-trigger`);
    const menu = document.getElementById(`${id}-menu`);
    const label = document.getElementById(`${id}-label`);
    if (!dd || !trigger || !menu) return;
    const show = (val) => {
      menu.querySelectorAll('.m3-dropdown-option').forEach((o) => {
        const sel = o.dataset.value === val;
        o.classList.toggle('selected', sel);
        if (sel && label) label.textContent = o.textContent;
      });
    };
    show(localStorage.getItem(key) || fallback);
    trigger.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
    menu.querySelectorAll('.m3-dropdown-option').forEach((o) => o.addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.setItem(key, o.dataset.value);
      show(o.dataset.value);
      dd.classList.remove('open');
      if (onPick) onPick(o.dataset.value);
    }));
    document.addEventListener('click', () => dd.classList.remove('open'));
  }
  applyIconPack(localStorage.getItem('muriel_icon_pack') || 'material');
  wireSettingDropdown('icon-pack', 'muriel_icon_pack', 'material', applyIconPack);

  // ---- the icon on the Home button: the classic glyph, Muriel's app icon or one of its styles, or your own ----
  var HOME_ICONS = [
    { id: 'classic', label: 'Classic' },
    { id: 'muriel', label: 'Muriel', src: 'assets/icon.svg' },
    { id: '01-default', label: 'Default' },
    { id: '02-editor', label: 'Editor' },
    { id: '03-orbit', label: 'Orbit' },
    { id: '04-vinyl', label: 'Vinyl' },
    { id: '06-cosmos', label: 'Cosmos' },
    { id: '07-aurora', label: 'Aurora' },
    { id: '08-sunset', label: 'Sunset' },
    { id: '09-amethyst', label: 'Amethyst' },
    { id: '10-y2k-disc', label: 'Y2K Disc' },
    { id: '11-cassette', label: 'Cassette' },
    { id: '12-invincible', label: 'Invincible' }
  ];
  var homeIconSrc = (val) => {
    if (!val || val === 'classic') return '';
    if (/^(file:|https?:|data:|capacitor:|blob:)/.test(val)) return val;
    const item = HOME_ICONS.find((i) => i.id === val);
    if (!item) return '';
    return item.src || `assets/app-icons/${item.id}.svg`;
  };
  function applyHomeAppIcon(val) {
    const src = homeIconSrc(val);
    const img = document.getElementById('nav-home-app-icon');
    const nav = document.getElementById('nav-discover');
    if (img) {
      if (src) img.src = src; else img.removeAttribute('src');
      img.classList.toggle('hidden', !src);
      img.onerror = src ? () => { if (img.getAttribute('src') === src) applyHomeAppIcon('classic'); } : null;
    }
    if (nav) nav.classList.toggle('has-app-icon', !!src);
    document.querySelectorAll('#app-icon-picker-grid .app-icon-option').forEach((b) => b.classList.toggle('active', b.dataset.icon === (src ? val : 'classic')));
  }
  function setHomeAppIcon(val) {
    localStorage.setItem('muriel_app_icon', val);
    applyHomeAppIcon(val);
  }
  (function setupHomeIconPicker() {
    const grid = document.getElementById('app-icon-picker-grid');
    if (grid) {
      const compass = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor"></polygon></svg>';
      grid.innerHTML = HOME_ICONS.map((i) => `<button type="button" class="app-icon-option" data-icon="${i.id}" title="${escapeHtml(i.label)}"><div class="app-icon-option-box">${i.id === 'classic' ? compass : `<img src="${homeIconSrc(i.id)}" alt="" draggable="false" loading="lazy">`}</div><span class="app-icon-option-label">${escapeHtml(i.label)}</span></button>`).join('');
      grid.querySelectorAll('.app-icon-option').forEach((b) => b.addEventListener('click', () => setHomeAppIcon(b.dataset.icon)));
    }
    const btnCustom = document.getElementById('btn-pick-custom-home-icon');
    if (btnCustom) {
      if (!window.electronAPI || !window.electronAPI.pickMedia) btnCustom.classList.add('hidden');
      else btnCustom.addEventListener('click', async () => {
        const url = await window.electronAPI.pickMedia();
        if (!url) return;
        if (/\.(mp4|webm)($|\?)/i.test(url)) { showToast('Pick an image for the icon', 'info'); return; }
        setHomeAppIcon(url);
      });
    }
    applyHomeAppIcon(localStorage.getItem('muriel_app_icon') || 'classic');
  })();

  // ---- playbar visualizer: compact (right of the bar) or wide behind the bar; bars or one liquid wave ----
  (function setupBarVisualizer() {
    const group = document.getElementById('bar-viz-pos-group');
    const applyPos = (pos) => {
      document.body.classList.toggle('bar-viz-behind', pos === 'behind' && !isPhoneApp);
      if (group) group.querySelectorAll('.theme-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.barVizPos === pos));
      resizeCanvases();
      if (state.isPlaying) startVisualizers();
    };
    applyPos(localStorage.getItem('muriel_bar_viz_pos') || 'behind');
    if (group) group.querySelectorAll('.theme-mode-btn').forEach((b) => b.addEventListener('click', () => {
      localStorage.setItem('muriel_bar_viz_pos', b.dataset.barVizPos);
      applyPos(b.dataset.barVizPos);
    }));

    const slider = document.getElementById('slider-bar-viz-opacity');
    const val = document.getElementById('val-bar-viz-opacity');
    const applyOpacity = (v) => {
      const n = Math.max(5, Math.min(85, parseInt(v, 10) || 22));
      document.documentElement.style.setProperty('--bar-viz-opacity', String(n / 100));
      if (val) val.textContent = `${n}%`;
      if (slider && String(slider.value) !== String(n)) slider.value = n;
    };
    applyOpacity(localStorage.getItem('muriel_bar_viz_opacity') || '22');
    if (slider) slider.addEventListener('input', (e) => { localStorage.setItem('muriel_bar_viz_opacity', e.target.value); applyOpacity(e.target.value); });

    const btns = [document.getElementById('btn-viz-connected'), document.getElementById('btn-tvk-viz-connected')].filter(Boolean);
    const sync = () => btns.forEach((b) => b.classList.toggle('active', vizConnected));
    btns.forEach((b) => b.addEventListener('click', () => {
      vizConnected = !vizConnected;
      localStorage.setItem('muriel_viz_connected', vizConnected ? '1' : '0');
      sync();
    }));
    sync();
  })();

  // ---- fullscreen karaoke: seek bar, moving cover colors behind the lyrics, settings from the top edge ----
  var tvkSeekDragging = false;
  function syncTvkProgress(cur, dur) {
    const slider = document.getElementById('tvk-seek-slider');
    const curEl = document.getElementById('tvk-time-current');
    const durEl = document.getElementById('tvk-time-duration');
    if (!dur || !Number.isFinite(dur)) dur = (state.currentTrack && Number(state.currentTrack.duration)) || 0;
    if (curEl && !tvkSeekDragging) { const t = formatDuration(cur || 0); if (curEl.textContent !== t) curEl.textContent = t; }
    if (durEl) { const d = formatDuration(dur || 0); if (durEl.textContent !== d) durEl.textContent = d; }
    if (slider && !tvkSeekDragging && dur > 0) {
      const v = String(Math.round(Math.max(0, Math.min(1, (cur || 0) / dur)) * 1000));
      if (slider.value !== v) slider.value = v;
    }
  }
  (function setupTvkSeek() {
    const slider = document.getElementById('tvk-seek-slider');
    if (!slider) return;
    const durNow = () => {
      const a = el.nativeAudio;
      return a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : ((state.currentTrack && Number(state.currentTrack.duration)) || 0);
    };
    slider.addEventListener('pointerdown', () => { tvkSeekDragging = true; });
    slider.addEventListener('input', () => {
      tvkSeekDragging = true;
      const t = (Number(slider.value) / 1000) * durNow();
      const curEl = document.getElementById('tvk-time-current');
      if (curEl) curEl.textContent = formatDuration(t);
    });
    slider.addEventListener('change', () => {
      const dur = durNow();
      const t = (Number(slider.value) / 1000) * dur;
      if (el.nativeAudio && dur > 0 && Number.isFinite(t)) {
        el.nativeAudio.currentTime = t;
        updateMediaPositionState();
      }
      tvkSeekDragging = false;
    });
    slider.addEventListener('pointerup', () => { setTimeout(() => { tvkSeekDragging = false; }, 0); });
    // the slider must not start a lyrics drag or hide the controls
    slider.addEventListener('mousemove', (e) => e.stopPropagation());
  })();

  var tvkAmbientCover = null;
  var tvkPaletteCache = new Map();
  function extractCoverPalette(src) {
    const mono = [[22, 22, 26], [34, 34, 40], [48, 48, 56], [28, 28, 34], [42, 42, 50], [18, 18, 22], [58, 58, 68], [30, 30, 36], [40, 40, 46], [25, 25, 30]];
    if (!src) return Promise.resolve(mono);
    if (tvkPaletteCache.has(src)) return Promise.resolve(tvkPaletteCache.get(src));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        let out = mono;
        try {
          const c = document.createElement('canvas');
          c.width = 40;
          c.height = 40;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 40, 40);
          const data = ctx.getImageData(0, 0, 40, 40).data;
          const colorful = [];
          for (let i = 0; i < data.length; i += 8) {
            const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
            if (hsl.l >= 12 && hsl.l <= 88 && hsl.s >= 18) colorful.push({ h: hsl.h, s: hsl.s, l: hsl.l, weight: (hsl.s / 100) * (1 - Math.abs(hsl.l - 50) / 55) });
          }
          if (colorful.length < 12) {
            out = [];
            for (let k = 0; k < 10; k++) { const v = 18 + Math.round((k / 9) * 52); out.push([v, v, Math.min(255, v + 3)]); }
          } else {
            colorful.sort((a, b) => b.weight - a.weight);
            const picked = [];
            for (let minHue = 22; picked.length < 6 && minHue >= 4; minHue -= 6) {
              for (const p of colorful) {
                if (picked.length >= 6) break;
                if (!picked.some((q) => Math.min(Math.abs(q.h - p.h), 360 - Math.abs(q.h - p.h)) < minHue && Math.abs(q.l - p.l) < 15)) picked.push(p);
              }
            }
            out = [];
            for (let i = 0; i < 10; i++) {
              const base = picked[i % picked.length];
              const shift = i >= picked.length ? (i % 2 === 0 ? 10 : -10) : 0;
              const rgb = hexToRgb(hslToHex(base.h, Math.max(35, Math.min(88, base.s)), Math.max(22, Math.min(56, base.l + shift))));
              out.push([rgb.r, rgb.g, rgb.b]);
            }
          }
        } catch (e) { out = mono; }
        if (tvkPaletteCache.size >= 80) tvkPaletteCache.delete(tvkPaletteCache.keys().next().value);
        tvkPaletteCache.set(src, out);
        resolve(out);
      };
      img.onerror = () => resolve(mono);
      img.src = src;
    });
  }
  function paintTvkLayer(canvas, colors, seed) {
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const rgb = (c) => `${c[0]}, ${c[1]}, ${c[2]}`;
    const c0 = colors[0];
    const base = ctx.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, `rgb(${rgb(c0)})`);
    base.addColorStop(0.5, `rgb(${rgb(colors[1] || c0)})`);
    base.addColorStop(1, `rgb(${rgb(colors[2] || c0)})`);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const spots = [[0.12, 0.18], [0.85, 0.15], [0.22, 0.82], [0.82, 0.78], [0.48, 0.32], [0.55, 0.68], [0.18, 0.48], [0.88, 0.46], [0.36, 0.14], [0.66, 0.88]];
    for (let i = 0; i < 10; i++) {
      const [px, py] = spots[(i + seed) % spots.length];
      const col = colors[(i + seed) % colors.length] || c0;
      const r = (0.48 + (i % 3) * 0.12) * Math.max(w, h);
      const g = ctx.createRadialGradient(px * w, py * h, 0, px * w, py * h, r);
      g.addColorStop(0, `rgba(${rgb(col)}, 0.92)`);
      g.addColorStop(0.45, `rgba(${rgb(col)}, 0.48)`);
      g.addColorStop(1, `rgba(${rgb(col)}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 0, w, h);
  }
  async function syncTvkAmbientBg() {
    const host = document.getElementById('tvk-ambient-bg');
    if (!host) return;
    if (!host.firstElementChild) host.innerHTML = '<canvas class="tvk-liquid-layer" width="96" height="54"></canvas><canvas class="tvk-liquid-layer tvk-liquid-layer-b" width="96" height="54"></canvas>';
    const thumb = state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '';
    if (thumb === tvkAmbientCover) return;
    tvkAmbientCover = thumb;
    const colors = await extractCoverPalette(thumb);
    if (tvkAmbientCover !== thumb) return;
    const [a, b] = host.querySelectorAll('canvas');
    paintTvkLayer(a, colors, 0);
    paintTvkLayer(b, colors, 5);
  }
  function setTvkAmbient(on) {
    const tv = el.tvKaraoke || document.getElementById('tv-karaoke');
    if (!tv) return;
    tv.classList.toggle('tvk-ambient-on', !!on);
    if (on) syncTvkAmbientBg();
  }
  // the drifting layers only move while fullscreen karaoke is on screen
  function syncTvkAmbientPlayback() {
    const tv = el.tvKaraoke || document.getElementById('tv-karaoke');
    if (!tv) return;
    tv.classList.toggle('tvk-bg-paused', !state.isTvKaraokeOpen || tv.classList.contains('hidden') || document.hidden || isPhoneApp);
  }
  document.addEventListener('visibilitychange', syncTvkAmbientPlayback);

  (function setupTvkTopHover() {
    const zone = document.getElementById('tvk-top-hover-zone');
    const panel = document.getElementById('tvk-panel');
    const btnSettings = document.getElementById('btn-tvk-settings');
    if (!zone || !panel || isPhoneApp) return;
    let closeTimer = null;
    const open = () => {
      clearTimeout(closeTimer);
      if (panel.classList.contains('open')) return;
      panel.classList.add('open');
      panel.dataset.hoverOpened = '1';
      if (btnSettings) btnSettings.classList.add('open');
      if (el.tvKaraoke) el.tvKaraoke.classList.remove('tv-idle');
      clearTimeout(tvIdleTimer);
    };
    const scheduleClose = () => {
      clearTimeout(closeTimer);
      if (panel.dataset.hoverOpened !== '1') return;
      closeTimer = setTimeout(() => {
        const font = document.getElementById('tvk-font-dropdown');
        if (font && font.classList.contains('open')) return;
        panel.classList.remove('open');
        delete panel.dataset.hoverOpened;
        if (btnSettings) btnSettings.classList.remove('open');
        resetTvIdleTimer();
      }, 320);
    };
    zone.addEventListener('mouseenter', open);
    zone.addEventListener('mouseleave', scheduleClose);
    panel.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    panel.addEventListener('mouseleave', scheduleClose);
    // opened by the gear: stays until closed the usual way
    if (btnSettings) btnSettings.addEventListener('click', () => { delete panel.dataset.hoverOpened; });
  })();

  // ---- lyrics under the mini player (desktop) ----
  var miniLyricsLastIdx = -2;
  function miniLyricsShown() {
    return document.body.classList.contains('mini') && document.body.classList.contains('mini-lyrics-on');
  }
  function renderMiniLyrics() {
    const box = document.getElementById('mini-lyrics-container');
    if (!box) return;
    miniLyricsLastIdx = -2;
    const lines = state.syncedLyrics || [];
    if (!lines.length) { box.innerHTML = '<div class="mini-lyrics-empty">No lyrics</div>'; return; }
    box.innerHTML = '';
    const words = getAdv('karaoke_words', true) && state.lyricsMode === 'word';
    lines.forEach((line, index) => {
      const div = document.createElement('div');
      div.className = 'mini-lyric-line';
      div.id = `mini-lyric-line-${index}`;
      div.setAttribute('dir', 'auto');
      if (words) div.innerHTML = lyricWordSpans(line);
      else div.textContent = line.text || '';
      if (line.time >= 0) div.addEventListener('click', () => { const t = getLineStartTime(index); if (el.nativeAudio && t >= 0) el.nativeAudio.currentTime = t; });
      box.appendChild(div);
    });
    if (miniLyricsShown() && el.nativeAudio) updateMiniLyricsHighlight(el.nativeAudio.currentTime || 0);
  }
  function updateMiniLyricsHighlight(currentTime) {
    const lines = state.syncedLyrics || [];
    const box = document.getElementById('mini-lyrics-container');
    if (!box || !lines.length || !state.isWindowVisible || !miniLyricsShown()) return;
    const t = currentTime + (state.isCustomLyrics ? 0.25 : 0);
    let active = -1;
    for (let i = 0; i < lines.length; i++) {
      const start = getLineStartTime(i);
      if (start >= 0 && start <= t) active = i;
      else if (start > t) break;
    }
    if (active !== miniLyricsLastIdx) {
      const prev = box.querySelector('.mini-lyric-line.active');
      if (prev) {
        prev.classList.remove('active');
        prev.querySelectorAll('.lyric-word').forEach((w) => { w.className = 'lyric-word past-word'; });
      }
      const cur = active >= 0 ? document.getElementById(`mini-lyric-line-${active}`) : null;
      if (cur) {
        cur.classList.add('active');
        const top = box.scrollTop + cur.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2 + cur.clientHeight / 2), behavior: document.body.classList.contains('perf') ? 'auto' : 'smooth' });
      }
      miniLyricsLastIdx = active;
    }
    if (active < 0) return;
    const cur = document.getElementById(`mini-lyric-line-${active}`);
    const spans = cur ? cur.querySelectorAll('.lyric-word') : [];
    if (!spans.length) return;
    const timed = lineTimedWords(lines[active]);
    let idx;
    if (timed && timed.length === spans.length) idx = timedWordIndex(timed, t);
    else {
      const start = getLineStartTime(active);
      const p = Math.min(0.999, Math.max(0, (t - start) / Math.max(0.5, getLineEndTime(active) - start)));
      idx = Math.floor(p * spans.length);
    }
    spans.forEach((w, i) => { w.className = i < idx ? 'lyric-word past-word' : i === idx ? 'lyric-word active-word' : 'lyric-word'; });
  }
  (function setupMiniLyrics() {
    const btn = document.getElementById('btn-mini-lyrics');
    const wanted = () => localStorage.getItem('muriel_mini_lyrics') === '1';
    const sync = () => {
      const on = document.body.classList.contains('mini') && wanted();
      document.body.classList.toggle('mini-lyrics-on', on);
      if (btn) btn.classList.toggle('active', on);
      if (on) renderMiniLyrics();
    };
    // the mini window is a body class set on resize (checkCompactLayout); follow it
    new MutationObserver(() => {
      const on = document.body.classList.contains('mini') && wanted();
      if (on !== document.body.classList.contains('mini-lyrics-on')) sync();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
    if (btn) btn.addEventListener('click', async () => {
      const next = !wanted();
      localStorage.setItem('muriel_mini_lyrics', next ? '1' : '0');
      if (window.electronAPI && window.electronAPI.setMiniLyrics) {
        try { await window.electronAPI.setMiniLyrics(next); } catch (e) {}
      }
      sync();
    });
  })();

  // ---- song radio (#28): a mix of songs like one song, or a few picked together; the queue grows as it plays ----
  // Settings > Tracks > Song radio shows or hides its buttons (on unless turned off).
  const songRadio = { current: null, nextId: 1 };
  function songRadioEnabled() {
    try { return localStorage.getItem('muriel_song_radio') !== '0'; } catch (e) { return true; }
  }
  function radioSeedOf(t) {
    return { id: t.id || '', title: t.title || '', artist: t.artist || '', platform: t.platform || 'youtube' };
  }
  function radioTrackKey(t) {
    return `${Lib.nameKey(t && t.artist)}::${Lib.nameKey(t && t.title)}`;
  }
  // the radio is on while its songs are still in the queue (playing something else from a list replaces the queue)
  function activeSongRadio() {
    const r = songRadio.current;
    return r && state.queue.some((t) => t && t._radio === r.id) ? r : null;
  }
  async function fetchSongRadio(r, limit) {
    const blocks = getBlocks();
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/radio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seeds: r.seeds.map(radioSeedOf),
        limit,
        exclude: { ids: [...r.ids], keys: [...r.keys] },
        blocks: { artists: blocks.artists, songs: blocks.songs },
      }),
    });
    const data = await res.json();
    const tracks = data && data.success && Array.isArray(data.tracks) ? data.tracks : [];
    // the server already leaves these out; this keeps a repeat out even if it found one under another id
    const fresh = tracks.filter((t) => t && t.title && !r.ids.has(String(t.id || '')) && !r.keys.has(radioTrackKey(t)) && !isBlocked(t));
    fresh.forEach((t) => { if (t.id) r.ids.add(String(t.id)); r.keys.add(radioTrackKey(t)); t._radio = r.id; });
    return fresh;
  }
  async function startSongRadio(seeds) {
    const list = (seeds || []).filter((t) => t && t.title).slice(0, 5);
    if (!list.length) return;
    const r = {
      id: songRadio.nextId++,
      seeds: list,
      label: list.length === 1 ? Tm('Radio · {0}', list[0].title) : Tm('Radio · {0} and {1} more', list[0].title, list.length - 1),
      ids: new Set(), keys: new Set(), loading: true, exhausted: false,
    };
    list.forEach((t) => { if (t.id) r.ids.add(String(t.id)); r.keys.add(radioTrackKey(t)); });
    songRadio.current = r;
    showToast(list.length === 1 ? Tm('Starting radio from "{0}"…', list[0].title) : Tm('Starting radio from {0} songs…', list.length), 'info');
    let tracks = [];
    try { tracks = await fetchSongRadio(r, 25); } catch (e) { console.warn('[radio]', e && e.message); }
    r.loading = false;
    if (songRadio.current !== r) return; // another radio was started meanwhile
    if (!tracks.length) {
      songRadio.current = null;
      showToast(navigator.onLine === false ? Tm('Radio needs the internet') : Tm('Couldn\'t find songs for a radio. Try another song'), 'error');
      return;
    }
    state.myWaveActive = false;
    if (list.length === 1) {
      // the song it was started from first; the same track when it is the one playing, so it doesn't restart
      const seed = state.currentTrack && isSameTrack(state.currentTrack, list[0]) ? state.currentTrack : list[0];
      seed._radio = r.id;
      if (seed === state.currentTrack) {
        state.queue = [seed, ...tracks];
        state.queueIndex = 0;
        state.queueHistory = [0];
        shuffleBag.next = []; shuffleBag.queue = state.queue;
        updateQueueBadge();
      } else {
        playTrack(seed, [seed, ...tracks], 0);
      }
    } else {
      playTrack(tracks[0], tracks, 0);
    }
    renderSongRadioLabel();
  }
  async function extendSongRadio() {
    const r = activeSongRadio();
    if (!r || r.loading || r.exhausted) return;
    if (state.queueIndex < state.queue.length - 5) return;
    r.loading = true;
    let more = [];
    try { more = await fetchSongRadio(r, 20); } catch (e) {}
    r.loading = false;
    if (activeSongRadio() !== r) return;
    if (!more.length) { r.exhausted = true; return; }
    state.queue.push(...more);
    updateQueueBadge();
  }
  // "Radio · <song>" above the queue while a radio plays
  function renderSongRadioLabel() {
    const list = el.queueTracksList;
    if (!list || !list.parentNode) return;
    let label = document.getElementById('queue-radio-label');
    const r = activeSongRadio();
    if (!r) { if (label) label.hidden = true; return; }
    if (!label) {
      label = document.createElement('div');
      label.id = 'queue-radio-label';
      label.className = 'queue-radio-label';
      label.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg><span class="queue-radio-text"></span>';
      list.parentNode.insertBefore(label, list);
    }
    label.hidden = false;
    I18N.text(label.querySelector('.queue-radio-text'), r.label);
  }
  window.addEventListener('muriel:queue', () => {
    renderSongRadioLabel();
    if (activeSongRadio()) extendSongRadio();
  });
  (function setupSongRadio() {
    const toggle = document.getElementById('toggle-song-radio');
    const apply = () => {
      const on = songRadioEnabled();
      document.body.classList.toggle('no-song-radio', !on);
      if (toggle) toggle.classList.toggle('active', on);
    };
    if (toggle) {
      toggle.addEventListener('click', () => {
        try { localStorage.setItem('muriel_song_radio', songRadioEnabled() ? '0' : '1'); } catch (e) {}
        apply();
      });
    }
    apply();
    const btn = document.getElementById('btn-playbar-radio');
    if (btn) {
      btn.addEventListener('click', () => {
        if (!state.currentTrack) { showToast(Tm('No track currently playing'), 'info'); return; }
        startSongRadio([state.currentTrack]);
      });
    }
  })();

  // ---- share the playing song: a one-song Muriel link, the same kind playlists use ----
  (function setupPlaybarShare() {
    const btn = document.getElementById('btn-playbar-share');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const t = state.currentTrack;
      if (!t) { showToast('Nothing is playing', 'info'); return; }
      if (t.platform === 'local') { showToast("Songs from your own files can't be shared", 'info'); return; }
      sharePlaylist({ name: [t.title, t.artist].filter(Boolean).join(' · ') || 'A song', tracks: [t] });
    });
  })();

  // ---- lyrics source (LRCLIB or Genius first) and word timings for word-by-word karaoke ----
  function lyricsSourcePref() { return localStorage.getItem('muriel_lyrics_source') === 'genius' ? 'genius' : 'lrclib'; }
  var CJK_WORD = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
  // the words to show for a line, with their times when the line has them (null: no times)
  function lineTimedWords(line) {
    if (!line || !Array.isArray(line.words) || !line.words.length || !window.MurielLyricsSources) return null;
    if (line._timedFor !== line.words) {
      line._timed = window.MurielLyricsSources.timedWords(line.text, line.words);
      line._timedFor = line.words;
    }
    return line._timed;
  }
  // the word being sung at time t: the first one that hasn't finished yet
  function timedWordIndex(timed, t) {
    for (let i = 0; i < timed.length; i++) if (t < timed[i].end) return i;
    return timed.length;
  }
  function lyricWordSpans(line) {
    const timed = lineTimedWords(line);
    const words = timed ? timed.map((w) => w.text) : String(line.text || '').replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean);
    return words.map((w, i) => {
      const sep = i === 0 || (CJK_WORD.test(w) && CJK_WORD.test(words[i - 1])) ? '' : ' ';
      return `${sep}<span class="lyric-word" data-word-idx="${i}">${escapeHtml(w)}</span>`;
    }).join('');
  }
  var wordsSessionCache = new Map();
  async function fetchAndUpgradeWords(title, artist, token) {
    const source = localStorage.getItem('muriel_word_source') || 'auto';
    const S = window.MurielLyricsSources;
    if (source === 'estimate' || !S || state.isCustomLyrics || !getAdv('online_lyrics', true)) return;
    // only word-by-word karaoke uses them: no lookup for line mode
    if (state.lyricsMode !== 'word' || !getAdv('karaoke_words', true)) return;
    const lines = state.syncedLyrics;
    if (!lines.length) return;
    // "Auto" keeps word times the lyrics brought themselves
    if (source === 'auto' && lines.some((l) => Array.isArray(l.words) && l.words.length)) return;
    const dur = Math.round(Number(state.currentTrack && state.currentTrack.duration) || (el.nativeAudio && el.nativeAudio.duration) || 0);
    const key = `${artist}\u0000${title}`;
    let data = wordsSessionCache.get(key);
    if (!data || (data.failed && Date.now() - data.at > 10 * 60 * 1000)) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/lyrics-words?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}${dur ? `&duration=${dur}` : ''}`);
        const json = await res.json();
        data = json && json.success && Array.isArray(json.lines) && json.lines.length ? { lines: json.lines } : { failed: true, at: Date.now() };
      } catch (e) {
        data = { failed: true, at: Date.now() };
      }
      wordsSessionCache.set(key, data);
      if (wordsSessionCache.size > 100) wordsSessionCache.delete(wordsSessionCache.keys().next().value);
    }
    if (token !== state.loadToken || state.syncedLyrics !== lines || !data.lines) return;
    if (lines.some((l) => l.time >= 0)) {
      const aligned = S.alignWordTimings(lines, data.lines);
      if (!aligned) return;
      aligned.forEach((words, i) => { if (words) lines[i].words = words; });
    } else {
      // plain lyrics: NetEase's timed lines take their place, when they are the same lyrics
      const ok = data.lines.filter((wl) => lines.some((l) => S.lineSimilarity(l.text, wl.text) >= 0.6)).length / data.lines.length >= 0.6;
      if (!ok) return;
      state.syncedLyrics = data.lines.map((l) => ({ time: l.start, text: l.text, words: l.words }));
      window.dispatchEvent(new Event('muriel:lyrics'));
      if (el.lyricsStatus) el.lyricsStatus.textContent = 'Synced';
      if (state.trActive) fetchAndApplyTranslation();
    }
    renderLyricsView();
    renderMiniLyrics();
    if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
  }
  var reloadLyrics = () => { if (state.currentTrack) loadSyncedLyrics(state.currentTrack.title, state.currentTrack.artist, state.loadToken); };
  wireSettingDropdown('lyrics-source', 'muriel_lyrics_source', 'lrclib', reloadLyrics);
  wireSettingDropdown('word-source', 'muriel_word_source', 'auto', reloadLyrics);

  // ---- stream timeout: a song that has loaded nothing for this long is given up on ----
  (function setupStreamTimeout() {
    const slider = document.getElementById('slider-stream-timeout');
    const val = document.getElementById('val-stream-timeout');
    const seconds = () => Math.max(5, Math.min(30, parseInt(localStorage.getItem('muriel_stream_timeout') || '12', 10) || 12));
    const show = () => { if (val) val.textContent = `${seconds()}s`; if (slider) slider.value = seconds(); };
    show();
    if (slider) slider.addEventListener('input', (e) => { localStorage.setItem('muriel_stream_timeout', e.target.value); show(); });
    const audio = el.nativeAudio;
    if (!audio) return;
    // checked once a second while a song with a source is loading; anything new buffered counts as progress
    let poll = null;
    let token = -1;
    let lastProgressAt = 0;
    let lastBuffered = -1;
    const stop = () => { clearInterval(poll); poll = null; };
    const bufferedEnd = () => { try { const b = audio.buffered; return b.length ? b.end(b.length - 1) : 0; } catch (e) { return 0; } };
    const giveUp = () => {
      stop();
      if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
      state.isPlaying = false;
      document.body.classList.remove('is-playing');
      if (retryFresh(token, state.currentTrack)) return;
      updatePlayPauseButton(false, false);
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      if (!skipUnplayable(token, state.currentTrack)) showToast('This song took too long to load. Try again or skip.', 'error');
    };
    const arm = () => {
      stop();
      if (!state.trackLoading || !state.currentTrack || state.currentTrack.platform === 'local') return;
      if (!audio.getAttribute('src') && !hlsInstance) return;
      token = state.loadToken;
      lastProgressAt = Date.now();
      lastBuffered = -1;
      poll = setInterval(() => {
        if (token !== state.loadToken || !state.trackLoading || (!audio.paused && audio.currentTime > 0)) { stop(); return; }
        const b = bufferedEnd() + audio.readyState * 1e-3;
        if (b !== lastBuffered) { lastBuffered = b; lastProgressAt = Date.now(); return; }
        if (Date.now() - lastProgressAt > seconds() * 1000) giveUp();
      }, 1000);
    };
    audio.addEventListener('loadstart', () => setTimeout(arm, 0));
    audio.addEventListener('playing', stop);
  })();

  // ---- banner effects for one song (Track art dialog): its own blur, opacity and fade ----
  function trackBannerFx(art) {
    const fx = art && art.bannerFx;
    return fx && fx.enabled ? fx : null;
  }
  function applyTrackBannerFx(art) {
    const fx = trackBannerFx(art);
    for (const node of [document.getElementById('right-panel-banner'), document.getElementById('tv-bg')]) {
      if (!node) continue;
      node.classList.toggle('has-track-fx', !!fx);
      if (fx) {
        node.style.setProperty('--banner-blur', `${document.body.classList.contains('perf') ? 0 : fx.blur}px`);
        node.style.setProperty('--banner-opacity', String(fx.opacity / 100));
        node.style.setProperty('--banner-fade-base', `${fx.fade}%`);
      } else {
        node.style.removeProperty('--banner-blur');
        node.style.removeProperty('--banner-opacity');
        node.style.removeProperty('--banner-fade-base');
      }
    }
  }
  function renderTrackBannerFxControls(track, art) {
    const toggle = document.getElementById('btn-track-banner-custom-fx');
    const box = document.getElementById('track-banner-fx-controls');
    const sliders = { blur: document.getElementById('slider-track-banner-blur'), opacity: document.getElementById('slider-track-banner-opacity'), fade: document.getElementById('slider-track-banner-fade') };
    const vals = { blur: document.getElementById('val-track-banner-blur'), opacity: document.getElementById('val-track-banner-opacity'), fade: document.getElementById('val-track-banner-fade') };
    if (!toggle || !box) return;
    // a song without its own effects starts from the ones in Settings
    const global = {
      blur: parseInt(localStorage.getItem('muriel_banner_blur') || '3', 10),
      opacity: parseInt(localStorage.getItem('muriel_banner_opacity') || '100', 10),
      fade: parseInt(localStorage.getItem('muriel_banner_fade') || '100', 10),
    };
    const fx = (art && art.bannerFx) || {};
    const cur = { blur: fx.blur !== undefined ? fx.blur : global.blur, opacity: fx.opacity !== undefined ? fx.opacity : global.opacity, fade: fx.fade !== undefined ? fx.fade : global.fade };
    const on = !!fx.enabled;
    const unit = { blur: 'px', opacity: '%', fade: '%' };
    toggle.classList.toggle('active', on);
    box.style.display = on ? 'flex' : 'none';
    for (const k of Object.keys(sliders)) {
      if (sliders[k]) sliders[k].value = cur[k];
      if (vals[k]) vals[k].textContent = `${cur[k]}${unit[k]}`;
    }
    const save = () => {
      const next = { enabled: toggle.classList.contains('active') };
      for (const k of Object.keys(sliders)) next[k] = sliders[k] ? parseInt(sliders[k].value, 10) : cur[k];
      setTrackArt(track, { bannerFx: next });
      if (state.currentTrack && isSameTrack(state.currentTrack, track)) applyTrackBannerFx(getTrackArt(track));
      if (state.isTvKaraokeOpen) syncTvBanner();
    };
    toggle.onclick = () => {
      const next = !toggle.classList.contains('active');
      toggle.classList.toggle('active', next);
      box.style.display = next ? 'flex' : 'none';
      save();
    };
    for (const k of Object.keys(sliders)) {
      if (!sliders[k]) continue;
      sliders[k].oninput = () => { if (vals[k]) vals[k].textContent = `${sliders[k].value}${unit[k]}`; save(); };
    }
  }

  // ---- Download dialog → "Trim best part": keep only part of a song; playback skips the rest ----
  var trackTrims = null;
  var trimDraft = { start: 0, end: 180, dur: 180 };
  var TRIM_BARS = 84;
  var trimPeaks = new Map();
  function allTrackTrims() {
    if (!trackTrims) trackTrims = safeJson('muriel_track_trims', {}) || {};
    return trackTrims;
  }
  function getTrackTrim(track) {
    const id = track ? getTrackCanonicalId(track) : '';
    return id ? allTrackTrims()[id] || null : null;
  }
  function saveTrackTrim(track, trim) {
    const id = track ? getTrackCanonicalId(track) : '';
    if (!id) return;
    const all = allTrackTrims();
    if (trim) all[id] = { ...trim, updatedAt: Date.now() }; else delete all[id];
    localStorage.setItem('muriel_track_trims', JSON.stringify(all));
  }
  window.addEventListener('storage', (e) => { if (!e.key || /muriel_track_trims$/.test(e.key)) trackTrims = null; });
  // called on every timeupdate: before the kept part, jump to it; after it, the song is over
  function enforceTrackTrim() {
    const a = el.nativeAudio;
    if (!a || !state.currentTrack || isDraggingScrubber || !window.MurielTrim) return false;
    const trim = getTrackTrim(state.currentTrack);
    const action = window.MurielTrim.trimAction(trim, a.currentTime);
    if (action === 'start') { a.currentTime = trim.start; return true; }
    if (action !== 'end' || a.paused) return false;
    if (state.isRepeat) { a.currentTime = trim.start; return true; }
    if ((state.sleepTimer && state.sleepTimer.mode === 'end') || queueFinished()) {
      a.pause();
      a.dispatchEvent(new Event('ended'));
      return true;
    }
    if (crossfadeTriggered) crossfadeFadeInPending = true;
    state._isNaturalEnding = true;
    try { playNext(); } finally { state._isNaturalEnding = false; }
    return true;
  }
  if (el.nativeAudio) {
    // a trimmed song starts at its trim
    const toTrimStart = () => {
      const trim = state.currentTrack && window.MurielTrim ? getTrackTrim(state.currentTrack) : null;
      if (window.MurielTrim && window.MurielTrim.trimAction(trim, el.nativeAudio.currentTime) === 'start') el.nativeAudio.currentTime = trim.start;
    };
    el.nativeAudio.addEventListener('loadedmetadata', toTrimStart);
    el.nativeAudio.addEventListener('play', toTrimStart);
  }
  function showDownloadPane(which) {
    document.querySelectorAll('.dl-mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.dlTab === which));
    const dl = document.getElementById('dl-pane-download');
    const tr = document.getElementById('dl-pane-trim');
    if (dl) dl.classList.toggle('hidden', which !== 'download');
    if (tr) tr.classList.toggle('hidden', which !== 'trim');
    if (which === 'trim') { sizeTrimCanvas(); updateTrimmerUI(); }
  }
  function prepareTrimPane(track) {
    const a = el.nativeAudio;
    const dur = isSameTrack(track, state.currentTrack) && a && Number.isFinite(a.duration) && a.duration > 0
      ? a.duration
      : (Number(track.duration) > 0 ? Number(track.duration) : 180);
    const saved = getTrackTrim(track);
    trimDraft = { start: saved ? Math.max(0, saved.start) : 0, end: saved ? Math.min(dur, saved.end) : dur, dur };
    const reset = document.getElementById('btn-cc-reset');
    if (reset) reset.classList.toggle('hidden', !saved);
    showDownloadPane('download');
    // a saved trim also fills in the download's trim (computers: ffmpeg cuts the file)
    if (saved) {
      const s = document.getElementById('trim-start');
      const e = document.getElementById('trim-end');
      if (s) s.value = window.MurielTrim.formatPreciseTime(trimDraft.start);
      if (e) e.value = window.MurielTrim.formatPreciseTime(trimDraft.end);
    }
  }
  function sizeTrimCanvas() {
    const canvas = document.getElementById('capcut-wave-canvas');
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  // the bars: the song's real waveform when it is on this device (decoded at a low sample rate, so a long song
  // stays small), else a stand-in shape
  function trimWavePeaks(track) {
    const id = getTrackCanonicalId(track);
    if (trimPeaks.has(id)) return trimPeaks.get(id);
    const peaks = window.MurielTrim.placeholderPeaks(id, TRIM_BARS);
    trimPeaks.set(id, peaks);
    if (trimPeaks.size > 30) trimPeaks.delete(trimPeaks.keys().next().value);
    (async () => {
      try {
        let url = '';
        if (track.platform === 'local' && track.id) url = `http://127.0.0.1:${state.serverPort}/api/library-file?id=${encodeURIComponent(track.id)}`;
        else if (track.id) {
          const r = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(track.id)}`);
          const c = await r.json();
          if (c && c.cached) url = `http://127.0.0.1:${state.serverPort}/api/local-track?id=${encodeURIComponent(track.id)}`;
        }
        if (!url) return;
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 60e6) return;
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Offline) return;
        const audio = await new Offline(1, 1, 8000).decodeAudioData(buf);
        trimPeaks.set(id, window.MurielTrim.wavePeaks(audio.getChannelData(0), TRIM_BARS));
        if (trackToDownload && getTrackCanonicalId(trackToDownload) === id) renderTrimWave();
      } catch (e) {}
    })();
    return peaks;
  }
  function renderTrimWave() {
    const canvas = document.getElementById('capcut-wave-canvas');
    if (!canvas || !trackToDownload) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const peaks = trimWavePeaks(trackToDownload);
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    const dur = Math.max(1, trimDraft.dur);
    const from = trimDraft.start / dur;
    const to = trimDraft.end / dur;
    if (!cachedPrimaryColor) refreshCachedThemeColors();
    const step = w / TRIM_BARS;
    const barW = step * 0.6;
    for (let i = 0; i < TRIM_BARS; i++) {
      const at = i / (TRIM_BARS - 1);
      ctx.fillStyle = at >= from - 0.01 && at <= to + 0.01 ? (cachedPrimaryColor || '#a8c7fa') : 'rgba(255, 255, 255, 0.22)';
      const barH = Math.max(6 * dpr, (peaks[i] || 0.3) * (h - 16 * dpr));
      ctx.beginPath();
      ctx.roundRect(i * step + (step - barW) / 2, (h - barH) / 2, barW, barH, 2 * dpr);
      ctx.fill();
    }
  }
  function updateTrimmerUI() {
    const T = window.MurielTrim;
    if (!T) return;
    const dur = Math.max(1, trimDraft.dur);
    const startPct = (trimDraft.start / dur) * 100;
    const endPct = (trimDraft.end / dur) * 100;
    const set = (id, fn) => { const n = document.getElementById(id); if (n) fn(n); };
    set('cc-mask-left', (n) => { n.style.width = `${startPct}%`; });
    set('cc-mask-right', (n) => { n.style.width = `${100 - endPct}%`; });
    set('cc-selection-box', (n) => { n.style.left = `${startPct}%`; n.style.width = `${Math.max(0, endPct - startPct)}%`; });
    const s = T.formatPreciseTime(trimDraft.start);
    const e = T.formatPreciseTime(trimDraft.end);
    set('cc-trim-start-val', (n) => { n.textContent = s; });
    set('cc-trim-end-val', (n) => { n.textContent = e; });
    set('cc-trim-dur-val', (n) => { n.textContent = T.formatPreciseTime(Math.max(0, trimDraft.end - trimDraft.start)); });
    set('cc-float-left', (n) => { n.textContent = s; });
    set('cc-float-right', (n) => { n.textContent = e; });
    renderTrimWave();
    updateTrimPlayhead();
  }
  function updateTrimPlayhead() {
    const head = document.getElementById('cc-playhead');
    if (!head) return;
    const same = trackToDownload && state.currentTrack && isSameTrack(state.currentTrack, trackToDownload);
    head.style.display = same ? '' : 'none';
    if (same && el.nativeAudio) head.style.left = `${Math.max(0, Math.min(100, ((el.nativeAudio.currentTime || 0) / Math.max(1, trimDraft.dur)) * 100))}%`;
  }
  (function setupTrimmer() {
    document.querySelectorAll('.dl-mode-tab').forEach((tab) => tab.addEventListener('click', () => showDownloadPane(tab.dataset.dlTab)));
    const stage = document.getElementById('capcut-wave-stage');
    if (!stage) return;
    const minKeep = window.MurielTrim ? window.MurielTrim.MIN_KEEP : 1;
    const ratioAt = (e) => { const r = stage.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; };
    const dragHandle = (handle, side) => {
      if (!handle) return;
      let dragging = false;
      handle.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragging = true; handle.setPointerCapture(e.pointerId); handle.classList.add('dragging'); });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const t = Math.round(ratioAt(e) * trimDraft.dur * 10) / 10;
        if (side === 'start') trimDraft.start = Math.max(0, Math.min(t, trimDraft.end - minKeep));
        else trimDraft.end = Math.min(trimDraft.dur, Math.max(t, trimDraft.start + minKeep));
        updateTrimmerUI();
      });
      const stop = (e) => { if (!dragging) return; dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch (_) {} handle.classList.remove('dragging'); };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
    dragHandle(document.getElementById('cc-handle-left'), 'start');
    dragHandle(document.getElementById('cc-handle-right'), 'end');
    // tap the waveform to listen from there
    const playFrom = async (t) => {
      if (!trackToDownload || !el.nativeAudio) return;
      if (!isSameTrack(state.currentTrack, trackToDownload)) await playTrack(trackToDownload);
      el.nativeAudio.currentTime = t;
      if (el.nativeAudio.paused) playSmooth();
    };
    stage.addEventListener('pointerdown', (e) => { if (!e.target.closest('.cc-handle')) playFrom(ratioAt(e) * trimDraft.dur); });
    const btnPreview = document.getElementById('btn-cc-preview');
    if (btnPreview) btnPreview.addEventListener('click', () => playFrom(trimDraft.start));
    const btnSave = document.getElementById('btn-cc-save');
    const btnReset = document.getElementById('btn-cc-reset');
    if (btnSave) btnSave.addEventListener('click', () => {
      if (!trackToDownload) return;
      const trim = window.MurielTrim.normalizeTrim(trimDraft.start, trimDraft.end, trimDraft.dur);
      saveTrackTrim(trackToDownload, trim);
      if (btnReset) btnReset.classList.toggle('hidden', !trim);
      const T = window.MurielTrim;
      showToast(trim ? `Trim saved: ${T.formatPreciseTime(trim.start)} – ${T.formatPreciseTime(trim.end)}` : 'That keeps the whole song, so there is no trim', trim ? 'success' : 'info');
      if (trim) {
        const s = document.getElementById('trim-start');
        const e = document.getElementById('trim-end');
        if (s) s.value = T.formatPreciseTime(trim.start);
        if (e) e.value = T.formatPreciseTime(trim.end);
        if (state.currentTrack && isSameTrack(state.currentTrack, trackToDownload) && el.nativeAudio) {
          const t = el.nativeAudio.currentTime;
          if (t < trim.start || t > trim.end) el.nativeAudio.currentTime = trim.start;
        }
      }
    });
    if (btnReset) btnReset.addEventListener('click', () => {
      if (!trackToDownload) return;
      saveTrackTrim(trackToDownload, null);
      trimDraft.start = 0;
      trimDraft.end = trimDraft.dur;
      updateTrimmerUI();
      btnReset.classList.add('hidden');
      showToast('Trim removed', 'info');
    });
    if (el.nativeAudio) el.nativeAudio.addEventListener('timeupdate', () => {
      const pane = document.getElementById('dl-pane-trim');
      if (pane && !pane.classList.contains('hidden') && el.downloadModal && !el.downloadModal.classList.contains('hidden')) updateTrimPlayhead();
    });
  })();
  // ======================= end of Riff 43: player & look =======================

  restoreQueueState();

  emitPluginEvent('ready');

  // ---- Core API for the iPhone interface (mobile/ui), which draws its own screens on this engine ----
  const savePlaylists = () => { localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); renderPlaylistsList(); window.dispatchEvent(new Event('muriel:library')); };
  window.MurielCore = {
    state,
    audio: el.nativeAudio,
    base: () => `http://127.0.0.1:${state.serverPort}`,
    thumb: (t) => getTrackThumbUrl(t),
    playTrack: (track, list, index) => playTrack(track, list || null, typeof index === 'number' ? index : -1),
    togglePlay: () => togglePlayPause(),
    next: () => playNext(),
    prev: () => playPrev(),
    seek: (sec) => { if (isFinite(sec)) el.nativeAudio.currentTime = Math.max(0, sec); },
    toggleShuffle: () => { if (el.btnShuffle) el.btnShuffle.click(); return state.isShuffle; },
    toggleRepeat: () => { if (el.btnRepeat) el.btnRepeat.click(); return state.repeatMode; },
    isFavorite: (t) => state.favorites.some((f) => isSameSong(f, t)),
    toggleFavorite: (t) => { toggleFavoriteTrack(t); window.dispatchEvent(new Event('muriel:library')); return state.favorites.some((f) => isSameSong(f, t)); },
    createPlaylist(name, tracks = []) {
      if (!name || !name.trim()) return null;
      const pl = { id: 'pl_' + Date.now(), name: name.trim(), tracks: tracks.slice() };
      state.playlists.push(pl);
      savePlaylists();
      return pl;
    },
    renamePlaylist(id, name) { const pl = state.playlists.find((p) => p.id === id); if (pl && name && name.trim()) { pl.name = name.trim(); savePlaylists(); } },
    deletePlaylist(id) { state.playlists = state.playlists.filter((p) => p.id !== id); savePlaylists(); },
    addToPlaylist(id, track) {
      const pl = state.playlists.find((p) => p.id === id);
      if (!pl || pl.tracks.some((t) => isSameTrack(t, track))) return false;
      pl.tracks.push(track);
      savePlaylists();
      return true;
    },
    removeFromPlaylist(id, track) { const pl = state.playlists.find((p) => p.id === id); if (pl) { pl.tracks = pl.tracks.filter((t) => !isSameTrack(t, track)); savePlaylists(); } },
    playNextInQueue(track) {
      const at = Math.max(0, state.queueIndex + 1);
      state.queue.splice(at, 0, track);
      updateQueueBadge();
      window.dispatchEvent(new Event('muriel:queue'));
    },
    addToQueue(track) { state.queue.push(track); updateQueueBadge(); window.dispatchEvent(new Event('muriel:queue')); },
    isSameTrack: (a, b) => isSameTrack(a, b),
    formatDuration: (s) => formatDuration(s),
    toast: (msg, kind) => showToast(msg, kind),
    refreshBackground: () => updateCustomBg(),
    // for lastfm.js and backup.js (Last.fm dialog, playlist files, backups)
    openModal: (m) => openModal(m),
    closeModal: (m) => closeModal(m),
    importPlaylist(name, tracks, { cover = '', description = '' } = {}) {
      const pl = createPlaylist(name, tracks || [], cover, { open: false });
      if (pl && description) { pl.description = description; localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists)); }
      if (pl) window.dispatchEvent(new Event('muriel:library'));
      return pl;
    },
    openPlaylist: (id) => openPlaylistDetail(id),
    // songs known only by title and artist, found on YouTube like a Spotify import
    matchTracks: (list, onProgress) => matchSpotifyTracks(list, onProgress),
    // sync.js wrote these keys with what another device had; show it without a restart
    reloadFromStorage(keys) {
      const has = (k) => keys.includes(k);
      if (has('devsize_playlists')) {
        state.playlists = safeArray('devsize_playlists');
        renderPlaylistsList();
        if (state.currentView === 'playlist-detail' && state.currentPlaylistId) {
          if (state.playlists.some((p) => p.id === state.currentPlaylistId)) openPlaylistDetail(state.currentPlaylistId);
          else switchView('local');
        }
      }
      if (has('devsize_favorites')) {
        state.favorites = dedupeFavoriteTracks(safeArray('devsize_favorites'));
        updateFavoritesBadge();
        updateFavoriteIcon();
        if (state.currentView === 'favorites') renderFavoritesView();
      }
      if (has('devsize_history')) {
        state.history = safeArray('devsize_history');
        if (state.currentView === 'history') renderHistoryView();
      }
      // saved albums and followed artists from another device
      if (has('muriel_saved_albums')) {
        updateAlbumsCount();
        if (state.currentView === 'albums') renderSavedAlbums();
        if (state.currentView === 'album') updateSaveAlbumButton();
      }
      if (has('muriel_followed_artists')) {
        renderFollowedArtists();
        if (state.currentView === 'artist') updateFollowButton();
      }
      if (['muriel_theme_mode', 'muriel_theme_accent', 'muriel_theme_intensity', 'muriel_theme_brightness', 'muriel_palette_style'].some(has)) {
        state.themeMode = localStorage.getItem('muriel_theme_mode') || 'dark';
        state.themeAccent = localStorage.getItem('muriel_theme_accent') || '#6750A4';
        state.themeIntensity = parseInt(localStorage.getItem('muriel_theme_intensity') || '0', 10);
        state.themeBrightness = parseInt(localStorage.getItem('muriel_theme_brightness') || '50', 10);
        state.paletteStyle = localStorage.getItem('muriel_palette_style') || 'classic';
        updateThemeFromState();
      }
      if (has('muriel_font')) {
        state.riffFont = localStorage.getItem('muriel_font') || 'google';
        applyFont(state.riffFont);
      }
      if (has('muriel_track_trims')) trackTrims = null;
      if (has('muriel_icon_pack')) applyIconPack(localStorage.getItem('muriel_icon_pack') || 'material');
      if (has('muriel_adv_intensity_bg')) updateThemeFromState();
      if (keys.some((k) => k === 'devsize_playlists' || k === 'devsize_favorites')) window.dispatchEvent(new Event('muriel:library'));
    },
  };
  window.dispatchEvent(new Event('muriel:ready'));
});

document.addEventListener('DOMContentLoaded', () => {
  const btnCollapseRightPanel = document.getElementById('btn-collapse-right-panel');
  const rightPanel = document.getElementById('right-panel');
  if (btnCollapseRightPanel && rightPanel) {
    btnCollapseRightPanel.addEventListener('click', () => {
      rightPanel.classList.toggle('is-collapsed');
    });
  }
});

