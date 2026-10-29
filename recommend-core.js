// Recommendations (#19), the parts that are plain data: reading YouTube Music's radio for a song (its "Up next"
// watch playlist) and Last.fm's similar songs and artists, and keeping blocked and just-played songs out.
// No network: server.js fetches and uses these in My Wave / the Daily Mixes, test/recommend-core.test.js runs them.
(function (root) {
  const lib = typeof module === 'object' && module.exports ? require('./library-pages') : root.MurielLibrary;
  const list = (v) => (Array.isArray(v) ? v : []);
  const VIDEO_ID = /^[\w-]{11}$/;
  const runsText = (r) => list(r && r.runs).map((x) => (x && x.text) || '').join('');

  function parseLength(text) {
    const s = String(text || '').trim();
    if (!/^\d+(:\d{1,2}){1,2}$/.test(s)) return 0;
    return s.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }

  // "(Official Music Video) [4K Remaster]" and the like: not part of the song's name
  const TITLE_NOISE = /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|upgrade|mv|m\/v)\b[^)\]]*[)\]]/gi;
  // talk, not songs
  const NOT_MUSIC = /\b(?:documentary|interview|trailer|reaction|behind the scenes|making of|podcast|full album|live stream)\b/i;
  const fold = (x) => String(x || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  // A video's title often carries its artist ("Radiohead - No Surprises (Official Video)"): the song's own name,
  // and the artist the title names (a re-upload's channel is not the artist).
  function cleanVideoTitle(title, artist) {
    let t = String(title || '').replace(TITLE_NOISE, '').replace(/\s+/g, ' ').trim();
    const given = String(artist || '').replace(/\s*-\s*Topic$/i, '').trim();
    // "OasisVEVO", "Radiohead Official": the channel, named after the artist
    let a = given.replace(/\s*(?:VEVO|Official)$/i, '').trim() || given;
    const same = (x) => !!fold(x) && !!fold(a) && (fold(x) === fold(a) || fold(a).includes(fold(x)) || fold(x).includes(fold(a)));
    // "Artist - Song" (the same artist repeated, as in "Pixies - Pixies - Where Is My Mind?", too)
    for (let i = 0; i < 2; i++) {
      const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (!m) break;
      const left = m[1].trim();
      const right = m[2].trim();
      if (same(left)) t = right;
      else if (same(right)) { t = left; break; } // "In The End - Linkin Park"
      else if (i === 0 && fold(left)) { a = left; t = right; } // a re-upload: the artist the title names
      else break;
    }
    return { title: t.replace(/\s+[-–—]\s+$/, '').trim() || String(title || '').trim(), artist: a, renamed: a !== given };
  }

  // YouTube Music's radio for a song: the `next` call with playlistId RDAMVM<videoId>. Its queue lists the songs
  // YouTube Music would play after this one (the seed itself first). Only songs of a normal length.
  function parseWatchPlaylist(json, seedId) {
    const tabs = (((((json || {}).contents || {}).singleColumnMusicWatchNextResultsRenderer || {}).tabbedRenderer || {})
      .watchNextTabbedResultsRenderer || {}).tabs;
    const panel = (((((list(tabs)[0] || {}).tabRenderer || {}).content || {}).musicQueueRenderer || {}).content || {}).playlistPanelRenderer;
    const items = list(panel && panel.contents);
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const r = (it && it.playlistPanelVideoRenderer)
        || (it && it.playlistPanelVideoWrapperRenderer && it.playlistPanelVideoWrapperRenderer.primaryRenderer
          && it.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer);
      if (!r || !VIDEO_ID.test(r.videoId || '') || r.videoId === seedId || seen.has(r.videoId)) continue;
      const title = runsText(r.title).trim();
      // "Artist & Other • Album • 2019" (or "Artist • 49M views • 227K likes" for a video)
      const runs = list(r.longBylineText && r.longBylineText.runs);
      const cut = runs.findIndex((x) => x && x.text === ' • ');
      const artistRuns = cut === -1 ? runs : runs.slice(0, cut);
      const artist = (artistRuns.map((x) => x.text).join('') || runsText(r.shortBylineText)).replace(/\s*-\s*Topic$/i, '').trim();
      const channel = artistRuns.map((x) => x && x.navigationEndpoint && x.navigationEndpoint.browseEndpoint && x.navigationEndpoint.browseEndpoint.browseId)
        .find((id) => typeof id === 'string' && /^UC[\w-]{22}$/.test(id));
      const duration = parseLength(runsText(r.lengthText));
      if (!title || !artist || (duration && (duration < 30 || duration > 600)) || NOT_MUSIC.test(title)) continue;
      const named = cleanVideoTitle(title, artist);
      const thumbs = list(r.thumbnail && r.thumbnail.thumbnails);
      seen.add(r.videoId);
      out.push({
        id: r.videoId,
        title: named.title,
        artist: named.artist,
        ...(channel && !named.renamed ? { artistId: channel } : {}),
        duration,
        thumbnail: (thumbs.length && thumbs[thumbs.length - 1].url) || `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${r.videoId}`,
        platform: 'youtube',
      });
    }
    return out;
  }

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const one = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []); // Last.fm sends one item as an object

  // track.getSimilar: [{ title, artist, match (0..1), duration }]
  function parseSimilarTracks(json) {
    const items = one(json && json.similartracks && json.similartracks.track);
    return items.map((t) => ({
      title: String((t && t.name) || '').trim(),
      artist: String((t && t.artist && (t.artist.name || t.artist['#text'])) || '').trim(),
      match: Math.max(0, Math.min(1, num(t && t.match))),
      duration: num(t && t.duration),
    })).filter((t) => t.title && t.artist);
  }

  // artist.getSimilar: [{ name, match (0..1) }]
  function parseSimilarArtists(json) {
    return one(json && json.similarartists && json.similarartists.artist)
      .map((a) => ({ name: String((a && a.name) || '').trim(), match: Math.max(0, Math.min(1, num(a && a.match))) }))
      .filter((a) => a.name);
  }

  // artist.getTopTracks: [{ title, artist }]
  function parseTopTracks(json, fallbackArtist = '') {
    return one(json && json.toptracks && json.toptracks.track).map((t) => ({
      title: String((t && t.name) || '').trim(),
      artist: String((t && t.artist && t.artist.name) || fallbackArtist || '').trim(),
    })).filter((t) => t.title && t.artist);
  }

  // Keeps out blocked artists and songs (library-pages.js: "Queen" also blocks "Queen & David Bowie"), songs whose
  // key or id is in `recent` (just played, or recommended a moment ago) and repeats within the list itself.
  // keyOf(track) gives the artist+title key the caller uses everywhere else.
  function dropUnwanted(tracks, { blocks, recentKeys, recentIds, keyOf } = {}) {
    const keys = recentKeys instanceof Set ? recentKeys : new Set(list(recentKeys));
    const ids = recentIds instanceof Set ? recentIds : new Set(list(recentIds));
    const b = { artists: list(blocks && blocks.artists), songs: list(blocks && blocks.songs) };
    const hasBlocks = b.artists.length > 0 || b.songs.length > 0;
    const key = typeof keyOf === 'function' ? keyOf : (t) => `${lib.nameKey(t.artist)}::${lib.nameKey(t.title)}`;
    const seenKeys = new Set();
    const seenIds = new Set();
    const out = [];
    for (const t of list(tracks)) {
      if (!t || !t.title) continue;
      const k = key(t);
      const id = t.id ? String(t.id) : '';
      if ((k && (keys.has(k) || seenKeys.has(k))) || (id && (ids.has(id) || seenIds.has(id)))) continue;
      if (hasBlocks && lib.isTrackBlocked(b, t)) continue;
      if (k) seenKeys.add(k);
      if (id) seenIds.add(id);
      out.push(t);
    }
    return out;
  }

  const api = { parseLength, cleanVideoTitle, parseWatchPlaylist, parseSimilarTracks, parseSimilarArtists, parseTopTracks, dropUnwanted };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurielRecommend = api;
})(typeof window !== 'undefined' ? window : globalThis);
