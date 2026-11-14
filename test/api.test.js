const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songchooser-'));
process.env.REVEAL_SECONDS = '1';
const { server, YEARS } = require('../server.js');
const { ICONS } = require('../public/scoring.js');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); })));
test.after(() => server.close());

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const state = async (code, who) => (await call('GET', `/games/${code}` + (who ? `?playerId=${who.playerId}&token=${who.token}` : ''))).body;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('live game: lobby, lock-in, secret picks, reveal, next year, done', async () => {
  const y = YEARS[0];
  const { body: { code, hostToken } } = await call('POST', '/games', { name: 'T', startYear: y, endYear: y + 1 });
  assert.match(code, /^[A-Z2-9]{5}$/);

  // Join with icons; icons are unique.
  const host = (await call('POST', `/games/${code}/players`, { name: 'Host', icon: ICONS[0], hostToken })).body;
  assert.strictEqual((await call('POST', `/games/${code}/players`, { name: 'Bo', icon: ICONS[0] })).status, 409);
  assert.strictEqual((await call('POST', `/games/${code}/players`, { name: 'Bo', icon: 'nope' })).status, 400);
  const bo = (await call('POST', `/games/${code}/players`, { name: 'Bo', icon: ICONS[1] })).body;
  assert.strictEqual((await call('PATCH', `/games/${code}/players/${bo.playerId}`, { token: bo.token, icon: ICONS[0] })).status, 409);
  assert.strictEqual((await call('PATCH', `/games/${code}/players/${bo.playerId}`, { token: bo.token, icon: ICONS[2] })).status, 200);

  let s = await state(code);
  assert.strictEqual(s.state.phase, 'lobby');
  assert.strictEqual(s.players[host.playerId].isHost, true);
  assert.strictEqual(s.players[bo.playerId].icon, ICONS[2]);
  assert.ok(!JSON.stringify(s).includes(host.token) && !JSON.stringify(s).includes(hostToken), 'tokens must not leak');

  // Voting before the start is refused; only the host can start.
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { ...bo, picks: [1, 2, 3], predict: 1 })).status, 409);
  assert.strictEqual((await call('POST', `/games/${code}/host`, { hostToken: 'x', action: 'start' })).status, 403);
  assert.strictEqual((await call('POST', `/games/${code}/host`, { hostToken, action: 'start' })).status, 200);
  s = await state(code);
  assert.strictEqual(s.state.phase, 'picking');
  assert.strictEqual(s.state.year, y);

  // Validation: medals on 3 different songs, plus a prediction; only the current year.
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { ...bo, picks: [1, 1, 3], predict: 1 })).status, 400);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { ...bo, picks: [1, 2, 3] })).status, 400);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y + 1}`, { ...bo, picks: [1, 2, 3], predict: 1 })).status, 409);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { ...bo, token: 'bad', picks: [1, 2, 3], predict: 1 })).status, 403);

  // Bo locks in: others can't see Bo's picks yet, Bo can.
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { ...bo, picks: [4, 5, 6], predict: 1 })).status, 200);
  s = await state(code, host);
  assert.deepStrictEqual(s.locked, [bo.playerId]);
  assert.strictEqual(s.votes[bo.playerId][y], undefined, "others' picks stay secret until the reveal");
  assert.strictEqual(s.predictions[bo.playerId][y], undefined);
  assert.deepStrictEqual((await state(code, bo)).votes[bo.playerId][y], [4, 5, 6]);

  // Unlock and re-lock.
  assert.strictEqual((await call('DELETE', `/games/${code}/votes/${y}`, bo)).status, 200);
  assert.deepStrictEqual((await state(code)).locked, []);
  await call('PUT', `/games/${code}/votes/${y}`, { ...bo, picks: [4, 5, 6], predict: 1 });

  // Last player locks in -> reveal, picks become visible.
  await call('PUT', `/games/${code}/votes/${y}`, { ...host, picks: [1, 2, 3], predict: 2 });
  s = await state(code);
  assert.strictEqual(s.state.phase, 'reveal');
  assert.deepStrictEqual(s.votes[host.playerId][y], [1, 2, 3]);
  assert.strictEqual(s.predictions[bo.playerId][y], 1);
  assert.strictEqual((await call('DELETE', `/games/${code}/votes/${y}`, bo)).status, 409, 'no changes after the reveal');

  // Host can pause; the reveal then stays put.
  await call('POST', `/games/${code}/host`, { hostToken, action: 'pause' });
  await sleep(1200);
  assert.strictEqual((await state(code)).state.phase, 'reveal');
  await call('POST', `/games/${code}/host`, { hostToken, action: 'next' });
  s = await state(code);
  assert.strictEqual(s.state.phase, 'picking');
  assert.strictEqual(s.state.year, y + 1);

  // Host can reveal without waiting for everyone; the reveal timer then moves on by itself.
  await call('PUT', `/games/${code}/votes/${y + 1}`, { ...host, picks: [1, 2, 3], predict: 1 });
  assert.strictEqual((await call('POST', `/games/${code}/host`, { hostToken, action: 'reveal' })).status, 200);
  assert.strictEqual((await state(code)).state.phase, 'reveal');
  await sleep(1200);
  assert.strictEqual((await state(code)).state.phase, 'done', 'last year -> done after the reveal timer');
});

test('removing the last holdout reveals the year', async () => {
  const y = YEARS[5];
  const { body: { code, hostToken } } = await call('POST', '/games', { name: 'K', startYear: y, endYear: y });
  const a = (await call('POST', `/games/${code}/players`, { name: 'A', icon: ICONS[3], hostToken })).body;
  const b = (await call('POST', `/games/${code}/players`, { name: 'B', icon: ICONS[4] })).body;
  await call('POST', `/games/${code}/host`, { hostToken, action: 'start' });
  await call('PUT', `/games/${code}/votes/${y}`, { ...a, picks: [1, 2, 3], predict: 1 });
  assert.strictEqual((await state(code)).state.phase, 'picking');
  assert.strictEqual((await call('DELETE', `/games/${code}/players/${b.playerId}`, null, { 'X-Host-Token': 'wrong' })).status, 403);
  assert.strictEqual((await call('DELETE', `/games/${code}/players/${b.playerId}`, null, { 'X-Host-Token': hostToken })).status, 200);
  assert.strictEqual((await state(code)).state.phase, 'reveal');
});

test('re-join by name keeps the same player', async () => {
  const { body: { code } } = await call('POST', '/games', { name: 'R', startYear: YEARS[0], endYear: YEARS[0] });
  const a = (await call('POST', `/games/${code}/players`, { name: 'Ann', icon: ICONS[5] })).body;
  const again = await call('POST', `/games/${code}/players`, { name: ' ann ', icon: ICONS[6] });
  assert.strictEqual(again.body.playerId, a.playerId);
  assert.strictEqual(again.body.rejoined, true);
});

test('unknown game is a 404', async () => {
  assert.strictEqual((await call('GET', '/games/ZZZZZ')).status, 404);
});
