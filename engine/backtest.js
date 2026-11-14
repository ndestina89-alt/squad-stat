// Walk-forward backtest and parameter tuning.
//
// For each block start T (every stepDays) the model is refitted using ONLY matches that ended strictly before T,
// then predicts matches that start inside [T, T + stepDays). Nothing played in or after the block is visible to the fit.
// Every prediction is out-of-sample by construction (the leakage guard lives in engine/eligibility.js).
import { fitDixonColes, FIT_DEFAULTS } from './fit.js';
import { predictMatch } from './predict.js';
import { isUsable, matchEndMs } from './eligibility.js';
import { evaluate, observedOutcome, pairedDifference, perMatchLoss } from './metrics.js';

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Start of a match: kickoff if known, otherwise the start of its date. */
export const matchStartMs = (m) => (m.kickoffUtc ? Date.parse(m.kickoffUtc) : Date.parse(`${m.matchDate}T00:00:00Z`));

const parseWindow = (w, name) => {
  const from = Date.parse(w?.from); const to = Date.parse(w?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError(`${name} needs valid from < to`);
  return { from, to };
};

/** League-wide frequencies from training data only: the no-skill reference forecast. Laplace-smoothed. */
export function baselineForecast(trainMatches) {
  let h = 0; let d = 0; let a = 0; let over = 0; let btts = 0;
  for (const m of trainMatches) {
    const o = observedOutcome(m.homeGoals, m.awayGoals);
    if (o.result === 'H') h++; else if (o.result === 'D') d++; else a++;
    if (o.over25) over++;
    if (o.btts) btts++;
  }
  const n = trainMatches.length;
  return { home: (h + 1) / (n + 3), draw: (d + 1) / (n + 3), away: (a + 1) / (n + 3), over25: (over + 1) / (n + 2), btts: (btts + 1) / (n + 2) };
}

/**
 * Run the walk-forward loop for one parameter set.
 * Returns { records, baselineRecords, config, counts, skippedBlocks }. records[i] and baselineRecords[i] are the same match.
 */
export function walkForward(matches, {
  from, to, stepDays = 7, halfLifeDays = FIT_DEFAULTS.halfLifeDays, ridge = FIT_DEFAULTS.ridge,
  minTrainMatches = FIT_DEFAULTS.minMatches, includeUnknownTeams = true,
} = {}) {
  const win = parseWindow({ from, to }, 'window');
  if (!(stepDays > 0)) throw new RangeError('stepDays must be > 0');
  const targets = matches
    .filter((m) => m.status === 'finished' && Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals))
    .sort((a, b) => matchStartMs(a) - matchStartMs(b) || a.id - b.id);

  const records = []; const baselineRecords = []; const skippedBlocks = [];
  const counts = { blocks: 0, fitted: 0, predicted: 0, unknownTeam: 0, lowData: 0, predictErrors: 0, notConverged: 0 };

  for (let t = win.from; t < win.to; t += stepDays * DAY_MS) {
    const blockEnd = Math.min(t + stepDays * DAY_MS, win.to);
    const block = targets.filter((m) => matchStartMs(m) >= t && matchStartMs(m) < blockEnd);
    if (block.length === 0) continue;
    counts.blocks++;
    let fit;
    try {
      fit = fitDixonColes(matches, { asOf: iso(t), halfLifeDays, ridge, minMatches: minTrainMatches });
    } catch (e) {
      skippedBlocks.push({ asOf: iso(t), matches: block.length, reason: e instanceof RangeError ? 'insufficient_training_data' : 'fit_error', message: e.message });
      continue;
    }
    counts.fitted++;
    if (!fit.diagnostics.converged) counts.notConverged++;
    const baseline = baselineForecast(matches.filter((m) => isUsable(m, t)));

    for (const m of block) {
      let pred;
      try { pred = predictMatch({ fit, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }); } catch { counts.predictErrors++; continue; }
      const unknown = pred.uncertainty.flags.some((f) => f.endsWith('_team_unknown'));
      if (unknown) counts.unknownTeam++;
      if (pred.uncertainty.lowData) counts.lowData++;
      if (unknown && !includeUnknownTeams) continue;
      const outcome = observedOutcome(m.homeGoals, m.awayGoals);
      records.push({
        matchId: m.id, cutoff: iso(t), outcome, flags: pred.uncertainty.flags,
        p: { home: pred.pHome, draw: pred.pDraw, away: pred.pAway, over25: pred.pOver25, btts: pred.pBttsYes },
      });
      baselineRecords.push({ matchId: m.id, cutoff: iso(t), outcome, p: baseline });
      counts.predicted++;
    }
  }
  return { records, baselineRecords, config: { halfLifeDays, ridge, stepDays, minTrainMatches, includeUnknownTeams, from: iso(win.from), to: iso(win.to) }, counts, skippedBlocks };
}

