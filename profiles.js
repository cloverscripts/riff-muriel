// Profiles, the part you see: the avatar in the top bar (tap it to switch) and Settings → Profiles (add, rename,
// delete). Which keys belong to a profile and how localStorage keeps them apart is in profiles-core.js. Switching
// stops the music and reloads the app, so everything in memory starts fresh with the other profile's things.
(() => {
  const P = window.MurielProfiles;
  if (!P) return;

  const EMOJI = ['', '🎧', '🎸', '🎹', '🎤', '🥁', '🦊', '🐱', '🐼', '🌙', '⭐', '🔥', '🌈', '🍀'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, kind) => { try { window.MurielCore && window.MurielCore.toast(m, kind || 'info'); } catch (e) {} };
  // UI language (i18n.js): data-i18n marks Muriel's own words in the HTML below; profile names only go into {0} slots
  const I18n = window.MurielI18n || (() => { const f = (s, ...a) => String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] != null ? a[i] : '')); return { T: (s) => s, Tf: f, Tm: f, Th: f, text: (el, s, ...a) => { if (el) el.textContent = f(s, ...a); } }; })();
  const initial = (name) => (Array.from(String(name || '').trim())[0] || '?').toUpperCase();
  // dark letters on light colors, white on dark ones
  const inkOn = (hex) => {
    const n = parseInt(String(hex).slice(1), 16) || 0;
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6 ? '#1D1B20' : '#FFFFFF';
  };
  const avatar = (p, size = '') => `<span class="profile-avatar${size ? ` ${size}` : ''}${p.emoji ? ' emoji' : ''}" style="background:${p.color};color:${inkOn(p.color)}" aria-hidden="true">${esc(p.emoji || initial(p.name))}</span>`;
  // '1 playlist' / '{0} playlists', each translated as a whole
  const plural = (n, one, many) => (n === 1 ? I18n.T(`1 ${one}`) : I18n.Tf(`{0} ${many}`, n));

  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const PEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const CHECK = '<svg class="profile-menu-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  // ---------- switching ----------
  function switchTo(id) {
    const target = P.list().find((p) => p.id === id);
    if (!target || id === P.id) return;
    let ok = false;
    try { ok = P.open(id); } catch (e) {}
    if (!ok) { toast(I18n.Tm('Could not switch: the storage is full'), 'error'); return; }
    const C = window.MurielCore;
    try { if (C && C.state && C.state.isPlaying) C.togglePlay(); if (C && C.audio) C.audio.pause(); } catch (e) {}
    // frees this profile's id on the link service right away, so switching back connects without waiting
    try { if (window.MurielSync && window.MurielSync.stop) window.MurielSync.stop(); } catch (e) {}
    closeMenu();
    const curtain = document.createElement('div');
    curtain.className = 'profile-curtain';
    curtain.innerHTML = `${avatar(target, 'xl')}<span>${esc(target.name)}</span>`;
    document.body.appendChild(curtain);
    requestAnimationFrame(() => requestAnimationFrame(() => curtain.classList.add('show')));
    // the queue and Encore save on the way out, into the profile that is still open
    setTimeout(() => location.reload(), 380);
  }

  // ---------- top bar: avatar + switcher ----------
  let menu = null;
  function renderSwitcher() {
    const btn = document.getElementById('profile-switch');
    if (!btn) return;
    const me = P.current();
    const many = P.list().length > 1;
    btn.innerHTML = `${avatar(me)}${many ? `<span class="profile-switch-name">${esc(me.name)}</span>` : ''}`;
    btn.classList.toggle('named', many);
    btn.title = many ? I18n.Tf('{0} · switch profile', me.name) : I18n.T('Profiles');
    btn.setAttribute('aria-label', I18n.Tf('Profile: {0}. Switch profile', me.name));
  }
  function mountSwitcher() {
    const bar = document.getElementById('titlebar');
    if (!bar || document.getElementById('profile-switch')) return;
    const btn = document.createElement('button');
    btn.id = 'profile-switch';
    btn.type = 'button';
    btn.className = 'profile-switch';
    btn.setAttribute('aria-haspopup', 'menu');
    bar.insertBefore(btn, bar.querySelector('.titlebar-controls'));
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu) closeMenu(); else openMenu(); });
    renderSwitcher();
  }

  function openMenu() {
    const btn = document.getElementById('profile-switch');
    if (!btn) return;
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'profile-menu';
    menu.setAttribute('role', 'menu');
    const rows = P.list().map((p) => `<button type="button" class="profile-menu-item${p.id === P.id ? ' current' : ''}" role="menuitem" data-id="${esc(p.id)}">${avatar(p)}<span class="profile-menu-name">${esc(p.name)}</span>${p.id === P.id ? CHECK : ''}</button>`);
    menu.innerHTML = `<div class="profile-menu-head">${I18n.Th('Profiles')}</div>${rows.join('')}<div class="profile-menu-sep"></div>
      <button type="button" class="profile-menu-item" role="menuitem" data-act="add"><span class="profile-menu-icon">${PLUS}</span><span class="profile-menu-name">${I18n.Th('Add profile')}</span></button>
      <button type="button" class="profile-menu-item" role="menuitem" data-act="manage"><span class="profile-menu-icon">${ICON}</span><span class="profile-menu-name">${I18n.Th('Manage profiles')}</span></button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    btn.setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('.profile-menu-item');
      if (!b) return;
      if (b.dataset.id) { if (b.dataset.id === P.id) closeMenu(); else switchTo(b.dataset.id); }
      else { closeMenu(); openSettings(b.dataset.act === 'add'); }
    });
    requestAnimationFrame(() => { if (menu) menu.classList.add('open'); });
    const first = menu.querySelector('.profile-menu-item:not(.current)') || menu.querySelector('.profile-menu-item');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    const btn = document.getElementById('profile-switch');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);

  function openSettings(add) {
    const nav = document.getElementById('nav-settings');
    if (nav) nav.click();
    if (window.showSettingsCategory) window.showSettingsCategory('profiles');
    if (add) { adding = true; editing = null; draft = null; render(); focusName(); }
  }

  // ---------- Settings → Profiles ----------
  let section = null;
  let adding = false, editing = null, draft = null, fresh = null;

  const count = (id, key) => { try { const v = JSON.parse(P.peek(id, key) || '[]'); return Array.isArray(v) ? v.length : 0; } catch (e) { return 0; } };
  function summary(p) {
    const parts = [];
    const pl = count(p.id, 'devsize_playlists'), fav = count(p.id, 'devsize_favorites');
    if (pl) parts.push(plural(pl, 'playlist', 'playlists'));
    if (fav) parts.push(plural(fav, 'favorite', 'favorites'));
    let linked = 0;
    try { const m = JSON.parse(P.peek(p.id, 'muriel_sync_members') || '{}'); linked = Math.max(0, Object.values(m).filter((x) => x && !x.del).length - 1); } catch (e) {}
    if (linked) parts.push(linked === 1 ? I18n.T('syncs with 1 device') : I18n.Tf('syncs with {0} devices', linked));
    return parts.length ? parts.join(' · ') : I18n.T('Nothing saved yet');
  }

  function form(p) {
    const d = draft || (draft = { name: p ? p.name : '', color: p ? p.color : nextColor(), emoji: p ? p.emoji : '' });
    const shown = { name: d.name || (p ? p.name : I18n.T('New profile')), color: d.color, emoji: d.emoji };
    return `<form class="profile-form" data-id="${p ? esc(p.id) : ''}">
      <div class="profile-form-top">${avatar(shown, 'lg')}
        <input class="profile-name-input" name="name" value="${esc(d.name)}" maxlength="24" placeholder="Name" autocomplete="off" spellcheck="false" aria-label="Profile name" data-i18n-attr="placeholder aria-label">
      </div>
      <div class="profile-picks" aria-label="Color" data-i18n-attr="aria-label">${P.COLORS.map((c) => `<button type="button" class="profile-swatch${c === d.color ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="${esc(I18n.Tf('Color {0}', c))}" aria-pressed="${c === d.color}"></button>`).join('')}</div>
      <div class="profile-picks" aria-label="Picture" data-i18n-attr="aria-label">${EMOJI.map((e) => `<button type="button" class="profile-emoji${e === d.emoji ? ' on' : ''}" data-emoji="${e}" aria-label="${esc(e ? I18n.Tf('Picture {0}', e) : I18n.T('First letter'))}" aria-pressed="${e === d.emoji}">${e || `<span class="profile-emoji-letter">${esc(initial(shown.name))}</span>`}</button>`).join('')}</div>
      <div class="sync-row"><button class="btn-pill-primary" type="submit" data-i18n>${p ? 'Save' : 'Add profile'}</button><button class="btn-outline-pill" type="button" data-act="cancel" data-i18n>Cancel</button></div>
    </form>`;
  }
  const nextColor = () => { const used = new Set(P.list().map((p) => p.color)); return P.COLORS.find((c) => !used.has(c)) || P.COLORS[0]; };
  // the preview follows the name, color and picture without redrawing the form (it would lose the keyboard)
  function refreshPreview(f) {
    const id = f.dataset.id;
    const p = id ? P.list().find((q) => q.id === id) : null;
    const shown = { name: draft.name || (p ? p.name : I18n.T('New profile')), color: draft.color, emoji: draft.emoji };
    const old = f.querySelector('.profile-form-top .profile-avatar');
    if (old) old.outerHTML = avatar(shown, 'lg');
    const letter = f.querySelector('.profile-emoji-letter');
    if (letter) letter.textContent = initial(shown.name);
    f.querySelectorAll('.profile-swatch').forEach((b) => { b.classList.toggle('on', b.dataset.color === draft.color); b.setAttribute('aria-pressed', String(b.dataset.color === draft.color)); });
    f.querySelectorAll('.profile-emoji').forEach((b) => { b.classList.toggle('on', b.dataset.emoji === draft.emoji); b.setAttribute('aria-pressed', String(b.dataset.emoji === draft.emoji)); });
  }
  const focusName = () => { const i = section && section.querySelector('.profile-name-input'); if (i) i.focus(); };

  function render() {
    renderSwitcher();
    if (!section) return;
    const me = P.current();
    const all = P.list();
    const parts = ['<span class="settings-section-title" data-i18n>Profiles</span>'];
    parts.push(`<div class="m3-group"><div class="setting-item"><div class="sync-intro">
      <b data-i18n>A Muriel for everyone who uses this device</b>
      <span data-i18n>Each profile has its own playlists, favorites, history, Encore stats, theme, sound and lyrics settings, and links to its own devices in Sync. Switching profiles restarts Muriel.</span>
    </div></div></div>`);
    const rows = all.map((p) => {
      if (editing === p.id) return `<div class="setting-item profile-row editing">${form(p)}</div>`;
      const open = p.id === me.id;
      const actions = [
        open ? '' : `<button class="btn-pill-primary" type="button" data-act="switch" data-id="${esc(p.id)}" data-i18n>Switch</button>`,
        `<button class="btn-icon-pill" type="button" data-act="edit" data-id="${esc(p.id)}" title="${I18n.Th('Rename')}" aria-label="${esc(I18n.Tf('Rename {0}', p.name))}">${PEN}</button>`,
        open ? '' : `<button class="btn-icon-pill profile-delete" type="button" data-act="delete" data-id="${esc(p.id)}" title="${I18n.Th('Delete')}" aria-label="${esc(I18n.Tf('Delete {0}', p.name))}">${TRASH}</button>`,
      ].join('');
      return `<div class="setting-item profile-row${open ? ' current' : ''}${fresh === p.id ? ' fresh' : ''}">${avatar(p, 'lg')}
        <div class="profile-row-text"><b>${esc(p.name)}</b><span>${open ? `<em>${I18n.Th('Open now')}</em> · ` : ''}${esc(summary(p))}</span></div>
        <div class="profile-row-actions">${actions}</div></div>`;
    });
    parts.push(`<div class="m3-group">${rows.join('')}</div>`);
    parts.push(`<div class="m3-group"><div class="setting-item sync-block">${adding ? form(null) : `<div class="sync-row"><button class="btn-outline-pill" type="button" data-act="add">${PLUS}<span data-i18n>Add profile</span></button></div>`}</div></div>`);
    parts.push(`<div class="m3-group"><div class="setting-item"><span class="sync-note" data-i18n>Shared by every profile on this device: songs kept for offline listening, downloads and your music folder, plus window, tray, media key and performance settings.</span></div></div>`);
    section.innerHTML = parts.join('');
  }

  function onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const f = b.closest('.profile-form');
    if (f && (b.dataset.color || b.dataset.emoji !== undefined) && !b.dataset.act) {
      if (b.dataset.color) draft.color = b.dataset.color;
      else draft.emoji = b.dataset.emoji;
      refreshPreview(f);
      return;
    }
    const act = b.dataset.act;
    const id = b.dataset.id;
    const p = id ? P.list().find((q) => q.id === id) : null;
    if (act === 'switch' && p) switchTo(p.id);
    else if (act === 'add') { adding = true; editing = null; draft = null; render(); focusName(); }
    else if (act === 'edit' && p) { editing = p.id; adding = false; draft = null; render(); focusName(); }
    else if (act === 'cancel') { adding = false; editing = null; draft = null; render(); }
    else if (act === 'delete' && p) {
      ask({ title: I18n.Tf('Delete the profile "{0}"?', p.name), message: I18n.T('Its playlists, favorites, history and settings are removed from this device. Devices it syncs with keep their copy.'), ok: I18n.T('Delete'), destructive: true },
        I18n.Tf('Delete the profile "{0}"? Its playlists, favorites, history and settings are removed from this device. Devices it syncs with keep their copy.', p.name)).then((yes) => {
        if (!yes) return;
        if (P.remove(p.id)) toast(I18n.Tm('Deleted {0}', p.name));
        render();
      });
    }
  }
  // Muriel Glass draws the question as an alert (glass/settings.js); the browser's confirm() otherwise
  const ask = (o, plain) => (window.MurielGlass && window.MurielGlass.confirm ? window.MurielGlass.confirm(o) : Promise.resolve(confirm(plain)));
  function onSubmit(e) {
    e.preventDefault();
    const f = e.target.closest('.profile-form');
    if (!f || !draft) return;
    const name = f.querySelector('.profile-name-input').value;
    try {
      if (f.dataset.id) {
        P.update(f.dataset.id, { name, color: draft.color, emoji: draft.emoji });
        editing = null;
      } else {
        const p = P.create({ name, color: draft.color, emoji: draft.emoji });
        adding = false;
        fresh = p.id;
        toast(I18n.Tm('Added {0}', p.name));
      }
    } catch (err) { toast(I18n.Tm('Could not save: the storage is full'), 'error'); return; }
    draft = null;
    render();
  }
  function onInput(e) {
    if (!e.target.classList.contains('profile-name-input') || !draft) return;
    draft.name = e.target.value;
    refreshPreview(e.target.closest('.profile-form'));
  }

  function mount() {
    const nav = document.getElementById('settings-nav');
    const about = document.getElementById('settings-section-about');
    if (!nav || !about || section) return;
    const btn = document.createElement('button');
    btn.className = 'settings-nav-btn';
    btn.dataset.cat = 'profiles';
    btn.innerHTML = `${ICON}<span data-i18n>Profiles</span>`;
    nav.insertBefore(btn, nav.querySelector('[data-cat="sync"]') || nav.querySelector('[data-cat="about"]'));
    section = document.createElement('div');
    section.className = 'settings-section profile-section';
    section.dataset.cat = 'profiles';
    about.parentElement.insertBefore(section, about.parentElement.querySelector('.sync-section') || about);
    section.addEventListener('click', onClick);
    section.addEventListener('submit', onSubmit);
    section.addEventListener('input', onInput);
    render();
  }

  mountSwitcher();
  mount();
  // another language, or its words just came in: names and counts are put together here
  window.addEventListener('muriel:i18n', () => { if (!editing && !adding) render(); });
})();
