import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDixonColes, makeObjective, featureHash } from '../../engine/fit.js';
import { simulateLeague, mulberry32 } from './helpers.js';

const ASOF = '2027-09-01T00:00:00Z';
const logLam = (p, i, j) => p.mu + p.homeAdvantage + Math.log(p.teams[i].attack) - Math.log(p.teams[j].defense);

test('analytic gradient matches central finite differences (including rho and low scores)', () => {
  const rng = mulberry32(5);
  const nTeams = 5;
  const rows = [];
  for (let k = 0; k < 120; k++) {
    const home = Math.floor(rng() * nTeams); let away = Math.floor(rng() * nTeams); if (away === home) away = (away + 1) % nTeams;
    rows.push({ home, away, x: Math.floor(rng() * 4), y: Math.floor(rng() * 3), w: 0.2 + rng() });
  }
  rows.push({ home: 0, away: 1, x: 0, y: 0, w: 1 }, { home: 1, away: 2, x: 0, y: 1, w: 1 }, { home: 2, away: 3, x: 1, y: 0, w: 1 }, { home: 3, away: 4, x: 1, y: 1, w: 1 });
  const { f, size, iRho } = makeObjective({ rows, nTeams, ridge: 0.7 });
  const x = new Float64Array(size).map(() => (rng() - 0.5) * 0.4);
  x[iRho] = -0.08;
  const { grad } = f(x);
  for (let i = 0; i < size; i++) {
    const e = 1e-6;
    const xp = Float64Array.from(x); xp[i] += e;
    const xm = Float64Array.from(x); xm[i] -= e;
    const num = (f(xp).value - f(xm).value) / (2 * e);
    assert.ok(Math.abs(num - grad[i]) < 1e-6 * Math.max(1, Math.abs(num)), `param ${i}: numeric ${num} vs analytic ${grad[i]}`);
  }
});

test('recovers known parameters from seeded synthetic data (no real data involved)', () => {
  const { matches, truth } = simulateLeague({ seed: 11, nTeams: 8, rounds: 20 });
  const fit = fitDixonColes(matches, { asOf: ASOF, halfLifeDays: 1e7, ridge: 0.05 });
  assert.equal(fit.diagnostics.converged, true, fit.diagnostics.reason);
  const p = fit.params;
  assert.ok(Math.abs(p.homeAdvantage - truth.h) < 0.1, `home advantage ${p.homeAdvantage}`);
  assert.ok(Math.abs(p.rho) < 0.12, 'data were generated with independent Poisson, so rho should be near 0');
  let se = 0; let n = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    if (i === j) continue;
    const truthLog = truth.mu + truth.h + truth.attack[i] - truth.defense[j];
    se += (logLam(p, i + 1, j + 1) - truthLog) ** 2; n++;
  }
  const rmse = Math.sqrt(se / n);
  assert.ok(rmse < 0.1, `log-lambda RMSE ${rmse}`);
});

test('the fit is deterministic and invariant to input order', () => {
  const { matches } = simulateLeague({ seed: 3, nTeams: 6, rounds: 6 });
  const a = fitDixonColes(matches, { asOf: ASOF });
  const b = fitDixonColes([...matches].reverse(), { asOf: ASOF });
  assert.deepEqual(a, b);
});

test('NO LEAKAGE: matches after asOf do not change the fit; a match ending exactly at asOf is excluded', () => {
  const { matches } = simulateLeague({ seed: 4, nTeams: 6, rounds: 8 });
  const cut = matches[Math.floor(matches.length * 0.6)];
  const asOf = cut.kickoffUtc; // the cut match itself ends 3 h later, so it is after asOf
  const known = matches.filter((m) => Date.parse(m.kickoffUtc) + 3 * 3600e3 < Date.parse(asOf));
  const full = fitDixonColes(matches, { asOf });
  const trimmed = fitDixonColes(known, { asOf });
  assert.deepEqual(full.params, trimmed.params);
  assert.equal(full.diagnostics.nMatches, known.length);
  // tamper with the future: results after asOf must not matter
  const tampered = matches.map((m) => (Date.parse(m.kickoffUtc) >= Date.parse(asOf) ? { ...m, homeGoals: 9, awayGoals: 0 } : m));
  assert.deepEqual(fitDixonColes(tampered, { asOf }).params, full.params);
  // boundary: end time == asOf is excluded, one second later is included
  const boundary = { id: 99999, homeTeamId: 1, awayTeamId: 2, homeGoals: 3, awayGoals: 0, status: 'finished', matchDate: '2026-01-01', kickoffUtc: '2026-01-01T15:00:00Z' };
  const base = fitDixonColes([...known], { asOf });
  const atEnd = fitDixonColes([...known, boundary], { asOf: '2026-01-01T18:00:00Z', minMatches: 1 });
  const afterEnd = fitDixonColes([boundary], { asOf: '2026-01-01T18:00:01Z', minMatches: 1 });
  assert.equal(base.diagnostics.nMatches, known.length);
  assert.equal(afterEnd.diagnostics.nMatches, 1);
  assert.equal(atEnd.diagnostics.nMatches, known.length, 'boundary match excluded at the exact end instant');
});

