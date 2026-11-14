import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreMatrix, bttsProbability, overProbability, resultProbabilities, tau, topScores, chooseMaxGoals } from '../../engine/scoreMatrix.js';
import { poissonPmf } from '../../engine/poisson.js';

const sum = (m) => m.matrix.flat().reduce((a, b) => a + b, 0);

test('matrix sums to 1 - tailMass, and the tail is tiny with adaptive size', () => {
  const m = buildScoreMatrix({ lambda: 1.6, nu: 1.1, rho: -0.08 });
  assert.ok(Math.abs(sum(m) - (1 - m.tailMass)) < 1e-14);
  assert.ok(m.tailMass < 1e-8);
});
test('rho = 0 equals independent Poisson', () => {
  const m = buildScoreMatrix({ lambda: 1.3, nu: 0.9, rho: 0, maxGoals: 10 });
  for (const [x, y] of [[0, 0], [1, 0], [2, 3], [5, 1]]) assert.ok(Math.abs(m.matrix[x][y] - poissonPmf(x, 1.3) * poissonPmf(y, 0.9)) < 1e-15);
});
test('Dixon-Coles correction preserves total mass for any valid rho', () => {
  for (const rho of [-0.2, -0.05, 0.05, 0.2]) {
    const m = buildScoreMatrix({ lambda: 1.4, nu: 1.2, rho, maxGoals: 25 });
    assert.ok(Math.abs(sum(m) - 1) < 1e-12, `rho=${rho}`);
  }
});
test('marginal means are unchanged by the correction (E[X]=lambda, E[Y]=nu)', () => {
  const m = buildScoreMatrix({ lambda: 1.7, nu: 0.8, rho: -0.12, maxGoals: 30 });
  let ex = 0; let ey = 0;
  m.matrix.forEach((row, x) => row.forEach((p, y) => { ex += x * p; ey += y * p; }));
  assert.ok(Math.abs(ex - 1.7) < 1e-9);
  assert.ok(Math.abs(ey - 0.8) < 1e-9);
});
test('P(X=0) marginal is exp(-lambda)', () => {
  const m = buildScoreMatrix({ lambda: 1.7, nu: 0.8, rho: -0.12, maxGoals: 30 });
  assert.ok(Math.abs(m.matrix[0].reduce((a, b) => a + b, 0) - Math.exp(-1.7)) < 1e-12);
});
test('negative rho raises 0-0 and 1-1, lowers 0-1 and 1-0', () => {
  const a = buildScoreMatrix({ lambda: 1.4, nu: 1.1, rho: 0, maxGoals: 8 });
  const b = buildScoreMatrix({ lambda: 1.4, nu: 1.1, rho: -0.1, maxGoals: 8 });
  assert.ok(b.matrix[0][0] > a.matrix[0][0] && b.matrix[1][1] > a.matrix[1][1]);
  assert.ok(b.matrix[0][1] < a.matrix[0][1] && b.matrix[1][0] < a.matrix[1][0]);
});
test('invalid rho (non-positive tau) throws', () => {
  assert.throws(() => buildScoreMatrix({ lambda: 3, nu: 3, rho: 0.5 }), RangeError);
  assert.throws(() => buildScoreMatrix({ lambda: 3, nu: 1, rho: -0.5 }), RangeError);
  assert.equal(tau(2, 2, 1, 1, 0.9), 1);
});
test('a too-small matrix reports a large tail instead of renormalising', () => {
  const m = buildScoreMatrix({ lambda: 3.5, nu: 3.0, rho: 0, maxGoals: 2 });
  assert.ok(m.tailMass > 0.5);
  const r = resultProbabilities(m);
  assert.ok(Math.abs(r.home + r.draw + r.away - (1 - m.tailMass)) < 1e-12);
  assert.throws(() => overProbability(m, 5.5), RangeError);
});
test('adaptive size grows with the goal rate and respects the cap', () => {
  assert.ok(chooseMaxGoals(0.8, 0.7) < chooseMaxGoals(4, 3.5));
  const capped = buildScoreMatrix({ lambda: 20, nu: 20, rho: 0, cap: 10 });
  assert.equal(capped.maxGoals, 10);
  assert.ok(capped.tailMass > 0.5);
});
test('result probabilities: symmetric teams give equal home and away', () => {
  const r = resultProbabilities(buildScoreMatrix({ lambda: 1.2, nu: 1.2, rho: -0.1 }));
  assert.ok(Math.abs(r.home - r.away) < 1e-12);
  assert.ok(r.draw > 0.2);
});
test('over 2.5 matches an independent brute-force sum', () => {
  const m = buildScoreMatrix({ lambda: 1.5, nu: 1.2, rho: -0.07, maxGoals: 25 });
  let over = 0;
  m.matrix.forEach((row, x) => row.forEach((p, y) => { if (x + y > 2) over += p; }));
  assert.ok(Math.abs(overProbability(m, 2.5) - over) < 1e-12);
  assert.ok(Math.abs(overProbability(m, 2) - over) < 1e-12, 'whole line 2 means more than 2 goals, same as 2.5');
  assert.ok(overProbability(m, 0.5) > overProbability(m, 3.5));
});
test('BTTS formula equals the matrix sum of cells where both score', () => {
  for (const rho of [0, -0.1, 0.06]) {
    const m = buildScoreMatrix({ lambda: 1.5, nu: 1.2, rho, maxGoals: 30 });
    let both = 0;
    m.matrix.forEach((row, x) => row.forEach((p, y) => { if (x >= 1 && y >= 1) both += p; }));
    assert.ok(Math.abs(bttsProbability(m) - both) < 1e-12, `rho=${rho}`);
  }
});
test('topScores is sorted, deterministic and bounded', () => {
  const t = topScores(buildScoreMatrix({ lambda: 1.2, nu: 1.2, rho: 0 }), 3);
  assert.equal(t.length, 3);
  assert.ok(t[0].p >= t[1].p && t[1].p >= t[2].p);
  assert.deepEqual([t[0].home, t[0].away], [1, 1]);
  assert.deepEqual([t[1].home, t[1].away], [0, 1], 'ties broken by home then away goals');
});
test('input validation', () => {
  assert.throws(() => buildScoreMatrix({ lambda: -1, nu: 1 }), RangeError);
  assert.throws(() => buildScoreMatrix({ lambda: 1, nu: NaN }), RangeError);
  assert.throws(() => buildScoreMatrix({ lambda: 1, nu: 1, maxGoals: 0 }), RangeError);
});
