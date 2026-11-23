// Picks the search result that is the same recording as an imported song (Spotify, Yandex, link imports).
// Used by app.js (browser global) and tests (CommonJS). #18: matching on title words alone took songs of
// other artists with the same title, so the artist now has to match too.

// words that make an upload a different version of the song, unless the imported title has them as well
const MATCH_VERSION_WORDS = ['remix', 'sped up', 'speed up', 'slowed', 'nightcore', 'reverb', '8d', 'bass boosted', 'bass boost',
  'cover', 'flip', 'mashup', 'instrumental', 'karaoke', 'loop', 'bootleg', 'live', 'acoustic', 'tribute', 'piano version',
  'reaction', 'tutorial', 'lesson', 'chords', 'drum cover', 'guitar cover', 'lyrics translation', '1 hour', '10 hours'];
// bracketed bits of a YouTube title that say nothing about the recording
const NOISE_WORDS = 'official|video|music|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|mv|m\\/v|remaster(ed)?(\\s+\\d{4})?|\\d{4}\\s+remaster(ed)?|explicit|clean|color coded|full song';
const NOISE = new RegExp(`\\b(${NOISE_WORDS})\\b`, 'g');
// "(from the film …)" only inside brackets: in a title, "from" is a word ("Letter from America", "From Me to You")
const BRACKET_NOISE = new RegExp(`\\b(${NOISE_WORDS}|from .*)\\b`, 'g');

// Cyrillic spelled in Latin letters, so "Кино" on Spotify meets "Kino" on YouTube
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };

function matchNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[а-яёіїєґ]/g, (c) => CYR[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// "Artist A, Artist B & C feat. D" -> ['artist a', 'artist b', 'c', 'd']
function splitArtists(artist) {
  return String(artist || '')
    .replace(/\s+-\s+topic\s*$/i, '')
    .split(/\s*(?:,|;|\/|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?)\s*/i)
    .map((a) => matchNorm(a.replace(/vevo$/i, '').replace(/\bofficial\b/i, '')))
    .filter(Boolean);
}

function stripFeat(t) {
  return String(t || '').replace(/[([]\s*(feat|ft|with)\.?\s[^)\]]*[)\]]/gi, ' ').replace(/\s(feat|ft)\.?\s.*$/i, ' ');
}

// the song title with the artist prefix, featured artists and "(Official Video)" style noise removed
function cleanTitle(title, artists = []) {
  let t = stripFeat(title);
  t = t.replace(/[([]([^)\]]*)[)\]]/g, (m, inner) => (matchNorm(inner).replace(BRACKET_NOISE, '').trim() ? ` ${inner} ` : ' '));
  // a title that is nothing but such words (Madonna's "Music") stays as it is
  const denoise = (x) => matchNorm(x).replace(NOISE, ' ').replace(/\s+/g, ' ').trim() || matchNorm(x);
  let n = denoise(t);
  // "Artist - Title" uploads
  // split the title with its brackets already cleaned, so "(from Frozen)" and "(Official Video)" are gone here too
  const dash = t.split(/\s[-–—|]\s/);
  if (dash.length > 1) {
    const head = matchNorm(dash[0]);
    if (artists.some((a) => a && (head === a || head.includes(a) || a.includes(head)))) {
      n = denoise(dash.slice(1).join(' '));
    }
  }
  return n;
}

function tokens(s) { return new Set(matchNorm(s).split(' ').filter(Boolean)); }

function titleSimilarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  const ca = [...A].join(''); const cb = [...B].join('');
  if (ca === cb) return 1;
  let hit = 0;
  A.forEach((t) => { if (B.has(t)) hit++; });
  // all of the wanted title's words present ("Yellow" in "Yellow (Live)") is close, but not exact
  const cover = hit / A.size;
  const jac = hit / Math.max(A.size, B.size);
  return Math.max(jac, cover * 0.85);
}

function hasWord(text, word) {
  return new RegExp(`(^| )${word.replace(/ /g, '[ -]?')}( |$)`).test(text);
}
function versionWords(text) {
  const n = matchNorm(text);
  return MATCH_VERSION_WORDS.filter((w) => hasWord(n, w));
}

