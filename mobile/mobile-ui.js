// iOS layout behaviour on top of app.js: mini player <-> now-playing sheet, swipe to dismiss,
// and the progress line on the mini player.

// Background playback: iOS suspends Web Audio when the app is backgrounded or the screen locks,
// but keeps a plain <audio> element playing (and on the lock screen). So on iPhone the engine never
// routes the element through an AudioContext. Speed/pitch still work (they're element properties);
// EQ, reverb, distortion and the visualizer need the graph and are off. app.js builds the engine on
// DOMContentLoaded, which hasn't fired yet when this script runs.
(() => {
  // desktop's default text scale (1.25x) is sized for a monitor; phones start at 1.0x unless the user picked one
  if (!localStorage.getItem('muriel_font_scale')) localStorage.setItem('muriel_font_scale', '80');
  const Engine = window.MurielAudioEngine;
  if (!Engine) return;
  Engine.prototype.init = function (audioElement) { this.__element = audioElement || this.__element; };
  // iOS ignores element.volume (hardware buttons own it); mute still works
  Engine.prototype._applyMasterVolume = function () {
    if (this.__element) this.__element.muted = !!this.isMuted || this.volume === 0;
  };
})();

(() => {
  const panel = document.getElementById('right-panel');
  const playbar = document.getElementById('playbar');
  const lyricsBtn = document.getElementById('btn-toggle-lyrics-panel');
  const audio = document.querySelector('audio');
  if (!panel || !playbar || !lyricsBtn) return;

  // app.js owns the drawer state; mirror it onto <body> so the player bar can restyle itself
  const sync = () => document.body.classList.toggle('np-open', !panel.classList.contains('hidden'));
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  sync();

  const openSheet = () => { if (panel.classList.contains('hidden')) lyricsBtn.click(); };
  const closeSheet = () => { if (!panel.classList.contains('hidden')) document.getElementById('btn-close-right-panel').click(); };

  // tapping the mini player (but not its buttons) opens the sheet
  playbar.addEventListener('click', (e) => {
    if (document.body.classList.contains('np-open')) return;
    if (e.target.closest('button, input, .scrubber-track-container')) return;
    openSheet();
  });

  // swipe down on the sheet's top area to close it
  let startY = null;
  panel.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const lyrics = document.getElementById('lyrics-container');
    // a finger on a seek bar or slider is seeking, not closing the sheet (#21)
    if (e.target.closest('input[type="range"], .scrubber-track-container, [role="slider"]')) { startY = null; return; }
    startY = (lyrics && lyrics.contains(e.target) && lyrics.scrollTop > 0) ? null : t.clientY;
  }, { passive: true });
  // one transform write per frame, and no CSS transition while the finger drags (it lagged behind)
  let dragY = 0, dragRaf = 0;
  panel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dragY = Math.max(0, e.touches[0].clientY - startY);
    if (dragY > 0 && !panel.classList.contains('is-dragging')) panel.classList.add('is-dragging');
    if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; if (startY !== null) panel.style.transform = dragY > 0 ? `translateY(${dragY}px)` : ''; });
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    panel.classList.remove('is-dragging');
    panel.style.transform = '';
    startY = null;
    if (dy > 110) closeSheet();
  });

  // Picked images and videos (background, banner, song covers) are saved as file URLs, and those change when
  // iOS moves the app container (every update or reinstall). Rebuild each saved one from its file name, then
  // delete picks nothing uses any more (every pick is a new copy). Only the background was repaired before,
  // and picking a song cover made even that repair forget the background.
  const fixPickedMedia = async () => {
    const api = window.electronAPI;
    if (!api.fileUrl) return;
    const nameOf = (u) => { const m = typeof u === 'string' && !u.startsWith('blob:') && u.match(/\/backgrounds\/(bg_[\w.-]+)$/); return m ? m[1] : null; };
    const keep = new Set();
    const fresh = async (u) => {
      const name = nameOf(u);
      if (!name) return u;
      const url = await api.fileUrl(`/data/backgrounds/${name}`);
      if (url) keep.add(name);
      return url || u;
    };
    let bgChanged = false;
    for (const key of ['muriel_bg_url', 'muriel_banner_media', 'muriel_app_icon']) {
      const cur = localStorage.getItem(key);
      if (!cur) continue;
      const next = await fresh(cur);
      if (next !== cur) { localStorage.setItem(key, next); if (key === 'muriel_bg_url') bgChanged = true; }
    }
    let artOk = true;
    try {
      const art = JSON.parse(localStorage.getItem('muriel_track_art') || '{}');
      let dirty = false;
      for (const v of Object.values(art)) {
        for (const f of ['cover', 'banner']) {
          if (!v || !v[f]) continue;
          const next = await fresh(v[f]);
          if (next !== v[f]) { v[f] = next; dirty = true; }
        }
      }
      if (dirty) localStorage.setItem('muriel_track_art', JSON.stringify(art));
    } catch (e) { artOk = false; }
    localStorage.removeItem('muriel_bg_vpath');
    if (bgChanged) window.MurielCore.refreshBackground();
    // these settings are per profile but the files are shared: keep every profile's picks, not only this one's
    // (switching to a profile without a background used to delete the other profile's)
    let othersOk = true;
    const P = window.MurielProfiles;
    if (P) {
      for (const p of P.list()) {
        for (const key of ['muriel_bg_url', 'muriel_banner_media', 'muriel_app_icon']) {
          const name = nameOf(P.peek(p.id, key));
          if (name) keep.add(name);
        }
        try {
          for (const v of Object.values(JSON.parse(P.peek(p.id, 'muriel_track_art') || '{}'))) {
            for (const f of ['cover', 'banner']) { const name = v && nameOf(v[f]); if (name) keep.add(name); }
          }
        } catch (e) { othersOk = false; }
      }
    }
    if (artOk && othersOk && api.pruneMedia) api.pruneMedia(keep);
  };
  if (window.MurielCore) fixPickedMedia(); else window.addEventListener('muriel:ready', fixPickedMedia, { once: true });

  // phones default to word-by-word karaoke (the Line/Word button still switches)
  const preferWordLyrics = () => {
    const st = window.MurielCore && window.MurielCore.state;
    const btn = document.getElementById('btn-lyrics-mode');
    if (st && btn && st.lyricsMode === 'line' && localStorage.getItem('muriel_adv_karaoke_words') !== 'false') btn.click();
  };
  if (window.MurielCore) preferWordLyrics(); else window.addEventListener('muriel:ready', preferWordLyrics, { once: true });

  // lyrics tools (edit / sync / translate / fullscreen) move up next to the Line/Word button,
  // so the lyrics get that row back; same buttons, so their handlers keep working
  const tools = panel.querySelector('.lyrics-header-actions');
  const topRow = panel.querySelector('.right-panel-header-actions');
  if (tools && topRow) { topRow.prepend(tools); tools.classList.add('np-tools-moved'); }

  // like button next to the title in Now Playing (the player bar's heart is hidden on phones);
  // it presses the real one and mirrors its state
  const realFav = document.getElementById('btn-toggle-fav');
  const favIcon = document.getElementById('fav-icon');
  const titleRow = panel.querySelector('.right-panel-title-row');
  if (realFav && favIcon && titleRow) {
    const like = document.createElement('button');
    like.id = 'np-like';
    like.type = 'button';
    like.setAttribute('data-i18n-attr', 'aria-label');
    like.setAttribute('aria-label', 'Like');
    like.innerHTML = favIcon.outerHTML.replace('id="fav-icon"', '');
    const mirror = () => { const on = favIcon.getAttribute('fill') === 'currentColor'; like.classList.toggle('on', on); like.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); };
    like.addEventListener('click', () => {
      realFav.click();
      like.classList.remove('pop'); void like.offsetWidth; like.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(12);
    });
    new MutationObserver(mirror).observe(favIcon, { attributes: true, attributeFilter: ['fill'] });
    titleRow.appendChild(like);
    mirror();
  }

  // slowly drifting colour glow behind Now Playing (cover colours, plain gradients: cheap to draw)
  const ambient = document.createElement('div');
  ambient.className = 'np-ambient';
  ambient.innerHTML = '<i></i><i></i><i></i>';
  panel.prepend(ambient);

  // swipe the cover left/right to skip, with the cover following your finger
  const cover = document.getElementById('cover-container');
  if (cover) {
    let x0 = null, y0 = null, dx = 0, horizontal = null;
    cover.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null; cover.style.transition = 'none'; }, { passive: true });
    cover.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) cover.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    }, { passive: true });
    cover.addEventListener('touchend', () => {
      if (x0 === null) return;
      x0 = null;
      cover.style.transition = 'transform .32s cubic-bezier(.2,.8,.2,1), opacity .32s';
      if (horizontal && Math.abs(dx) > 70) {
        const dir = dx < 0 ? -1 : 1;
        cover.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 12}deg)`;
        cover.style.opacity = '0';
        if (navigator.vibrate) navigator.vibrate(10);
        setTimeout(() => {
          if (dir < 0) document.getElementById('btn-next').click(); else document.getElementById('btn-prev').click();
          cover.style.transition = 'none';
          cover.style.transform = `translateX(${-dir * 60}px)`;
          requestAnimationFrame(() => { cover.style.transition = 'transform .38s cubic-bezier(.2,.8,.2,1), opacity .38s'; cover.style.transform = ''; cover.style.opacity = ''; });
        }, 220);
      } else {
        cover.style.transform = '';
      }
    });
  }

  // mini player progress line
  if (audio) {
    const tick = () => {
      if (document.hidden) return;
      const p = audio.duration ? audio.currentTime / audio.duration : 0;
      playbar.style.setProperty('--mini-progress', String(Math.max(0, Math.min(1, p))));
    };
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('emptied', tick);
    document.addEventListener('visibilitychange', tick);
  }

  // phone-only settings: the song storage limit (Storage → Offline songs) and sharing the error log (About)
  const storageGroup = document.querySelector('.settings-section[data-cat="storage"] .m3-group[data-group="offline"]') || document.querySelector('.settings-section[data-cat="storage"] .m3-group');
  const aboutGroup = document.querySelector('.settings-section[data-cat="about"] .m3-group');
  if (storageGroup) {
    const limits = [['1024', '1 GB'], ['2048', '2 GB'], ['5120', '5 GB'], ['10240', '10 GB']];
    const current = localStorage.getItem('muriel_cache_limit_mb') || '2048';
    const limitRow = document.createElement('div');
    limitRow.className = 'setting-item';
    limitRow.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name" data-i18n>Song storage limit</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);" data-i18n>Songs you play are kept for offline use. Over this limit, the ones played longest ago are removed.</span>
        </div>
      </div>
      <div class="theme-mode-toggle" style="margin-top: 10px;">
        ${limits.map(([v, l]) => `<button class="fps-cap-btn${v === current ? ' active' : ''}" data-limit="${v}">${l}</button>`).join('')}
      </div>`;
    limitRow.querySelectorAll('[data-limit]').forEach((b) => b.addEventListener('click', () => {
      localStorage.setItem('muriel_cache_limit_mb', b.dataset.limit);
      limitRow.querySelectorAll('[data-limit]').forEach((x) => x.classList.toggle('active', x === b));
      // a lower limit applies now, not only after the next download
      if (window.MurielCache) window.MurielCache.enforceLimit();
    }));
    const logRow = document.createElement('div');
    logRow.className = 'setting-item';
    logRow.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name" data-i18n>Share error log</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);" data-i18n>If something breaks, send this so it can be fixed.</span>
        </div>
        <button class="btn-pill-primary" type="button" data-i18n>Share</button>
      </div>`;
    logRow.querySelector('button').addEventListener('click', async () => {
      const res = await window.electronAPI.shareText('Muriel error log', window.MurielLog ? window.MurielLog.text() : 'no log');
      if (res === 'copied' && window.MurielCore) window.MurielCore.toast((window.MurielI18n || { T: (x) => x, Tm: (x) => x }).Tm('Log copied to clipboard'), 'info');
    });
    storageGroup.append(limitRow);
    if (aboutGroup) aboutGroup.insertBefore(logRow, aboutGroup.lastElementChild); else storageGroup.append(logRow);
  }

  // the desktop placeholder doesn't fit beside the source buttons on a phone
  const searchInput = document.getElementById('search-input');
  if (searchInput) { searchInput.setAttribute('data-i18n-attr', 'placeholder'); searchInput.placeholder = 'Search songs, artists…'; }

  // iPhone: lyrics on the lock screen and in the Dynamic Island (mobile/live-activity.js)
  const trRow = document.getElementById('btn-tr-enabled') && document.getElementById('btn-tr-enabled').closest('.setting-item');
  // the phone's own playback rows go to Tracks → Playback
  const playbackGroup = document.querySelector('.m3-group[data-group="playback"]');
  const addPlaybackRow = (row) => { if (playbackGroup) playbackGroup.append(row); else trRow.parentElement.insertBefore(row, trRow); };
  if (window.MurielLiveActivity && trRow) {
    const la = window.MurielLiveActivity;
    const row = document.createElement('div');
    row.className = 'setting-item';
    row.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name" data-i18n>Lock screen &amp; Dynamic Island</span>
          <span class="la-hint" style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);" data-i18n>The song, its progress and the line being sung. Long-press the Dynamic Island for play, skip and shuffle (iOS 17).</span>
        </div>
        <button class="effect-switch-btn${la.enabled() ? ' active' : ''}" type="button" aria-label="Lock screen and Dynamic Island" data-i18n-attr="aria-label"><span class="thumb"></span></button>
      </div>`;
    const sw = row.querySelector('button');
    sw.addEventListener('click', () => {
      const on = !sw.classList.contains('active');
      sw.classList.toggle('active', on);
      la.setEnabled(on);
    });
    la.available().then((ok) => {
      if (!ok) row.querySelector('.la-hint').textContent = 'Turn on Live Activities for Muriel in the iPhone Settings app first (needs iOS 16.2 or newer).';
    });
    addPlaybackRow(row);
  }

  // Android: let Muriel off battery optimization so the phone doesn't stop it in the background (media-controls.js)
  if (window.MurielBackground && trRow) {
    const bg = window.MurielBackground;
    const row = document.createElement('div');
    row.className = 'setting-item';
    row.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name" data-i18n>Play in the background</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);" data-i18n>Some phones stop apps to save battery, even while music plays. Allow Muriel to keep running.</span>
        </div>
        <button class="btn-pill-primary" type="button" data-i18n>Allow</button>
      </div>`;
    const btn = row.querySelector('button');
    const refresh = () => bg.allowed().then((ok) => { btn.textContent = ok ? 'Allowed' : 'Allow'; btn.disabled = ok; });
    btn.addEventListener('click', () => bg.allow().then(refresh));
    // some phones send you to the battery list in Settings instead of asking
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh();
    addPlaybackRow(row);
  }

  // Android: the song in the island at the top of the screen, as an Android 16 live update (media-controls.js).
  // vivo's Origin Island and OPPO's Fluid Cloud only take music apps on their maker's list; a live update they take
  // from any app. Xiaomi's Super Island and Samsung's Now Bar show the playback notification already: no row there.
  if (window.MurielIsland && trRow) {
    const isl = window.MurielIsland;
    isl.status().then((s) => {
      if (!s.vendor || s.vendor === 'xiaomi' || s.vendor === 'samsung' || (!s.supported && s.vendor !== 'vivo')) return;
      const name = { vivo: 'Origin Island', oplus: 'Fluid Cloud' }[s.vendor] || 'Song in the status bar';
      const about = {
        vivo: 'The song in the Origin Island at the top of the screen. vivo’s music capsule only takes apps on vivo’s list, so Muriel shows there as a live update.',
        oplus: 'The song in Fluid Cloud at the top of the screen, as a live update.',
      }[s.vendor] || 'The song as a live update in the status bar.';
      const row = document.createElement('div');
      row.className = 'setting-item';
      row.innerHTML = `
        <div class="setting-item-top" style="align-items: center;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span class="setting-name">${name}</span>
            <span class="island-hint" style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);"></span>
            <button class="btn-pill-primary island-fix" type="button" style="align-self: flex-start; margin-top: 6px; display: none;"></button>
          </div>
          <button class="effect-switch-btn" type="button" aria-label="${name}"><span class="thumb"></span></button>
        </div>`;
      const hint = row.querySelector('.island-hint');
      const fix = row.querySelector('.island-fix');
      const sw = row.querySelector('.effect-switch-btn');
      const show = (st) => {
        if (!st.supported) {
          // OriginOS 5 and older: no live updates yet
          hint.textContent = 'Needs OriginOS 6 (Android 16). vivo’s own music capsule only takes apps on vivo’s list.';
          sw.style.display = 'none';
          return;
        }
        const on = isl.enabled(st);
        sw.classList.toggle('active', on);
        let need = '';
        if (on && !st.notifications) { need = ' Allow Muriel’s notifications for it.'; fix.textContent = 'Allow'; }
        else if (on && !st.promoted) {
          need = st.vendor === 'oplus' ? ' Turn on “Show Live Updates on Live Alerts” for Muriel in the phone’s settings.'
            : ' Live updates are turned off for Muriel in the phone’s settings.';
          fix.textContent = 'Settings';
        }
        hint.textContent = about + need;
        fix.style.display = need ? '' : 'none';
      };
      const refresh = () => isl.status().then(show);
      sw.addEventListener('click', () => {
        const on = !sw.classList.contains('active');
        isl.setEnabled(on);
        // turning it on asks for what's missing right away
        (on ? isl.allow() : isl.status()).then(show);
      });
      fix.addEventListener('click', () => isl.allow().then(show));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); isl.refresh(); } });
      show(s);
      addPlaybackRow(row);
    });
  }

  // settings that only make sense on desktop
  ['btn-hw-accel', 'btn-tray-on-close', 'btn-media-keys'].forEach((id) => {
    const row = document.getElementById(id) && document.getElementById(id).closest('.setting-item');
    if (row) row.style.display = 'none';
  });
})();

// a write to the phone's storage failed (usually: storage full); say so instead of losing it silently
(() => {
  let last = 0;
  window.addEventListener('muriel:storage-error', () => {
    if (Date.now() - last < 30000 || !window.MurielCore || !window.MurielCore.toast) return;
    last = Date.now();
    window.MurielCore.toast((window.MurielI18n || { T: (x) => x, Tm: (x) => x }).Tm('Could not save to storage. Is your phone full?'), 'error');
  });
})();
