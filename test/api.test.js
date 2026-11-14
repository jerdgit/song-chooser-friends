const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songchooser-'));
const { server, YEARS } = require('../server.js');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); })));
test.after(() => server.close());

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('full game flow', async () => {
  const y = YEARS[0];
  const created = await call('POST', '/games', { name: 'T', startYear: y, endYear: y + 2 });
  assert.strictEqual(created.status, 201);
  const { code, hostToken } = created.body;
  assert.match(code, /^[A-Z2-9]{5}$/);

  const a = (await call('POST', `/games/${code}/players`, { name: 'Ann' })).body;
  const again = await call('POST', `/games/${code}/players`, { name: ' ann ' });
  assert.strictEqual(again.body.playerId, a.playerId);     // rejoin by name
  assert.strictEqual(again.body.rejoined, true);
  const b = (await call('POST', `/games/${code}/players`, { name: 'Bo' })).body;

  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { playerId: a.playerId, token: a.token, picks: [1, 2, 3] })).status, 200);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { playerId: a.playerId, token: a.token, picks: [1, 1, 3] })).status, 400);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { playerId: a.playerId, token: a.token, picks: [1, 2, 11] })).status, 400);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/${y}`, { playerId: a.playerId, token: 'nope', picks: [1, 2, 3] })).status, 403);
  assert.strictEqual((await call('PUT', `/games/${code}/votes/1900`, { playerId: a.playerId, token: a.token, picks: [1, 2, 3] })).status, 400);

  const g = (await call('GET', `/games/${code.toLowerCase()}`)).body;
  assert.deepStrictEqual(g.votes[a.playerId][y], [1, 2, 3]);
  assert.strictEqual(g.years.length, 3);
  assert.ok(!JSON.stringify(g).includes(a.token), 'tokens must not leak');
  assert.ok(!JSON.stringify(g).includes(hostToken), 'host token must not leak');

  assert.strictEqual((await call('DELETE', `/games/${code}/players/${b.playerId}`, null, { 'X-Host-Token': 'wrong' })).status, 403);
  assert.strictEqual((await call('DELETE', `/games/${code}/players/${b.playerId}`, null, { 'X-Host-Token': hostToken })).status, 200);
  assert.ok(!(await call('GET', `/games/${code}`)).body.players[b.playerId]);
});

test('unknown game is a 404', async () => {
  assert.strictEqual((await call('GET', '/games/ZZZZZ')).status, 404);
});
