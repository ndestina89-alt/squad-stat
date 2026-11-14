import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDixonColes } from '../../engine/fit.js';
import { predictMatch } from '../../engine/predict.js';
import { simulateLeague } from './helpers.js';

const { matches } = simulateLeague({ seed: 21, nTeams: 6, rounds: 10 });
const fit = fitDixonColes(matches, { asOf: '2027-09-01T00:00:00Z', halfLifeDays: 1e7, ridge: 0.1 });

test('prediction has coherent probabilities, labelled as model goal expectation (not xG)', () => {
  const p = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 });
  assert.equal(p.goalExpectationKind, 'model_goal_expectation');
  assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) <= 0.001);
  assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - (1 - p.tailMass)) < 1e-12, 'no hidden renormalisation');
  for (const v of [p.pHome, p.pDraw, p.pAway, p.pOver25, p.pBttsYes]) assert.ok(v >= 0 && v <= 1);
  assert.ok(p.expectedHomeGoals > 0 && p.expectedAwayGoals > 0);
  assert.equal(p.topScores.length, 5);
  assert.match(p.featureHash, /^[0-9a-f]{64}$/);
  assert.equal(p.dataAsOf, fit.dataAsOf);
});
test('lambda and nu follow the fitted formula', () => {
  const p = predictMatch({ fit, homeTeamId: 3, awayTeamId: 4 });
  const { mu, homeAdvantage, teams } = fit.params;
  assert.ok(Math.abs(p.expectedHomeGoals - Math.exp(mu + homeAdvantage) * teams[3].attack / teams[4].defense) < 1e-12);
  assert.ok(Math.abs(p.expectedAwayGoals - Math.exp(mu) * teams[4].attack / teams[3].defense) < 1e-12);
});
test('neutral venue removes home advantage; home advantage is positive in this synthetic league', () => {
  const home = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 });
  const neutral = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2, neutral: true });
  assert.ok(neutral.expectedHomeGoals < home.expectedHomeGoals);
  assert.equal(neutral.expectedAwayGoals, home.expectedAwayGoals);
});
test('unknown team falls back to league average and is flagged, never silently', () => {
  const p = predictMatch({ fit, homeTeamId: 1, awayTeamId: 9999 });
  assert.ok(p.uncertainty.flags.includes('away_team_unknown'));
  assert.ok(p.uncertainty.lowData);
  assert.equal(p.uncertainty.awayEffectiveMatches, 0);
  const both = predictMatch({ fit, homeTeamId: 8888, awayTeamId: 9999 });
  assert.ok(both.uncertainty.flags.includes('home_team_unknown') && both.uncertainty.flags.includes('away_team_unknown'));
});
test('well-covered teams are not flagged low-data', () => {
  assert.equal(predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 }).uncertainty.lowData, false);
});
test('deterministic: same inputs, same hash and numbers; different inputs, different hash', () => {
  const a = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 });
  const b = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 });
  assert.deepEqual(a, b);
  assert.notEqual(a.featureHash, predictMatch({ fit, homeTeamId: 2, awayTeamId: 1 }).featureHash);
});
test('same team on both sides is rejected', () => {
  assert.throws(() => predictMatch({ fit, homeTeamId: 1, awayTeamId: 1 }), RangeError);
});
test('a matrix too small to store honestly is rejected', () => {
  assert.throws(() => predictMatch({ fit, homeTeamId: 1, awayTeamId: 2, maxGoals: 1 }), /tail mass/);
});
test('Elo expectation is attached only when ratings are provided', () => {
  assert.equal(predictMatch({ fit, homeTeamId: 1, awayTeamId: 2 }).eloExpectedHome, null);
  const e = predictMatch({ fit, homeTeamId: 1, awayTeamId: 2, elo: { home: 1600, away: 1500 } }).eloExpectedHome;
  assert.ok(e > 0.5 && e < 1);
});
