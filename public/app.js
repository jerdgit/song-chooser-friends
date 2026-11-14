/* Song Chooser — front end. Plain JS, no build step. */
'use strict';

const $app = document.getElementById('app');
const $nav = document.getElementById('topnav');
const PLACE = ['1st', '2nd', '3rd'];
const MEDAL = ['🥇', '🥈', '🥉'];
const ICONS = Scoring.ICONS;
// The four things you place on songs each year: three medals and the #1 guess.
const TOKENS = {
  0: { emoji: '🥇', label: '1st', sub: '5 pts' },
  1: { emoji: '🥈', label: '2nd', sub: '3 pts' },
  2: { emoji: '🥉', label: '3rd', sub: '1 pt' },
  p: { emoji: '🔮', label: '#1 guess', sub: "Billboard's #1?" },
};
const POLL_MS = 1500;

let SONGS = null;       // { year: [{rank,title,artist,preview,art,link}] }
let YEARS = [];
let pollTimer = null;
let cleanup = null;     // per-view teardown

// ---------------------------------------------------------------- utilities
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const meFor = code => store.get('sc:player:' + code);
const hostFor = code => store.get('sc:host:' + code);
function rememberGame(code, name) {
  const list = store.get('sc:games', []).filter(g => g.code !== code);
  list.unshift({ code, name });
  store.set('sc:games', list.slice(0, 12));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
// A player's goofy icon in a colored bubble. size: '' | 'sm' | 'lg' | 'xl'
function avatar(p, size = '', badge = '') {
  const icon = p?.icon || '❔';
  return `<span class="avatar ${size}" style="background:hsl(${hue(icon)} 85% 80%)" title="${esc(p?.name || '')}">${icon}${badge ? `<i class="av-badge">${badge}</i>` : ''}</span>`;
}
const who = p => `${avatar(p, 'sm')}<span>${esc(p?.name || 'Someone')}</span>`;
function art(song, cls = 'art') {
  if (song.art) return `<img class="${cls}" src="${esc(song.art)}" alt="" loading="lazy">`;
  return `<div class="${cls} ph">${esc(song.title[0] || '♪')}</div>`;
}
// Deterministic shuffle so each player sees a stable, random-looking order per year
// (hides the Billboard order while you listen).
function seededOrder(seedStr, items) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const rand = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const songOf = (year, rank) => SONGS[year].find(s => s.rank === rank);
function iconGrid(selected, taken) {
  return `<div class="icon-grid">${ICONS.map(i => `<button type="button" class="icon-opt ${i === selected ? 'on' : ''}" data-icon="${i}"
    ${taken.has(i) && i !== selected ? 'disabled title="Taken"' : ''}>${i}</button>`).join('')}</div>`;
}

// ---------------------------------------------------------------- audio
const Player = {
  el: new Audio(),
  key: null,
  song: null,
  onEnded: null,    // set by the picking screen to auto-advance
  unlocked: false,  // true once the browser has let us play sound (after a tap)
  year: null,
  retried: new Set(),
  init() {
    this.el.preload = 'auto';
    this.el.addEventListener('timeupdate', () => this.paint());
    this.el.addEventListener('play', () => this.paint());
    this.el.addEventListener('pause', () => this.paint());
    this.el.addEventListener('ended', () => { this.paint(); if (this.onEnded) this.onEnded(this.key); });
    this.el.addEventListener('error', () => this.recover());
  },
  async play(year, song) {
    const key = `${year}-${song.rank}`;
    if (this.key !== key) {
      this.key = key; this.song = song; this.year = year;
      if (!song.preview) await this.refresh();
      if (this.key !== key) return false;
      if (!song.preview) { this.paint(); toast('No preview available for this one'); return false; }
      this.el.src = song.preview;
    }
    try { await this.el.play(); this.unlocked = true; } catch { /* autoplay blocked: user can hit play */ }
    this.paint();
    return true;
  },
  toggle(year, song) {
    const key = `${year}-${song.rank}`;
    if (this.key === key && !this.el.paused) this.el.pause();
    else this.play(year, song);
  },
  stop() { this.el.pause(); this.key = null; this.paint(); },
  async refresh() {
    try {
      const fresh = await api(`/preview?year=${this.year}&rank=${this.song.rank}`);
      this.song.preview = fresh.preview;
      if (!this.song.art && fresh.art) this.song.art = fresh.art;
    } catch { /* none */ }
  },
  async recover() {
    // Stored preview link died — ask the server for a fresh one once.
    const key = this.key;
    // Preview can't be played: let the picking screen move on to the next song.
    const giveUp = () => { this.paint(); if (this.key === key && this.onEnded) this.onEnded(key); };
    if (!this.song || this.retried.has(key)) return giveUp();
    this.retried.add(key);
    await this.refresh();
    if (this.key === key && this.song.preview) { this.el.src = this.song.preview; this.el.play().catch(() => {}); }
    else giveUp();
  },
  isPlaying(key) { return this.key === key && !this.el.paused && !this.el.ended; },
  paint() {
    document.querySelectorAll('[data-play]').forEach(b => {
      const on = this.isPlaying(b.dataset.play);
      b.classList.toggle('playing', on);
      b.textContent = on ? '❚❚' : '▶';
      b.setAttribute('aria-label', on ? 'Pause preview' : 'Play preview');
    });
    document.querySelectorAll('[data-progress]').forEach(p => {
      const pct = p.dataset.progress === this.key && this.el.duration ? (this.el.currentTime / this.el.duration) * 100 : 0;
      p.style.width = pct + '%';
    });
  },
};
Player.init();

// Delegate play buttons everywhere.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const [year, rank] = b.dataset.play.split('-').map(Number);
  Player.toggle(year, songOf(year, rank));
});
const miniPlay = (year, rank) => `<button class="mini-play" data-play="${year}-${rank}" aria-label="Play preview">▶</button>`;

