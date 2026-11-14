// Song Chooser — a tiny zero-dependency server for a live, play-together song ranking game.
// Run: node server.js   (PORT and DATA_DIR env vars are optional)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ICONS } = require('./public/scoring.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SONGS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'songs.json'), 'utf8'));
const YEARS = Object.keys(SONGS).map(Number).sort((a, b) => a - b);
// After everyone locks in, the year's results show for this long before the whole group moves on.
const REVEAL_MS = Number(process.env.REVEAL_SECONDS || 15) * 1000;

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

// ---------- game flow ----------
// phase: 'lobby' (waiting for the host to start) -> 'picking' (everyone picks for the current year)
//        -> 'reveal' (results for that year, then on to the next year) -> ... -> 'done'
function migrate(g) {
  g.predictions = g.predictions || {};
  if (!g.state) {
    const anyVotes = Object.values(g.votes || {}).some(v => Object.keys(v).length);
    g.state = { phase: anyVotes ? 'done' : 'lobby', yearIndex: 0, revealEndsAt: null };
  }
  const used = new Set();
  for (const p of Object.values(g.players)) {
    if (!p.icon || used.has(p.icon)) p.icon = ICONS.find(i => !used.has(i));
    used.add(p.icon);
  }
  return g;
}
for (const g of Object.values(db.games)) migrate(g);

const currentYear = g => g.years[g.state.yearIndex];
const hasLocked = (g, id) => !!(g.votes[id] || {})[currentYear(g)];

function startReveal(g) {
  g.state.phase = 'reveal';
  g.state.revealEndsAt = Date.now() + REVEAL_MS;
}
function nextYear(g) {
  if (g.state.yearIndex + 1 >= g.years.length) g.state.phase = 'done';
  else { g.state.yearIndex++; g.state.phase = 'picking'; }
  g.state.revealEndsAt = null;
}
// Move the game along when its time has come. Called on every request, so no timers are needed.
function tick(g) {
  if (g.state.phase === 'reveal' && g.state.revealEndsAt && Date.now() >= g.state.revealEndsAt) { nextYear(g); save(); }
  if (g.state.phase === 'picking') {
    const ids = Object.keys(g.players);
    if (ids.length && ids.every(id => hasLocked(g, id))) { startReveal(g); save(); }
  }
}

