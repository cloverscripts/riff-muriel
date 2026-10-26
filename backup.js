// Playlist files and profile backups, the part you see: "Export as JSON" on a playlist, Settings → Storage
// (export / import playlists, back up / restore this profile), Settings → Integrations → Playlist file and the
// JSON button under "Create playlist". What goes in and what is let back in is in backup-core.js.
// Files are saved with the desktop save dialog, or handed to the share sheet on phones (electronAPI.saveTextFile).
(function () {
  const B = window.MurielBackup;
  if (!B) return;
  const $ = (id) => document.getElementById(id);
  let core = null;
  const toast = (m, kind) => { try { core && core.toast(m, kind || 'info'); } catch (e) {} };
  const P = () => window.MurielProfiles || null;
  const isDevice = (k) => { const p = P(); return p && p.isDevice ? p.isDevice(k) : false; };

  async function appVersion() {
    try { return (window.electronAPI && window.electronAPI.getAppVersion && (await window.electronAPI.getAppVersion())) || ''; } catch (e) { return ''; }
  }

  // desktop: save dialog (main.js); phones: share sheet (mobile/electron-api.js); a plain browser: a download
  async function saveFile(name, text, kind) {
    const api = window.electronAPI;
    if (api && typeof api.saveTextFile === 'function') {
      const r = await api.saveTextFile({ defaultName: name, content: text, kind });
      if (r && r.canceled) return 'canceled';
      if (r && (r.success || r.shared)) return 'saved';
      throw new Error((r && r.error) || "Couldn't save the file");
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return 'saved';
  }

  // ---------- playlist files ----------
  async function exportPlaylists(list, name) {
    const valid = (list || []).filter((p) => p && Array.isArray(p.tracks));
    if (!valid.length) { toast('No playlists to export', 'info'); return; }
    const text = JSON.stringify(B.playlistFile(valid, { appVersion: await appVersion() }), null, 2);
    try {
      if ((await saveFile(name, text, 'playlists')) === 'saved') toast(valid.length === 1 ? `Exported "${valid[0].name}"` : `Exported ${valid.length} playlists`, 'success');
    } catch (e) { toast(e.message || "Couldn't export", 'error'); }
  }

  function exportCurrent() {
    const s = core && core.state;
    const pl = s && s.playlists.find((p) => p.id === s.currentPlaylistId);
    if (pl) exportPlaylists([pl], B.fileName(pl.name || 'playlist', 'json'));
  }

  function exportAll() {
    const s = core && core.state;
    const me = P() ? P().current().name : '';
    exportPlaylists(s ? s.playlists : [], B.fileName(me && P().list().length > 1 ? `muriel-playlists-${me}` : 'muriel-playlists', 'json'));
  }

  function pickPlaylistFiles() {
    const input = $('json-playlist-file-input');
    if (!input) return;
    input.value = '';
    input.click();
  }

  async function importPlaylistFiles(files) {
    if (!files.length || !core) return;
    const found = [];
    for (const f of files.slice(0, 20)) {
      if (f.size > B.LIMITS.fileBytes) { toast(`${f.name} is too big`, 'error'); continue; }
      try { found.push(...B.parsePlaylistFile(await f.text())); } catch (e) {}
    }
    const playlists = found.filter((p) => p.tracks.length);
    if (!playlists.length) { toast('No playlists with songs in that file', 'error'); return; }
    // songs known only by title and artist get looked up first
    const unmatched = playlists.flatMap((p) => p.tracks.filter((t) => t.needsMatch)).slice(0, 2000);
    const matched = new Map();
    if (unmatched.length) {
      toast(`Finding ${unmatched.length} song${unmatched.length === 1 ? '' : 's'} on YouTube…`, 'info');
      // one at a time per worker, so each answer stays with its song (and the playlist keeps its order)
      let next = 0;
      let failures = 0;
      const worker = async () => {
        while (next < unmatched.length && failures < 8) {
          const t = unmatched[next++];
          try {
            const [m] = await core.matchTracks([{ title: t.title, artist: t.artist, duration: t.duration }]);
            if (m) { matched.set(t, m); failures = 0; }
          } catch (e) { failures++; }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failures >= 8) toast("Search isn't answering; songs without a link were left out", 'info');
    }
    let made = 0;
    let songs = 0;
    let missing = 0;
    for (const p of playlists) {
      const tracks = [];
      for (const t of p.tracks) {
        if (!t.needsMatch) { tracks.push(t); continue; }
        const m = matched.get(t);
        if (m) tracks.push(m); else missing++;
      }
      if (!tracks.length) continue;
      if (core.importPlaylist(p.name, tracks, { cover: p.cover, description: p.description })) { made++; songs += tracks.length; }
    }
    if (!made) { toast('None of those songs could be found', 'error'); return; }
    const create = $('create-playlist-modal');
    if (create && create.classList.contains('visible')) core.closeModal(create);
    toast(`Imported ${made} playlist${made === 1 ? '' : 's'} (${songs} songs)${missing ? `, ${missing} not found` : ''}`, 'success');
  }

  // ---------- backups ----------
  function ownEntries() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out.push([k, localStorage.getItem(k)]);
      }
    } catch (e) {}
    return out;
  }

  async function exportBackup() {
    if (!core) return;
    const me = P() ? P().current() : { name: '' };
    const data = B.makeBackup(ownEntries(), { profileName: me.name, appVersion: await appVersion(), isDevice });
    const day = new Date().toISOString().slice(0, 10);
    try {
      if ((await saveFile(B.fileName(`muriel-backup-${me.name || 'profile'}-${day}`, 'json'), JSON.stringify(data), 'backup')) === 'saved') toast('Backup saved', 'success');
    } catch (e) { toast(e.message || "Couldn't save the backup", 'error'); }
  }

  function pickBackupFile() {
    const input = $('account-file-input');
    if (!input) return;
    input.value = '';
    input.click();
  }

  async function restoreBackup(file) {
    if (!file || !core) return;
    let backup;
    try {
      if (file.size > B.LIMITS.fileBytes) throw new Error('That file is too big');
      backup = B.readBackup(await B.parseBackupFile(new Uint8Array(await file.arrayBuffer())), { isDevice });
    } catch (e) { toast(e.message || "Couldn't read that file", 'error'); return; }
    const c = backup.counts;
    if (!c.keys) { toast('That backup has nothing Muriel can restore', 'error'); return; }
    const me = P() ? P().current().name : '';
    const what = [`${c.playlists} playlist${c.playlists === 1 ? '' : 's'}`, `${c.favorites} favorite${c.favorites === 1 ? '' : 's'}`];
    const from = backup.source === 'riff' ? 'this Riff account' : (backup.profileName ? `the backup of "${backup.profileName}"` : 'this backup');
    const linked = (() => { try { return !!localStorage.getItem('muriel_sync_group'); } catch (e) { return false; } })();
    const question = `Restore ${from} (${what.join(', ')}) into ${me ? `the profile "${me}"` : 'Muriel'}?`;
    const details = `Its playlists, favorites, history and settings are replaced by the backup's.${linked ? ' Devices this profile syncs with get the restored ones too.' : ''} Muriel restarts afterwards.`;
    // Muriel Glass draws the question as an alert (glass/settings.js); the browser's confirm() otherwise
    const ok = window.MurielGlass && window.MurielGlass.confirm
      ? await window.MurielGlass.confirm({ title: question, message: details, ok: 'Restore', destructive: true })
      : window.confirm(`${question}\n\n${details}`);
    if (!ok) return;
    // stop what would save over the restored keys while the page goes away
    try { if (core.state && core.state.isPlaying) core.togglePlay(); if (core.audio) core.audio.pause(); } catch (e) {}
    try { if (core.state) core.state._queueRestored = false; } catch (e) {}
    try { if (window.MurielSync && window.MurielSync.stop) window.MurielSync.stop(); } catch (e) {}
    const entries = backup.entries;
    const apply = () => {
      for (const [k] of ownEntries()) {
        if (!B.keepOnRestore(k, isDevice) && !(k in entries)) { try { localStorage.removeItem(k); } catch (e) {} }
      }
      for (const [k, v] of Object.entries(entries)) { try { localStorage.setItem(k, v); } catch (e) {} }
    };
    apply();
    const short = Object.entries(entries).filter(([k, v]) => { try { return localStorage.getItem(k) !== v; } catch (e) { return true; } });
    if (short.length) { toast("The storage is full: part of the backup couldn't be restored", 'error'); }
    else toast('Backup restored. Restarting…', 'success');
    // Encore and the queue save on the way out; this runs after them (added last), so the backup wins
    window.addEventListener('pagehide', apply);
    setTimeout(() => location.reload(), 700);
  }

  function hook() {
    core = window.MurielCore;
    if (!core) return;
    const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    on('btn-export-playlist', exportCurrent);
    on('btn-export-all-playlists', exportAll);
    on('btn-import-json-playlists', pickPlaylistFiles);
    on('btn-open-json-import', pickPlaylistFiles);
    on('btn-cpm-json', pickPlaylistFiles);
    on('btn-export-account', exportBackup);
    on('btn-import-account', pickBackupFile);
    const files = $('json-playlist-file-input');
    if (files) files.addEventListener('change', () => { const list = [...(files.files || [])]; files.value = ''; importPlaylistFiles(list); });
    const acc = $('account-file-input');
    if (acc) acc.addEventListener('change', () => { const f = acc.files && acc.files[0]; acc.value = ''; restoreBackup(f); });
    // with several profiles, say whose backup this is
    const hint = $('export-account-hint');
    if (hint && P() && P().list().length > 1) hint.textContent = `${P().current().name}: playlists, favorites, history, Encore and settings in one file`;
  }

  if (window.MurielCore) hook();
  else window.addEventListener('muriel:ready', hook, { once: true });
})();
