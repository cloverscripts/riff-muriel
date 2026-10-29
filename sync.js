// Muriel sync (free, no account): link your devices with a code or a QR code, and playlists,
// favorites, history, Encore stats, the look of the app and what you're listening to stay the same on all of
// them. There is no Muriel server and no account: every device keeps its own data, and linked devices talk to
// each other directly (WebRTC, encrypted) whenever they're open at the same time. A public PeerJS server only
// introduces them to each other; it never sees the data. Merging (who wins when both changed) is in sync-core.js.
(() => {
  const Core = window.MurielSyncCore;
  if (!Core || !window.localStorage) return;
  // UI language (i18n.js); without it everything stays English
  const I18n = window.MurielI18n || (() => { const f = (s, ...a) => String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] != null ? a[i] : '')); return { T: (s) => s, Tf: f, Tm: f, Th: f, text: (el, s, ...a) => { if (el) el.textContent = f(s, ...a); } }; })();

  const LINK_PAGE = 'https://cloverscripts.github.io/riff-muriel/link.html';
  const DAY = 864e5;
  const LINK_TTL = 5 * 60e3;
  const KEEP_TOMBSTONES = 120 * DAY;
  const CONTINUE_WITHIN = 12 * 3600e3;

  const K = {
    device: 'muriel_sync_device', group: 'muriel_sync_group', members: 'muriel_sync_members', meta: 'muriel_sync_meta',
    listens: 'muriel_sync_listens', np: 'muriel_sync_np', cats: 'muriel_sync_cats', seen: 'muriel_sync_seen',
    dismissed: 'muriel_sync_np_dismissed', invite: 'muriel_sync_invite',
  };

  // ---------- storage ----------
  let applying = false; // writes made by sync itself (not the user) don't count as local changes
  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  const read = (k, fb = null) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } };
  const write = (k, v) => { applying = true; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} finally { applying = false; } };
  const writeRaw = (k, v) => { applying = true; try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} finally { applying = false; } };
  const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

  const platform = (() => { try { return window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'web'; } catch (e) { return 'web'; } })();
  function defaultName() {
    const ua = navigator.userAgent || '';
    if (platform === 'ios') return /iPad/.test(ua) ? 'iPad' : 'iPhone';
    if (platform === 'android') return 'Android phone';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux PC';
    return 'Computer';
  }
  const kind = platform === 'ios' || platform === 'android' ? 'phone' : 'computer';
  let device = read(K.device);
  if (!device || !device.id) { device = { id: hex(16), name: defaultName() }; write(K.device, device); }

  let group = read(K.group); // { id, secret }
  let members = read(K.members, {}); // { deviceId: { name, kind, t, del? } }
  let meta = read(K.meta) || {}; // { lists: { playlists, favorites, albums, artists, history }, settings, listensT }
  let listens = read(K.listens, {}); // other devices' Encore data { deviceId: { t, name, db } }
  let np = read(K.np, {}); // what each device last played { deviceId: { t, name, track, pos, playing } }
  let seen = read(K.seen, {});
  const catsOn = () => ({ library: true, history: true, look: true, continue: true, ...read(K.cats, {}) });

  const active = () => !!group;
  const liveMembers = () => Object.entries(members).filter(([id, m]) => id !== device.id && m && !m.del);

  // ---------- what syncs ----------
  const trackKey = (t) => {
    if (!t) return '';
    const p = t.platform || 'youtube';
    if (t.id) return `${p}:${t.id}`;
    if (t.url) return `${p}:${t.url}`;
    return `${p}:${(t.title || '').trim().toLowerCase()}|${(t.artist || '').trim().toLowerCase()}`;
  };
  // a followed artist is its YouTube Music channel when known (namesakes stay apart), otherwise its name
  const artistKey = (a) => (!a ? '' : a.id ? `id:${a.id}` : a.name ? `name:${String(a.name).trim().toLowerCase()}` : '');
  const LISTS = {
    playlists: { key: 'devsize_playlists', cat: 'library', id: (p) => (p && p.id ? String(p.id) : '') },
    favorites: { key: 'devsize_favorites', cat: 'library', id: trackKey },
    albums: { key: 'muriel_saved_albums', cat: 'library', id: (a) => (a && a.id ? String(a.id) : '') },
    artists: { key: 'muriel_followed_artists', cat: 'library', id: artistKey },
    history: { key: 'devsize_history', cat: 'history', id: (t) => (trackKey(t) ? `${trackKey(t)}@${t.playedAt || 0}` : ''), sort: (a, b) => (b.playedAt || 0) - (a.playedAt || 0), cap: 100 },
  };
  // the look of the app; sizes, volume, folders and anything else that belongs to one device stay local
  const SETTINGS = ['muriel_theme_mode', 'muriel_theme_accent', 'muriel_theme_intensity', 'muriel_theme_brightness', 'muriel_palette_style',
    'muriel_mesh_brightness', 'muriel_mesh_cfg', 'muriel_font', 'muriel_corner_radius', 'muriel_glass_blur', 'muriel_ui_alpha', 'muriel_text_alpha',
    'muriel_cover_bg_brightness', 'devsize_vfx', 'muriel_lyrics_word_style', 'muriel_lyrics_ease', 'muriel_lyrics_speed',
    'muriel_lyrics_gradient_tightness', 'muriel_gradient_tight', 'muriel_wavy_progress', 'muriel_progress_knob', 'muriel_progress_bg',
    'muriel_highlight_buttons', 'muriel_track_art', 'muriel_tr_enabled', 'muriel_tr_lang', 'muriel_tr_auto', 'muriel_crossfade',
    'muriel_icon_pack', 'muriel_adv_intensity_bg', 'muriel_lyrics_source', 'muriel_word_source', 'muriel_track_trims',
    'muriel_blocked_artists', 'muriel_blocked_tracks'];
  const LISTENS_KEY = 'muriel_listens_v1';
  const WATCH = new Map([...Object.entries(LISTS).map(([n, l]) => [l.key, n]), ...SETTINGS.map((k) => [k, 'settings']), [LISTENS_KEY, 'listens']]);

  const listItems = (name) => { const v = read(LISTS[name].key, []); return Array.isArray(v) ? v : []; };
  const settingValues = () => Object.fromEntries(SETTINGS.map((k) => [k, localStorage.getItem(k)]));
  const lists = () => meta.lists || (meta.lists = {});

  function stamp(name) {
    const now = Date.now();
    if (name === 'settings') meta.settings = Core.stampMap(meta.settings || null, settingValues(), now);
    else lists()[name] = Core.pruneMeta(Core.stampList(lists()[name] || null, listItems(name), LISTS[name].id, now), now, KEEP_TOMBSTONES);
  }
  const saveMeta = () => write(K.meta, meta);

  function ownListens() {
    const E = window.MurielEncore;
    const db = E && E.own ? E.own() : read(LISTENS_KEY);
    return db ? { t: meta.listensT || 1, name: device.name, db } : null;
  }

  // the part of this device's state the other side gets; `only` limits it to what just changed
  function snapshot(only) {
    const want = (x) => !only || only.includes(x);
    const cats = catsOn();
    const s = { members };
    for (const [name, l] of Object.entries(LISTS)) {
      if (!cats[l.cat] || !want(name)) continue;
      stamp(name);
      (s.lists || (s.lists = {}))[name] = { items: listItems(name), meta: lists()[name] };
    }
    if (cats.look && want('settings')) { stamp('settings'); s.settings = { values: settingValues(), meta: meta.settings }; }
    if (cats.history && want('listens')) { const mine = ownListens(); s.listens = { ...listens, ...(mine ? { [device.id]: mine } : {}) }; }
    if (cats.continue && want('np')) s.np = np;
    saveMeta();
    return s;
  }

  // ---------- applying what another device sent ----------
  function applyRemote(r) {
    if (!r || typeof r !== 'object') return false;
    let any = false;
    const changedKeys = [];
    if (r.members) {
      const m = Core.mergeById(members, r.members, null);
      if (m.changed) { members = m.value; write(K.members, members); any = true; }
      if (members[device.id] && members[device.id].del) { leaveLocally('This device was unlinked'); return true; }
    }
    const cats = catsOn();
    for (const [name, l] of Object.entries(LISTS)) {
      const theirs = r.lists && r.lists[name];
      if (!theirs || !cats[l.cat]) continue;
      stamp(name);
      const res = Core.mergeList({ items: listItems(name), meta: lists()[name] }, theirs, l.id, { sort: l.sort, cap: l.cap });
      lists()[name] = res.meta;
      if (res.changed) { write(l.key, res.items); changedKeys.push(l.key); }
    }
    if (r.settings && cats.look) {
      stamp('settings');
      const res = Core.mergeMap({ values: settingValues(), meta: meta.settings }, r.settings);
      meta.settings = res.meta;
      res.changedKeys.forEach((k) => { writeRaw(k, res.values[k]); changedKeys.push(k); });
    }
    if (r.listens && cats.history) {
      const res = Core.mergeById(listens, r.listens, device.id);
      if (res.changed) {
        listens = res.value;
        write(K.listens, listens);
        any = true;
        try { window.MurielEncore && window.MurielEncore.refresh && window.MurielEncore.refresh(); } catch (e) {}
      }
    }
    if (r.np && cats.continue) {
      const res = Core.mergeById(np, r.np, device.id);
      if (res.changed) { np = res.value; write(K.np, np); any = true; updateContinue(); }
    }
    saveMeta();
    if (changedKeys.length) {
      any = true;
      try { window.MurielCore && window.MurielCore.reloadFromStorage(changedKeys); } catch (e) { console.warn('[sync] reload', e); }
    }
    if (any) render();
    return any || changedKeys.length > 0;
  }

  // ---------- noticing local changes ----------
  const dirty = new Set();
  let flushTimer = null, listensTimer = null;
  function noteLocal(key) {
    if (!group) return;
    const what = WATCH.get(key);
    if (what === 'listens') {
      meta.listensT = Date.now();
      // Encore saves every few seconds while music plays; the others get it every two minutes
      if (!listensTimer) listensTimer = setTimeout(() => { listensTimer = null; saveMeta(); broadcast(snapshot(['listens'])); }, 120e3);
      return;
    }
    dirty.add(what);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { const only = [...dirty]; dirty.clear(); broadcast(snapshot(only)); }, 400);
  }
  Storage.prototype.setItem = function (key, value) {
    const r = rawSet.call(this, key, value);
    if (!applying && this === window.localStorage && WATCH.has(key)) noteLocal(key);
    return r;
  };
  Storage.prototype.removeItem = function (key) {
    const r = rawRemove.call(this, key);
    if (!applying && this === window.localStorage && WATCH.has(key)) noteLocal(key);
    return r;
  };

  // ---------- connections ----------
  // Peer ids on the public PeerJS server. Only the device with the smaller id dials, so two devices never
  // open two connections to each other.
  const peerId = (id) => `muriel-${id}`;
  const serverOpts = () => ({ debug: 0, ...(read('muriel_sync_server') || {}) });
  let peer = null, peerRetry = null, dialTimer = null;
  const conns = new Map(); // deviceId -> { conn, ok }

  function startPeer() {
    if (peer || !active() || typeof window.Peer !== 'function') return;
    try { peer = new window.Peer(peerId(device.id), serverOpts()); } catch (e) { peer = null; return; }
    peer.on('open', () => { dialAll(); });
    peer.on('connection', (conn) => accept(conn, false));
    peer.on('disconnected', () => { setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch (e) {} }, 3000); });
    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'peer-unavailable') return; // that device just isn't open right now
      if (type === 'unavailable-id' || type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        stopPeer();
        clearTimeout(peerRetry);
        peerRetry = setTimeout(startPeer, type === 'unavailable-id' ? 15000 : 30000);
      }
    });
    clearInterval(dialTimer);
    dialTimer = setInterval(dialAll, 12000);
  }
  function stopPeer() {
    clearInterval(dialTimer);
    dialTimer = null;
    for (const { conn } of conns.values()) try { conn.close(); } catch (e) {}
    conns.clear();
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    render();
  }
  function dialAll() {
    if (!peer || peer.disconnected || document.hidden) return;
    for (const [id] of liveMembers()) {
      if (!(device.id < id)) continue;
      const st = conns.get(id);
      if (st && (st.ok || Date.now() - st.created < 15000)) continue;
      if (st) { try { st.conn.close(); } catch (e) {} conns.delete(id); } // that device wasn't there; try again
      try { accept(peer.connect(peerId(id), { reliable: true }), true, id); } catch (e) {}
    }
  }

  // Both sides prove they hold the group secret before anything else is exchanged.
  function accept(conn, outgoing, expectId) {
    if (!conn || !group) return;
    const nonce = hex(16);
    const st = { conn, ok: false, id: expectId || null, created: Date.now() };
    if (expectId) conns.set(expectId, st);
    const fail = () => { try { conn.close(); } catch (e) {} };
    conn.on('open', () => conn.send({ t: 'hi', id: device.id, nonce, v: 1 }));
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hi') {
        const m = members[msg.id];
        if (m && m.del && msg.nonce && conn.peer === peerId(msg.id)) {
          // it was unlinked while it was away: tell it (proven with the group secret) instead of letting it knock forever
          conn.send({ t: 'bye', mac: Core.sha256(`${group.secret}|${msg.nonce}|bye`) });
          setTimeout(fail, 500);
          return;
        }
        if (!msg.id || msg.id === device.id || !m || conn.peer !== peerId(msg.id) || (expectId && msg.id !== expectId)) return fail();
        if (!outgoing) {
          const old = conns.get(msg.id);
          if (old && old.conn !== conn) try { old.conn.close(); } catch (e) {}
          st.id = msg.id;
          conns.set(msg.id, st);
        }
        conn.send({ t: 'proof', mac: Core.sha256(`${group.secret}|${msg.nonce}|${device.id}`) });
        return;
      }
      if (msg.t === 'proof') {
        if (!st.id || msg.mac !== Core.sha256(`${group.secret}|${nonce}|${st.id}`)) return fail();
        st.ok = true;
        seen[st.id] = Date.now();
        write(K.seen, seen);
        conn.send({ t: 'state', s: snapshot() });
        render();
        return;
      }
      if (msg.t === 'bye' && (st.ok || msg.mac === Core.sha256(`${group.secret}|${nonce}|bye`))) {
        fail();
        leaveLocally('This device was unlinked');
        return;
      }
      if (!st.ok) return;
      seen[st.id] = Date.now();
      if (msg.t === 'state') {
        // pass what was new on to the other linked devices too (three or more devices)
        if (applyRemote(msg.s)) broadcast(snapshot(), st.id);
      } else if (msg.t === 'np') {
        if (applyRemote({ np: msg.np })) broadcast({ np }, st.id);
      } else if (msg.t === 'handoff') {
        const C = window.MurielCore;
        if (C && C.state.isPlaying) { C.togglePlay(); if (C.toast) C.toast(I18n.Tm('Now playing on another device'), 'info'); }
      }
    });
    const gone = () => { if (st.id && conns.get(st.id) === st) conns.delete(st.id); write(K.seen, seen); render(); };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  function broadcast(state, exceptId) {
    if (!state) return;
    for (const [id, st] of conns) if (st.ok && id !== exceptId) try { st.conn.send({ t: 'state', s: state }); } catch (e) {}
  }
  function sendTo(id, msg) { const st = conns.get(id); if (st && st.ok) try { st.conn.send(msg); } catch (e) {} }

  // ---------- linking ----------
  const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const newCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[O]/g, '0').slice(0, 8);
  const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
  let linking = null; // { code, peer, until, timer }

  function ensureGroup() {
    if (group) return;
    group = { id: hex(8), secret: hex(32) };
    members = { [device.id]: { name: device.name, kind, t: Date.now() } };
    write(K.group, group);
    write(K.members, members);
  }

  function startLinking() {
    if (typeof window.Peer !== 'function') return;
    stopLinking();
    ensureGroup();
    startPeer();
    const code = newCode();
    const lp = new window.Peer(`muriel-link-${code.toLowerCase()}`, serverOpts());
    linking = { code, peer: lp, until: Date.now() + LINK_TTL, timer: setTimeout(stopLinking, LINK_TTL), error: '' };
    lp.on('error', (err) => {
      if (!linking || linking.peer !== lp) return;
      if (err && err.type === 'unavailable-id') { startLinking(); return; }
      linking.error = "Couldn't reach the link service. Check your internet connection.";
      render();
    });
    lp.on('connection', (conn) => {
      conn.on('data', (msg) => {
        if (!msg || msg.t !== 'join' || !msg.id || msg.id === device.id) return;
        members = { ...members, [msg.id]: { name: String(msg.name || 'Device').slice(0, 40), kind: msg.kind === 'phone' ? 'phone' : 'computer', t: Date.now() } };
        write(K.members, members);
        conn.send({ t: 'welcome', group, members, from: { id: device.id, name: device.name } });
        toast(I18n.Tm('Linked with {0}', members[msg.id].name));
        setTimeout(() => { stopLinking(); broadcast({ members }); }, 1500);
        [2000, 5000, 9000].forEach((ms) => setTimeout(dialAll, ms)); // the new device needs a moment to come online
      });
    });
    render();
  }
  function stopLinking() {
    if (!linking) return;
    clearTimeout(linking.timer);
    try { linking.peer.destroy(); } catch (e) {}
    linking = null;
    render();
  }

  let joining = null;
  function joinWithCode(raw) {
    const code = cleanCode(raw);
    if (code.length !== 8) { joining = { error: 'The code has 8 letters and numbers, like K7M2-9QXP.' }; render(); return; }
    if (typeof window.Peer !== 'function') return;
    joining = { code, busy: true };
    render();
    const tp = new window.Peer(`muriel-j-${hex(12)}`, serverOpts());
    const done = (error) => { clearTimeout(timer); try { tp.destroy(); } catch (e) {} joining = error ? { code, error } : null; render(); };
    const timer = setTimeout(() => done("No device answered. Check the code, and that Muriel shows it on the other device."), 20000);
    tp.on('error', (err) => done(err && err.type === 'peer-unavailable' ? 'No device is showing that code right now.' : "Couldn't reach the link service. Check your internet connection."));
    tp.on('open', () => {
      const conn = tp.connect(`muriel-link-${code.toLowerCase()}`, { reliable: true });
      conn.on('open', () => conn.send({ t: 'join', id: device.id, name: device.name, kind, v: 1 }));
      conn.on('data', (msg) => {
        if (!msg || msg.t !== 'welcome' || !msg.group || !msg.group.secret) return;
        if (group && group.id !== msg.group.id) leaveLocally();
        group = msg.group;
        members = Core.mergeById(msg.members || {}, { [device.id]: { name: device.name, kind, t: Date.now() } }, null).value;
        // this device takes on the look of the devices it joins (if the theme syncs), so linking never
        // swaps someone's theme at random: dated before everything there, its own look loses the first merge
        if (!meta.settings) { meta.settings = Core.stampMap(null, settingValues(), Date.now(), 0); saveMeta(); }
        write(K.group, group);
        write(K.members, members);
        toast(msg.from && msg.from.name ? I18n.Tm('Linked with {0}', msg.from.name) : I18n.Tm('Linked with your device'));
        wantCode = false;
        done('');
        stopPeer();
        startPeer();
      });
    });
  }

  function unlink(id) {
    if (!members[id]) return;
    sendTo(id, { t: 'bye' });
    members = { ...members, [id]: { ...members[id], del: 1, t: Date.now() } };
    write(K.members, members);
    broadcast({ members });
    const st = conns.get(id);
    if (st) setTimeout(() => { try { st.conn.close(); } catch (e) {} }, 500);
    render();
  }
  function leave() {
    if (!group) return;
    members = { ...members, [device.id]: { ...(members[device.id] || { name: device.name, kind }), del: 1, t: Date.now() } };
    broadcast({ members });
    setTimeout(() => leaveLocally('This device left sync'), 600);
  }
  // keeps the music, playlists and everything else on this device; only the link is gone
  function leaveLocally(msg) {
    stopLinking();
    stopPeer();
    group = null; members = {}; meta = {}; listens = {}; np = {};
    [K.group, K.members, K.meta, K.listens, K.np, K.seen].forEach((k) => { try { rawRemove.call(localStorage, k); } catch (e) {} });
    try { window.MurielEncore && window.MurielEncore.refresh && window.MurielEncore.refresh(); } catch (e) {}
    updateContinue();
    if (msg) toast(I18n.Tm(msg));
    render();
  }

  // ---------- continue listening ----------
  const trackInfo = (t) => (t ? { id: t.id, title: t.title, artist: t.artist, album: t.album, thumbnail: t.thumbnail, platform: t.platform, url: t.url, duration: t.duration } : null);
  let npTimer = null, lastNpSent = 0;
  function publishNp(force) {
    const C = window.MurielCore;
    if (!group || !catsOn().continue || !C || !C.state.currentTrack) return;
    const now = Date.now();
    if (!force && now - lastNpSent < 15000) return;
    lastNpSent = now;
    np = { ...np, [device.id]: { t: now, name: device.name, track: trackInfo(C.state.currentTrack), pos: Math.floor(C.audio.currentTime || 0), playing: !!C.state.isPlaying } };
    write(K.np, np);
    for (const [id, st] of conns) if (st.ok) try { st.conn.send({ t: 'np', np: { [device.id]: np[device.id] } }); } catch (e) {}
    updateContinue();
  }

  let banner = null;
  function candidate() {
    const C = window.MurielCore;
    if (!group || !catsOn().continue || !C || C.state.isPlaying) return null;
    const mine = np[device.id];
    const dismissed = read(K.dismissed, {});
    let best = null;
    for (const [id, e] of Object.entries(np)) {
      if (id === device.id || !e || !e.track || !members[id] || members[id].del) continue;
      if (Date.now() - e.t > CONTINUE_WITHIN || (mine && mine.t >= e.t) || dismissed[id] === e.t) continue;
      if (!best || e.t > best.e.t) best = { id, e };
    }
    return best;
  }
  function updateContinue() {
    const c = candidate();
    if (!c) { if (banner) { const b = banner; banner = null; b.classList.remove('show'); setTimeout(() => b.remove(), 400); } return; }
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'update-banner sync-continue';
      banner.setAttribute('role', 'status');
      banner.innerHTML = `
        <svg class="update-banner-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <div class="update-banner-text"><b></b><span></span></div>
        <button type="button" class="update-banner-later" data-i18n>Not now</button>
        <button type="button" class="update-banner-go" data-i18n>Play here</button>`;
      document.body.appendChild(banner);
      requestAnimationFrame(() => requestAnimationFrame(() => banner && banner.classList.add('show')));
    }
    const { id, e } = c;
    const live = e.playing && Date.now() - e.t < 60e3;
    I18n.text(banner.querySelector('b'), live ? 'Playing on {0}' : 'Continue from {0}', e.name);
    banner.querySelector('span').textContent = `${e.track.title || I18n.T('Unknown')}${e.track.artist ? ` · ${e.track.artist}` : ''} · ${fmt(e.pos || 0)}`;
    banner.querySelector('.update-banner-later').onclick = () => { write(K.dismissed, { ...read(K.dismissed, {}), [id]: e.t }); updateContinue(); };
    banner.querySelector('.update-banner-go').onclick = () => {
      const C = window.MurielCore;
      const at = (e.pos || 0) + (live ? (Date.now() - e.t) / 1000 : 0);
      write(K.dismissed, { ...read(K.dismissed, {}), [id]: e.t });
      if (live) sendTo(id, { t: 'handoff' });
      C.playTrack(e.track);
      const seekOnce = () => { C.audio.removeEventListener('loadedmetadata', seekOnce); if (at > 3 && (!C.audio.duration || at < C.audio.duration - 5)) C.seek(at); };
      C.audio.addEventListener('loadedmetadata', seekOnce);
      updateContinue();
    };
  }

  // ---------- Settings → Sync ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { try { window.MurielCore && window.MurielCore.toast(m, 'info'); } catch (e) {} };
  // UI language (i18n.js): data-i18n marks Muriel's own words in the HTML below; names only ever go into {0} slots
  // phones hand outside links to the browser; the desktop app opens https links in the default browser
  const openUrl = (u) => { if (platform === 'ios' || platform === 'android') location.href = u; else window.open(u, '_blank'); };
  const qrSvg = (text) => {
    if (typeof window.qrcode !== 'function') return '';
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  const ago = (t) => {
    if (!t) return 'Not synced yet';
    const m = Math.round((Date.now() - t) / 60e3);
    if (m < 1) return 'Synced just now';
    if (m < 60) return `Synced ${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `Synced ${h} h ago` : `Synced ${Math.round(h / 24)} days ago`;
  };
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="12" height="9" rx="1.5"/><path d="M5 17h6"/><rect x="15" y="8" width="7" height="13" rx="1.5"/><path d="M18 18h1"/></svg>';
  const deviceIcon = (k) => (k === 'phone'
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>');

  let section = null;
  function mount() {
    const nav = document.getElementById('settings-nav');
    const about = document.getElementById('settings-section-about');
    if (!nav || !about || section) return;
    const btn = document.createElement('button');
    btn.className = 'settings-nav-btn';
    btn.dataset.cat = 'sync';
    btn.innerHTML = `${ICON}<span data-i18n>Sync</span>`;
    nav.insertBefore(btn, nav.querySelector('[data-cat="storage"]') || nav.querySelector('[data-cat="about"]'));
    section = document.createElement('div');
    section.className = 'settings-section sync-section';
    section.dataset.cat = 'sync';
    about.parentElement.insertBefore(section, about);
    section.addEventListener('click', onClick);
    section.addEventListener('submit', onSubmit);
    render();
  }

  // pieces shared by Settings → Sync and the invite on the home screen
  const linkButtons = () => `<div class="sync-row"><button class="btn-pill-primary" data-act="link" data-i18n>Show a code</button><button class="btn-outline-pill" data-act="want-code" data-i18n>I have a code</button></div>`;
  function linkPanel() {
    const left = Math.max(0, Math.round((linking.until - Date.now()) / 1000));
    return `<div class="sync-pair">
      <div class="sync-qr">${qrSvg(`${LINK_PAGE}#${linking.code}`)}</div>
      <div class="sync-pair-text"><span>${I18n.Th("On your other device open {0}, or scan this with your phone's camera.", `<b>${esc(`${I18n.T('Settings')} → ${I18n.T('Sync')} → ${I18n.T('I have a code')}`)}</b>`)}</span>
      <div class="sync-code">${showCode(linking.code)}</div>
      ${linking.error ? `<span class="sync-note sync-error" data-i18n>${esc(linking.error)}</span>` : `<span class="sync-note" data-countdown data-i18n>Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span>`}
      <div class="sync-row"><button class="btn-outline-pill" data-act="stop-link" data-i18n>Done</button></div></div></div>`;
  }
  function joinForm() {
    const note = joining && joining.error ? `<span class="sync-note sync-error" data-i18n>${esc(joining.error)}</span>`
      : joining && joining.busy ? '<span class="sync-note" data-i18n>Linking…</span>'
        : '<span class="sync-note" data-i18n>Enter the code your other device shows.</span>';
    return `<form class="sync-join">
      <input class="m3-input sync-code-input" placeholder="Code" data-i18n-attr="placeholder" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9">
      <button class="btn-pill-primary" type="submit"${joining && joining.busy ? ' disabled' : ''} data-i18n>Link</button></form>${note}`;
  }
  let wantCode = false; // "I have a code" was tapped

  function render() {
    renderInvite();
    if (!section) return;
    const cats = catsOn();
    const parts = [`<span class="settings-section-title" data-i18n>Sync <span class="sync-badge" data-i18n>New</span></span>`];
    // every profile on this device has its own group (its keys, device id included, are its own: profiles-core.js)
    const prof = window.MurielProfiles;
    const profNote = prof && prof.list().length > 1
      ? `<span>${I18n.Th('This links the profile “{0}”; every profile on this device links its own devices. Open the same profile on the other device before you link.', esc(prof.current().name))}</span>` : '';
    parts.push(`<div class="m3-group"><div class="setting-item"><div class="sync-intro">
      <b data-i18n>Your music on all your devices</b>
      <span data-i18n>Link your phone and computer: playlists, favorites, history, Encore stats and what you're listening to stay the same everywhere. Free, no account. Your data stays on your devices; linked devices talk to each other directly while they're open.</span>
      ${profNote}
    </div></div></div>`);
    if (group) {
      const rows = [`<div class="setting-item sync-device"><span class="sync-dev-icon">${deviceIcon(kind)}</span><div class="sync-dev-text"><b>${esc(device.name)}</b><span data-i18n>This device</span></div></div>`];
      for (const [id, m] of liveMembers()) {
        const on = conns.get(id) && conns.get(id).ok;
        rows.push(`<div class="setting-item sync-device"><span class="sync-dev-icon">${deviceIcon(m.kind)}</span><div class="sync-dev-text"><b>${esc(m.name)}</b><span class="${on ? 'sync-online' : ''}" data-i18n>${on ? 'Connected' : ago(seen[id])}</span></div><button class="btn-outline-pill" data-act="unlink" data-id="${esc(id)}" data-i18n>Unlink</button></div>`);
      }
      parts.push(`<div class="m3-group">${rows.join('')}</div>`);
    }
    const pairing = linking ? linkPanel() : wantCode || (joining && (joining.busy || joining.error)) ? joinForm() : linkButtons();
    parts.push(`<div class="m3-group"><div class="setting-item sync-block">${group && !linking ? '<span class="setting-name" data-i18n>Link another device</span>' : ''}${pairing}</div></div>`);
    const sw = (c, name, hint) => `<div class="setting-item"><div class="setting-item-top" style="align-items:center;"><div style="display:flex;flex-direction:column;gap:2px;"><span class="setting-name" data-i18n>${name}</span><span class="sync-note" data-i18n>${hint}</span></div><button class="effect-switch-btn${cats[c] ? ' active' : ''}" type="button" data-act="cat" data-cat-key="${c}" aria-label="${name}" data-i18n-attr="aria-label"><span class="thumb"></span></button></div></div>`;
    parts.push(`<div class="m3-group">
      ${sw('library', 'Library', 'Playlists, favorites, saved albums and the artists you follow')}
      ${sw('history', 'History and stats', 'Recently played and Encore')}
      ${sw('look', 'Theme', 'Same colors, font and lyrics style on every device')}
      ${sw('continue', 'Continue listening', 'Pick up where another device left off')}
    </div>`);
    if (group) parts.push(`<div class="m3-group"><div class="setting-item sync-block"><div class="sync-row"><button class="btn-outline-pill" data-act="leave" data-i18n>Stop syncing this device</button></div></div></div>`);
    paint(section, parts.join(''));
  }

  // re-renders keep a half-typed code
  function paint(el, html) {
    const typing = document.activeElement && document.activeElement.classList.contains('sync-code-input') && el.contains(document.activeElement) ? document.activeElement.value : null;
    el.innerHTML = html;
    if (typing !== null) { const i = el.querySelector('.sync-code-input'); if (i) { i.value = typing; i.focus(); } }
  }

  // ---------- home screen: "Sync your devices?" ----------
  // asks once (until linked or "Not now"), then whether the theme should follow too, then links
  let inviteStep = 'ask';
  function renderInvite() {
    const box = document.getElementById('section-sync-invite');
    if (!box) return;
    // "Show a code" sets up the group right away: the card stays up while that code is on screen
    const show = (!group && read(K.invite) !== 'dismissed') || (inviteStep === 'pair' && !!linking);
    box.hidden = !show;
    if (!show) { if (box.innerHTML) box.innerHTML = ''; return; }
    let body;
    if (inviteStep === 'theme') {
      body = `<div class="sync-invite-text"><b data-i18n>Keep the same theme on every device?</b><span data-i18n>Colors, font and lyrics style follow you too. You can change this later in Settings → Sync.</span></div>
        <div class="sync-row"><button class="btn-pill-primary" data-act="theme-yes" data-i18n>Yes, sync my theme</button><button class="btn-outline-pill" data-act="theme-no" data-i18n>No, just my music</button></div>`;
    } else if (inviteStep === 'pair') {
      const pairing = linking ? linkPanel() : wantCode || (joining && (joining.busy || joining.error)) ? joinForm() : linkButtons();
      body = `<div class="sync-invite-text"><b data-i18n>Link your other device</b><span data-i18n>Show a code here and enter it on the other device (or scan the QR code with your phone), or enter the code your other device shows.</span></div>${pairing}`;
    } else {
      body = `<div class="sync-invite-text"><b data-i18n>Sync your devices?</b><span data-i18n>Keep playlists, favorites and history the same on your phone and computer. Free, no account.</span></div>
        <div class="sync-row"><button class="btn-pill-primary" data-act="invite-setup" data-i18n>Set up sync</button><button class="btn-outline-pill" data-act="invite-dismiss" data-i18n>Not now</button></div>`;
    }
    paint(box, `<div class="sync-invite"><span class="sync-invite-icon">${ICON}</span><div class="sync-invite-body">${body}</div></div>`);
  }
  function mountInvite() {
    const box = document.getElementById('section-sync-invite');
    if (!box || box._sync) return;
    box._sync = true;
    box.addEventListener('click', onClick);
    box.addEventListener('submit', onSubmit);
    renderInvite();
  }

  function onSubmit(e) {
    e.preventDefault();
    const i = e.target.querySelector('.sync-code-input');
    if (i) joinWithCode(i.value);
  }
  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'link') { wantCode = false; startLinking(); }
    else if (act === 'want-code') {
      const where = b.closest('#section-sync-invite') ? '#section-sync-invite' : '.sync-section';
      wantCode = true; joining = null; render();
      const f = document.querySelector(`${where} .sync-code-input`);
      if (f) f.focus();
    }
    else if (act === 'stop-link') { wantCode = false; stopLinking(); }
    else if (act === 'unlink') { const m = members[b.dataset.id]; if (m && confirm(I18n.Tf('Unlink {0}? Its music stays on it, it just stops syncing.', m.name))) unlink(b.dataset.id); }
    else if (act === 'leave') { if (confirm(I18n.T('Stop syncing this device? Everything stays on it.'))) leave(); }
    else if (act === 'invite-setup') { inviteStep = 'theme'; renderInvite(); }
    else if (act === 'invite-dismiss') { write(K.invite, 'dismissed'); renderInvite(); }
    else if (act === 'theme-yes' || act === 'theme-no') { write(K.cats, { ...read(K.cats, {}), look: act === 'theme-yes' }); inviteStep = 'pair'; render(); }
    else if (act === 'cat') {
      const c = b.dataset.catKey;
      const next = { ...read(K.cats, {}), [c]: !catsOn()[c] };
      write(K.cats, next);
      render();
      if (next[c]) for (const [id] of conns) sendTo(id, { t: 'state', s: snapshot() });
    }
  }

  // ---------- links from the QR code (muriel://link?code=…) ----------
  function handleLink(url) {
    const m = /^muriel:\/\/link\/?\?(?:.*&)?code=([0-9A-Za-z-]+)/.exec(String(url || ''));
    if (!m) return;
    if (window.showSettingsCategory) { const nav = document.getElementById('nav-settings'); if (nav) nav.click(); window.showSettingsCategory('sync'); }
    joinWithCode(m[1]);
  }
  window.addEventListener('muriel:deeplink', (e) => handleLink(e.detail));
  // another language, or its words just came in: the sentences with names in them are built here
  window.addEventListener('muriel:i18n', () => { if (section || document.getElementById('section-sync-invite')) render(); });

  // ---------- start ----------
  function wake() {
    if (document.hidden) return;
    if (active()) { startPeer(); if (peer && peer.disconnected) try { peer.reconnect(); } catch (e) {} dialAll(); }
    updateContinue();
    render();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); else if (group) publishNp(true); });
  window.addEventListener('online', wake);
  setInterval(() => {
    if (!linking) return;
    const left = Math.max(0, Math.round((linking.until - Date.now()) / 1000));
    document.querySelectorAll('[data-countdown]').forEach((c) => { c.textContent = `Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; });
  }, 1000);

  function hook() {
    const C = window.MurielCore;
    if (C && C.audio) {
      window.addEventListener('muriel:track', () => publishNp(true));
      C.audio.addEventListener('playing', () => { publishNp(true); updateContinue(); });
      C.audio.addEventListener('pause', () => publishNp(true));
      C.audio.addEventListener('timeupdate', () => publishNp(false));
    }
    mount();
    mountInvite();
    if (active()) startPeer();
    updateContinue();
  }
  if (window.MurielCore) hook(); else window.addEventListener('muriel:ready', hook, { once: true });

  window.MurielSync = {
    // other devices' Encore data, for encore.js
    listenDbs: () => (catsOn().history ? Object.entries(listens).filter(([id]) => id !== device.id && members[id] && !members[id].del).map(([, e]) => e.db).filter(Boolean) : []),
    status: () => ({ device, group: !!group, members, connected: [...conns].filter(([, s]) => s.ok).map(([id]) => id) }),
    link: startLinking,
    join: joinWithCode,
    handleLink,
    // before switching profiles (profiles.js): leaves the link service now instead of when the page goes
    stop: () => { stopLinking(); stopPeer(); },
  };
})();
