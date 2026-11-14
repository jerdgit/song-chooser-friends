const test = require('node:test');
const assert = require('node:assert');
const Scoring = require('../public/scoring.js');

const songs = { 2000: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, title: 'S' + (i + 1), artist: 'A' })) };
const game = (votes, predictions = {}) => ({
  years: [2000],
  players: Object.fromEntries(Object.keys(votes).map(id => [id, { name: id }])),
  votes: Object.fromEntries(Object.entries(votes).map(([id, picks]) => [id, picks ? { 2000: picks } : {}])),
  predictions: Object.fromEntries(Object.entries(predictions).map(([id, r]) => [id, { 2000: r }])),
});

test('5/3/1 points are summed per song', () => {
  const r = Scoring.yearResults(game({ a: [1, 2, 3], b: [2, 1, 4], c: [2, 5, 1] }), songs, 2000);
  const pts = Object.fromEntries(r.rows.map(x => [x.rank, x.points]));
  assert.deepStrictEqual([pts[1], pts[2], pts[3], pts[4], pts[5]], [5 + 3 + 1, 3 + 5 + 5, 1, 1, 3]);
  assert.strictEqual(r.voterCount, 3);
  assert.strictEqual(r.rows[0].rank, 2);       // 13 pts wins
  assert.strictEqual(r.matchesBillboard, false);
  assert.strictEqual(r.billboardNo1.groupRank, 2);
});

test('ties share a rank; first-place votes break point ties', () => {
  // song 1: 5 (one 1st) vs song 2: 3+1+1 = 5 (no 1sts) -> song 1 ahead
  const r = Scoring.yearResults(game({ a: [1, 2, 3], b: [4, 5, 2], c: [6, 7, 2] }), songs, 2000);
  const s1 = r.rows.find(x => x.rank === 1), s2 = r.rows.find(x => x.rank === 2);
  assert.ok(s1.groupRank < s2.groupRank);
  // songs 3,5,7 each have exactly one... 3 has one 3rd (1pt); 5 and 7 have one 2nd each (3pts) -> tie
  const s5 = r.rows.find(x => x.rank === 5), s7 = r.rows.find(x => x.rank === 7);
  assert.strictEqual(s5.groupRank, s7.groupRank);
});

test('group #1 matching Billboard #1 is detected', () => {
  const r = Scoring.yearResults(game({ a: [1, 2, 3], b: [1, 3, 2] }), songs, 2000);
  assert.strictEqual(r.matchesBillboard, true);
  assert.strictEqual(r.billboardNo1InTop3, true);
});

test('no votes means no winner', () => {
  const r = Scoring.yearResults(game({ a: null }), songs, 2000);
  assert.strictEqual(r.voterCount, 0);
  assert.strictEqual(r.winners.length, 0);
  assert.strictEqual(r.matchesBillboard, false);
});

test('similarity: identical picks = 100%, disjoint = 0%', () => {
  const g = game({ a: [1, 2, 3], b: [1, 2, 3], c: [4, 5, 6] });
  assert.strictEqual(Scoring.similarity(g, 'a', 'b').score, 1);
  assert.strictEqual(Scoring.similarity(g, 'a', 'c').score, 0);
});

test('summary stats per player', () => {
  const s = Scoring.summary(game({ a: [1, 2, 3], b: [7, 1, 2] }), songs);
  const a = s.players.find(p => p.playerId === 'a'), b = s.players.find(p => p.playerId === 'b');
  assert.strictEqual(a.chartMatch, 1);
  assert.strictEqual(b.chartMatch, 0);
  assert.strictEqual(b.avgFirstPickRank, 7);
  assert.strictEqual(a.twin.playerId, 'b');
  assert.strictEqual(s.voted.length, 1);
});

test('#1 predictions: 1 point for guessing Billboard #1, leaderboard shares places on ties', () => {
  const g = game({ a: [1, 2, 3], b: [4, 5, 6], c: [7, 8, 9] }, { a: 1, b: 2, c: 1 });
  const s = Scoring.summary(g, songs);
  const by = id => s.players.find(p => p.playerId === id);
  assert.strictEqual(by('a').predictCorrect, 1);
  assert.strictEqual(by('b').predictCorrect, 0);
  assert.strictEqual(by('c').predictTotal, 1);
  assert.deepStrictEqual(s.leaderboard.map(p => [p.playerId, p.place]), [['a', 1], ['c', 1], ['b', 3]]);
  const r = Scoring.yearResults(g, songs, 2000);
  assert.deepStrictEqual(r.rows.find(x => x.rank === 1).predictors.sort(), ['a', 'c']);
});