test('time decay: a shorter half-life moves the fit toward recent form', () => {
  // team 1 is strong in the first half of history, weak in the second.
  const rng = mulberry32(8);
  const ms = []; let id = 0;
  for (let r = 0; r < 24; r++) for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) {
    if (i === j) continue;
    id++;
    const t = new Date(Date.UTC(2025, 0, 1) + id * 86400000 / 2);
    const early = r < 12;
    const boost = i === 1 ? (early ? 1.2 : -1.0) : 0;
    const lam = Math.exp(0.1 + boost); const nu = Math.exp(0.1 - (j === 1 ? boost : 0) * 0);
    const poi = (l) => { const L = Math.exp(-l); let k = 0; let p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; };
    ms.push({ id, homeTeamId: i, awayTeamId: j, homeGoals: poi(lam), awayGoals: poi(nu), status: 'finished', matchDate: t.toISOString().slice(0, 10), kickoffUtc: t.toISOString().slice(0, 19) + 'Z' });
  }
  const asOf = '2026-06-01T00:00:00Z';
  const slow = fitDixonColes(ms, { asOf, halfLifeDays: 1e7, ridge: 0.1 });
  const fast = fitDixonColes(ms, { asOf, halfLifeDays: 20, ridge: 0.1 });
  assert.ok(fast.params.teams[1].attack < slow.params.teams[1].attack, 'recent weakness counts more with a short half-life');
  assert.ok(fast.diagnostics.effectiveMatches < slow.diagnostics.effectiveMatches);
});

test('ridge shrinks strengths toward 1 (log 0)', () => {
  const { matches } = simulateLeague({ seed: 6, nTeams: 6, rounds: 3 });
  const loose = fitDixonColes(matches, { asOf: ASOF, halfLifeDays: 1e7, ridge: 0.001 });
  const tight = fitDixonColes(matches, { asOf: ASOF, halfLifeDays: 1e7, ridge: 50 });
  const spread = (f) => Math.max(...Object.values(f.params.teams).map((t) => Math.abs(Math.log(t.attack))));
  assert.ok(spread(tight) < spread(loose));
});

test('refuses to fit with too little data and validates options', () => {
  const { matches } = simulateLeague({ seed: 1, nTeams: 4, rounds: 1 });
  assert.throws(() => fitDixonColes(matches, { asOf: ASOF }), /need at least/);
  assert.throws(() => fitDixonColes(matches, { asOf: 'garbage' }), RangeError);
  assert.throws(() => fitDixonColes(matches, { asOf: ASOF, halfLifeDays: 0, minMatches: 1 }), RangeError);
  assert.throws(() => fitDixonColes(matches, { asOf: ASOF, ridge: -1, minMatches: 1 }), RangeError);
});

test('dataAsOf never exceeds asOf and per-team counts add up', () => {
  const { matches } = simulateLeague({ seed: 2, nTeams: 5, rounds: 5 });
  const fit = fitDixonColes(matches, { asOf: ASOF });
  assert.ok(fit.dataAsOf <= fit.asOf);
  const used = Object.values(fit.params.teams).reduce((s, t) => s + t.matchesUsed, 0);
  assert.equal(used, 2 * fit.diagnostics.nMatches);
});

test('featureHash is stable under key order and tiny float noise, and sensitive to real changes', () => {
  assert.equal(featureHash({ a: 1.0000000000001, b: [1, 2] }), featureHash({ b: [1, 2], a: 1 }));
  assert.notEqual(featureHash({ a: 1 }), featureHash({ a: 1.001 }));
});
