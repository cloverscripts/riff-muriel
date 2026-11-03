// Artist pages by YouTube Music channel. Several artists can share a name ("NobodyKnows"); their channel id
// (UC…) tells them apart, so tracks from YouTube / YouTube Music keep it as `artistId` and the artist page is
// built from that channel. Only reads innertube answers (WEB_REMIX client); server.js makes the requests.

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;

const channelId = (v) => (CHANNEL_ID.test(String(v || '')) ? String(v) : undefined);
const runsText = (t) => ((t && t.runs) || []).map((r) => r.text).join('').trim();
// case, accents, spaces and punctuation aside (NFKD splits the accents off as marks, which the filter drops)
const fold = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f\u20d0-\u20ff\ufe00-\ufe0f]/g, '').replace(/[^\p{L}\p{N}\p{M}]/gu, '');
// "NobodyKnows", "NOBODYKNOWS - Topic" and "Nobodyknows+" are the same name
const nameKey = (s) => fold(String(s || '').replace(/\s*-\s*Topic$/i, ''));
// "Nevermind (Remastered)" on one service is "Nevermind" on another; iTunes calls singles "Song - Single"
const titleKey = (s) => fold(String(s || '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+(Single|EP)$/i, ''));

// every object under `key`, wherever it sits: YouTube moves shelves around between layouts
function findAll(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const k of Object.keys(node)) {
    if (k === key) out.push(node[k]);
    else findAll(node[k], key, out);
  }
  return out;
}

const playlistLink = (e) => (e && e.browseEndpoint && /^VL/.test(e.browseEndpoint.browseId || '') ? e.browseEndpoint.browseId : '');
const titleLink = (t) => playlistLink(t && t.runs && t.runs[0] && t.runs[0].navigationEndpoint);

const lastThumb = (t) => {
  const list = (t && t.musicThumbnailRenderer && t.musicThumbnailRenderer.thumbnail && t.musicThumbnailRenderer.thumbnail.thumbnails) || [];
  return list.length ? list[list.length - 1].url : '';
};

// the linked artists in a line of runs ("A & B • Album • 3:20"): [{ name, id }]
function artistRuns(runs) {
  return (runs || [])
    .map((r) => ({ name: r.text, id: channelId(r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId) }))
    .filter((a) => a.name && a.id);
}

// "Song • A & B • 1.2B views" -> ["A & B", "1.2B views"]
function segments(runs) {
  const out = [];
  let cur = '';
  for (const r of runs || []) {
    if (r.text === ' • ') { out.push(cur.trim()); cur = ''; } else cur += r.text;
  }
  out.push(cur.trim());
  return out.filter((s) => s && !/^(song|video|artist|single|album|ep)$/i.test(s));
}

const parseDuration = (s) => (/^\d+(:\d{1,2}){1,2}$/.test(String(s || '').trim()) ? String(s).trim().split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : 0);

// "3.35M" subscribers -> 3350000
function shortCount(s) {
  const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  return m ? Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1)) : 0;
}

// the [E] YouTube Music shows next to explicit songs (a row's badges, a card's subtitle badges)
function explicitBadge(r) {
  return [...((r && r.badges) || []), ...((r && r.subtitleBadges) || [])].some((b) => {
    const badge = b && b.musicInlineBadgeRenderer;
    const label = badge && badge.accessibilityData && badge.accessibilityData.accessibilityData && badge.accessibilityData.accessibilityData.label;
    return !!badge && ((badge.icon && badge.icon.iconType === 'MUSIC_EXPLICIT_BADGE') || /explicit/i.test(label || ''));
  });
}

