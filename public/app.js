/* Song Chooser — front end. Plain JS, no build step. */
'use strict';

const $app = document.getElementById('app');
const $nav = document.getElementById('topnav');
const PLACE = ['1st', '2nd', '3rd'];
const MEDAL = ['🥇', '🥈', '🥉'];

let SONGS = null;       // { year: [{rank,title,artist,preview,art,link}] }
let YEARS = [];
let pollTimer = null;
let cleanup = null;     // per-view teardown

// ---------------------------------------------------------------- utilities
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
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
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
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
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatar(name) {
  const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="avatar" style="background:hsl(${hue(name)} 80% 72%)">${esc(initials)}</span>`;
}
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

// ---------------------------------------------------------------- audio
const Player = {
  el: new Audio(),
  key: null,
  song: null,
  onEnded: null,  // set by the play screen to auto-advance
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
    try { await this.el.play(); } catch { /* autoplay blocked: user can hit play */ }
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
    // Preview can't be played: let the play screen move on to the next song.
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

// Delegate mini play buttons everywhere.
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
    <a href="#/g/${code}" class="${!h.includes('/results') && !h.includes('/play') ? 'active' : ''}">Lobby</a>
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
    setNav(code);
    if (parts[2] === 'play') return renderPlay(code, Number(parts[3]));
    if (parts[2] === 'results') return renderResults(code, parts[3] || 'years');
    return renderLobby(code);
  } catch (err) {
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
      <p>Every year, the 10 biggest hits. Listen to each one, then crown your top 3.
      Your friends do the same, and at the end you'll see how the group ranked every year next to the real Billboard charts.</p>
    </section>
    <div class="stack">
      ${mine.length ? `<div class="card stack"><h2>Your games</h2><div class="list">${mine.map(g => `
        <a class="yrow" style="grid-template-columns:1fr auto" href="#/g/${esc(g.code)}">
          <div><div class="t">${esc(g.name)}</div><div class="s">Code ${esc(g.code)}</div></div><span class="pill">Open →</span>
        </a>`).join('')}</div></div>` : ''}
      <form class="card stack" id="create">
        <h2>Start a game</h2>
        <div><label for="gname">Game name</label><input type="text" id="gname" maxlength="30" placeholder="e.g. Friday Night Hits" required></div>
        <div>
          <label>Years</label>
          <div class="chips" id="presets">
            <button type="button" class="chip on" data-r="${first}-${last}">All (${first}–${last})</button>
            ${decades.map(d => `<button type="button" class="chip" data-r="${Math.max(d, first)}-${Math.min(d + 9, last)}">${String(d).slice(2)}s</button>`).join('')}
          </div>
        </div>
        <div class="grid2">
          <div><label for="from">From</label><select id="from">${yearOpts(first)}</select></div>
          <div><label for="to">To</label><select id="to">${yearOpts(last)}</select></div>
        </div>
        <p class="small muted">Nobody has to finish every year. Results count whatever each person has voted on.</p>
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

// ---------------------------------------------------------------- lobby / join
async function renderLobby(code) {
  Player.stop();
  let game = await api('/games/' + code);
  rememberGame(code, game.name);
  const me = meFor(code);
  if (!me || !game.players[me.playerId]) return renderJoin(game);

  const paint = () => {
    const myVotes = game.votes[me.playerId] || {};
    const done = game.years.filter(y => myVotes[y]).length;
    const next = game.years.find(y => !myVotes[y]);
    const host = hostFor(code);
    const link = `${location.origin}/#/g/${code}`;
    const players = Object.entries(game.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
    $app.innerHTML = `
      <div class="stack fade-in">
        <div class="center">
          <span class="pill">Hi ${esc(me.name)} 👋</span>
          <h1 style="margin-top:10px">${esc(game.name)}</h1>
          <p class="muted">${game.years[0]}–${game.years.at(-1)} · ${game.years.length} years · 10 songs each</p>
        </div>
        <div class="card stack">
          <div class="row spread"><h2 style="margin:0">Your progress</h2><span class="muted">${done} / ${game.years.length}</span></div>
          <div class="progress"><i style="width:${(done / game.years.length) * 100}%"></i></div>
          ${next ? `<a class="btn primary big block" href="#/g/${code}/play/${next}">${done ? 'Keep going' : 'Start'} with ${next} →</a>`
                 : `<a class="btn primary big block" href="#/g/${code}/results">You've voted on every year. See results →</a>`}
          <div><label>Jump to any year (tap a ✓ year to change your vote)</label>
            <div class="years">${game.years.map(y => `<a class="year-chip ${myVotes[y] ? 'done' : ''}" href="#/g/${code}/play/${y}">${y}</a>`).join('')}</div>
          </div>
        </div>
        <div class="card stack">
          <h2>Invite friends</h2>
          <div class="center"><div class="small muted">Game code</div><div class="code-big">${code}</div></div>
          <div class="share"><input type="text" readonly value="${esc(link)}" id="link"><button class="btn" id="copy">Copy</button></div>
        </div>
        <div class="card stack">
          <div class="row spread"><h2 style="margin:0">Players</h2><a href="#/g/${code}/results" class="pill">Results →</a></div>
          <div class="players">${players.map(([id, p]) => {
            const n = game.years.filter(y => (game.votes[id] || {})[y]).length;
            return `<div class="player">${avatar(p.name)}<div style="flex:1;min-width:0">
                <div class="row spread"><b>${esc(p.name)}${id === me.playerId ? ' (you)' : ''}</b><span class="small muted">${n}/${game.years.length}</span></div>
                <div class="progress" style="margin-top:6px"><i style="width:${(n / game.years.length) * 100}%"></i></div></div>
                ${host && id !== me.playerId ? `<button class="linkbtn small" data-kick="${id}" title="Remove player">✕</button>` : ''}
              </div>`;
          }).join('')}</div>
        </div>
        <p class="center small muted">Not ${esc(me.name)}? <button class="linkbtn" id="switch">Switch player</button></p>
      </div>`;
    document.getElementById('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied!'); }
      catch { document.getElementById('link').select(); toast('Copy the link above'); }
    };
    document.getElementById('switch').onclick = () => { localStorage.removeItem('sc:player:' + code); route(); };
    document.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
      const p = game.players[b.dataset.kick];
      if (!confirm(`Remove ${p.name} and all of their votes?`)) return;
      try { await api(`/games/${code}/players/${b.dataset.kick}`, { method: 'DELETE', headers: { 'X-Host-Token': host } }); game = await api('/games/' + code); paint(); }
      catch (err) { toast(err.message); }
    });
  };
  paint();
  pollTimer = setInterval(async () => {
    if (document.hidden || document.activeElement?.id === 'link') return;
    try { const g = await api('/games/' + code); if (JSON.stringify(g) !== JSON.stringify(game)) { game = g; paint(); } } catch { /* ignore */ }
  }, 6000);
}

function renderJoin(game) {
  const names = Object.values(game.players).map(p => p.name);
  $app.innerHTML = `
    <div class="stack fade-in">
      <div class="center"><span class="pill">You're invited</span><h1 style="margin-top:10px">${esc(game.name)}</h1>
        <p class="muted">Rank the top songs of ${game.years[0]}–${game.years.at(-1)} with your friends.</p></div>
      <form class="card stack" id="joinf">
        <div><label for="name">Your name</label><input type="text" id="name" maxlength="30" placeholder="What should friends call you?" required autofocus></div>
        <button class="btn primary block big">Join game</button>
        ${names.length ? `<p class="small muted">Already playing: ${names.map(esc).join(', ')}.<br>On a new device? Enter the same name to pick up where you left off.</p>` : ''}
      </form>
    </div>`;
  document.getElementById('joinf').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    try {
      const r = await api(`/games/${game.code}/players`, { method: 'POST', body: { name } });
      store.set('sc:player:' + game.code, { playerId: r.playerId, token: r.token, name: name.trim() });
      if (r.rejoined) toast('Welcome back!');
      route();
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------- play a year
async function renderPlay(code, year) {
  const me = meFor(code);
  if (!me) { location.hash = `#/g/${code}`; return; }
  let game = await api('/games/' + code);
  if (!game.players[me.playerId]) { location.hash = `#/g/${code}`; return; }
  if (!game.years.includes(year)) throw new Error('That year is not part of this game.');

  const order = seededOrder(`${me.playerId}:${year}`, SONGS[year].map(s => s.rank));
  const existing = (game.votes[me.playerId] || {})[year];
  // Steps: 'intro' -> 'board' (songs are revealed and played one by one, and picked on the same screen) -> 'reveal'
  const st = {
    step: existing ? 'board' : 'intro',
    picks: existing ? existing.slice() : [],
    changing: !!existing,
    revealed: existing ? order.length : 0,   // how many songs are showing
    autoplay: false,                          // keep moving to the next song when one ends
    pop: null,                                // rank of the song that just appeared (for the animation)
  };
  const yi = game.years.indexOf(year);
  const current = () => songOf(year, order[st.revealed - 1]);
  const curKey = () => `${year}-${order[st.revealed - 1]}`;

  const go = step => { st.step = step; st.animate = true; draw(); window.scrollTo(0, 0); };
  const redraw = () => { const y = window.scrollY; st.animate = false; draw(); window.scrollTo(0, y); };

  async function playCurrent() {
    const key = curKey();
    const ok = await Player.play(year, current());
    // No preview for this one: give it a moment on screen, then keep going.
    if (!ok) setTimeout(() => { if (st.autoplay && curKey() === key) advance(); }, 2500);
  }
  function advance() {
    if (st.revealed < order.length) {
      st.revealed++;
      st.autoplay = true;
      st.pop = order[st.revealed - 1];
      redraw();
      document.querySelector(`[data-tile="${st.pop}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      playCurrent();
    } else {
      st.autoplay = false;
      redraw();
    }
  }
  function showAll() { st.revealed = order.length; st.autoplay = false; st.pop = null; Player.stop(); redraw(); }

  // When the song that's "up" finishes, reveal and play the next one.
  Player.onEnded = key => { if (st.step === 'board' && st.autoplay && key === curKey()) advance(); };

  function draw() {
    if (st.step === 'intro') {
      $app.innerHTML = `
        <div class="center stack fade-in" style="padding-top:30px">
          <div class="muted">Year ${yi + 1} of ${game.years.length}</div>
          <div class="year-title">${year}</div>
          <p class="muted">Ten of the year's biggest songs, shuffled. They'll appear and play one at a time. Pick your top 3 whenever you're ready.</p>
          <button class="btn primary big" id="begin">▶ Start listening</button>
          <div><button class="linkbtn" id="skip">I know these. Show them all</button></div>
        </div>`;
      document.getElementById('begin').onclick = () => { st.revealed = 1; st.autoplay = true; st.pop = order[0]; go('board'); playCurrent(); };
      document.getElementById('skip').onclick = () => { st.revealed = order.length; go('board'); };
      return;
    }

    if (st.step === 'board') {
      const listening = st.revealed > 0 && (st.revealed < order.length || st.autoplay);
      const cur = st.revealed ? current() : null;
      const slot = i => {
        const r = st.picks[i]; const s = r && songOf(year, r);
        return `<div class="slot p${i + 1} ${s ? 'filled' : ''}"><span class="medal">${MEDAL[i]}</span>
          ${s ? `<b>${esc(s.title)}</b><span class="muted">${esc(s.artist)}</span>` : `<span class="muted">${PLACE[i]} · ${Scoring.POINTS[i]} pt${i < 2 ? 's' : ''}</span>`}</div>`;
      };
      $app.innerHTML = `
        <div class="${st.animate ? 'fade-in' : ''}">
          ${listening ? `
          <div class="now-playing">
            ${cur.art ? `<img src="${esc(cur.art)}" alt="">` : `<div class="ph">${esc(cur.title[0])}</div>`}
            <div style="min-width:0">
              <div class="np-label">Song ${st.revealed} of ${order.length}</div>
              <div class="t">${esc(cur.title)}</div><div class="a">${esc(cur.artist)}</div>
            </div>
            <div class="np-controls">
              <button class="np-play" data-play="${curKey()}" aria-label="Play preview">▶</button>
              <button class="btn primary np-next" id="next">${st.revealed < order.length ? 'Next ›' : 'Done'}</button>
            </div>
            <div class="progress np-progress"><i data-progress="${curKey()}"></i></div>
          </div>` : ''}
          <div class="row spread" style="margin-bottom:8px">
            <h2 style="margin:0">Your top 3 of ${year}</h2>
            ${st.revealed < order.length ? `<button class="linkbtn small" id="showall">Show all songs</button>` : ''}
          </div>
          <p class="muted small">Tap a song to pick it: first tap is 1st place. Tap a picked song to remove it. ${listening ? 'Each song plays in turn.' : 'Tap ▶ on any song to hear it again.'}</p>
          <div class="slots">${[0, 1, 2].map(slot).join('')}</div>
          <div class="tiles">${order.map((r, i) => {
            if (i >= st.revealed) return `<div class="tile locked" aria-hidden="true"><div class="ph">${i + 1}</div><div class="meta"><div class="tw"><span class="t">Song ${i + 1}</span></div><div class="a">Up next</div></div></div>`;
            const s = songOf(year, r); const p = st.picks.indexOf(r);
            const now = listening && i === st.revealed - 1;
            return `<div class="tile ${p >= 0 ? 'p' + (p + 1) : ''} ${now ? 'now' : ''} ${st.pop === r ? 'pop' : ''}" data-pick="${r}" data-tile="${r}" role="button" tabindex="0" aria-pressed="${p >= 0}">
              ${s.art ? `<img src="${esc(s.art)}" alt="" loading="lazy">` : `<div class="ph">${esc(s.title[0])}</div>`}
              ${p >= 0 ? `<span class="badge">${p + 1}</span>` : ''}
              ${now ? '<span class="now-tag" title="Now playing">♪</span>' : ''}
              <div class="meta">
                <div class="tw"><button class="tile-play" data-play="${year}-${r}" aria-label="Play preview">▶</button><span class="t">${esc(s.title)}</span></div>
                <div class="a">${esc(s.artist)}</div>
              </div>
            </div>`;
          }).join('')}</div>
          <div class="sticky-submit">
            <button class="btn primary big block" id="submit" ${st.picks.length === 3 ? '' : 'disabled'}>
              ${st.picks.length === 3 ? (st.changing ? 'Save my new picks' : 'Lock in my picks') : `Pick ${3 - st.picks.length} more`}
            </button>
          </div>
        </div>`;
      st.pop = null;
      Player.paint();
      $app.querySelectorAll('[data-pick]').forEach(t => {
        const act = e => {
          if (e.target.closest('[data-play]')) return;  // ▶ only plays; it never picks
          const r = Number(t.dataset.pick); const i = st.picks.indexOf(r);
          if (i >= 0) st.picks.splice(i, 1);
          else if (st.picks.length < 3) st.picks.push(r);
          else return toast('You already have 3. Tap one to remove it.');
          redraw();
        };
        t.addEventListener('click', act);
        t.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-play]')) { e.preventDefault(); act(e); } });
      });
      document.getElementById('next')?.addEventListener('click', advance);
      document.getElementById('showall')?.addEventListener('click', showAll);
      document.getElementById('submit').onclick = async e => {
        e.currentTarget.disabled = true;
        try {
          await api(`/games/${code}/votes/${year}`, { method: 'PUT', body: { playerId: me.playerId, token: me.token, picks: st.picks } });
          st.autoplay = false;
          Player.stop();
          game = await api('/games/' + code);
          go('reveal');
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      };
      return;
    }

    if (st.step === 'reveal') {
      const res = Scoring.yearResults(game, SONGS, year);
      const bb = res.billboardNo1;
      const myVotes = game.votes[me.playerId] || {};
      const next = game.years.slice(yi + 1).find(y => !myVotes[y]) || game.years.find(y => !myVotes[y]);
      const hit = st.picks[0] === 1;
      const top = res.rows.filter(r => r.points > 0).slice(0, 3);
      $app.innerHTML = `
        <div class="stack fade-in">
          <div class="center"><div class="year-title" style="font-size:3.2rem">${year}</div><p class="muted">Picks saved ✓</p></div>
          <div class="callout ${hit ? 'win' : ''}">
            ${hit ? `<b>🎯 Chart match!</b> Your #1 was also Billboard's #1 song of ${year}.`
                  : `<b>Billboard's #1 of ${year}:</b> ${esc(bb.title)} by ${esc(bb.artist)}`}
          </div>
          <div class="card stack">
            <h3>Where your picks landed on the Billboard year-end chart</h3>
            <div class="list">${st.picks.map((r, i) => { const s = songOf(year, r); return `
              <div class="srow"><div class="gr">${MEDAL[i]}</div>
                <div class="thumb-wrap">${art(s, 'thumb')}${miniPlay(year, r)}</div>
                <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}</div></div>
                <span class="bb ${r === 1 ? 'one' : ''}">Billboard #${r}</span></div>`; }).join('')}
            </div>
          </div>
          <div class="card stack">
            <div class="row spread"><h3 style="margin:0">The group so far</h3><span class="small muted">${res.voterCount} voter${res.voterCount === 1 ? '' : 's'}</span></div>
            <div class="list">${top.map(r => `
              <div class="srow r${r.groupRank}"><div class="gr">${r.groupRank}</div>
                <div class="thumb-wrap">${art(r, 'thumb')}${miniPlay(year, r.rank)}</div>
                <div style="min-width:0"><div class="t">${esc(r.title)}</div><div class="a">${esc(r.artist)}</div></div>
                <div class="pts"><b>${r.points}</b><span>pts</span></div></div>`).join('')}
            </div>
            <a class="linkbtn small" href="#/g/${code}/results/${year}">Full ${year} results →</a>
          </div>
          ${next ? `<a class="btn primary big block" href="#/g/${code}/play/${next}">On to ${next} →</a>`
                 : `<a class="btn primary big block" href="#/g/${code}/results">All done! See the results →</a>`}
          <a class="btn ghost block" href="#/g/${code}">Back to lobby</a>
        </div>`;
      Player.paint();
    }
  }

  const onKey = e => {
    if (st.step !== 'board' || !st.revealed || e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); advance(); }
    if (e.key === ' ' && !e.target.closest('[data-pick]')) { e.preventDefault(); Player.toggle(year, current()); }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => { document.removeEventListener('keydown', onKey); Player.onEnded = null; Player.stop(); };
  draw();
}

// ---------------------------------------------------------------- results
async function renderResults(code, tab) {
  let game = await api('/games/' + code);
  rememberGame(code, game.name);
  const me = meFor(code);
  const year = Number(tab);
  const nameOf = id => game.players[id]?.name || '?';

  const paint = () => {
    const sum = Scoring.summary(game, SONGS);
    const tabs = `<nav class="tabs">
      <a href="#/g/${code}/results" class="${tab === 'years' || year ? 'on' : ''}">Years</a>
      <a href="#/g/${code}/results/friends" class="${tab === 'friends' ? 'on' : ''}">Friends</a>
      <a href="#/g/${code}/results/fame" class="${tab === 'fame' ? 'on' : ''}">Hall of Fame</a></nav>`;
    let body = '';

    if (year) {
      const res = Scoring.yearResults(game, SONGS, year);
      const i = game.years.indexOf(year);
      const prev = game.years[i - 1], next = game.years[i + 1];
      const iVoted = me && (game.votes[me.playerId] || {})[year];
      body = `
        <div class="row spread" style="margin-bottom:10px">
          ${prev ? `<a class="btn ghost" href="#/g/${code}/results/${prev}">← ${prev}</a>` : '<span></span>'}
          <div class="year-title" style="font-size:2.6rem">${year}</div>
          ${next ? `<a class="btn ghost" href="#/g/${code}/results/${next}">${next} →</a>` : '<span></span>'}
        </div>
        <p class="center muted small">${res.voterCount} voter${res.voterCount === 1 ? '' : 's'} · 5 pts for 1st, 3 for 2nd, 1 for 3rd
          ${me && !iVoted ? ` · <a href="#/g/${code}/play/${year}">Cast your vote</a>` : ''}</p>
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
              ${r.voters.length ? `<div class="voters">${r.voters.map(v => `<span class="vchip p${v.place}">${MEDAL[v.place]} ${esc(nameOf(v.playerId))}</span>`).join('')}</div>` : ''}
            </div>
            <div class="pts"><b>${r.points}</b><span>${r.medals.map((m, k) => m ? `${m}×${MEDAL[k]}` : '').filter(Boolean).join(' ') || 'pts'}</span></div>
          </div>`).join('')}</div>`;
    } else if (tab === 'friends') {
      body = `<div class="list">${sum.players.map(p => `
        <div class="pcard">
          <div class="row">${avatar(p.name)}<b style="font-size:1.1rem">${esc(p.name)}</b><span class="small muted">${p.yearsVoted} of ${game.years.length} years voted</span></div>
          ${p.yearsVoted ? `<div class="grid">
            <div><b>${p.chartMatch}</b><span>🎯 Times your #1 = Billboard #1</span></div>
            <div><b>${p.groupSync}</b><span>🤝 Times your #1 = group #1</span></div>
            <div><b>${p.avgFirstPickRank.toFixed(1)}</b><span>📻 Avg Billboard rank of your #1 picks (lower = more mainstream)</span></div>
            <div><b>${p.twin ? Math.round(p.twin.score * 100) + '%' : '–'}</b><span>👯 Taste twin${p.twin ? ': ' + esc(nameOf(p.twin.playerId)) : ''}</span></div>
          </div>` : ''}
        </div>`).join('') || '<p class="muted">No players yet.</p>'}</div>
        <p class="small muted" style="margin-top:12px">Taste twin = the friend whose picks overlap most with yours (identical top 3s in the same order = 100%).</p>`;
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
          <div class="stat"><div class="n">${sum.voted.length}<span class="muted" style="font-size:1rem">/${game.years.length}</span></div><div class="l">Years with votes</div></div>
          <div class="stat"><div class="n">${sum.voted.length ? Math.round(sum.matches / sum.voted.length * 100) : 0}%</div><div class="l">Group #1 = Billboard #1 (${sum.matches} yr${sum.matches === 1 ? "" : "s"})</div></div>
          <div class="stat"><div class="n">${sum.voted.length ? Math.round(sum.top3 / sum.voted.length * 100) : 0}%</div><div class="l">Billboard #1 made the group's top 3</div></div>
        </div>
        <div class="list">${sum.years.map(y => {
          if (!y.voterCount) return `<a class="yrow empty" href="#/g/${code}/results/${y.year}"><div class="y">${y.year}</div><div class="thumb"></div><div class="s">No votes yet</div><span class="muted">›</span></a>`;
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
    try { const g = await api('/games/' + code); if (JSON.stringify(g) !== JSON.stringify(game)) { game = g; paint(); } } catch { /* ignore */ }
  }, 5000);
}

route();
