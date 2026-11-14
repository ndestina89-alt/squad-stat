import test from 'node:test';
import assert from 'node:assert/strict';
import { minimize } from '../../engine/optimizer.js';

test('quadratic converges to the exact minimum', () => {
  const f = (x) => ({ value: (x[0] - 3) ** 2 + 10 * (x[1] + 1) ** 2, grad: Float64Array.of(2 * (x[0] - 3), 20 * (x[1] + 1)) });
  const r = minimize(f, [0, 0]);
  assert.equal(r.converged, true);
  assert.ok(Math.abs(r.x[0] - 3) < 1e-6 && Math.abs(r.x[1] + 1) < 1e-6);
});
test('Rosenbrock reaches (1, 1)', () => {
  const f = ([x, y]) => ({
    value: (1 - x) ** 2 + 100 * (y - x * x) ** 2,
    grad: Float64Array.of(-2 * (1 - x) - 400 * x * (y - x * x), 200 * (y - x * x)),
  });
  const r = minimize(f, [-1.2, 1], { maxIter: 500 });
  assert.ok(Math.abs(r.x[0] - 1) < 1e-4 && Math.abs(r.x[1] - 1) < 1e-4, JSON.stringify([...r.x]));
});
test('infeasible region (Infinity) is avoided by the line search', () => {
  // minimise x - log(x); only defined for x > 0; the minimum is at x = 1.
  const f = ([x]) => (x <= 0 ? { value: Infinity, grad: Float64Array.of(0) } : { value: x - Math.log(x), grad: Float64Array.of(1 - 1 / x) });
  const r = minimize(f, [0.01]);
  assert.ok(Math.abs(r.x[0] - 1) < 1e-5);
});
test('non-finite start throws; maxIter is honoured and reported', () => {
  assert.throws(() => minimize(() => ({ value: NaN, grad: Float64Array.of(0) }), [0]), RangeError);
  const f = ([x, y]) => ({ value: (1 - x) ** 2 + 100 * (y - x * x) ** 2, grad: Float64Array.of(-2 * (1 - x) - 400 * x * (y - x * x), 200 * (y - x * x)) });
  const r = minimize(f, [-1.2, 1], { maxIter: 2 });
  assert.equal(r.converged, false);
  assert.equal(r.reason, 'max_iterations');
});
