// Muriel Glass: behaviour for Settings and the overlays (see glass/DESIGN.md and glass/settings.css).
//  - the accent color setting drives --g-user-accent (the Liquid Glass accent; pink when none is picked)
//  - grouped lists know their first/last visible row and hide a group (with its header) that has none
//  - the settings pane shows the section's name; on phones Settings is a list you drill into (iOS style)
//  - phone sheets close with a swipe down from their top edge
// Everything here sits on top of app.js: same ids, same handlers, nothing app.js reads is renamed.
(() => {
  'use strict';
  const root = document.documentElement;
  const isPhone = () => root.classList.contains('is-mobile');
  const raf = (fn) => { let q = 0; return () => { if (q) return; q = requestAnimationFrame(() => { q = 0; fn(); }); }; };

  // ---------- accent ----------
  // the Material swatches Muriel offered before map onto the Apple colors that replaced them
  const LEGACY = { '#b69df8': '#BF5AF2', '#7aa7ff': '#0A84FF', '#56c5c5': '#40C8E0', '#6dd58c': '#30D158', '#f5b83d': '#FF9F0A', '#f28b82': '#FF453A', '#f48fb1': '#FF375F', '#6750a4': '' };
  const DEFAULT = '#FF375F';
  const stored = () => {
    let v = '';
    try { v = localStorage.getItem('muriel_theme_accent') || ''; } catch (e) {}
    v = v.trim();
    if (!/^#[0-9a-f]{6}$/i.test(v)) return '';
    const k = v.toLowerCase();
    return k in LEGACY ? LEGACY[k] : v;
  };
  function applyAccent() {
    const want = stored();
    const now = root.style.getPropertyValue('--g-user-accent').trim();
    if (want && now.toLowerCase() !== want.toLowerCase()) root.style.setProperty('--g-user-accent', want);
    else if (!want && now) root.style.removeProperty('--g-user-accent');
    markSwatch();
  }
  function markSwatch() {
    const sw = [...document.querySelectorAll('#view-settings .theme-swatch')];
    if (!sw.length) return;
    const want = (stored() || DEFAULT).toLowerCase();
    // app.js marks the swatch equal to its own stored value; a legacy value or no value marks its Apple color here
    if (sw.some((b) => b.classList.contains('active') && (b.dataset.color || '').toLowerCase() === want)) return;
    const custom = !sw.some((b) => (b.dataset.color || '').toLowerCase() === want);
    sw.forEach((b) => b.classList.toggle('active', !custom && (b.dataset.color || '').toLowerCase() === want));
  }
  // the swatches and the color well (app.js stores the pick first: these run after its handlers),
  // and applyTheme (app.js), which rewrites the palette on the root element
  const accentSoon = raf(applyAccent);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.theme-swatch')) accentSoon(); });
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'settings-custom-color-input') accentSoon(); });
  new MutationObserver(accentSoon).observe(root, { attributes: true, attributeFilter: ['style'] });
  applyAccent();
  // another device's theme (sync.js) comes in through MurielCore.reloadFromStorage
  function hookSync() {
    const core = window.MurielCore;
    if (!core || typeof core.reloadFromStorage !== 'function' || core.reloadFromStorage.__glass) return;
    const reload = core.reloadFromStorage;
    core.reloadFromStorage = function () { const r = reload.apply(this, arguments); accentSoon(); return r; };
    core.reloadFromStorage.__glass = true;
  }

  // ---------- grouped lists ----------
  // a row's own display (retired rows, rows a platform hides, empty rows): independent of whether its section is open
  const shown = (el) => getComputedStyle(el).display !== 'none' && !el.hidden;
  function markGroups() {
    const view = document.getElementById('view-settings');
    if (!view) return;
    view.querySelectorAll('.m3-group').forEach((g) => {
      const rows = [...g.children].filter(shown);
      [...g.children].forEach((r) => { r.classList.toggle('gs-first', r === rows[0]); r.classList.toggle('gs-last', r === rows[rows.length - 1]); });
      const empty = rows.length === 0;
      g.classList.toggle('gs-empty', empty);
      const head = g.previousElementSibling;
      if (head && head.classList.contains('settings-group-title')) head.classList.toggle('gs-empty', empty);
      const foot = g.nextElementSibling;
      if (foot && foot.classList.contains('settings-group-footer')) foot.classList.toggle('gs-empty', empty);
    });
  }
  const markSoon = raf(markGroups);

  // ---------- Settings: section title, phone drill-down ----------
  const NAMES = { interface: 'Interface', theme: 'Theme', tracks: 'Tracks', integrations: 'Integrations', storage: 'Storage', advanced: 'Advanced', profiles: 'Profiles', sync: 'Sync', about: 'About', plugins: 'Plugins' };
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let head = null;
  const currentCat = () => { const b = document.querySelector('#settings-nav .settings-nav-btn.active'); return b ? b.dataset.cat : ''; };
  function setTitle() {
    if (!head) return;
    const cat = currentCat();
    const t = head.querySelector('.gs-pane-title');
    const en = NAMES[cat] || (cat ? cat[0].toUpperCase() + cat.slice(1) : '');
    if (t.dataset.cat !== cat) { t.dataset.cat = cat; t.textContent = en; }
  }
  function mountHead() {
    const pane = document.querySelector('#view-settings .settings-pane');
    if (!pane || head) return;
    head = document.createElement('div');
    head.className = 'gs-pane-head';
    head.innerHTML = `<button type="button" class="gs-back" aria-label="Back to Settings" data-i18n-attr="aria-label">${CHEVRON}<span data-i18n>Settings</span></button><h3 class="gs-pane-title" data-i18n></h3>`;
    pane.prepend(head);
    head.querySelector('.gs-back').addEventListener('click', () => toRoot(true));
    setTitle();
  }
  const view = () => document.getElementById('view-settings');
  function toDetail() {
    const v = view();
    if (!v || !isPhone()) return;
    if (!v.classList.contains('gs-detail')) {
      v.classList.add('gs-detail');
      v.classList.remove('gs-root');
      const sc = document.querySelector('.main-content');
      if (sc) sc.scrollTop = 0;
    }
  }
  function toRoot(animate) {
    const v = view();
    if (!v) return;
    v.classList.remove('gs-detail');
    v.classList.add('gs-root');
    if (animate) { v.classList.add('gs-pop'); setTimeout(() => v.classList.remove('gs-pop'), 400); }
    const sc = document.querySelector('.main-content');
    if (sc) sc.scrollTop = 0;
  }
  // Android's back button (mobile/bridge.js asks first): a section goes back to the list
  window.MurielGlassBack = () => {
    const v = view();
    if (!v || !isPhone() || !v.classList.contains('active') || !v.classList.contains('gs-detail')) return false;
    toRoot(true);
    return true;
  };

  function hookSettings() {
    mountHead();
    const v = view();
    if (!v) return;
    if (!v.classList.contains('gs-detail')) v.classList.add('gs-root');
    const nav = document.getElementById('settings-nav');
    if (nav) {
      nav.addEventListener('click', (e) => { if (e.target.closest('.settings-nav-btn')) { toDetail(); setTitle(); markSoon(); } });
      new MutationObserver(() => { setTitle(); markSoon(); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
    }
    // opening Settings from its tab starts at the list
    const tab = document.getElementById('nav-settings');
    if (tab) tab.addEventListener('click', () => toRoot(false), true);
    // profiles.js and sync.js open a section directly (the profile menu, a sync link): show that section
    const show = window.showSettingsCategory;
    if (typeof show === 'function' && !show.__glass) {
      const wrapped = function (cat) { const r = show.apply(this, arguments); toDetail(); setTitle(); markSoon(); return r; };
      wrapped.__glass = true;
      window.showSettingsCategory = wrapped;
    }
    new MutationObserver(markSoon).observe(v, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    window.addEventListener('resize', markSoon);
    window.addEventListener('muriel:i18n', setTitle);
    markGroups();
  }

  // ---------- phone sheets: swipe down to close ----------
  const CARD = '.dialog-card, .settings-card, .modal-card';
  function closeSheet(modal) {
    const btn = modal.querySelector('[id^="btn-close"], [id^="btn-cancel"], .modal-close');
    if (btn) btn.click();
    else if (window.MurielCore && window.MurielCore.closeModal) window.MurielCore.closeModal(modal);
  }
  let drag = null;
  document.addEventListener('touchstart', (e) => {
    if (!isPhone() || e.touches.length !== 1) return;
    const card = e.target.closest && e.target.closest(CARD);
    const modal = card && card.parentElement;
    if (!modal || !modal.classList.contains('modal-backdrop') || !modal.classList.contains('visible') || card.classList.contains('gs-alert')) return;
    if (e.target.closest('input, textarea, select, .sl, .eq-bands, .capcut-wave-stage, .m3-dropdown-menu')) return;
    const r = card.getBoundingClientRect();
    const y = e.touches[0].clientY;
    // from the grabber and header, or anywhere while the sheet is scrolled to its top
    if (y - r.top > 72 && card.scrollTop > 0) return;
    drag = { card, modal, y0: y, dy: 0, top: card.scrollTop <= 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dy = e.touches[0].clientY - drag.y0;
    if (dy <= 0 || (!drag.top && drag.card.scrollTop > 0)) { drag.dy = 0; drag.card.style.transform = ''; return; }
    drag.dy = dy;
    drag.card.style.transition = 'none';
    drag.card.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!drag) return;
    const { card, modal, dy } = drag;
    drag = null;
    card.style.transition = '';
    card.style.transform = '';
    if (dy > 110) closeSheet(modal);
  });

  // ---------- alerts: a compact Apple alert instead of the browser's confirm() ----------
  // MurielGlass.confirm({ title, message, ok, cancel, destructive }) resolves true or false. profiles.js, sync.js
  // and backup.js use it when it is there, and window.confirm when it is not.
  const T = (s) => (window.MurielI18n && window.MurielI18n.T ? window.MurielI18n.T(s) : s);
  function confirmAlert(o) {
    o = typeof o === 'string' ? { title: o } : (o || {});
    const core = window.MurielCore;
    if (!core || !core.openModal) return Promise.resolve(window.confirm([o.title, o.message].filter(Boolean).join('\n\n')));
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'modal-backdrop hidden gs-alert-backdrop';
      m.setAttribute('role', 'alertdialog');
      m.setAttribute('aria-modal', 'true');
      m.innerHTML = `<div class="dialog-card gs-alert"><h3></h3>${o.message ? '<p></p>' : ''}<div class="dialog-actions">
        <button type="button" class="btn-outline-pill" id="btn-cancel-glass-alert"></button>
        <button type="button" class="btn-pill-primary${o.destructive ? ' gs-destructive' : ''}" id="btn-ok-glass-alert"></button></div></div>`;
      m.querySelector('h3').textContent = o.title || '';
      if (o.message) m.querySelector('p').textContent = o.message;
      m.querySelector('#btn-cancel-glass-alert').textContent = o.cancel || T('Cancel');
      m.querySelector('#btn-ok-glass-alert').textContent = o.ok || T('OK');
      document.body.appendChild(m);
      const prev = document.activeElement;
      let done = false;
      const finish = (yes) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        core.closeModal(m);
        setTimeout(() => m.remove(), 400);
        if (prev && prev.focus) try { prev.focus({ preventScroll: true }); } catch (e) {}
        resolve(yes);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      };
      m.querySelector('#btn-cancel-glass-alert').addEventListener('click', () => finish(false));
      m.querySelector('#btn-ok-glass-alert').addEventListener('click', () => finish(true));
      document.addEventListener('keydown', onKey, true);
      core.openModal(m);
      // the keyboard lands on the safe button (no keyboard on a phone: nothing to focus)
      if (!isPhone()) setTimeout(() => { const b = m.querySelector(o.destructive ? '#btn-cancel-glass-alert' : '#btn-ok-glass-alert'); if (b) b.focus({ preventScroll: true }); }, 60);
    });
  }
  window.MurielGlass = Object.assign(window.MurielGlass || {}, { confirm: confirmAlert });

  // ---------- start ----------
  const start = () => { hookSettings(); hookSync(); applyAccent(); };
  if (window.MurielCore) start(); else window.addEventListener('muriel:ready', start, { once: true });
  if (document.readyState !== 'loading') mountHead(); else document.addEventListener('DOMContentLoaded', mountHead, { once: true });
})();
