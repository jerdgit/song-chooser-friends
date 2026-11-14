#!/usr/bin/env node
// Clear out saved games.
//
//   npm run clear-games                 list games, then delete ALL of them (asks first)
//   npm run clear-games -- ABCDE XYZ12  delete only these game codes
//   npm run clear-games -- --list       just list games, change nothing
//   add --yes to skip the confirmation
//
// A backup copy of the data file is written next to it before anything is deleted.
// Stop the server (npm start) first: it keeps games in memory and would write them back.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 3000;
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const codes = args.filter(a => !a.startsWith('--')).map(c => c.toUpperCase());

function serverIsRunning() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/games/____', timeout: 1000 }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

(async () => {
  if (!fs.existsSync(DB_FILE)) { console.log(`No saved games (${DB_FILE} doesn't exist). Nothing to clear.`); return; }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const games = Object.values(db.games || {});

  if (!games.length) { console.log('No saved games. Nothing to clear.'); return; }
  console.log(`Saved games (${games.length}):`);
  for (const g of games.sort((a, b) => a.createdAt - b.createdAt)) {
    const players = Object.values(g.players).map(p => p.name);
    const votes = Object.values(g.votes).reduce((n, v) => n + Object.keys(v).length, 0);
    console.log(`  ${g.code}  "${g.name}"  ${g.years[0]}–${g.years.at(-1)}  created ${new Date(g.createdAt).toLocaleDateString()}  ` +
      `${players.length} player${players.length === 1 ? '' : 's'}${players.length ? ` (${players.join(', ')})` : ''}, ${votes} year-vote${votes === 1 ? '' : 's'}`);
  }
  if (flags.has('--list')) return;

  const unknown = codes.filter(c => !db.games[c]);
  if (unknown.length) { console.error(`\nNo game with code: ${unknown.join(', ')}`); process.exit(1); }
  const targets = codes.length ? codes : Object.keys(db.games);

  if (await serverIsRunning()) {
    console.error(`\nThe game server is running on port ${PORT}. Stop it first (Ctrl+C in its terminal),`);
    console.error('otherwise it will write the games right back. Then run this again.');
    process.exit(1);
  }

  if (!flags.has('--yes')) {
    const what = codes.length ? `game${targets.length === 1 ? '' : 's'} ${targets.join(', ')}` : `ALL ${targets.length} games`;
    const answer = await ask(`\nDelete ${what} and their votes? Type "yes" to confirm: `);
    if (answer !== 'yes') { console.log('Cancelled. Nothing was changed.'); return; }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(DATA_DIR, `db.backup-${stamp}.json`);
  fs.copyFileSync(DB_FILE, backup);
  for (const c of targets) delete db.games[c];
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);

  console.log(`\nDeleted ${targets.length} game${targets.length === 1 ? '' : 's'}. ${Object.keys(db.games).length} left.`);
  console.log(`Backup saved to ${backup}`);
  console.log('To undo: stop the server, then copy the backup over data/db.json.');
})();