function track(id, title, runs, thumbnail, duration, isExplicit) {
  const artist = artistRuns(runs)[0];
  const out = {
    id,
    title: title || 'untitled',
    artist: segments(runs)[0] || (artist && artist.name) || 'Unknown Artist',
    artistId: artist && artist.id,
    duration,
    thumbnail: (thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`).replace(/=w\d+-h\d+[^&]*$/, '=w544-h544'),
    url: `https://www.youtube.com/watch?v=${id}`,
    platform: 'youtube',
  };
  if (isExplicit) out.isExplicit = true;
  return out;
}

// song rows of an artist page or playlist: title | artists | album, the length in a fixed column
function parseSongRows(json) {
  return findAll(json && json.contents, 'musicResponsiveListItemRenderer').map((r) => {
    const id = r.playlistItemData && r.playlistItemData.videoId;
    if (!VIDEO_ID.test(id || '')) return null;
    const col = (i) => (r.flexColumns && r.flexColumns[i] && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer.text) || {};
    const fixed = r.fixedColumns && r.fixedColumns[0] && r.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
    return track(id, runsText(col(0)), col(1).runs, lastThumb(r.thumbnail), parseDuration(fixed && runsText(fixed.text)), explicitBadge(r));
  }).filter(Boolean);
}

// an artist's YouTube Music page: who it is, its songs and videos, and the titles of its releases
function parseArtistPage(json, id) {
  const h = json && json.header && (json.header.musicImmersiveHeaderRenderer || json.header.musicVisualHeaderRenderer || json.header.musicHeaderRenderer);
  const name = h && runsText(h.title).replace(/\s*-\s*Topic$/i, '');
  if (!name) return null;
  const sub = h.subscriptionButton && h.subscriptionButton.subscribeButtonRenderer;
  const about = findAll(json.contents, 'musicDescriptionShelfRenderer')[0];
  const micro = json.microformat && json.microformat.microformatDataRenderer;
  const square = micro && micro.thumbnail && micro.thumbnail.thumbnails && micro.thumbnail.thumbnails[0] && micro.thumbnail.thumbnails[0].url;
  // the header picture is a wide banner; the same image cropped square makes the avatar
  const avatar = lastThumb(h.foregroundThumbnail) || square || lastThumb(h.thumbnail).replace(/=w\d+-h\d+[^&]*$/, '=w544-h544-p-l90-rj');
  // the banner for the top of the artist page, big enough for a wide window
  const banner = lastThumb(h.thumbnail).replace(/=w\d+-h\d+[^&]*$/, '=w1920-h800-p-l90-rj');
  const subscribers = sub && runsText(sub.subscriberCountText);
  const longSubscribers = sub && (runsText(sub.longSubscriberCountText) || (sub.longSubscriberCountText && sub.longSubscriberCountText.simpleText) || '');

  const songs = parseSongRows(json);
  const cards = findAll(json.contents, 'musicTwoRowItemRenderer');
  const videos = cards.map((r) => {
    const watch = r.navigationEndpoint && r.navigationEndpoint.watchEndpoint;
    return watch && VIDEO_ID.test(watch.videoId || '') ? track(watch.videoId, runsText(r.title), r.subtitle && r.subtitle.runs, '', 0, explicitBadge(r)) : null;
  }).filter(Boolean);
  const releases = cards.filter((r) => {
    const browse = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
    return browse && /^MPRE/.test(browse.browseId || '');
  }).map((r) => runsText(r.title)).filter(Boolean);
  // the "Songs" shelf shows five (the "Videos" one a few, where there are no songs); its title links to the
  // playlist with all of them and their lengths
  const shelf = findAll(json.contents, 'musicShelfRenderer')[0];
  const videoShelf = findAll(json.contents, 'musicCarouselShelfRenderer')
    .find((c) => (c.contents || []).some((x) => x.musicTwoRowItemRenderer && x.musicTwoRowItemRenderer.navigationEndpoint && x.musicTwoRowItemRenderer.navigationEndpoint.watchEndpoint));
  const videoHeader = videoShelf && videoShelf.header && videoShelf.header.musicCarouselShelfBasicHeaderRenderer;
  const playlist = (shelf && (titleLink(shelf.title) || playlistLink(shelf.bottomEndpoint))) || (!songs.length && videoHeader && titleLink(videoHeader.title)) || '';

  // one artist answers to several ids (its YouTube Music page, its YouTube channel): the page's own rows tell
  const key = nameKey(name);
  const ids = [...new Set([id, sub && sub.channelId, ...[...songs, ...videos].filter((t) => t.artistId && nameKey(t.artist) === key).map((t) => t.artistId)].filter((x) => channelId(x)))];

  return {
    id,
    ids,
    name,
    // the first paragraph, like the Wikipedia summary a page by name shows
    bio: (runsText(h.description) || (about ? runsText(about.description) : '')).split(/\n\s*\n/)[0].trim(),
    avatar,
    banner,
    // "2.4M subscribers", for the line under the artist's name
    fans: shortCount(subscribers),
    fansText: longSubscribers || (subscribers ? `${subscribers} subscribers` : ''),
    // an uploader's channel (a lyrics channel, a label) has a plain header and isn't an artist
    isVerified: !!json.header.musicImmersiveHeaderRenderer && shortCount(subscribers) > 30000,
    songs,
    videos,
    releases,
    playlist,
  };
}

// a search with the "Artists" filter: [{ id, name, subtitle, thumbnail }]
function parseArtistResults(json) {
  return findAll(json && json.contents, 'musicResponsiveListItemRenderer').map((r) => {
    const id = channelId(r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId);
    const col = (i) => (r.flexColumns && r.flexColumns[i] && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer.text) || {};
    const name = runsText(col(0));
    if (!id || !name) return null;
    return { id, name, subtitle: segments(col(1).runs).join(' • '), thumbnail: lastThumb(r.thumbnail).replace(/=w\d+-h\d+/, '=w240-h240') };
  }).filter(Boolean);
}

// who a video is credited to on YouTube Music (the uploader, for an ordinary upload)
function parseWatchArtists(json, videoId) {
  const v = findAll(json, 'playlistPanelVideoRenderer').find((p) => p.videoId === videoId);
  return v ? artistRuns(v.longBylineText && v.longBylineText.runs) : [];
}

// the credited artist a track's artist text means: the whole text, or the lead artist of "A & B" / "A feat. B"
function pickArtist(artists, name) {
  const keys = [name, String(name || '').split(/\s*(?:,|&|\bfeat\.|\bft\.|\bfeaturing\b)\s*/i)[0]].map(nameKey).filter(Boolean);
  for (const k of keys) {
    const hit = (artists || []).find((a) => nameKey(a.name) === k);
    if (hit) return hit;
  }
  return null;
}

// how many titles two discographies share
function sharedTitles(a, b) {
  const have = new Set((a || []).map(titleKey).filter(Boolean));
  return new Set((b || []).map(titleKey).filter((k) => have.has(k))).size;
}

module.exports = { CHANNEL_ID, VIDEO_ID, channelId, nameKey, artistRuns, explicitBadge, parseSongRows, parseArtistPage, parseArtistResults, parseWatchArtists, pickArtist, sharedTitles };
