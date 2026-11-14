import test from 'node:test';
import assert from 'node:assert/strict';
import { brier1x2, logLoss1x2, brierBinary, logLossBinary, calibrationBins, expectedCalibrationError, evaluate, pairedDifference, observedOutcome, predictedResult } from '../../engine/metrics.js';

const rec = (home, draw, away, result, over25 = 0.5, o25 = false, btts = 0.5, ob = false) => ({ p: { home, draw, away, over25, btts }, outcome: { result, over25: o25, btts: ob } });

test('Brier 1X2 by hand', () => {
  assert.ok(Math.abs(brier1x2({ home: 0.5, draw: 0.3, away: 0.2 }, 'H') - (0.25 + 0.09 + 0.04)) < 1e-15);
  assert.equal(brier1x2({ home: 1, draw: 0, away: 0 }, 'H'), 0);
  assert.equal(brier1x2({ home: 0, draw: 0, away: 1 }, 'H'), 2);
  assert.ok(Math.abs(brier1x2({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'D') - 2 / 3) < 1e-15, 'uniform forecast scores 2/3');
});
test('log-loss by hand and clipping of impossible forecasts', () => {
  assert.ok(Math.abs(logLoss1x2({ home: 0.5, draw: 0.3, away: 0.2 }, 'D') + Math.log(0.3)) < 1e-15);
  assert.ok(Math.abs(logLoss1x2({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'A') - Math.log(3)) < 1e-15);
  assert.ok(Number.isFinite(logLoss1x2({ home: 1, draw: 0, away: 0 }, 'A')), 'p = 0 is clipped, not Infinity');
  assert.ok(Math.abs(logLossBinary(0.8, true) + Math.log(0.8)) < 1e-15);
  assert.ok(Math.abs(logLossBinary(0.8, false) + Math.log(0.2)) < 1e-15);
  assert.ok(Math.abs(brierBinary(0.8, false) - 0.64) < 1e-15);
});
test('bad inputs throw', () => {
  assert.throws(() => brier1x2({ home: 1, draw: 0, away: 0 }, 'X'), RangeError);
  assert.throws(() => calibrationBins([{ p: 1.2, o: true }]), RangeError);
  assert.throws(() => calibrationBins([], 0), RangeError);
});
test('calibration bins: edges, p = 1 goes to the last bin, empty bins stay null', () => {
  const bins = calibrationBins([{ p: 0, o: false }, { p: 0.05, o: true }, { p: 0.1, o: true }, { p: 1, o: true }, { p: 0.95, o: false }], 10);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].n, 2);
  assert.ok(Math.abs(bins[0].meanPredicted - 0.025) < 1e-15);
  assert.equal(bins[0].observedFrequency, 0.5);
  assert.equal(bins[1].n, 1, '0.1 belongs to [0.1, 0.2)');
  assert.equal(bins[9].n, 2);
  assert.equal(bins[4].n, 0);
  assert.equal(bins[4].meanPredicted, null);
  assert.equal(bins[4].observedFrequency, null);
});
test('ECE: perfectly calibrated is ~0, always-wrong extreme is large, empty is null', () => {
  const perfect = calibrationBins(Array.from({ length: 100 }, (_, i) => ({ p: 0.3, o: i < 30 })), 10);
  assert.ok(expectedCalibrationError(perfect) < 1e-12);
  const bad = calibrationBins(Array.from({ length: 50 }, () => ({ p: 0.95, o: false })), 10);
  assert.ok(Math.abs(expectedCalibrationError(bad) - 0.95) < 1e-12);
  assert.equal(expectedCalibrationError(calibrationBins([], 10)), null);
});
test('observed outcome and predicted result', () => {
  assert.deepEqual(observedOutcome(2, 1), { result: 'H', over25: true, btts: true });
  assert.deepEqual(observedOutcome(0, 0), { result: 'D', over25: false, btts: false });
  assert.deepEqual(observedOutcome(0, 2), { result: 'A', over25: false, btts: false });
  assert.deepEqual(observedOutcome(3, 0), { result: 'H', over25: true, btts: false });
  assert.equal(predictedResult({ home: 0.2, draw: 0.5, away: 0.3 }), 'D');
});
test('evaluate aggregates correctly and handles empty input', () => {
  const e0 = evaluate([]);
  assert.equal(e0.n, 0);
  assert.equal(e0.logLoss1x2, null);
  const records = [rec(0.6, 0.25, 0.15, 'H', 0.6, true, 0.7, true), rec(0.2, 0.3, 0.5, 'H', 0.4, false, 0.3, false)];
  const e = evaluate(records);
  assert.equal(e.n, 2);
  assert.ok(Math.abs(e.brier1x2 - (brier1x2(records[0].p, 'H') + brier1x2(records[1].p, 'H')) / 2) < 1e-15);
  assert.ok(Math.abs(e.logLoss1x2 - (-Math.log(0.6) - Math.log(0.2)) / 2) < 1e-15);
  assert.equal(e.accuracy1x2, 0.5);
  assert.ok(Math.abs(e.brierOver25 - ((0.4 ** 2) + (0.4 ** 2)) / 2) < 1e-15);
  assert.ok(e.logLoss1x2Se > 0);
  assert.equal(e.calibration.home.reduce((s, b) => s + b.n, 0), 2);
  assert.deepEqual(Object.keys(e.calibration), ['home', 'draw', 'away', 'over_2_5', 'btts_yes']);
});
test('paired difference: sign, mean, SE', () => {
  const d = pairedDifference([1, 2, 3, 4], [2, 3, 4, 7]);
  assert.equal(d.n, 4);
  assert.ok(Math.abs(d.mean - -1.5) < 1e-15);
  assert.ok(Math.abs(d.se - Math.sqrt(1 / 4)) < 1e-12, 'diffs -1,-1,-1,-3: var 1, se 0.5');
  assert.throws(() => pairedDifference([1], [1, 2]), RangeError);
  assert.equal(pairedDifference([1], [3]).se, null);
});
