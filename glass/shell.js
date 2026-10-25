// Muriel Glass: the app frame's behaviour (see glass/DESIGN.md). Loaded after app.js and the other scripts, before
// DOMContentLoaded, so app.js sees window.MurielGlass when it starts. Everything here works on the elements app.js
// already owns (same ids, same handlers): it only moves a few into place, mirrors state onto <body> for the CSS, and
// turns a few clicks into the clicks app.js expects.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const body = document.body;
  const root = document.documentElement;
  const phone = root.classList.contains('is-mobile');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const player = $('#playbar');
  const panel = $('#right-panel');
  const audio = $('#native-audio');
  const main = $('#main-content');
  if (!player || !panel) return;

  // which phone: iOS owns the volume (hardware buttons), so the volume slider is only shown elsewhere
  try {
    const p = window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform();
    if (p === 'ios' || p === 'android') root.classList.add(`g-${p}`);
  } catch (e) {}

  // ---------- progress: a thin line instead of the drawn wave ----------
  // app.js calls progress() every frame its render loop runs (smooth, follows a drag); when that loop is stopped
  // (paused, phone sheet closed) the audio element's own events keep the line right.
  let lastP = -1;
  let lastHook = 0;
  const setProgress = (p, force) => {
    if (!Number.isFinite(p)) p = 0;
    p = Math.max(0, Math.min(1, p));
    if (!force && Math.abs(p - lastP) < 0.0004) return;
    lastP = p;
    player.style.setProperty('--g-progress', p.toFixed(5));
  };
  window.MurielGlass = {
    progress(p, dragging) {
      lastHook = performance.now();
      player.classList.toggle('g-scrubbing', !!dragging);
      setProgress(p, dragging);
    },
  };
  if (audio) {
    const fromAudio = () => {
      if (performance.now() - lastHook < 300) return;
      // streams without a known length fall back to the song's own duration, as app.js does
      const st = window.MurielCore && window.MurielCore.state;
      const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number((st && st.currentTrack && st.currentTrack.duration) || 0);
      setProgress(d > 0 ? audio.currentTime / d : 0, true);
    };
    ['timeupdate', 'seeked', 'emptied', 'loadedmetadata', 'durationchange'].forEach((t) => audio.addEventListener(t, fromAudio));
  }

  // touch: the seek line takes a finger drag too (app.js listens for the mouse)
  const track = $('#scrubber-track');
  if (track) {
    const fire = (type, t, target) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY, button: 0 }));
    let touching = false;
    track.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touching = true;
      e.preventDefault();
      player.classList.add('g-scrubbing');
      fire('mousedown', e.touches[0], track);
    }, { passive: false });
    track.addEventListener('touchmove', (e) => {
      if (!touching) return;
      e.preventDefault();
      fire('mousemove', e.touches[0], window);
    }, { passive: false });
    const end = (e) => {
      if (!touching) return;
      touching = false;
      player.classList.remove('g-scrubbing');
      fire('mouseup', e.changedTouches[0], window);
    };
    track.addEventListener('touchend', end);
    track.addEventListener('touchcancel', end);
  }

  // ---------- sliders: Apple-style fill (a CSS variable that follows the value, also when app.js sets it) ----------
  const paintSlider = (input) => {
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 1;
    const v = parseFloat(input.value);
    input.style.setProperty('--g-val', `${(((Number.isFinite(v) ? v : 0) - min) / ((max - min) || 1)) * 100}%`);
  };
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  $$('#volume-slider, #tvk-seek-slider').forEach((input) => {
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); paintSlider(this); },
    });
    input.addEventListener('input', () => paintSlider(input));
    paintSlider(input);
  });

  // ---------- clicks that stand in for other buttons ----------
  const drawer = $('#rail-drawer');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g-click]');
    if (!b) return;
    const target = $(b.getAttribute('data-g-click'));
    if (!target) return;
    e.preventDefault();
    target.click();
    // a library row in the phone's Library sheet: the sheet closes once the page is open
    if (drawer && drawer.contains(b) && /^#(nav-|btn-open-encore)/.test(b.getAttribute('data-g-click'))) {
      const close = $('#btn-close-rail-drawer');
      if (close) close.click();
    }
  });
  // the sidebar's counts (favorites, files, albums) say nothing when they are 0
  $$('#sidebar .nav-badge').forEach((b) => {
    const zero = () => b.classList.toggle('g-zero', !b.textContent.trim() || b.textContent.trim() === '0');
    new MutationObserver(zero).observe(b, { childList: true, characterData: true, subtree: true });
    zero();
  });

  // rows for tabs that are switched off in Settings (Albums, My files) go with them
  const mirrors = $$('[data-g-mirror]');
  const syncMirrors = () => mirrors.forEach((m) => { const t = $(m.getAttribute('data-g-mirror')); m.hidden = !t || t.classList.contains('nav-collapsed'); });
  mirrors.forEach((m) => { const t = $(m.getAttribute('data-g-mirror')); if (t) new MutationObserver(syncMirrors).observe(t, { attributes: true, attributeFilter: ['class'] }); });
  syncMirrors();

  // ---------- computers: the playlists live in the sidebar; Settings and the profile avatar sit at its foot ----------
  const list = $('#playlists-list');
  const library = $('#g-library');
  if (!phone && list && library) library.appendChild(list);
  const foot = $('#g-sidebar-foot');
  const settingsNav = $('#nav-settings');
  if (!phone && foot && settingsNav) foot.appendChild(settingsNav);
  // the lyrics tools share one row with the Word/Line button (mobile-ui.js does the same on phones)
  const lyricTools = $('.lyrics-header-actions', panel);
  const toolRow = $('.right-panel-header-actions', panel);
  if (!phone && lyricTools && toolRow) toolRow.prepend(lyricTools);
  const placeProfile = () => {
    const btn = $('#profile-switch');
    if (!btn) return false;
    if (!phone) { const foot = $('#g-sidebar-foot'); if (foot && btn.parentElement !== foot) foot.appendChild(btn); }
    return true;
  };
  if (!placeProfile()) {
    const mo = new MutationObserver(() => { if (placeProfile()) mo.disconnect(); });
    mo.observe(body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
  }

  // sidebar: collapsible to icons (remembered); narrow windows collapse it by themselves until widened again
  const toggle = $('#g-sidebar-toggle');
  const COLLAPSE_KEY = 'muriel_glass_sidebar_collapsed';
  const narrow = window.matchMedia ? window.matchMedia('(max-width: 900px)') : { matches: false };
  const applyCollapse = () => body.classList.toggle('g-sidebar-collapsed', !phone && (store.get(COLLAPSE_KEY) === '1' || narrow.matches));
  applyCollapse();
  if (narrow.addEventListener) narrow.addEventListener('change', applyCollapse);
  if (toggle) toggle.addEventListener('click', () => {
    const on = !body.classList.contains('g-sidebar-collapsed');
    body.classList.toggle('g-sidebar-collapsed', on);
    store.set(COLLAPSE_KEY, on ? '1' : '0');
  });

  // computers: the window buttons go grey while the window is in the background (as on a Mac)
  if (!phone) {
    window.addEventListener('blur', () => body.classList.add('g-window-blurred'));
    window.addEventListener('focus', () => body.classList.remove('g-window-blurred'));
  }

  // a song is loaded (the idle player shows Muriel's star instead of empty text)
  const markTrack = () => body.classList.toggle('g-has-track', !!(window.MurielCore && window.MurielCore.state && window.MurielCore.state.currentTrack));
  window.addEventListener('muriel:track', () => body.classList.add('g-has-track'));
  window.addEventListener('muriel:ready', markTrack);
  // collapsed: the search glyph opens the sidebar and puts you in the field
  const searchIcon = $('#search-icon-btn');
  const searchInput = $('#search-input');
  if (searchIcon && searchInput) searchIcon.addEventListener('click', () => {
    if (!phone && body.classList.contains('g-sidebar-collapsed')) {
      body.classList.remove('g-sidebar-collapsed');
      store.set(COLLAPSE_KEY, '0');
      setTimeout(() => searchInput.focus(), 60);
    }
  });

  // ---------- search ----------
  const searchArea = $('#g-search-area');
  const syncSearching = () => body.classList.toggle('g-searching', !!searchInput && (document.activeElement === searchInput || !!searchInput.value));
  if (searchInput) {
    ['focus', 'blur', 'input'].forEach((t) => searchInput.addEventListener(t, () => setTimeout(syncSearching, t === 'blur' ? 180 : 0)));
  }
  // phones: the round search button opens search over Home; Cancel (or any tab) closes it
  const openSearch = () => {
    const home = $('#nav-discover');
    if (home && !home.classList.contains('active')) home.click();
    body.classList.add('g-search-open');
    if (searchInput) setTimeout(() => searchInput.focus(), 30);
  };
  const closeSearch = (clear) => {
    body.classList.remove('g-search-open');
    if (searchInput) searchInput.blur();
    if (clear) { const c = $('#search-clear-btn'); if (c && !c.classList.contains('hidden')) c.click(); }
    syncSearching();
  };
  const tabSearch = $('#g-tab-search');
  if (tabSearch) tabSearch.addEventListener('click', () => (body.classList.contains('g-search-open') ? closeSearch(false) : openSearch()));
  const cancel = $('#g-search-cancel');
  if (cancel) cancel.addEventListener('click', () => closeSearch(true));
  $$('#sidebar .g-nav-item').forEach((n) => n.addEventListener('click', () => { if (phone && body.classList.contains('g-search-open')) closeSearch(false); }));
  if (searchArea) searchArea.addEventListener('keydown', (e) => { if (e.key === 'Escape' && phone) closeSearch(false); });

  // ---------- views: which page is open (tab bar state, the small title on phones, the playlist row in the sidebar) ----------
  const VIEW_NAMES = { discover: 'Home', favorites: 'Favorites', albums: 'Albums', local: 'My files', history: 'History', settings: 'Settings' };
  const topTitle = $('#g-top-title');
  const libTab = $('#btn-toggle-playlists-drawer');
  const T = (s) => (window.MurielI18n && window.MurielI18n.T ? window.MurielI18n.T(s) : s);
  const currentView = () => { const v = $('#main-content > .content-view.active'); return v ? v.id.replace(/^view-/, '') : 'discover'; };
  const viewTitle = (v) => {
    if (v === 'playlist-detail') return ($('#playlist-detail-title') || {}).textContent || '';
    if (v === 'album') return ($('#album-detail-title') || {}).textContent || '';
    if (v === 'artist') return ($('#artist-profile-name') || {}).textContent || '';
    if (v === 'discover' && body.classList.contains('g-search-open')) return T('Search');
    return T(VIEW_NAMES[v] || '');
  };
  const syncView = () => {
    const v = currentView();
    body.dataset.gView = v;
    if (libTab) libTab.classList.toggle('g-active', ['history', 'albums', 'local', 'playlist-detail', 'album'].includes(v));
    if (topTitle) topTitle.textContent = viewTitle(v).trim();
    if (list) {
      const id = v === 'playlist-detail' && window.MurielCore && window.MurielCore.state ? window.MurielCore.state.currentPlaylistId : null;
      $$('.playlist-item', list).forEach((it) => it.classList.toggle('active', !!id && it.dataset.playlistId === id));
    }
  };
  $$('#main-content > .content-view').forEach((s) => new MutationObserver(syncView).observe(s, { attributes: true, attributeFilter: ['class'] }));
  if (list) new MutationObserver(syncView).observe(list, { childList: true });
  syncView();

  // scrolling: the glass top area (and the small title) appears once the page moves; on phones the tab bar shrinks
  // while scrolling down and comes back on the way up
  if (main) {
    let lastY = 0;
    let ticking = false;
    const onScroll = () => {
      ticking = false;
      const y = main.scrollTop;
      body.classList.toggle('g-scrolled', y > 24);
      if (phone) {
        if (y < 40) body.classList.remove('g-tabbar-min');
        else if (y > lastY + 6) body.classList.add('g-tabbar-min');
        else if (y < lastY - 6) body.classList.remove('g-tabbar-min');
      }
      lastY = y;
    };
    main.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
    // a new page starts with the full tab bar
    let shownView = currentView();
    $$('#main-content > .content-view').forEach((s) => new MutationObserver(() => {
      const v = currentView();
      if (v === shownView) return;
      shownView = v;
      body.classList.remove('g-tabbar-min');
      requestAnimationFrame(onScroll);
    }).observe(s, { attributes: true, attributeFilter: ['class'] }));
  }
  // tapping a tab always brings the tab bar back
  $$('#sidebar button').forEach((b) => b.addEventListener('click', () => body.classList.remove('g-tabbar-min')));

  // ---------- the player's "more" menu ----------
  const moreBtn = $('#g-more-btn');
  const menu = $('#g-more-menu');
  const sleepValue = $('#g-mi-sleep-value');
  const sleepStatus = $('#sleep-timer-status');
  const closeMenu = () => {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    body.classList.remove('g-menu-open');
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  };
  const openMenu = () => {
    if (!menu || !moreBtn) return;
    if (sleepValue && sleepStatus) sleepValue.textContent = sleepStatus.classList.contains('active') ? sleepStatus.textContent.trim() : '';
    menu.hidden = false;
    body.classList.add('g-menu-open');
    moreBtn.setAttribute('aria-expanded', 'true');
    // place it under (computers) or above (phones, Now Playing at the bottom) the button, inside the window
    const r = moreBtn.getBoundingClientRect();
    const pr = player.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const below = r.bottom + 8 + mh < window.innerHeight - 8;
    const left = Math.max(8 - pr.left, Math.min(r.right - pr.left - mw, window.innerWidth - 8 - pr.left - mw));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = below ? `${Math.round(r.bottom - pr.top + 8)}px` : `${Math.round(r.top - pr.top - mh - 8)}px`;
    menu.classList.toggle('g-from-top', below);
    const first = $('.g-menu-item:not([hidden])', menu);
    if (first) first.focus({ preventScroll: true });
  };
  if (moreBtn && menu) {
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
    menu.addEventListener('click', (e) => { if (e.target.closest('.g-menu-item')) setTimeout(closeMenu, 0); });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
  }
  // sleep timer: the Audio dialog, on its Sleep tab
  const sleepItem = $('#g-mi-sleep');
  if (sleepItem) sleepItem.addEventListener('click', () => {
    const open = $('#btn-open-settings');
    if (open) open.click();
    setTimeout(() => { const tab = $('.audio-tab[data-audio-tab="sleep"]'); if (tab) tab.click(); }, 0);
  });

  // ---------- Now Playing ----------
  const openPanel = () => { if (panel.classList.contains('hidden')) { const b = $('#btn-toggle-lyrics-panel'); if (b) b.click(); } };
  const closePanel = () => { const b = $('#btn-close-right-panel'); if (b && !panel.classList.contains('hidden')) b.click(); };
  const tab = (name) => { const t = $(`.drawer-tab[data-drawer-tab="${name}"]`); if (t) t.click(); };
  const activeTab = () => { const t = $('.drawer-tab.active'); return t ? t.dataset.drawerTab : 'now'; };
  let fromSide = false;
  const setFull = (on) => {
    body.classList.toggle('g-np-full', !!on);
    if (!on) body.classList.remove('g-np-nolyrics');
    // the lyrics re-measure their scroll positions for the new size
    window.dispatchEvent(new Event('resize'));
  };
  const syncPanel = () => {
    const open = !panel.classList.contains('hidden');
    body.classList.toggle('g-np-open', open);
    body.classList.toggle('g-np-queue', activeTab() === 'queue');
    body.classList.toggle('g-lyrics-empty', panel.classList.contains('lyrics-empty'));
    if (!open && body.classList.contains('g-np-full')) setFull(false);
    if (!open) body.classList.remove('g-np-lyrics');
  };
  new MutationObserver(syncPanel).observe(panel, { attributes: true, attributeFilter: ['class'] });
  $$('.drawer-tab').forEach((t) => new MutationObserver(syncPanel).observe(t, { attributes: true, attributeFilter: ['class'] }));
  syncPanel();

  // computers: the artwork in the player opens Now Playing over the whole window
  const art = $('#playbar-artwork-wrapper');
  if (art) art.addEventListener('click', (e) => {
    if (body.classList.contains('mini')) return;
    // phones: the mini player's artwork opens the Now Playing sheet, like the rest of the mini player
    if (phone) { if (panel.classList.contains('hidden')) openPanel(); return; }
    e.stopPropagation();
    if (body.classList.contains('g-np-full')) { closeFull(); return; }
    fromSide = !panel.classList.contains('hidden');
    if (!fromSide) openPanel();
    else if (activeTab() !== 'now') tab('now');
    setFull(true);
  });
  const closeFull = () => {
    if (fromSide) { setFull(false); fromSide = false; return; }
    closePanel();
  };
  const expand = $('#g-np-expand');
  if (expand) expand.addEventListener('click', () => { fromSide = true; setFull(true); });
  const collapse = $('#g-np-collapse');
  if (collapse) collapse.addEventListener('click', () => { if (phone) closePanel(); else closeFull(); });

  // the lyrics and queue buttons switch what Now Playing shows while it fills the screen (instead of closing it)
  const lyricsBtn = $('#btn-toggle-lyrics-panel');
  const queueBtn = $('#btn-toggle-queue');
  const bigNowPlaying = () => !panel.classList.contains('hidden') && (phone || body.classList.contains('g-np-full'));
  if (lyricsBtn) lyricsBtn.addEventListener('click', (e) => {
    if (!bigNowPlaying()) return;
    e.stopImmediatePropagation();
    const cls = phone ? 'g-np-lyrics' : 'g-np-nolyrics';
    if (activeTab() !== 'now') { tab('now'); body.classList.toggle(cls, !phone ? false : true); return; }
    body.classList.toggle(cls);
    window.dispatchEvent(new Event('resize'));
  }, true);
  if (queueBtn) queueBtn.addEventListener('click', (e) => {
    if (!bigNowPlaying()) return;
    e.stopImmediatePropagation();
    tab(activeTab() === 'queue' ? 'now' : 'queue');
  }, true);
  const syncToolButtons = () => {
    if (lyricsBtn) lyricsBtn.classList.toggle('g-on', bigNowPlaying() ? (activeTab() === 'now' && (phone ? body.classList.contains('g-np-lyrics') : !body.classList.contains('g-np-nolyrics'))) : lyricsBtn.classList.contains('active'));
    if (queueBtn) queueBtn.classList.toggle('g-on', bigNowPlaying() ? activeTab() === 'queue' : queueBtn.classList.contains('active'));
  };
  new MutationObserver(syncToolButtons).observe(body, { attributes: true, attributeFilter: ['class'] });
  [lyricsBtn, queueBtn].forEach((b) => b && new MutationObserver(syncToolButtons).observe(b, { attributes: true, attributeFilter: ['class'] }));
  syncToolButtons();

  // the artwork, blurred, behind the full-window Now Playing (computers); the sheet uses the cover's colours instead
  const cover = $('#right-panel-cover');
  const backdrop = $('#g-np-backdrop-img');
  if (!phone && cover && backdrop) {
    const copy = () => {
      const src = cover.getAttribute('src') || '';
      if (src && backdrop.getAttribute('src') !== src) backdrop.setAttribute('src', src);
      backdrop.hidden = !src || cover.style.display === 'none';
    };
    new MutationObserver(copy).observe(cover, { attributes: true, attributeFilter: ['src', 'style'] });
    copy();
  }

  // a heart next to the title in Now Playing (phones get theirs from mobile-ui.js)
  const realFav = $('#btn-toggle-fav');
  const favIcon = $('#fav-icon');
  const titleRow = $('.right-panel-title-row', panel);
  if (!phone && realFav && favIcon && titleRow && !$('#np-like')) {
    const like = document.createElement('button');
    like.id = 'g-np-like';
    like.type = 'button';
    like.className = 'g-icon-btn g-np-like';
    like.setAttribute('aria-label', 'Favorite');
    like.setAttribute('data-i18n-attr', 'aria-label');
    like.innerHTML = favIcon.outerHTML.replace('id="fav-icon"', '');
    const mirror = () => { const on = favIcon.getAttribute('fill') === 'currentColor'; like.classList.toggle('on', on); like.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); };
    like.addEventListener('click', () => realFav.click());
    new MutationObserver(mirror).observe(favIcon, { attributes: true, attributeFilter: ['fill'] });
    titleRow.appendChild(like);
    mirror();
  }

  // phones: the controls under the sheet follow it while it is pulled down (mobile-ui.js moves the sheet)
  if (phone) {
    new MutationObserver(() => {
      const t = panel.style.transform;
      body.classList.toggle('g-dragging', !!t);
      player.style.transform = (t && body.classList.contains('np-open')) ? t : '';
    }).observe(panel, { attributes: true, attributeFilter: ['style'] });
  }

  // ---------- the phone's Library sheet: a dimmed backdrop behind it ----------
  if (drawer) {
    const scrim = document.createElement('div');
    scrim.className = 'g-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    drawer.parentElement.insertBefore(scrim, drawer);
    const syncDrawer = () => body.classList.toggle('g-drawer-open', !drawer.classList.contains('hidden'));
    new MutationObserver(syncDrawer).observe(drawer, { attributes: true, attributeFilter: ['class'] });
    syncDrawer();
  }

  // ---------- karaoke: a body class for the CSS ----------
  const tv = $('#tv-karaoke');
  if (tv) {
    const syncTv = () => body.classList.toggle('g-tv-open', !tv.classList.contains('hidden'));
    new MutationObserver(syncTv).observe(tv, { attributes: true, attributeFilter: ['class'] });
    syncTv();
  }
})();
