import test from 'node:test';
import assert from 'node:assert/strict';
import { logFactorial, poissonPmf, poissonPmfArray, poissonTail } from '../../engine/poisson.js';

test('log factorial is exact for small k', () => {
  assert.equal(logFactorial(0), 0);
  assert.equal(logFactorial(1), 0);
  assert.ok(Math.abs(logFactorial(5) - Math.log(120)) < 1e-12);
  assert.ok(Math.abs(logFactorial(10) - Math.log(3628800)) < 1e-12);
  assert.throws(() => logFactorial(-1), RangeError);
  assert.throws(() => logFactorial(1.5), RangeError);
});
test('pmf matches closed forms, sums to 1, has mean lambda', () => {
  assert.ok(Math.abs(poissonPmf(0, 2) - Math.exp(-2)) < 1e-15);
  assert.ok(Math.abs(poissonPmf(3, 2) - (Math.exp(-2) * 8) / 6) < 1e-14);
  const p = poissonPmfArray(1.7, 40);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(p.reduce((s, v, k) => s + k * v, 0) - 1.7) < 1e-12);
});
test('lambda 0 is a point mass; invalid lambda throws', () => {
  assert.equal(poissonPmf(0, 0), 1);
  assert.equal(poissonPmf(2, 0), 0);
  assert.throws(() => poissonPmf(1, -1), RangeError);
  assert.throws(() => poissonPmf(1, NaN), RangeError);
});
test('tail is consistent with the cdf', () => {
  const p = poissonPmfArray(2.2, 6);
  const cdf = p.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(poissonTail(2.2, 6) - (1 - cdf)) < 1e-12);
});
