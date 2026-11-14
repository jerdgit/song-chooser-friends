// Scoring + stats for Song Chooser. Works in the browser (window.Scoring) and in Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const POINTS = [5, 3, 1]; // 1st, 2nd, 3rd

  // Results for one year: one row per song, sorted by group ranking.
  function yearResults(game, songs, year) {
    const rows = songs[year].map(s => ({ ...s, points: 0, medals: [0, 0, 0], voters: [] }));
    const byRank = Object.fromEntries(rows.map(r => [r.rank, r]));
    let voterCount = 0;
    for (const [playerId, votes] of Object.entries(game.votes)) {
      const picks = votes[year];
      if (!picks || !game.players[playerId]) continue;
      voterCount++;
      picks.forEach((rank, place) => {
        const row = byRank[rank];
        if (!row) return;
        row.points += POINTS[place];
        row.medals[place]++;
        row.voters.push({ playerId, place });
      });
    }
    const cmp = (a, b) => b.points - a.points || b.medals[0] - a.medals[0] || b.medals[1] - a.medals[1];
    rows.sort((a, b) => cmp(a, b) || a.rank - b.rank);
    // Shared ("1224") ranking: songs tie when points and medal counts are identical.
    rows.forEach((r, i) => { r.groupRank = i > 0 && cmp(rows[i - 1], r) === 0 ? rows[i - 1].groupRank : i + 1; });
    for (const r of rows) r.voters.sort((a, b) => a.place - b.place);
    const billboardNo1 = byRank[1];
    const winners = voterCount ? rows.filter(r => r.groupRank === 1) : [];
    return {
      year, rows, voterCount, billboardNo1, winners,
      matchesBillboard: voterCount > 0 && billboardNo1.groupRank === 1,
      billboardNo1InTop3: voterCount > 0 && billboardNo1.groupRank <= 3 && billboardNo1.points > 0,
    };
  }

  // Taste similarity between two players: overlap of points given to the same songs,
  // as a share of the maximum (9 points per shared year).
  function similarity(game, a, b) {
    let shared = 0, years = 0;
    for (const year of Object.keys(game.votes[a] || {})) {
      const pa = game.votes[a][year], pb = (game.votes[b] || {})[year];
      if (!pa || !pb) continue;
      years++;
      pa.forEach((rank, i) => { const j = pb.indexOf(rank); if (j >= 0) shared += Math.min(POINTS[i], POINTS[j]); });
    }
    return years ? { score: shared / (9 * years), years } : null;
  }

  function summary(game, songs) {
    const years = game.years.map(y => yearResults(game, songs, y));
    const voted = years.filter(y => y.voterCount > 0);
    const playerIds = Object.keys(game.players);

    const players = playerIds.map(id => {
      const votes = game.votes[id] || {};
      const yrs = Object.keys(votes).filter(y => game.years.includes(Number(y)));
      let chartMatch = 0, groupSync = 0, firstRankSum = 0, top3Hits = 0;
      for (const y of yrs) {
        const picks = votes[y];
        const yr = years.find(r => String(r.year) === String(y));
        if (picks[0] === 1) chartMatch++;
        if (yr && yr.winners.some(w => w.rank === picks[0])) groupSync++;
        firstRankSum += picks[0];
        top3Hits += picks.filter(r => r <= 3).length;
      }
      let twin = null;
      for (const other of playerIds) {
        if (other === id) continue;
        const s = similarity(game, id, other);
        if (s && (!twin || s.score > twin.score)) twin = { playerId: other, ...s };
      }
      return {
        playerId: id, name: game.players[id].name, yearsVoted: yrs.length,
        chartMatch, groupSync, top3Hits,
        avgFirstPickRank: yrs.length ? firstRankSum / yrs.length : null, // lower = more mainstream
        twin,
      };
    }).sort((a, b) => b.yearsVoted - a.yearsVoted || a.name.localeCompare(b.name));

    const allSongs = voted.flatMap(y => y.rows.filter(r => r.points > 0).map(r => ({ ...r, year: y.year })))
      .sort((a, b) => b.points - a.points || b.medals[0] - a.medals[0] || a.rank - b.rank);

    return {
      years, voted, players,
      matches: voted.filter(y => y.matchesBillboard).length,
      top3: voted.filter(y => y.billboardNo1InTop3).length,
      hallOfFame: allSongs.slice(0, 15),
      snubs: voted.filter(y => y.billboardNo1.points === 0).map(y => ({ ...y.billboardNo1, year: y.year, voterCount: y.voterCount })),
      underdogs: voted.flatMap(y => y.winners.filter(w => w.rank >= 6).map(w => ({ ...w, year: y.year }))),
    };
  }

  return { POINTS, yearResults, similarity, summary };
});
