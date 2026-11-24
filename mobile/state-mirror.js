// Playlists, favorites, history, the queue and settings live in the WebView's localStorage. iOS (and Android)
// write that to disk only now and then: when the phone died (battery out, hard reset), what was saved since
// the last time was lost, and sometimes all of it. This keeps a copy of every profile's keys in a file in
// Muriel's own folder, written within seconds of a change and right away when the app goes to the background,
// and puts it back at launch when localStorage came back older (or empty).
//
// Two files take turns, so one cut off halfway by a power loss still leaves the other. Each copy carries a
// number that goes up with every save; localStorage remembers the number of the copy it matches
// (muriel_state_seq). Saved later than localStorage (a higher number) means localStorage lost something.
const store = require('./shims/store');

const SEQ = 'muriel_state_seq';
const FILES = ['/data/state/library-1.muriel', '/data/state/library-2.muriel'];
const EVERY_MS = 3000;
// rebuilt on their own, big, or not to be put in a file the Files app shows (logins)
const SKIP = new Set([SEQ, 'muriel_debug_log', 'muriel_i18n_snap']);
const SKIP_PREFIXES = ['muriel_secret_', 'muriel_audio_analysis_'];
const kept = (k) => typeof k === 'string' && !SKIP.has(k) && !SKIP_PREFIXES.some((p) => k.startsWith(p));

// localStorage as stored, every profile's keys (profiles-core.js shows the app only the open profile's)
function rawStorage() {
  const P = window.MurielProfiles;
  if (P && P.raw) return P.raw;
  const ls = window.localStorage;
  return {
    get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k),
    keys: () => { const out = []; for (let i = 0; i < ls.length; i++) out.push(ls.key(i)); return out; },
  };
}

function snapshot(raw) {
  const keys = {};
  for (const k of raw.keys().sort()) if (kept(k)) { const v = raw.get(k); if (v != null) keys[k] = v; }
  return keys;
}

async function readCopies() {
  const out = [];
  for (const f of FILES) {
    try {
      const c = JSON.parse(await store.readText(f));
      if (c && c.v === 1 && Number.isFinite(c.seq) && c.keys && typeof c.keys === 'object') out.push(c);
    } catch (e) {} // missing, or cut off halfway
  }
  return out.sort((a, b) => b.seq - a.seq);
}

// the newest copy on disk, when localStorage is older than it; null when there's nothing to put back
function pickRestore(copies, lsSeq) {
  const newest = copies[0];
  return newest && newest.seq > (Number(lsSeq) || 0) ? newest : null;
}

function restore(raw, copy) {
  for (const k of raw.keys()) if (kept(k) && !(k in copy.keys)) raw.remove(k);
  for (const [k, v] of Object.entries(copy.keys)) raw.set(k, String(v));
  raw.set(SEQ, String(copy.seq));
}

function start() {
  if (!store.isNative()) return;
  const raw = rawStorage();
  let ready = false; // nothing is saved before the copy on disk was checked: it could be the only full one
  let seq = 0;
  let lastText = null;
  let timer = null;
  let saving = null;
  let again = false;

  async function save() {
    timer = null;
    if (!ready) return;
    if (saving) { again = true; return saving; }
    const body = JSON.stringify(snapshot(raw));
    if (body === lastText) return;
    const next = Math.max(seq, Number(raw.get(SEQ)) || 0) + 1;
    const text = `{"v":1,"seq":${next},"savedAt":${Date.now()},"keys":${body}}`;
    saving = store.writeText(FILES[next % 2], text)
      .then(() => { seq = next; lastText = body; raw.set(SEQ, String(next)); })
      .catch((e) => console.warn('[state-mirror] save failed', e && e.message))
      .finally(() => { saving = null; if (again) { again = false; schedule(); } });
    return saving;
  }
  const schedule = () => { if (!timer) timer = setTimeout(save, EVERY_MS); };
  const now = () => { clearTimeout(timer); timer = null; save(); };

  // every change the app makes goes through these (also profiles-core.js's and app.js's versions of them)
  const P = Storage.prototype;
  for (const name of ['setItem', 'removeItem', 'clear']) {
    const orig = P[name];
    P[name] = function () { const r = orig.apply(this, arguments); schedule(); return r; };
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) now(); });
  window.addEventListener('pagehide', now);
  try { require('@capacitor/app').App.addListener('pause', now); } catch (e) {}

  readCopies().then((copies) => {
    const copy = pickRestore(copies, raw.get(SEQ));
    let once = false;
    try { once = sessionStorage.getItem('muriel_state_restored') === String(copy && copy.seq); } catch (e) {}
    if (copy && !once) {
      console.warn(`[state-mirror] localStorage is older than the saved copy (${raw.get(SEQ) || 'none'} < ${copy.seq}): restoring`);
      try { sessionStorage.setItem('muriel_state_restored', String(copy.seq)); } catch (e) {}
      try { restore(raw, copy); } catch (e) { console.warn('[state-mirror] restore failed', e && e.message); }
      location.reload(); // app.js read the old storage already
      return;
    }
    seq = copies.length ? copies[0].seq : 0;
    ready = true;
    save(); // the first copy, or one with what changed since the last
  }).catch((e) => { console.warn('[state-mirror] check failed', e && e.message); ready = true; schedule(); });
}

module.exports = start;
module.exports._test = { snapshot, pickRestore, restore, kept };
