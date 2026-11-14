import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForward, summarize, tuneParameters, baselineForecast } from '../../engine/backtest.js';
import { simulateLeague, mulberry32, poissonSample } from './helpers.js';

const base = simulateLeague({ seed: 31, nTeams: 8, rounds: 18 }); // ~1000 matches over ~250 days from 2025-08-01
const M = base.matches;
const W = { from: '2025-11-01T00:00:00Z', to: '2026-03-15T00:00:00Z' };

test('every prediction uses only data before its cutoff, and cutoff <= match start', () => {
  const r = walkForward(M, { ...W, halfLifeDays: 365, ridge: 0.5 });
  assert.ok(r.records.length > 200);
  const byId = new Map(M.map((m) => [m.id, m]));
  for (const rec of r.records) {
    const m = byId.get(rec.matchId);
    assert.ok(Date.parse(rec.cutoff) <= Date.parse(m.kickoffUtc), 'prediction made before kickoff');
  }
  assert.equal(r.records.length, r.baselineRecords.length);
  assert.deepEqual(r.records.map((x) => x.matchId), r.baselineRecords.map((x) => x.matchId));
});

test('NO LEAKAGE: rewriting every result after a cutoff leaves all earlier predictions bit-identical', () => {
  const cutoff = Date.parse('2026-01-15T00:00:00Z');
  const clean = walkForward(M, { ...W, halfLifeDays: 200, ridge: 0.5 });
  const tampered = M.map((m) => (Date.parse(m.kickoffUtc) >= cutoff ? { ...m, homeGoals: 7, awayGoals: 0 } : m));
  const dirty = walkForward(tampered, { ...W, halfLifeDays: 200, ridge: 0.5 });
  const before = (r) => r.records.filter((x) => Date.parse(x.cutoff) + 7 * 86400000 <= cutoff);
  const a = before(clean); const b = before(dirty);
  assert.ok(a.length > 100);
  assert.deepEqual(a.map((x) => x.p), b.map((x) => x.p));
  // control: predictions at/after the tampered region do change, proving the test can detect a difference
  const afterClean = clean.records.filter((x) => Date.parse(x.cutoff) >= cutoff + 14 * 86400000);
  const afterDirty = dirty.records.filter((x) => Date.parse(x.cutoff) >= cutoff + 14 * 86400000);
  assert.ok(afterClean.length > 0);
  assert.notDeepEqual(afterClean.map((x) => x.p), afterDirty.map((x) => x.p));
});

test('on synthetic data with real team differences the model beats the no-skill baseline', () => {
  const s = summarize(walkForward(M, { ...W, halfLifeDays: 1e5, ridge: 0.5 }));
  assert.ok(s.model.logLoss1x2 < s.baseline.logLoss1x2, `${s.model.logLoss1x2} vs ${s.baseline.logLoss1x2}`);
  assert.ok(s.logLossVsBaseline.mean < 0);
  assert.ok(s.logLossVsBaseline.mean + 2 * s.logLossVsBaseline.se < 0, 'improvement exceeds two standard errors');
  assert.ok(s.model.n === s.baseline.n && s.model.n > 200);
});

test('on pure noise the model does NOT beat the baseline (the harness cannot invent skill)', () => {
  const rng = mulberry32(99);
  const ms = []; let id = 0;
  for (let r = 0; r < 18; r++) for (let i = 1; i <= 8; i++) for (let j = 1; j <= 8; j++) {
    if (i === j) continue;
    id++;
    const t = new Date(Date.UTC(2025, 7, 1) + id * 86400000 / 4);
    ms.push({ id, homeTeamId: i, awayTeamId: j, homeGoals: poissonSample(rng, 1.4), awayGoals: poissonSample(rng, 1.1), status: 'finished', matchDate: t.toISOString().slice(0, 10), kickoffUtc: t.toISOString().slice(0, 19) + 'Z' });
  }
  const s = summarize(walkForward(ms, { ...W, halfLifeDays: 1e5, ridge: 0.5 }));
  assert.ok(s.logLossVsBaseline.mean > -2 * s.logLossVsBaseline.se, 'no significant improvement on structureless data');
});

test('blocks without enough training data are skipped and reported, never silently predicted', () => {
  const r = walkForward(M, { from: '2025-08-02T00:00:00Z', to: '2025-08-07T00:00:00Z', stepDays: 3, minTrainMatches: 30 });
  assert.equal(r.records.length, 0);
  assert.ok(r.skippedBlocks.length > 0);
  assert.equal(r.skippedBlocks[0].reason, 'insufficient_training_data');
});

test('unknown teams are flagged, and can be excluded', () => {
  const extra = [{ id: 90001, homeTeamId: 1, awayTeamId: 777, homeGoals: 1, awayGoals: 0, status: 'finished', matchDate: '2026-02-10', kickoffUtc: '2026-02-10T15:00:00Z' }];
  const incl = walkForward([...M, ...extra], { ...W, halfLifeDays: 1e5, ridge: 0.5 });
  const excl = walkForward([...M, ...extra], { ...W, halfLifeDays: 1e5, ridge: 0.5, includeUnknownTeams: false });
  assert.equal(incl.counts.unknownTeam, 1);
  assert.equal(incl.records.length, excl.records.length + 1);
  assert.ok(incl.records.find((x) => x.matchId === 90001).flags.includes('away_team_unknown'));
});