// ---------------------------------------------------------------- router
function setNav(code) {
  if (!code) { $nav.innerHTML = ''; return; }
  const h = location.hash;
  $nav.innerHTML = `
    <a href="#/g/${code}" class="${!h.includes('/results') ? 'active' : ''}">Game</a>
    <a href="#/g/${code}/results" class="${h.includes('/results') ? 'active' : ''}">Results</a>`;
}
async function route() {
  clearInterval(pollTimer); pollTimer = null;
  if (cleanup) { cleanup(); cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (!SONGS) {
      $app.innerHTML = '<p class="muted center">Loading songs…</p>';
      SONGS = await (await fetch('/songs.json')).json();
      YEARS = Object.keys(SONGS).map(Number).sort((a, b) => a - b);
    }
    if (parts[0] !== 'g') { setNav(null); return renderHome(); }
    const code = (parts[1] || '').toUpperCase();
    if (parts[2] && parts[2] !== 'results') { location.replace(`#/g/${code}`); return; } // old links
    setNav(code);
    if (parts[2] === 'results') return renderResults(code, parts[3] || 'years');
    return renderGame(code);
  } catch (err) {
    // A game that was deleted on the server: drop it from this browser's "Your games" list.
    if (/game not found/i.test(err.message) && parts[1]) {
      const code = parts[1].toUpperCase();
      store.set('sc:games', store.get('sc:games', []).filter(g => g.code !== code));
      store.del('sc:player:' + code);
    }
    $app.innerHTML = `<div class="card center stack"><h2>Hmm.</h2><p class="muted">${esc(err.message)}</p><a class="btn" href="#/">Home</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- home
function renderHome() {
  Player.stop();
  const first = YEARS[0], last = YEARS.at(-1);
  const decades = [...new Set(YEARS.map(y => Math.floor(y / 10) * 10))];
  const mine = store.get('sc:games', []);
  const yearOpts = sel => YEARS.map(y => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
  $app.innerHTML = `
    <section class="hero fade-in">
      <h1>Pick your songs.<br>Settle the debate.</h1>
      <p>Get everyone in one lobby. Each year, listen to the 10 biggest hits together, drag your 🥇🥈🥉 onto your favorites
      and your 🔮 onto the song you think was Billboard's #1. When everyone locks in, see who picked what.</p>
    </section>
    <div class="stack">
      ${mine.length ? `<div class="card stack"><h2>Your games</h2><div class="list">${mine.map(g => `
        <a class="yrow" style="grid-template-columns:1fr auto" href="#/g/${esc(g.code)}">
          <div><div class="t">${esc(g.name)}</div><div class="s">Code ${esc(g.code)}</div></div><span class="pill">Open →</span>
        </a>`).join('')}</div></div>` : ''}
      <form class="card stack" id="create">
        <h2>Host a game</h2>
        <div><label for="gname">Game name</label><input type="text" id="gname" maxlength="30" placeholder="e.g. Friday Night Hits" required></div>
        <div>
          <label>Years</label>
          <div class="chips" id="presets">
            <button type="button" class="chip" data-r="${first}-${last}">All (${first}–${last})</button>
            ${decades.map(d => `<button type="button" class="chip ${d === 1990 ? 'on' : ''}" data-r="${Math.max(d, first)}-${Math.min(d + 9, last)}">${String(d).slice(2)}s</button>`).join('')}
          </div>
        </div>
        <div class="grid2">
          <div><label for="from">From</label><select id="from">${yearOpts(1990)}</select></div>
          <div><label for="to">To</label><select id="to">${yearOpts(1999)}</select></div>
        </div>
        <p class="small muted">Everyone plays the years in order, together. A decade (10 years) takes roughly 30–45 minutes.</p>
        <button class="btn primary block big">Create game</button>
      </form>
      <form class="card stack" id="join">
        <h2>Join a friend's game</h2>
        <input type="text" id="code" class="code-input" maxlength="5" placeholder="CODE" autocomplete="off" required>
        <button class="btn block">Join</button>
      </form>
    </div>`;
  const from = document.getElementById('from'), to = document.getElementById('to');
  document.getElementById('presets').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    document.querySelectorAll('#presets .chip').forEach(x => x.classList.toggle('on', x === c));
    const [a, b] = c.dataset.r.split('-'); from.value = a; to.value = b;
  });
  [from, to].forEach(s => s.addEventListener('change', () => document.querySelectorAll('#presets .chip').forEach(x => x.classList.remove('on'))));
  document.getElementById('create').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button.primary'); btn.disabled = true;
    try {
      const name = document.getElementById('gname').value;
      const { code, hostToken } = await api('/games', { method: 'POST', body: { name, startYear: from.value, endYear: to.value } });
      store.set('sc:host:' + code, hostToken);
      rememberGame(code, name);
      location.hash = `#/g/${code}`;
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  document.getElementById('join').addEventListener('submit', e => {
    e.preventDefault();
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (code) location.hash = `#/g/${code}`;
  });
}

// ---------------------------------------------------------------- join
function renderJoin(game) {
  const taken = new Set(Object.values(game.players).map(p => p.icon));
  let icon = ICONS.filter(i => !taken.has(i))[Math.floor(Math.random() * (ICONS.length - taken.size))];
  const names = Object.values(game.players);
  const isHost = !!hostFor(game.code);
  $app.innerHTML = `
    <div class="stack fade-in">
      <div class="center"><span class="pill">${isHost ? "You're the host" : "You're invited"}</span><h1 style="margin-top:10px">${esc(game.name)}</h1>
        <p class="muted">The top songs of ${game.years[0]}–${game.years.at(-1)}, played together.</p></div>
      <form class="card stack" id="joinf">
        <div class="center" id="preview">${avatar({ icon }, 'xl')}</div>
        <div><label for="name">Your name</label><input type="text" id="name" maxlength="30" placeholder="What should friends call you?" required autofocus></div>
        <div><label>Pick your icon</label>${iconGrid(icon, taken)}</div>
        <button class="btn primary block big">${isHost ? 'Open the lobby' : 'Join game'}</button>
        ${names.length ? `<p class="small muted">Already here: ${names.map(p => `${p.icon} ${esc(p.name)}`).join(', ')}.<br>On a new device? Enter the same name to pick up where you left off.</p>` : ''}
      </form>
    </div>`;
  $app.querySelector('.icon-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-icon]'); if (!b || b.disabled) return;
    icon = b.dataset.icon;
    $app.querySelectorAll('.icon-opt').forEach(x => x.classList.toggle('on', x === b));
    document.getElementById('preview').innerHTML = avatar({ icon }, 'xl');
  });
  document.getElementById('joinf').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    try {
      const r = await api(`/games/${game.code}/players`, { method: 'POST', body: { name, icon, hostToken: hostFor(game.code) || undefined } });
      store.set('sc:player:' + game.code, { playerId: r.playerId, token: r.token, name: name.trim() });
      if (r.rejoined) toast('Welcome back!');
      route();
    } catch (err) { toast(err.message); if (/icon/i.test(err.message)) route(); }
  });
}

