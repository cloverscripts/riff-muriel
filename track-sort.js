const TRACK_SORT_MODES = ['manual', 'added-desc', 'added-asc', 'title-asc', 'title-desc', 'artist-asc', 'album-asc', 'duration-asc'];

function compareText(a, b, key) {
  const av = a && typeof a[key] === 'string' ? a[key].trim() : '';
  const bv = b && typeof b[key] === 'string' ? b[key].trim() : '';
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av.localeCompare(bv, undefined, { sensitivity: 'base', numeric: true });
}

// Z to A, still with the songs that have no title at the end
function compareTextDesc(a, b, key) {
  const av = a && typeof a[key] === 'string' ? a[key].trim() : '';
  const bv = b && typeof b[key] === 'string' ? b[key].trim() : '';
  if (!av || !bv) return compareText(a, b, key);
  return bv.localeCompare(av, undefined, { sensitivity: 'base', numeric: true });
}

const addedTime = (t) => (t && typeof t.addedAt === 'number' ? t.addedAt : 0);

function compareNumber(a, b, key) {
  const av = a && Number.isFinite(a[key]) && a[key] > 0 ? a[key] : Infinity;
  const bv = b && Number.isFinite(b[key]) && b[key] > 0 ? b[key] : Infinity;
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function sortTracks(tracks, mode) {
  const list = Array.isArray(tracks) ? tracks.slice() : [];
  if (mode === 'title-asc') return list.sort((a, b) => compareText(a, b, 'title'));
  if (mode === 'title-desc') return list.sort((a, b) => compareTextDesc(a, b, 'title'));
  // albums A to Z; inside an album its track order when known, otherwise the order the songs were added.
  // Songs without an album come last.
  if (mode === 'album-asc') {
    return list.sort((a, b) => compareText(a, b, 'album') || compareNumber(a, b, 'disc') || compareNumber(a, b, 'no') || addedTime(a) - addedTime(b));
  }
  if (mode === 'artist-asc') return list.sort((a, b) => compareText(a, b, 'artist'));
  if (mode === 'duration-asc') return list.sort((a, b) => compareNumber(a, b, 'duration'));
  if (mode !== 'added-desc' && mode !== 'added-asc') return list;
  const dir = mode === 'added-desc' ? -1 : 1;
  return list.sort((a, b) => {
    const at = addedTime(a);
    const bt = addedTime(b);
    if (at === bt) return 0;
    return at < bt ? -dir : dir;
  });
}

function backfillAddedAt(tracks, newestFirst) {
  if (!Array.isArray(tracks)) return tracks;
  const now = Date.now();
  let changed = false;
  const list = tracks.map((t, i) => {
    if (!t || typeof t.addedAt === 'number') return t;
    changed = true;
    return { ...t, addedAt: now - (newestFirst ? i : tracks.length - i) * 1000 };
  });
  return changed ? list : tracks;
}

// Library pages (#19): the Albums tab, the playlists list and the Artists tab. 'custom' is the stored order
// (saved / followed newest first, playlists in the order they were dragged to). Ties keep that order.
const LIBRARY_SORT_MODES = {
  albums: ['custom', 'title-asc', 'artist-asc', 'year-desc'],
  playlists: ['custom', 'name-asc', 'name-desc', 'size-desc'],
  artists: ['custom', 'name-asc', 'plays-desc'],
};

function librarySortMode(kind, mode) {
  const modes = LIBRARY_SORT_MODES[kind] || ['custom'];
  return modes.includes(mode) ? mode : 'custom';
}

// plays: (item) => number, for 'plays-desc' (the app counts them from the listening history)
function sortLibrary(kind, items, mode, { plays } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const m = librarySortMode(kind, mode);
  if (m === 'custom') return list;
  const indexed = list.map((item, i) => ({ item, i }));
  const tie = (a, b) => a.i - b.i;
  let cmp;
  if (m === 'title-asc') cmp = (a, b) => compareText(a.item, b.item, 'title') || compareText(a.item, b.item, 'artist');
  else if (m === 'artist-asc') cmp = (a, b) => compareText(a.item, b.item, 'artist') || compareText(a.item, b.item, 'title');
  else if (m === 'year-desc') {
    const year = (x) => { const y = parseInt(String((x && x.year) || ''), 10); return Number.isFinite(y) ? y : -Infinity; };
    cmp = (a, b) => year(b.item) - year(a.item) || compareText(a.item, b.item, 'title');
  } else if (m === 'name-asc') cmp = (a, b) => compareText(a.item, b.item, 'name');
  else if (m === 'name-desc') cmp = (a, b) => compareTextDesc(a.item, b.item, 'name');
  else if (m === 'size-desc') {
    const size = (x) => (x && Array.isArray(x.tracks) ? x.tracks.length : 0);
    cmp = (a, b) => size(b.item) - size(a.item) || compareText(a.item, b.item, 'name');
  } else if (m === 'plays-desc') {
    const count = typeof plays === 'function' ? plays : () => 0;
    const n = new Map(indexed.map((e) => [e, Number(count(e.item)) || 0]));
    cmp = (a, b) => n.get(b) - n.get(a) || compareText(a.item, b.item, 'name');
  }
  return indexed.sort((a, b) => cmp(a, b) || tie(a, b)).map((e) => e.item);
}

// Favourites (#10): the same song reaches the heart from several places with different ids: an album row has an
// id made from the album ("<albumId>_1_3", no platform), the player bar the YouTube video it resolved to, a
// YouTube Music search 'ytmusic' or no platform at all. favoriteTrackKey() makes the id comparable; isSameSong() also
// matches the same title and artist (and a close length) across sources.
const TS_YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function tsYoutubeIdOf(t) {
  if (!t) return '';
  const id = String(t.id || t.videoId || '').replace(/^(?:yt|youtube|ytm|ytmusic):/i, '');
  if (TS_YT_VIDEO_ID.test(id)) return id;
  const url = String(t.url || '');
  const m = url.match(/^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

function favoriteTrackKey(t) {
  if (!t) return '';
  const platform = String(t.platform || '').toLowerCase();
  if (!platform || platform === 'youtube' || platform === 'ytmusic' || platform === 'yt') {
    const yt = tsYoutubeIdOf(t);
    if (yt) return `youtube:${yt}`;
  }
  const p = platform === 'ytmusic' || platform === 'yt' || !platform ? 'youtube' : platform;
  if (t.id) return `${p}:${String(t.id).replace(/^(?:yt|youtube|ytm|ytmusic|sc|soundcloud):/i, '')}`;
  if (t.url) return `${p}:${t.url}`;
  return `${p}:${tsSongKey(t)}|${Math.round(Number(t.duration) || 0)}`;
}

const TS_TITLE_NOISE = /\s*[([](?:[^)\]]*\b(?:official|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|explicit|clean|mv|m\/v)\b[^)\]]*)[)\]]/gi;
function tsNormTitle(s) {
  return String(s || '').replace(TS_TITLE_NOISE, '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+-\s+(?:official|audio|video|lyrics?).*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function tsNormArtist(s) {
  const first = String(s || '').replace(/\s*-\s*topic$/i, '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b|;)\s*/i)[0];
  return tsNormTitle(first);
}
function tsSongKey(t) { return t ? `${tsNormTitle(t.title)}|${tsNormArtist(t.artist)}` : ''; }

function isSameSong(a, b) {
  if (!a || !b) return false;
  if (favoriteTrackKey(a) === favoriteTrackKey(b)) return true;
  const pa = String(a.platform || '').toLowerCase(), pb = String(b.platform || '').toLowerCase();
  if (pa === 'local' || pb === 'local') return false;
  const ka = tsSongKey(a);
  if (!tsNormTitle(a.title) || !tsNormArtist(a.artist) || ka !== tsSongKey(b)) return false;
  const da = Number(a.duration) || 0, db = Number(b.duration) || 0;
  return !(da > 0 && db > 0 && Math.abs(da - db) > 6);
}

// keeps the first copy of every song (favourites are newest first, so the newest heart wins)
function dedupeFavoriteTracks(tracks) {
  if (!Array.isArray(tracks)) return tracks;
  const out = [];
  const keys = new Set();
  const bySong = new Map();
  for (const t of tracks) {
    if (!t) continue;
    const k = favoriteTrackKey(t);
    const sk = tsSongKey(t);
    const same = bySong.get(sk) || [];
    if (keys.has(k) || same.some((o) => isSameSong(o, t))) continue;
    keys.add(k);
    same.push(t);
    bySong.set(sk, same);
    out.push(t);
  }
  return out.length === tracks.length ? tracks : out;
}

if (typeof module !== 'undefined') module.exports = { TRACK_SORT_MODES, LIBRARY_SORT_MODES, librarySortMode, sortLibrary, sortTracks, backfillAddedAt, favoriteTrackKey, isSameSong, dedupeFavoriteTracks };