/** Evaluate a walk-forward result against its baseline, with a paired significance-style summary. */
export function summarize(result) {
  const model = evaluate(result.records);
  const baseline = evaluate(result.baselineRecords);
  const diff = result.records.length
    ? pairedDifference(perMatchLoss(result.records), perMatchLoss(result.baselineRecords)) : { n: 0, mean: null, se: null };
  return {
    model, baseline,
    logLossVsBaseline: { ...diff, interpretation: 'mean per-match log-loss difference (model - baseline); negative means the model is better' },
    counts: result.counts, skippedBlocks: result.skippedBlocks, config: result.config,
  };
}

/**
 * Select half-life and ridge on the TUNE window, then report the chosen setting on a later HOLDOUT window that took
 * no part in the selection. Only the holdout numbers are an honest estimate of out-of-sample quality.
 */
export function tuneParameters(matches, {
  grid, tune, holdout, stepDays = 7, minTrainMatches = FIT_DEFAULTS.minMatches, minEvalMatches = 100,
} = {}) {
  const hls = grid?.halfLifeDays; const rs = grid?.ridge;
  if (!Array.isArray(hls) || !Array.isArray(rs) || hls.length === 0 || rs.length === 0) throw new RangeError('grid needs non-empty halfLifeDays and ridge arrays');
  if (hls.some((v) => !(v > 0)) || rs.some((v) => !(v >= 0))) throw new RangeError('grid values must be halfLife > 0 and ridge >= 0');
  const tw = parseWindow(tune, 'tune'); const hw = parseWindow(holdout, 'holdout');
  if (tw.to > hw.from) throw new RangeError('tune window must end before the holdout window starts');

  const results = [];
  for (const halfLifeDays of hls) for (const ridge of rs) {
    const run = walkForward(matches, { from: tune.from, to: tune.to, stepDays, halfLifeDays, ridge, minTrainMatches });
    const s = summarize(run);
    results.push({ halfLifeDays, ridge, n: s.model.n, logLoss: s.model.logLoss1x2, brier: s.model.brier1x2, ece: s.model.ece, skippedBlocks: s.skippedBlocks.length });
  }
  const eligible = results.filter((r) => r.n >= minEvalMatches);
  if (eligible.length === 0) throw new RangeError(`no grid point has at least ${minEvalMatches} evaluated matches in the tune window`);
  // Lowest log-loss; ties (within 1e-12) broken by Brier, then by grid order.
  const best = eligible.reduce((b, r) => (r.logLoss < b.logLoss - 1e-12 || (Math.abs(r.logLoss - b.logLoss) <= 1e-12 && r.brier < b.brier) ? r : b));
  const boundaryHit = [];
  if (hls.length > 1 && (best.halfLifeDays === Math.min(...hls) || best.halfLifeDays === Math.max(...hls))) boundaryHit.push('halfLifeDays');
  if (rs.length > 1 && (best.ridge === Math.min(...rs) || best.ridge === Math.max(...rs))) boundaryHit.push('ridge');

  const holdRun = walkForward(matches, { from: holdout.from, to: holdout.to, stepDays, halfLifeDays: best.halfLifeDays, ridge: best.ridge, minTrainMatches });
  return {
    grid: results, best: { halfLifeDays: best.halfLifeDays, ridge: best.ridge, tuneLogLoss: best.logLoss, tuneN: best.n },
    boundaryHit, holdout: { run: holdRun, summary: summarize(holdRun) },
    note: 'Selection used only the tune window. Quote the holdout summary, not the tune scores, as out-of-sample quality.',
  };
}

export { matchEndMs };
