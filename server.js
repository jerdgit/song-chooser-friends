// Song Chooser — a tiny zero-dependency server for a friends-only song ranking game.
// Run: node server.js   (PORT and DATA_DIR env vars are optional)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SONGS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'songs.json'), 'utf8'));
const YEARS = Object.keys(SONGS).map(Number).sort((a, b) => a - b);

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { games: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* fresh start */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

// ---------- helpers ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do { code = Array.from(crypto.randomBytes(5), b => CODE_CHARS[b % CODE_CHARS.length]).join(''); }
  while (db.games[code]);
  return code;
}
const newId = () => crypto.randomBytes(8).toString('hex');
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? headers['Content-Type'] : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Public view of a game: never leak player tokens.
function publicGame(g) {
  const players = {};
  for (const [id, p] of Object.entries(g.players)) players[id] = { name: p.name, joinedAt: p.joinedAt };
  return { code: g.code, name: g.name, years: g.years, createdAt: g.createdAt, players, votes: g.votes };
}

// ---------- preview refresh (used when a stored preview URL stops working) ----------
const previewCache = new Map();
async function lookupPreview(year, rank) {
  const song = (SONGS[year] || []).find(s => s.rank === rank);
  if (!song) return null;
  const key = `${year}|${rank}`;
  const hit = previewCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const artist = song.artist.split(/\s+(?:featuring|feat\.?|with|and|&|x)\s+|,/i)[0];
  const title = song.title.split(' / ')[0];
  let value = null;
  try {
    const u = 'https://itunes.apple.com/search?media=music&entity=song&limit=5&term=' + encodeURIComponent(`${title} ${artist}`);
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const c = (j.results || []).find(x => x.previewUrl);
    if (c) value = { preview: c.previewUrl, art: (c.artworkUrl100 || '').replace('100x100bb', '400x400bb') };
  } catch { /* fall through */ }
  if (!value) {
    try { // Deezer as a backup (its preview links expire, so cache briefly)
      const u = 'https://api.deezer.com/search?limit=5&q=' + encodeURIComponent(`artist:"${artist}" track:"${title}"`);
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const c = (j.data || []).find(x => x.preview);
      if (c) value = { preview: c.preview, art: c.album && c.album.cover_big };
    } catch { /* give up */ }
  }
  previewCache.set(key, { value, expires: Date.now() + (value ? 30 * 60e3 : 5 * 60e3) });
  return value;
}

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'preview' && method === 'GET') {
    const v = await lookupPreview(String(url.searchParams.get('year')), Number(url.searchParams.get('rank')));
    return v ? send(res, 200, v) : send(res, 404, { error: 'No preview found' });
  }

  if (parts[1] !== 'games') return send(res, 404, { error: 'Not found' });

  // POST /api/games  -> create a game
  if (parts.length === 2 && method === 'POST') {
    const body = await readBody(req);
    let start = Number(body.startYear), end = Number(body.endYear);
    if (!YEARS.includes(start) || !YEARS.includes(end)) return send(res, 400, { error: 'Pick years between ' + YEARS[0] + ' and ' + YEARS.at(-1) });
    if (start > end) [start, end] = [end, start];
    const years = YEARS.filter(y => y >= start && y <= end);
    const code = newCode();
    const hostToken = newId();
    db.games[code] = {
      code, name: cleanName(body.name) || 'Song Chooser', years, createdAt: Date.now(),
      hostToken, players: {}, votes: {},
    };
    save();
    return send(res, 201, { code, hostToken });
  }

  const game = db.games[String(parts[2] || '').toUpperCase()];
  if (!game) return send(res, 404, { error: 'Game not found. Double-check the code.' });

  // GET /api/games/:code
  if (parts.length === 3 && method === 'GET') return send(res, 200, publicGame(game));

  // POST /api/games/:code/players  -> join (or re-join by name on a new device)
  if (parts[3] === 'players' && parts.length === 4 && method === 'POST') {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return send(res, 400, { error: 'Enter a name' });
    const existing = Object.entries(game.players).find(([, p]) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return send(res, 200, { playerId: existing[0], token: existing[1].token, rejoined: true });
    if (Object.keys(game.players).length >= 50) return send(res, 400, { error: 'This game is full' });
    const playerId = newId(), token = newId();
    game.players[playerId] = { name, token, joinedAt: Date.now() };
    game.votes[playerId] = {};
    save();
    return send(res, 201, { playerId, token });
  }

  // DELETE /api/games/:code/players/:id  -> host removes a player
  if (parts[3] === 'players' && parts.length === 5 && method === 'DELETE') {
    if (req.headers['x-host-token'] !== game.hostToken) return send(res, 403, { error: 'Only the host can remove players' });
    delete game.players[parts[4]];
    delete game.votes[parts[4]];
    save();
    return send(res, 200, { ok: true });
  }

  // PUT /api/games/:code/votes/:year  body {playerId, token, picks:[rank1st, rank2nd, rank3rd]}
  if (parts[3] === 'votes' && parts.length === 5 && method === 'PUT') {
    const year = Number(parts[4]);
    if (!game.years.includes(year)) return send(res, 400, { error: 'That year is not in this game' });
    const body = await readBody(req);
    const player = game.players[body.playerId];
    if (!player || player.token !== body.token) return send(res, 403, { error: 'Unknown player — please re-join' });
    const picks = (body.picks || []).map(Number);
    const valid = SONGS[year].map(s => s.rank);
    if (picks.length !== 3 || new Set(picks).size !== 3 || !picks.every(p => valid.includes(p)))
      return send(res, 400, { error: 'Pick three different songs' });
    game.votes[body.playerId][year] = picks;
    save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p === '/songs.json' ? 'public, max-age=3600' : 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, 400, { error: e.message || 'Bad request' });
  }
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`Song Chooser running at http://localhost:${PORT}  (data: ${DB_FILE})`));
}
module.exports = { server, SONGS, YEARS };