test('baseline forecast uses only the matches it is given and is smoothed', () => {
  const b = baselineForecast([{ homeGoals: 1, awayGoals: 0 }, { homeGoals: 2, awayGoals: 2 }]);
  assert.ok(Math.abs(b.home + b.draw + b.away - 1) < 1e-12);
  assert.ok(b.away > 0, 'smoothing keeps unseen outcomes possible');
  assert.ok(Math.abs(b.home - 2 / 5) < 1e-15);
});

test('input validation', () => {
  assert.throws(() => walkForward(M, { from: 'x', to: W.to }), RangeError);
  assert.throws(() => walkForward(M, { from: W.to, to: W.from }), RangeError);
  assert.throws(() => walkForward(M, { ...W, stepDays: 0 }), RangeError);
});

// ---- tuning
const TUNE = { from: '2025-11-01T00:00:00Z', to: '2026-01-20T00:00:00Z' };
const HOLD = { from: '2026-01-20T00:00:00Z', to: '2026-03-15T00:00:00Z' };
const GRID = { halfLifeDays: [60, 365, 3650], ridge: [0.1, 2] };

test('tuning picks the lowest tune log-loss, evaluates the holdout separately, and is deterministic', () => {
  const t = tuneParameters(M, { grid: GRID, tune: TUNE, holdout: HOLD, minEvalMatches: 50 });
  assert.equal(t.grid.length, 6);
  const min = Math.min(...t.grid.map((g) => g.logLoss));
  assert.equal(t.best.tuneLogLoss, min);
  assert.ok(GRID.halfLifeDays.includes(t.best.halfLifeDays) && GRID.ridge.includes(t.best.ridge));
  assert.ok(t.holdout.summary.model.n > 50);
  assert.ok(Date.parse(t.holdout.run.records[0].cutoff) >= Date.parse(HOLD.from), 'holdout predictions all fall in the holdout window');
  const tuneIds = new Set(walkForward(M, { ...TUNE, halfLifeDays: 365, ridge: 0.1 }).records.map((r) => r.matchId));
  assert.ok(t.holdout.run.records.every((r) => !tuneIds.has(r.matchId)), 'no match is in both windows');
  assert.deepEqual(tuneParameters(M, { grid: GRID, tune: TUNE, holdout: HOLD, minEvalMatches: 50 }).best, t.best);
});

test('tuning flags a best value sitting on the grid boundary', () => {
  const t = tuneParameters(M, { grid: { halfLifeDays: [3650], ridge: [0.1, 0.5, 2] }, tune: TUNE, holdout: HOLD, minEvalMatches: 50 });
  assert.ok(!t.boundaryHit.includes('halfLifeDays'), 'single-value axis is not a boundary');
  const t2 = tuneParameters(M, { grid: { halfLifeDays: [3650, 5000], ridge: [0.5] }, tune: TUNE, holdout: HOLD, minEvalMatches: 50 });
  assert.ok(t2.boundaryHit.includes('halfLifeDays'));
});

test('tuning rejects overlapping windows, bad grids and too little evaluation data', () => {
  assert.throws(() => tuneParameters(M, { grid: GRID, tune: TUNE, holdout: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' } }), /before the holdout/);
  assert.throws(() => tuneParameters(M, { grid: { halfLifeDays: [], ridge: [1] }, tune: TUNE, holdout: HOLD }), RangeError);
  assert.throws(() => tuneParameters(M, { grid: { halfLifeDays: [-1], ridge: [1] }, tune: TUNE, holdout: HOLD }), RangeError);
  assert.throws(() => tuneParameters(M, { grid: GRID, tune: TUNE, holdout: HOLD, minEvalMatches: 100000 }), /at least/);
});

test('with drifting team strength a short half-life beats an extremely long one on the holdout', () => {
  const rng = mulberry32(2024);
  const ms = []; let id = 0;
  const n = 8; const att0 = Array.from({ length: n }, () => (rng() - 0.5) * 0.8);
  for (let r = 0; r < 24; r++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    id++;
    const dayIdx = id / 4;
    const t = new Date(Date.UTC(2025, 7, 1) + dayIdx * 86400000);
    // strengths rotate over time: team i's attack follows a sinusoid with its own phase
    const a = (k) => att0[k] * Math.cos(dayIdx / 40 + k);
    const lam = Math.exp(0.3 + 0.25 + a(i) * 1.6 - a((j + 3) % n) * 0.4); const nu = Math.exp(0.3 + a(j) * 1.6 - a((i + 3) % n) * 0.4);
    ms.push({ id, homeTeamId: i + 1, awayTeamId: j + 1, homeGoals: poissonSample(rng, lam), awayGoals: poissonSample(rng, nu), status: 'finished', matchDate: t.toISOString().slice(0, 10), kickoffUtc: t.toISOString().slice(0, 19) + 'Z' });
  }
  const tune = { from: '2025-11-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
  const hold = { from: '2026-02-01T00:00:00Z', to: '2026-04-20T00:00:00Z' };
  const t = tuneParameters(ms, { grid: { halfLifeDays: [45, 100000], ridge: [0.5] }, tune, holdout: hold, minEvalMatches: 50 });
  assert.equal(t.best.halfLifeDays, 45);
  const long = summarize(walkForward(ms, { ...hold, halfLifeDays: 100000, ridge: 0.5 }));
  assert.ok(t.holdout.summary.model.logLoss1x2 < long.model.logLoss1x2, 'selected setting generalises to the holdout');
});
