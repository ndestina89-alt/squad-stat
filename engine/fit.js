// Time-decayed Dixon-Coles fit for ONE competition scope.
//
//   log lambda (home goals) = mu + h + a[home] - d[away]
//   log nu     (away goals) = mu + a[away] - d[home]        (higher d = stronger defence)
//
// Objective (minimised): ( -sum_i w_i * loglik_i + ridge/2 * (sum a^2 + sum d^2) ) / sum w_i
// with w_i = exp(-xi * age_days_i), xi = ln2 / halfLifeDays. Gradients are analytic.
// Only matches that ended strictly before asOf are used (see eligibility.js).
import { createHash } from 'node:crypto';
import { byTime, isUsable, matchEndMs, toAsOfMs } from './eligibility.js';
import { minimize } from './optimizer.js';

export const FIT_DEFAULTS = Object.freeze({ halfLifeDays: 365, ridge: 1.0, maxIter: 400, minMatches: 30 });
export const MODEL_VERSION = 'dc-td-1';
const DAY_MS = 86400000;

/** Build the objective for already-filtered data. Exported so the gradient can be verified numerically. */
export function makeObjective({ rows, nTeams, ridge }) {
  const W = rows.reduce((s, r) => s + r.w, 0);
  const iA = (t) => 2 + t;
  const iD = (t) => 2 + nTeams + t;
  const iRho = 2 + 2 * nTeams;
  const size = iRho + 1;

  const f = (p) => {
    const grad = new Float64Array(size);
    let ll = 0;
    const mu = p[0]; const h = p[1]; const rho = p[iRho];
    for (const r of rows) {
      const etaL = mu + h + p[iA(r.home)] - p[iD(r.away)];
      const etaN = mu + p[iA(r.away)] - p[iD(r.home)];
      const lam = Math.exp(etaL); const nu = Math.exp(etaN);
      let l = r.x * etaL - lam + r.y * etaN - nu; // factorial terms are constant and dropped
      let dLam = 0; let dNu = 0; let dRho = 0; // d log tau / d lam, d nu, d rho
      if (r.x <= 1 && r.y <= 1) {
        let t;
        if (r.x === 0 && r.y === 0) { t = 1 - lam * nu * rho; dLam = -nu * rho / t; dNu = -lam * rho / t; dRho = -lam * nu / t; }
        else if (r.x === 0 && r.y === 1) { t = 1 + lam * rho; dLam = rho / t; dRho = lam / t; }
        else if (r.x === 1 && r.y === 0) { t = 1 + nu * rho; dNu = rho / t; dRho = nu / t; }
        else { t = 1 - rho; dRho = -1 / t; }
        if (!(t > 0)) return { value: Infinity, grad };
        l += Math.log(t);
      }
      ll += r.w * l;
      const gL = r.w * ((r.x - lam) + lam * dLam); // d(w*l)/d etaL
      const gN = r.w * ((r.y - nu) + nu * dNu);
      grad[0] -= gL + gN;
      grad[1] -= gL;
      grad[iA(r.home)] -= gL; grad[iD(r.away)] += gL;
      grad[iA(r.away)] -= gN; grad[iD(r.home)] += gN;
      grad[iRho] -= r.w * dRho;
    }
    let pen = 0;
    for (let t = 0; t < nTeams; t++) {
      const a = p[iA(t)]; const d = p[iD(t)];
      pen += a * a + d * d;
      grad[iA(t)] += ridge * a; grad[iD(t)] += ridge * d;
    }
    const value = (-ll + 0.5 * ridge * pen) / W;
    for (let i = 0; i < size; i++) grad[i] /= W;
    return { value, grad };
  };
  return { f, size, iA, iD, iRho };
}

export const round = (v, d = 10) => Math.round(v * 10 ** d) / 10 ** d;

export function featureHash(obj) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    if (typeof v === 'number') return round(v, 9);
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(obj))).digest('hex');
}

/**
 * Fit the model. matches: { id, homeTeamId, awayTeamId, homeGoals, awayGoals, status, matchDate, kickoffUtc }.
 * Throws if fewer than minMatches usable matches exist (no silent garbage fit).
 */
export function fitDixonColes(matches, { asOf, halfLifeDays = FIT_DEFAULTS.halfLifeDays, ridge = FIT_DEFAULTS.ridge,
  maxIter = FIT_DEFAULTS.maxIter, minMatches = FIT_DEFAULTS.minMatches } = {}) {
  if (!(halfLifeDays > 0)) throw new RangeError('halfLifeDays must be > 0');
  if (!(ridge >= 0)) throw new RangeError('ridge must be >= 0');
  const cutoff = toAsOfMs(asOf);
  const usable = matches.filter((m) => isUsable(m, cutoff)).sort(byTime);
  if (usable.length < minMatches) throw new RangeError(`only ${usable.length} usable matches before asOf, need at least ${minMatches}`);

  const teamIds = [...new Set(usable.flatMap((m) => [m.homeTeamId, m.awayTeamId]))].sort((a, b) => a - b);
  const index = new Map(teamIds.map((id, i) => [id, i]));
  const xi = Math.LN2 / halfLifeDays;
  const rows = usable.map((m) => ({
    home: index.get(m.homeTeamId), away: index.get(m.awayTeamId), x: m.homeGoals, y: m.awayGoals,
    w: Math.exp(-xi * (cutoff - matchEndMs(m)) / DAY_MS),
  }));

  const { f, iA, iD, iRho, size } = makeObjective({ rows, nTeams: teamIds.length, ridge });
  const x0 = new Float64Array(size);
  const totalGoals = rows.reduce((s, r) => s + r.w * (r.x + r.y), 0);
  const W = rows.reduce((s, r) => s + r.w, 0);
  x0[0] = Math.log(Math.max(totalGoals / (2 * W), 0.1));
  const res = minimize(f, x0, { maxIter });

  const teamStats = new Map(teamIds.map((id) => [id, { matches: 0, weight: 0 }]));
  usable.forEach((m, i) => {
    for (const id of [m.homeTeamId, m.awayTeamId]) { const s = teamStats.get(id); s.matches++; s.weight += rows[i].w; }
  });
  const teams = {};
  teamIds.forEach((id, t) => {
    teams[id] = { attack: Math.exp(res.x[iA(t)]), defense: Math.exp(res.x[iD(t)]), matchesUsed: teamStats.get(id).matches, effectiveMatches: teamStats.get(id).weight };
  });
  const last = usable[usable.length - 1];
  const dataAsOf = new Date(Math.min(matchEndMs(last), cutoff)).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    modelVersion: MODEL_VERSION,
    asOf: new Date(cutoff).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    dataAsOf,
    params: { mu: res.x[0], homeAdvantage: res.x[1], rho: res.x[iRho], teams },
    config: { halfLifeDays, ridge },
    diagnostics: {
      converged: res.converged, reason: res.reason, iterations: res.iterations, gradNorm: res.gradNorm, objective: res.value,
      nMatches: usable.length, effectiveMatches: W, nTeams: teamIds.length,
    },
  };
}