// Public view of a game: never leak tokens, and keep this year's picks secret until the reveal.
function publicGame(g, viewerId) {
  const year = currentYear(g);
  const secret = g.state.phase === 'picking';
  const players = {}, votes = {}, predictions = {};
  for (const [id, p] of Object.entries(g.players)) {
    players[id] = { name: p.name, icon: p.icon, joinedAt: p.joinedAt, isHost: id === g.hostPlayerId };
    votes[id] = { ...(g.votes[id] || {}) };
    predictions[id] = { ...(g.predictions[id] || {}) };
    if (secret && id !== viewerId) { delete votes[id][year]; delete predictions[id][year]; }
  }
  return {
    code: g.code, name: g.name, years: g.years, createdAt: g.createdAt, players, votes, predictions,
    state: { ...g.state, year },
    locked: g.state.phase === 'picking' ? Object.keys(g.players).filter(id => hasLocked(g, id)) : [],
    now: Date.now(),
  };
}
function auth(g, body) {
  const p = g.players[body.playerId];
  return p && p.token === body.token ? body.playerId : null;
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

  // POST /api/games  -> create a game (the creator gets the host token)
  if (parts.length === 2 && method === 'POST') {
    const body = await readBody(req);
    let start = Number(body.startYear), end = Number(body.endYear);
    if (!YEARS.includes(start) || !YEARS.includes(end)) return send(res, 400, { error: 'Pick years between ' + YEARS[0] + ' and ' + YEARS.at(-1) });
    if (start > end) [start, end] = [end, start];
    const code = newCode();
    const hostToken = newId();
    db.games[code] = migrate({
      code, name: cleanName(body.name) || 'Song Chooser', years: YEARS.filter(y => y >= start && y <= end),
      createdAt: Date.now(), hostToken, hostPlayerId: null, players: {}, votes: {}, predictions: {},
    });
    save();
    return send(res, 201, { code, hostToken });
  }

  const game = db.games[String(parts[2] || '').toUpperCase()];
  if (!game) return send(res, 404, { error: 'Game not found. Double-check the code.' });
  tick(game);
  const isHost = token => token && token === game.hostToken;

  // GET /api/games/:code?playerId=&token=   (the viewer also sees their own secret picks)
  if (parts.length === 3 && method === 'GET') {
    const viewer = auth(game, { playerId: url.searchParams.get('playerId'), token: url.searchParams.get('token') });
    return send(res, 200, publicGame(game, viewer));
  }

  // POST /api/games/:code/players {name, icon, hostToken?}  -> join (or re-join by name on a new device)
  if (parts[3] === 'players' && parts.length === 4 && method === 'POST') {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return send(res, 400, { error: 'Enter a name' });
    const existing = Object.entries(game.players).find(([, p]) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (isHost(body.hostToken)) game.hostPlayerId = existing[0];
      return send(res, 200, { playerId: existing[0], token: existing[1].token, rejoined: true });
    }
    if (Object.keys(game.players).length >= ICONS.length) return send(res, 400, { error: 'This game is full' });
    const taken = new Set(Object.values(game.players).map(p => p.icon));
    if (!ICONS.includes(body.icon)) return send(res, 400, { error: 'Pick an icon' });
    if (taken.has(body.icon)) return send(res, 409, { error: 'Someone just grabbed that icon. Pick another!' });
    const playerId = newId(), token = newId();
    game.players[playerId] = { name, icon: body.icon, token, joinedAt: Date.now() };
    game.votes[playerId] = {};
    game.predictions[playerId] = {};
    if (isHost(body.hostToken)) game.hostPlayerId = playerId;
    save();
    return send(res, 201, { playerId, token });
  }

  // PATCH /api/games/:code/players/:id {token, icon}  -> change your icon
  if (parts[3] === 'players' && parts.length === 5 && method === 'PATCH') {
    const body = await readBody(req);
    if (!auth(game, { playerId: parts[4], token: body.token })) return send(res, 403, { error: 'Unknown player — please re-join' });
    if (!ICONS.includes(body.icon)) return send(res, 400, { error: 'Pick an icon' });
    if (Object.entries(game.players).some(([id, p]) => id !== parts[4] && p.icon === body.icon)) return send(res, 409, { error: 'That icon is taken' });
    game.players[parts[4]].icon = body.icon;
    save();
    return send(res, 200, { ok: true });
  }

  // DELETE /api/games/:code/players/:id  -> host removes a player
  if (parts[3] === 'players' && parts.length === 5 && method === 'DELETE') {
    if (!isHost(req.headers['x-host-token'])) return send(res, 403, { error: 'Only the host can remove players' });
    delete game.players[parts[4]];
    delete game.votes[parts[4]];
    delete game.predictions[parts[4]];
    tick(game);  // everyone left may now be locked in
    save();
    return send(res, 200, { ok: true });
  }

  // PUT /api/games/:code/votes/:year {playerId, token, picks:[1st,2nd,3rd], predict}  -> lock in
  // DELETE same path {playerId, token}  -> unlock to change picks (only before the reveal)
  if (parts[3] === 'votes' && parts.length === 5 && (method === 'PUT' || method === 'DELETE')) {
    const year = Number(parts[4]);
    const body = await readBody(req);
    const id = auth(game, body);
    if (!id) return send(res, 403, { error: 'Unknown player — please re-join' });
    if (game.state.phase !== 'picking' || year !== currentYear(game)) return send(res, 409, { error: "That year isn't open for picks right now" });
    if (method === 'DELETE') {
      delete game.votes[id][year];
      delete game.predictions[id][year];
      save();
      return send(res, 200, { ok: true });
    }
    const picks = (body.picks || []).map(Number);
    const predict = Number(body.predict);
    const valid = SONGS[year].map(s => s.rank);
    if (picks.length !== 3 || new Set(picks).size !== 3 || !picks.every(p => valid.includes(p)))
      return send(res, 400, { error: 'Place all three medals on three different songs' });
    if (!valid.includes(predict)) return send(res, 400, { error: 'Place your 🔮 #1 guess on a song' });
    game.votes[id][year] = picks;
    game.predictions[id][year] = predict;
    tick(game);
    save();
    return send(res, 200, { ok: true });
  }

  // POST /api/games/:code/host {hostToken, action}
  //   start: lobby -> first year     reveal: stop waiting and reveal now     pause: hold the reveal screen
  //   next: on to the next year      end: finish the game
  if (parts[3] === 'host' && parts.length === 4 && method === 'POST') {
    const body = await readBody(req);
    if (!isHost(body.hostToken)) return send(res, 403, { error: 'Only the host can do that' });
    const st = game.state;
    switch (body.action) {
      case 'start':
        if (st.phase !== 'lobby') return send(res, 409, { error: 'The game has already started' });
        if (!Object.keys(game.players).length) return send(res, 400, { error: 'Nobody has joined yet' });
        st.phase = 'picking'; st.yearIndex = 0;
        break;
      case 'reveal':
        if (st.phase !== 'picking') return send(res, 409, { error: 'Nothing to reveal right now' });
        if (!Object.keys(game.players).some(id => hasLocked(game, id))) return send(res, 400, { error: 'Nobody has locked in yet' });
        startReveal(game);
        break;
      case 'pause':
        if (st.phase !== 'reveal') return send(res, 409, { error: 'Nothing to pause' });
        st.revealEndsAt = null;
        break;
      case 'next':
        if (st.phase !== 'reveal') return send(res, 409, { error: 'Wait for the reveal first' });
        nextYear(game);
        break;
      case 'end':
        st.phase = 'done'; st.revealEndsAt = null;
        break;
      default:
        return send(res, 400, { error: 'Unknown action' });
    }
    tick(game);
    save();
    return send(res, 200, publicGame(game, game.hostPlayerId));
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
module.exports = { server, SONGS, YEARS, db };