// ---------------------------------------------------------------- the live game
// One screen per phase. The server decides the phase; everyone polls it and follows along.
async function renderGame(code) {
  const me = meFor(code);
  const query = () => (me ? `?playerId=${me.playerId}&token=${me.token}` : '');
  let game = await api(`/games/${code}${query()}`);
  rememberGame(code, game.name);
  if (!me || !game.players[me.playerId]) return renderJoin(game);

  let offset = Date.now() - game.now;           // our clock minus the server's
  let view = null, viewKey = null;
  const ctx = {
    code, me, hostToken: hostFor(code),
    get game() { return game; },
    serverNow: () => Date.now() - offset,
    async refresh() {
      const g = await api(`/games/${code}${query()}`);
      offset = Date.now() - g.now; game = g; show();
    },
    async host(action) {
      try { const g = await api(`/games/${code}/host`, { method: 'POST', body: { hostToken: ctx.hostToken, action } }); offset = Date.now() - g.now; game = g; show(); }
      catch (err) { toast(err.message); }
    },
  };
  ctx.isHost = () => !!ctx.hostToken && game.players[me.playerId]?.isHost;
  const views = { lobby: LobbyView, picking: PickView, reveal: RevealView, done: DoneView };
  function show() {
    if (!game.players[me.playerId]) { store.del('sc:player:' + code); toast('You were removed from this game'); return route(); }
    const key = `${game.state.phase}:${game.state.yearIndex}`;
    if (key !== viewKey) {
      view?.destroy?.();
      viewKey = key;
      view = views[game.state.phase](ctx);
      window.scrollTo(0, 0);
      view.render();
    } else view.update?.();
  }
  show();
  let last = JSON.stringify({ ...game, now: 0 });
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const g = await api(`/games/${code}${query()}`);
      offset = Date.now() - g.now;
      const sig = JSON.stringify({ ...g, now: 0 });
      if (sig !== last) { last = sig; game = g; show(); }
    } catch { /* keep trying */ }
  }, POLL_MS);
  cleanup = () => { view?.destroy?.(); Player.onEnded = null; Player.stop(); };
}

