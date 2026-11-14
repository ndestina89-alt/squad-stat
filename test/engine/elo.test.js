import test from 'node:test';
import assert from 'node:assert/strict';
import { computeElo, eloExpected, eloUpdate, goalDifferenceMultiplier } from '../../engine/elo.js';

const m = (id, h, a, hg, ag, date, kickoff = `${date}T15:00:00Z`) => ({ id, homeTeamId: h, awayTeamId: a, homeGoals: hg, awayGoals: ag, status: 'finished', matchDate: date, kickoffUtc: kickoff });

test('expected score is 0.5 for equal ratings without home advantage, and symmetric', () => {
  assert.equal(eloExpected(1500, 1500, 0), 0.5);
  assert.ok(Math.abs(eloExpected(1600, 1500, 0) + eloExpected(1500, 1600, 0) - 1) < 1e-15);
  assert.ok(eloExpected(1500, 1500) > 0.5, 'home advantage helps the home side');
});
test('goal-difference multiplier', () => {
  assert.deepEqual([0, 1, 2, 3, 5].map(goalDifferenceMultiplier), [1, 1, 1.5, 1.75, 2]);
  assert.equal(goalDifferenceMultiplier(-3), goalDifferenceMultiplier(3));
});
test('update is zero-sum, rewards the winner and scales with margin', () => {
  const a = eloUpdate(1500, 1500, 1, 0);
  const b = eloUpdate(1500, 1500, 4, 0);
  assert.ok(Math.abs(a.home + a.away - 3000) < 1e-12);
  assert.ok(a.home > 1500 && a.away < 1500);
  assert.ok(b.delta > a.delta);
});
test('an upset moves ratings more than an expected win', () => {
  const upset = eloUpdate(1400, 1700, 1, 0);
  const expectedWin = eloUpdate(1700, 1400, 1, 0);
  assert.ok(upset.delta > expectedWin.delta);
});
test('draw between equals only moves ratings by the home-advantage expectation', () => {
  const u = eloUpdate(1500, 1500, 1, 1);
  assert.ok(u.home < 1500, 'home side was expected to win slightly more than a draw');
  assert.ok(Math.abs(u.delta) < 10);
});
test('computeElo replays in time order, ignores future and unfinished matches, strictly before asOf', () => {
  const list = [
    m(2, 2, 1, 0, 0, '2026-02-01'),
    m(1, 1, 2, 2, 0, '2026-01-01'),
    m(3, 1, 2, 5, 0, '2026-03-01'),
    { ...m(4, 1, 2, 1, 0, '2026-01-15'), status: 'scheduled', homeGoals: null, awayGoals: null },
  ];
  const upToFeb = computeElo(list, { asOf: '2026-02-15T00:00:00Z' });
  assert.equal(upToFeb.get(1).matches, 2);
  const all = computeElo(list, { asOf: '2026-12-01T00:00:00Z' });
  assert.equal(all.get(1).matches, 3);
  const sameAfterFuture = computeElo(list.slice(0, 2), { asOf: '2026-02-15T00:00:00Z' });
  assert.equal(sameAfterFuture.get(1).elo, upToFeb.get(1).elo, 'later matches do not change an earlier snapshot');
  // match 1 kicks off 2026-01-01T15:00Z and is treated as over at 18:00Z: excluded at exactly that instant
  assert.equal(computeElo(list, { asOf: '2026-01-01T18:00:00Z' }).size, 0);
  assert.equal(computeElo(list, { asOf: '2026-01-01T18:00:01Z' }).size, 2);
});
test('input order does not matter (deterministic)', () => {
  const list = [m(1, 1, 2, 2, 0, '2026-01-01'), m(2, 2, 3, 1, 1, '2026-01-08'), m(3, 3, 1, 0, 1, '2026-01-15')];
  const a = computeElo(list, { asOf: '2026-06-01T00:00:00Z' });
  const b = computeElo([...list].reverse(), { asOf: '2026-06-01T00:00:00Z' });
  for (const id of [1, 2, 3]) assert.equal(a.get(id).elo, b.get(id).elo);
});
test('total rating is conserved', () => {
  const list = [m(1, 1, 2, 2, 0, '2026-01-01'), m(2, 2, 3, 1, 1, '2026-01-08'), m(3, 3, 1, 0, 4, '2026-01-15')];
  const r = computeElo(list, { asOf: '2026-06-01T00:00:00Z' });
  const total = [...r.values()].reduce((s, v) => s + v.elo, 0);
  assert.ok(Math.abs(total - 4500) < 1e-9);
});
test('unknown kickoff is treated as the end of the match date', () => {
  const list = [{ ...m(1, 1, 2, 1, 0, '2026-01-01'), kickoffUtc: null }];
  assert.equal(computeElo(list, { asOf: '2026-01-01T12:00:00Z' }).size, 0);
  assert.equal(computeElo(list, { asOf: '2026-01-02T00:00:00Z' }).size, 2);
});