// how sure we are that the result is by (one of) the wanted artists: 0..1
function artistScore(wanted, result) {
  if (!wanted.length) return 0.5;
  const channel = splitArtists(result.artist || result.uploader || '');
  const compact = (s) => s.replace(/^the /, '').replace(/ /g, '');
  let best = 0;
  for (const w of wanted) {
    for (const c of channel) {
      if (compact(c) === compact(w)) return 1;
      const cc = compact(c); const cw = compact(w);
      // "Coldplay" vs "ColdplayVEVO"/"Coldplay Official" (already trimmed) or "Taylor Swift" vs "TaylorSwiftOfficial"
      if (cw.length >= 4 && (cc.startsWith(cw) || cc.endsWith(cw))) best = Math.max(best, 0.9);
    }
    // re-uploads named "Artist - Title" on someone else's channel
    const titleN = matchNorm(stripFeat(result.title || ''));
    const head = String(result.title || '').split(/\s[-–—|]\s/);
    if (head.length > 1 && splitArtists(head[0]).some((a) => compact(a) === compact(w))) best = Math.max(best, 0.8);
    else if (w.length >= 3 && hasWord(titleN, w)) best = Math.max(best, 0.6);
    // featured artists on the result's title
    if (w.length >= 3 && hasWord(matchNorm(result.title || ''), w)) best = Math.max(best, 0.6);
  }
  return best;
}

// sp: { title, artist, duration (s) }; results: search results { title, artist, duration }
function scoreCandidate(sp, r) {
  const wanted = splitArtists(sp.artist);
  const wantTitle = cleanTitle(sp.title, wanted);
  const gotTitle = cleanTitle(r.title, wanted.concat(splitArtists(r.artist)));
  const tSim = titleSimilarity(wantTitle, gotTitle);
  const aSim = artistScore(wanted, r);
  const want = Number(sp.duration) || 0;
  const got = Number(r.duration) || 0;
  const dDiff = want && got ? Math.abs(want - got) : null;
  let score = tSim * 1.0 + aSim * 1.2;
  if (dDiff !== null) {
    if (dDiff <= 3) score += 0.4;
    else if (dDiff <= 10) score += 0.2;
    else if (dDiff > 30) score -= 0.5;
  }
  const wantVersions = new Set(versionWords(sp.title));
  const extra = versionWords(r.title).filter((w) => !wantVersions.has(w) && !wantTitle.includes(w));
  if (extra.length) score -= 1.0;
  // missing a version the source has (wanted the remix, got the original)
  const missing = [...wantVersions].filter((w) => !hasWord(matchNorm(r.title), w));
  if (missing.length) score -= 0.5;
  const durationClose = dDiff !== null && dDiff <= 5;
  const accept = !extra.length && tSim >= 0.5
    && (aSim >= 0.6 || (!wanted.length && tSim >= 0.8) || (aSim > 0 && durationClose && tSim >= 0.9));
  return { score, accept, tSim, aSim, dDiff };
}

function pickBestMatch(sp, results) {
  let best = null;
  let bestScore = -Infinity;
  for (const r of results || []) {
    if (!r || !r.title) continue;
    const { score, accept } = scoreCandidate(sp, r);
    if (accept && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// search queries for an imported song, best first: main artist + clean title, then all artists + title
function matchQueries(sp) {
  const artists = splitArtists(sp.artist);
  const title = String(stripFeat(sp.title || '')).replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?(\s+\d{4})?.*$/i, '').trim();
  const out = [];
  const add = (q) => { q = String(q || '').replace(/\s+/g, ' ').trim(); if (q && !out.includes(q)) out.push(q); };
  const main = String(sp.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0];
  add(`${main} ${title}`);
  if (artists.length > 1) add(`${title} ${String(sp.artist || '')}`);
  return out;
}

const trackMatch = { matchNorm, splitArtists, cleanTitle, titleSimilarity, artistScore, scoreCandidate, pickBestMatch, matchQueries };
if (typeof module !== 'undefined' && module.exports) module.exports = trackMatch;
if (typeof window !== 'undefined') window.trackMatch = trackMatch;