// ---------------- pregame lobby
function LobbyView(ctx) {
  let picking = false; // icon picker open
  const render = () => {
    const g = ctx.game, me = ctx.me;
    const link = `${location.origin}/#/g/${ctx.code}`;
    const players = Object.entries(g.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
    const mine = g.players[me.playerId];
    const taken = new Set(players.map(([, p]) => p.icon));
    $app.innerHTML = `
      <div class="stack">
        <div class="center">
          <span class="pill">Pregame lobby</span>
          <h1 style="margin-top:10px">${esc(g.name)}</h1>
          <p class="muted">${g.years[0]}–${g.years.at(-1)} · ${g.years.length} year${g.years.length === 1 ? '' : 's'} · 10 songs each</p>
        </div>
        <div class="card stack">
          <div class="row spread"><h2 style="margin:0">Who's here (${players.length})</h2>
            <button class="linkbtn small" id="change">${picking ? 'Done' : `Change my icon ${mine.icon}`}</button></div>
          ${picking ? iconGrid(mine.icon, taken) : ''}
          <div class="lobby-grid">${players.map(([id, p]) => `
            <div class="lobby-player ${id === me.playerId ? 'me' : ''}">
              ${avatar(p, 'lg')}
              <b>${esc(p.name)}</b>
              <span class="small muted">${p.isHost ? '👑 Host' : id === me.playerId ? 'You' : '&nbsp;'}</span>
              ${ctx.isHost() && id !== me.playerId ? `<button class="kick" data-kick="${id}" title="Remove ${esc(p.name)}">✕</button>` : ''}
            </div>`).join('')}</div>
        </div>
        ${ctx.isHost()
          ? `<button class="btn primary big block" id="start">Everyone's in. Start the game!</button>`
          : `<div class="callout center">Waiting for the host to start the game<span class="dots-anim"></span></div>`}
        <div class="card stack">
          <h2>Invite friends</h2>
          <div class="center"><div class="small muted">Game code</div><div class="code-big">${ctx.code}</div></div>
          <div class="share"><input type="text" readonly value="${esc(link)}" id="link"><button class="btn" id="copy">Copy</button></div>
        </div>
        <div class="card flat stack small">
          <b>How it works</b>
          <div class="muted">Each year, the 10 biggest songs play one by one. Drag 🥇 🥈 🥉 onto your three favorites (5, 3 and 1 points) and
          🔮 onto the song you think was Billboard's #1 that year. Once everyone locks in, you'll see who picked what.
          Every correct 🔮 guess is worth a point on the scoreboard.</div>
        </div>
        <p class="center small muted">Not ${esc(mine.name)}? <button class="linkbtn" id="switch">Switch player</button></p>
      </div>`;
    document.getElementById('change').onclick = () => { picking = !picking; render(); };
    $app.querySelector('.icon-grid')?.addEventListener('click', async e => {
      const b = e.target.closest('[data-icon]'); if (!b || b.disabled) return;
      try { await api(`/games/${ctx.code}/players/${me.playerId}`, { method: 'PATCH', body: { token: me.token, icon: b.dataset.icon } }); picking = false; await ctx.refresh(); }
      catch (err) { toast(err.message); }
    });
    document.getElementById('start')?.addEventListener('click', () => ctx.host('start'));
    document.getElementById('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied!'); }
      catch { document.getElementById('link').select(); toast('Copy the link above'); }
    };
    document.getElementById('switch').onclick = () => { store.del('sc:player:' + ctx.code); route(); };
    $app.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => kick(ctx, b.dataset.kick));
  };
  return { render, update: () => { if (document.activeElement?.id !== 'link') render(); } };
}
async function kick(ctx, id) {
  const p = ctx.game.players[id];
  if (!confirm(`Remove ${p.name} from the game?`)) return;
  try { await api(`/games/${ctx.code}/players/${id}`, { method: 'DELETE', headers: { 'X-Host-Token': ctx.hostToken } }); await ctx.refresh(); }
  catch (err) { toast(err.message); }
}

// Strip of everyone's icons with a ✓ once they've locked in.
function lockStrip(ctx) {
  const g = ctx.game;
  const players = Object.entries(g.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  return players.map(([id, p]) => `<span class="lock-av ${g.locked.includes(id) ? 'in' : ''}" title="${esc(p.name)}${g.locked.includes(id) ? ' – locked in' : ' – still picking'}">
    ${avatar(p, 'sm', g.locked.includes(id) ? '✓' : '')}</span>`).join('');
}

// ---------------- picking a year
function PickView(ctx) {
  const g0 = ctx.game, me = ctx.me;
  const year = g0.state.year, yi = g0.state.yearIndex;
  const order = seededOrder(`${me.playerId}:${year}`, SONGS[year].map(s => s.rank));
  const mineVotes = (g0.votes[me.playerId] || {})[year];
  const st = {
    picks: mineVotes ? mineVotes.slice() : [null, null, null],
    predict: (g0.predictions[me.playerId] || {})[year] || null,
    locked: !!mineVotes,
    step: mineVotes ? 'board' : Player.unlocked ? 'board' : 'intro',  // after the first year, skip straight to listening
    revealed: mineVotes ? order.length : Player.unlocked ? 1 : 0,
    autoplay: !mineVotes && Player.unlocked,
    pop: null,
    armed: null,  // token picked up by tapping (tap a song to drop it)
  };
  const current = () => songOf(year, order[st.revealed - 1]);
  const curKey = () => `${year}-${order[st.revealed - 1]}`;
  const tokenAt = rank => ({ medal: st.picks.indexOf(rank), predict: st.predict === rank });
  const complete = () => st.picks.every(Boolean) && !!st.predict;

  async function playCurrent() {
    const key = curKey();
    const ok = await Player.play(year, current());
    if (!ok) setTimeout(() => { if (st.autoplay && curKey() === key) advance(); }, 2500);
  }
  function advance() {
    if (st.revealed < order.length) {
      st.revealed++; st.autoplay = true; st.pop = order[st.revealed - 1];
      redraw();
      document.querySelector(`[data-tile="${st.pop}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      playCurrent();
    } else { st.autoplay = false; redraw(); }
  }
  function showAll() { st.revealed = order.length; st.autoplay = false; st.pop = null; Player.stop(); redraw(); }
  Player.onEnded = key => { if (st.step === 'board' && st.autoplay && key === curKey()) advance(); };

  function place(token, rank) {
    if (st.locked) return;
    if (token === 'p') st.predict = rank;
    else {
      const t = Number(token), other = st.picks.indexOf(rank);
      if (other >= 0 && other !== t) st.picks[other] = st.picks[t]; // swap medals
      st.picks[t] = rank;
    }
    st.armed = null;
  }
  function unplace(token) { if (token === 'p') st.predict = null; else st.picks[Number(token)] = null; }

  const redraw = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };
  function draw() {
    if (st.step === 'intro') {
      $app.innerHTML = `
        <div class="center stack fade-in" style="padding-top:20px">
          <div class="lock-strip center-strip">${lockStrip(ctx)}</div>
          <div class="muted">Year ${yi + 1} of ${ctx.game.years.length}</div>
          <div class="year-title">${year}</div>
          <p class="muted">Ten of the year's biggest songs, shuffled. They'll play one at a time. Drag your medals and your 🔮 onto songs whenever you're ready.</p>
          <button class="btn primary big" id="begin">▶ Start listening</button>
          <div><button class="linkbtn" id="skip">I know these. Show them all</button></div>
        </div>`;
      document.getElementById('begin').onclick = () => { st.step = 'board'; st.revealed = 1; st.autoplay = true; st.pop = order[0]; draw(); playCurrent(); };
      document.getElementById('skip').onclick = () => { st.step = 'board'; st.revealed = order.length; draw(); };
      return;
    }
    const listening = st.revealed > 0 && (st.revealed < order.length || st.autoplay);
    const cur = st.revealed ? current() : null;
    const tokenEl = (t, where) => `<span class="token ${st.locked ? 'locked' : ''} ${st.armed === String(t) ? 'armed' : ''}" data-token="${t}" role="button" tabindex="0"
      aria-label="${TOKENS[t].label}${where ? ' on ' + esc(where) : ''}">${TOKENS[t].emoji}</span>`;
    const trayItem = t => {
      const rank = t === 'p' ? st.predict : st.picks[t];
      const s = rank && songOf(year, rank);
      return `<div class="tray-item ${s ? 'placed' : ''} ${t === 'p' ? 'predict' : 'p' + (Number(t) + 1)}">
        ${tokenEl(t)}
        <div class="tray-text"><b>${s ? esc(s.title) : TOKENS[t].label}</b><span>${s ? (t === 'p' ? 'your #1 guess' : TOKENS[t].label + ' · ' + TOKENS[t].sub) : TOKENS[t].sub}</span></div>
      </div>`;
    };
    const missing = Object.entries(ctx.game.players).filter(([id]) => !ctx.game.locked.includes(id) && id !== me.playerId);
    $app.innerHTML = `
      <div>
        ${listening ? `
        <div class="now-playing">
          ${cur.art ? `<img src="${esc(cur.art)}" alt="">` : `<div class="ph">${esc(cur.title[0])}</div>`}
          <div style="min-width:0">
            <div class="np-label">${year} · Song ${st.revealed} of ${order.length}</div>
            <div class="t">${esc(cur.title)}</div><div class="a">${esc(cur.artist)}</div>
          </div>
          <div class="np-controls">
            <button class="np-play" data-play="${curKey()}" aria-label="Play preview">▶</button>
            <button class="btn primary np-next" id="next">${st.revealed < order.length ? 'Next ›' : 'Done'}</button>
          </div>
          <div class="progress np-progress"><i data-progress="${curKey()}"></i></div>
        </div>` : ''}
        <div class="row spread" style="margin-bottom:6px">
          <h2 style="margin:0">${year}</h2>
          <div class="lock-strip">${lockStrip(ctx)}</div>
        </div>
        ${st.locked ? `
          <div class="callout win wait-banner">
            <b>Locked in ✓</b> ${missing.length ? `Waiting for ${missing.map(([, p]) => `${p.icon} ${esc(p.name)}`).join(', ')}…` : 'Revealing…'}
            <div class="row" style="margin-top:8px">
              <button class="btn ghost" id="unlock">Change my picks</button>
              ${ctx.isHost() && missing.length ? `<button class="btn ghost" id="force">Reveal now</button>` : ''}
            </div>
          </div>` : `<p class="muted small" style="margin:0 0 8px">${st.armed ? `Now tap a song to put your ${TOKENS[st.armed].emoji} on it.` : 'Drag each medal and your 🔮 onto a song (or tap one, then tap a song).'}</p>`}
        <div class="tray">${[0, 1, 2, 'p'].map(trayItem).join('')}</div>
        <div class="tiles ${st.locked ? 'is-locked' : ''}">${order.map((r, i) => {
          if (i >= st.revealed) return `<div class="tile locked" aria-hidden="true"><div class="ph">${i + 1}</div><div class="meta"><div class="tw"><span class="t">Song ${i + 1}</span></div><div class="a">Up next</div></div></div>`;
          const s = songOf(year, r); const { medal, predict } = tokenAt(r);
          const now = listening && i === st.revealed - 1;
          return `<div class="tile ${medal >= 0 ? 'p' + (medal + 1) : ''} ${predict ? 'predicted' : ''} ${now ? 'now' : ''} ${st.pop === r ? 'pop' : ''} ${st.armed ? 'armable' : ''}" data-tile="${r}">
            ${s.art ? `<img src="${esc(s.art)}" alt="" loading="lazy" draggable="false">` : `<div class="ph">${esc(s.title[0])}</div>`}
            ${medal >= 0 ? `<span class="tile-token medal">${tokenEl(medal, s.title)}</span>` : ''}
            ${predict ? `<span class="tile-token pred">${tokenEl('p', s.title)}</span>` : ''}
            ${now ? '<span class="now-tag" title="Now playing">♪</span>' : ''}
            <div class="meta">
              <div class="tw"><button class="tile-play" data-play="${year}-${r}" aria-label="Play preview">▶</button><span class="t">${esc(s.title)}</span></div>
              <div class="a">${esc(s.artist)}</div>
            </div>
          </div>`;
        }).join('')}</div>
        ${st.revealed < order.length ? `<p class="center"><button class="linkbtn small" id="showall">Show all songs</button></p>` : ''}
        ${st.locked ? '' : `<div class="lock-row">
          <button class="btn primary big block" id="lock" ${complete() ? '' : 'disabled'}>
            ${complete() ? 'Lock in my picks' : `Place ${[0, 1, 2].filter(t => !st.picks[t]).map(t => TOKENS[t].emoji).join('')}${st.predict ? '' : '🔮'} to lock in`}
          </button></div>`}
      </div>`;
    st.pop = null;
    Player.paint();
    document.getElementById('next')?.addEventListener('click', advance);
    document.getElementById('showall')?.addEventListener('click', showAll);
    document.getElementById('lock')?.addEventListener('click', lockIn);
    document.getElementById('unlock')?.addEventListener('click', unlock);
    document.getElementById('force')?.addEventListener('click', () => { if (confirm('Reveal now, without waiting for everyone?')) ctx.host('reveal'); });
  }

  async function lockIn(e) {
    e.currentTarget.disabled = true;
    try {
      await api(`/games/${ctx.code}/votes/${year}`, { method: 'PUT', body: { playerId: me.playerId, token: me.token, picks: st.picks, predict: st.predict } });
      st.locked = true; st.armed = null; redraw(); await ctx.refresh();
    } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
  }
  async function unlock() {
    try { await api(`/games/${ctx.code}/votes/${year}`, { method: 'DELETE', body: { playerId: me.playerId, token: me.token } }); st.locked = false; redraw(); await ctx.refresh(); }
    catch (err) { toast(err.message); }
  }

  // ---- drag and drop (pointer events work for mouse, touch and pen)
  let drag = null;
  const tileAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-tile]');
  function onDown(e) {
    const t = e.target.closest('[data-token]');
    if (!t || st.locked || st.step !== 'board' || e.button > 0) return;
    e.preventDefault();
    drag = { token: t.dataset.token, x: e.clientX, y: e.clientY, moved: false, ghost: null, over: null, from: t.closest('[data-tile]') };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }
  function onMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.moved = true;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'drag-ghost';
      drag.ghost.textContent = TOKENS[drag.token].emoji;
      document.body.appendChild(drag.ghost);
      document.body.classList.add('dragging');
    }
    drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY - 28}px) translate(-50%, -50%)`;
    const over = tileAt(e.clientX, e.clientY - 28);
    if (over !== drag.over) { drag.over?.classList.remove('drop-over'); over?.classList.add('drop-over'); drag.over = over; }
  }
  function endDrag() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    drag?.ghost?.remove(); drag?.over?.classList.remove('drop-over');
    document.body.classList.remove('dragging');
  }
  function onUp(e) {
    if (!drag) return;
    const d = drag; endDrag(); drag = null;
    if (!d.moved) { st.armed = st.armed === d.token ? null : d.token; return redraw(); } // tap: pick it up
    const tile = tileAt(e.clientX, e.clientY - 28);
    if (tile) place(d.token, Number(tile.dataset.tile));
    else if (d.from) unplace(d.token); // dragged off a song: take it back
    redraw();
  }
  function onCancel() { endDrag(); drag = null; }
  function onClick(e) {
    if (e.target.closest('[data-play], [data-token]')) return;
    const tile = e.target.closest('[data-tile]');
    if (!tile || st.locked) return;
    if (st.armed) { place(st.armed, Number(tile.dataset.tile)); redraw(); }
    else toast('Drag a medal or your 🔮 onto a song');
  }
  function onKey(e) {
    if (st.step !== 'board' || e.target.matches('input, textarea')) return;
    const t = e.target.closest('[data-token]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.armed = st.armed === t.dataset.token ? null : t.dataset.token; return redraw(); }
    if (e.key === 'ArrowRight' && st.revealed) { e.preventDefault(); advance(); }
  }
  $app.addEventListener('pointerdown', onDown);
  $app.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  return {
    render() {
      // From the second year on the browser already allows sound, so start listening straight away.
      if (st.step === 'board' && st.autoplay && st.revealed === 1) { st.pop = order[0]; draw(); playCurrent(); }
      else draw();
    },
    update() {
      // Only the "who's locked in" bits change while picking; never redraw mid-drag.
      if (drag) return;
      if (st.step === 'intro') { const s = $app.querySelector('.lock-strip'); if (s) s.innerHTML = lockStrip(ctx); return; }
      redraw();
    },
    destroy() {
      endDrag();
      $app.removeEventListener('pointerdown', onDown);
      $app.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      Player.onEnded = null; Player.stop();
    },
  };
}

// ---------------- reveal: who picked what, Billboard's real top 10, the 🔮 scoreboard
function RevealView(ctx) {
  let timer = null;
  const render = () => {
    const g = ctx.game, year = g.state.year;
    const res = Scoring.yearResults(g, SONGS, year);
    const sum = Scoring.summary(g, SONGS);
    const chart = res.rows.slice().sort((a, b) => a.rank - b.rank);
    const last = g.state.yearIndex === g.years.length - 1;
    const players = g.players;
    const gotIt = new Set(res.rows.find(r => r.rank === 1).predictors);
    $app.innerHTML = `
      <div class="stack reveal-stack fade-in">
        <div class="row spread reveal-head"><div class="year-title">${year}</div><span class="muted">Year ${g.state.yearIndex + 1} of ${g.years.length}</span></div>
        <div class="next-bar" id="nextbar"></div>
        ${res.winners.length ? `<div class="callout compact ${res.matchesBillboard ? 'win' : ''}">Group favorite: <b>${res.winners.map(w => esc(w.title)).join(' / ')}</b> (${res.winners[0].points} pts)${res.matchesBillboard ? '. Billboard agrees! 🎯' : ''}</div>` : ''}
        <div class="card chart-card">
          <h3 style="margin:0 0 8px">Billboard's top 10 of ${year}</h3>
          <div class="list chart-list">${chart.map(s => `
            <div class="srow chart-row reveal-row ${s.rank === 1 ? 'top' : ''}" style="animation-delay:${(chart.length - s.rank) * 110}ms">
              <div class="gr">${s.rank}</div>
              <div class="thumb-wrap">${art(s, 'thumb')}${miniPlay(year, s.rank)}</div>
              <div class="ln-wrap">
                <div class="ln"><span class="t">${esc(s.title)}</span> <span class="a">${esc(s.artist)}</span></div>
                ${s.voters.length || s.predictors.length ? `<div class="pickers">${s.voters.map(v => avatar(players[v.playerId], 'sm', MEDAL[v.place])).join('')}${s.predictors.map(id => avatar(players[id], 'sm', '🔮')).join('')}</div>` : ''}
              </div>
              <div class="pts-mini">${s.points ? `${s.points}<span>pts</span>` : ''}</div>
            </div>`).join('')}</div>
        </div>
        <div class="card stack">
          <h3 style="margin:0">🔮 #1 guess scoreboard</h3>
          <div class="list">${sum.leaderboard.map(p => `
            <div class="score-row ${gotIt.has(p.playerId) ? 'got' : ''}">
              <span class="place">${p.place}</span>${avatar(players[p.playerId], 'sm')}<span class="nm">${esc(p.name)}</span>
              ${gotIt.has(p.playerId) ? '<span class="plus">+1</span>' : ''}
              <b>${p.predictCorrect}</b>
            </div>`).join('')}</div>
        </div>
        ${ctx.isHost() ? `<button class="linkbtn small center" id="end">End the game now</button>` : ''}
      </div>`;
    Player.paint();
    paintBar(last);
    document.getElementById('end')?.addEventListener('click', () => { if (confirm('End the game for everyone?')) ctx.host('end'); });
  };
  function paintBar(last = ctx.game.state.yearIndex === ctx.game.years.length - 1) {
    const bar = document.getElementById('nextbar'); if (!bar) return;
    const ends = ctx.game.state.revealEndsAt;
    const what = last ? 'Final scores' : `Next: <b>${ctx.game.years[ctx.game.state.yearIndex + 1]}</b>`;
    bar.innerHTML = `
      <div class="row" style="flex-wrap:nowrap">
        <div class="nb-text">${ends ? `${what} in <span id="secs"></span>s` : `${what} · paused by the host`}</div>
        ${ctx.isHost() && ends ? '<button class="btn ghost" id="pause">Pause</button>' : ''}
        ${ctx.isHost() ? `<button class="btn primary" id="go">${last ? 'Finish →' : 'Next year →'}</button>` : ''}
      </div>
      ${ends ? '<div class="progress"><i id="nbprog"></i></div>' : ''}`;
    document.getElementById('pause')?.addEventListener('click', () => ctx.host('pause'));
    document.getElementById('go')?.addEventListener('click', () => ctx.host('next'));
    clearInterval(timer);
    if (ends) {
      const total = Math.max(1, ends - ctx.serverNow());
      const tickBar = () => {
        const left = Math.max(0, ends - ctx.serverNow());
        const s = document.getElementById('secs'); if (s) s.textContent = Math.ceil(left / 1000);
        const p = document.getElementById('nbprog'); if (p) p.style.width = (left / total) * 100 + '%';
        if (left <= 0) { clearInterval(timer); ctx.refresh().catch(() => {}); }
      };
      tickBar(); timer = setInterval(tickBar, 200);
    }
  }
  let lastEnds = ctx.game.state.revealEndsAt;
  return {
    render,
    update() { if (ctx.game.state.revealEndsAt !== lastEnds) { lastEnds = ctx.game.state.revealEndsAt; paintBar(); } },
    destroy() { clearInterval(timer); Player.stop(); },
  };
}

// ---------------- game over
function DoneView(ctx) {
  return {
    render() {
      const g = ctx.game;
      const sum = Scoring.summary(g, SONGS);
      const champs = sum.leaderboard.filter(p => p.place === 1 && p.predictCorrect > 0);
      $app.innerHTML = `
        <div class="stack fade-in">
          <div class="center"><span class="pill">Game over</span><h1 style="margin-top:10px">${esc(g.name)}</h1></div>
          ${champs.length ? `<div class="card center stack champ">
            <div class="champ-avs">${champs.map(p => avatar(g.players[p.playerId], 'xl')).join('')}</div>
            <h2 style="margin:0">${champs.map(p => esc(p.name)).join(' & ')}</h2>
            <p class="muted" style="margin:0">${champs.length > 1 ? 'tie for' : 'wins'} the 🔮 #1 guess crown with ${champs[0].predictCorrect} correct!</p>
          </div>` : ''}
          <div class="card stack">
            <h3 style="margin:0">🔮 Final scoreboard</h3>
            <div class="list">${sum.leaderboard.map(p => `
              <div class="score-row"><span class="place">${p.place}</span>${avatar(g.players[p.playerId], 'sm')}<span class="nm">${esc(p.name)}</span>
                <span class="small muted">${p.predictCorrect}/${p.predictTotal}</span><b>${p.predictCorrect}</b></div>`).join('')}</div>
          </div>
          ${sum.hallOfFame.length ? `<div class="card stack"><h3 style="margin:0">🏆 The group's most-loved songs</h3><div class="list">${sum.hallOfFame.slice(0, 5).map(s => `
            <div class="srow"><div class="gr" style="font-size:.85rem">${s.year}</div><div class="thumb-wrap">${art(s, 'thumb')}${miniPlay(s.year, s.rank)}</div>
              <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}</div></div><div class="pts"><b>${s.points}</b><span>pts</span></div></div>`).join('')}</div></div>` : ''}
          <a class="btn primary big block" href="#/g/${ctx.code}/results">See every year's results →</a>
          <a class="btn ghost block" href="#/">Home</a>
        </div>`;
      Player.paint();
    },
    destroy() { Player.stop(); },
  };
}

// ---------------------------------------------------------------- results
async function renderResults(code, tab) {
  const me = meFor(code);
  const query = me ? `?playerId=${me.playerId}&token=${me.token}` : '';
  let game = await api(`/games/${code}${query}`);
  rememberGame(code, game.name);
  const year = Number(tab);
  const P = id => game.players[id];

  const paint = () => {
    // Years still being played (or not reached yet) have no results to show.
    const done = y => game.state.phase === 'done' || game.years.indexOf(y) < game.state.yearIndex || (game.state.phase === 'reveal' && y === game.state.year);
    const sum = Scoring.summary(game, SONGS);
    const tabs = `<nav class="tabs">
      <a href="#/g/${code}/results" class="${tab === 'years' || year ? 'on' : ''}">Years</a>
      <a href="#/g/${code}/results/players" class="${tab === 'players' ? 'on' : ''}">Players</a>
      <a href="#/g/${code}/results/fame" class="${tab === 'fame' ? 'on' : ''}">Hall of Fame</a></nav>`;
    let body = '';

    if (year) {
      const res = Scoring.yearResults(game, SONGS, year);
      const i = game.years.indexOf(year);
      const prev = game.years[i - 1], next = game.years[i + 1];
      body = `
        <div class="row spread" style="margin-bottom:10px">
          ${prev ? `<a class="btn ghost" href="#/g/${code}/results/${prev}">← ${prev}</a>` : '<span></span>'}
          <div class="year-title" style="font-size:2.6rem">${year}</div>
          ${next ? `<a class="btn ghost" href="#/g/${code}/results/${next}">${next} →</a>` : '<span></span>'}
        </div>
        ${!done(year) ? '<p class="center muted">This year hasn\'t been played yet.</p>' : `
        <p class="center muted small">${res.voterCount} voter${res.voterCount === 1 ? '' : 's'} · 5 pts for 1st, 3 for 2nd, 1 for 3rd · 🔮 = #1 guess</p>
        ${res.voterCount ? `<div class="callout ${res.matchesBillboard ? 'win' : ''}" style="margin-bottom:12px">${
          res.matchesBillboard ? `🎯 The group agrees with Billboard: <b>${esc(res.billboardNo1.title)}</b> is #1.`
          : `Group #1: <b>${res.winners.map(w => esc(w.title)).join(' / ')}</b>. Billboard #1: <b>${esc(res.billboardNo1.title)}</b> (group rank ${res.billboardNo1.points ? '#' + res.billboardNo1.groupRank : 'no votes'}).`}</div>` : ''}
        <div class="row" style="margin-bottom:10px"><span class="small muted">Sort:</span>
          <div class="chips"><button class="chip ${!paint.byBB ? 'on' : ''}" data-sort="group">Group ranking</button><button class="chip ${paint.byBB ? 'on' : ''}" data-sort="bb">Billboard ranking</button></div></div>
        <div class="list">${(paint.byBB ? res.rows.slice().sort((a, b) => a.rank - b.rank) : res.rows).map(r => `
          <div class="srow ${r.points ? 'r' + r.groupRank : ''}">
            <div class="gr">${paint.byBB ? '#' + r.rank : r.points ? r.groupRank : '–'}</div>
            <div class="thumb-wrap">${art(r, 'thumb')}${miniPlay(year, r.rank)}</div>
            <div style="min-width:0"><div class="t">${esc(r.title)}</div><div class="a">${esc(r.artist)}
              ${paint.byBB ? (r.points ? `<span class="bb">Group #${r.groupRank}</span>` : '') : `<span class="bb ${r.rank === 1 ? 'one' : ''}">Billboard #${r.rank}</span>`}</div>
              ${r.voters.length || r.predictors.length ? `<div class="voters">${r.voters.map(v => `<span class="vchip p${v.place}">${MEDAL[v.place]} ${P(v.playerId)?.icon || ''} ${esc(P(v.playerId)?.name)}</span>`).join('')}${
                r.predictors.map(id => `<span class="vchip pred">🔮 ${P(id)?.icon || ''} ${esc(P(id)?.name)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="pts"><b>${r.points}</b><span>${r.medals.map((m, k) => m ? `${m}×${MEDAL[k]}` : '').filter(Boolean).join(' ') || 'pts'}</span></div>
          </div>`).join('')}</div>`}`;
    } else if (tab === 'players') {
      body = `<div class="list">${sum.leaderboard.map(p => `
        <div class="pcard">
          <div class="row">${avatar(P(p.playerId))}<b style="font-size:1.1rem">${esc(p.name)}</b><span class="small muted">${p.yearsVoted} year${p.yearsVoted === 1 ? '' : 's'} played</span></div>
          ${p.yearsVoted ? `<div class="grid">
            <div><b>${p.predictCorrect}/${p.predictTotal}</b><span>🔮 Correct #1 guesses</span></div>
            <div><b>${p.chartMatch}</b><span>🎯 Times your 🥇 was Billboard's #1</span></div>
            <div><b>${p.groupSync}</b><span>🤝 Times your 🥇 = the group's #1</span></div>
            <div><b>${p.avgFirstPickRank.toFixed(1)}</b><span>📻 Avg Billboard rank of your 🥇 picks (lower = more mainstream)</span></div>
            <div><b>${p.twin ? Math.round(p.twin.score * 100) + '%' : '–'}</b><span>👯 Taste twin${p.twin ? ': ' + (P(p.twin.playerId)?.icon || '') + ' ' + esc(P(p.twin.playerId)?.name) : ''}</span></div>
          </div>` : ''}
        </div>`).join('') || '<p class="muted">No players yet.</p>'}</div>
        <p class="small muted" style="margin-top:12px">Taste twin = the friend whose medals overlap most with yours (identical top 3s in the same order = 100%).</p>`;
    } else if (tab === 'fame') {
      const songRow = (s, extra) => `<div class="srow"><div class="gr" style="font-size:.85rem">${s.year}</div>
        <div class="thumb-wrap">${art(s, 'thumb')}${miniPlay(s.year, s.rank)}</div>
        <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}</div></div>${extra}</div>`;
      body = `
        <div class="card stack"><h2>🏆 Most-loved songs</h2><p class="small muted">Total points across all years.</p>
          <div class="list">${sum.hallOfFame.map(s => songRow(s, `<div class="pts"><b>${s.points}</b><span>Billboard #${s.rank}</span></div>`)).join('') || '<p class="muted">No votes yet.</p>'}</div></div>
        <div class="card stack" style="margin-top:14px"><h2>🐎 Underdog wins</h2><p class="small muted">Group #1 songs that Billboard ranked 6th or lower.</p>
          <div class="list">${sum.underdogs.map(s => songRow(s, `<span class="bb">Billboard #${s.rank}</span>`)).join('') || '<p class="muted">None yet. You all love the hits.</p>'}</div></div>
        <div class="card stack" style="margin-top:14px"><h2>🙅 Snubbed #1s</h2><p class="small muted">Billboard's #1 song of the year, and not one point from the group.</p>
          <div class="list">${sum.snubs.map(s => songRow(s, `<span class="bb one">#1</span>`)).join('') || '<p class="muted">None yet.</p>'}</div></div>`;
    } else {
      body = `
        <div class="stats" style="margin-bottom:14px">
          <div class="stat"><div class="n">${sum.voted.length}<span class="muted" style="font-size:1rem">/${game.years.length}</span></div><div class="l">Years played</div></div>
          <div class="stat"><div class="n">${sum.voted.length ? Math.round(sum.matches / sum.voted.length * 100) : 0}%</div><div class="l">Group #1 = Billboard #1 (${sum.matches} yr${sum.matches === 1 ? '' : 's'})</div></div>
          <div class="stat"><div class="n">${sum.voted.length ? Math.round(sum.top3 / sum.voted.length * 100) : 0}%</div><div class="l">Billboard #1 made the group's top 3</div></div>
        </div>
        <div class="list">${sum.years.map(y => {
          if (!y.voterCount || !done(y.year)) return `<a class="yrow empty" href="#/g/${code}/results/${y.year}"><div class="y">${y.year}</div><div class="thumb"></div><div class="s">Not played yet</div><span class="muted">›</span></a>`;
          const w = y.winners[0];
          return `<a class="yrow" href="#/g/${code}/results/${y.year}"><div class="y">${y.year}</div>${art(w, 'thumb')}
            <div style="min-width:0"><div class="t">${esc(y.winners.map(x => x.title).join(' / '))}</div>
              <div class="s">${esc(w.artist)} · ${w.points} pts · ${y.voterCount} voter${y.voterCount === 1 ? '' : 's'}</div>
              <div class="s" style="margin-top:3px"><span class="match ${y.matchesBillboard ? 'yes' : 'no'}">${y.matchesBillboard ? '🎯 Same as Billboard #1' : 'Billboard #1: ' + esc(y.billboardNo1.title)}</span></div></div>
            <span class="muted">›</span></a>`;
        }).join('')}</div>`;
    }

    $app.innerHTML = `<div class="fade-in"><div class="center" style="margin-bottom:14px"><h1 style="margin-bottom:2px">${esc(game.name)}</h1>
      <p class="muted small">Group rankings vs. the Billboard Year-End Hot 100 · updates live</p></div>${tabs}${body}</div>`;
    $app.querySelectorAll('[data-sort]').forEach(c => c.onclick = () => { paint.byBB = c.dataset.sort === 'bb'; paint(); });
    Player.paint();
  };
  paint();
  cleanup = () => Player.stop();
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try { const g = await api(`/games/${code}${query}`); if (JSON.stringify({ ...g, now: 0 }) !== JSON.stringify({ ...game, now: 0 })) { game = g; paint(); } } catch { /* ignore */ }
  }, 5000);
}

route();
