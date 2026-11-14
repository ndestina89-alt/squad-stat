// Evaluation metrics for probabilistic forecasts. Pure functions, no I/O.
//
// A "record" is one out-of-sample prediction with its observed outcome:
//   { p: { home, draw, away, over25, btts }, outcome: { result: 'H'|'D'|'A', over25: bool, btts: bool } }
const EPS = 1e-15;
export const MARKETS = ['home', 'draw', 'away', 'over_2_5', 'btts_yes'];

const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function outcomeVector(result) {
  if (result === 'H') return [1, 0, 0];
  if (result === 'D') return [0, 1, 0];
  if (result === 'A') return [0, 0, 1];
  throw new RangeError(`bad result: ${result}`);
}

export const resultOf = (homeGoals, awayGoals) => (homeGoals > awayGoals ? 'H' : homeGoals === awayGoals ? 'D' : 'A');
export const observedOutcome = (homeGoals, awayGoals) => ({
  result: resultOf(homeGoals, awayGoals), over25: homeGoals + awayGoals > 2, btts: homeGoals >= 1 && awayGoals >= 1,
});

/** Multi-class Brier score for one match (0 = perfect, 2 = worst). */
export function brier1x2(p, result) {
  const o = outcomeVector(result);
  return (p.home - o[0]) ** 2 + (p.draw - o[1]) ** 2 + (p.away - o[2]) ** 2;
}

/** Negative log-likelihood of the observed result. */
export function logLoss1x2(p, result) {
  const o = outcomeVector(result);
  return -Math.log(clip(o[0] ? p.home : o[1] ? p.draw : p.away));
}

export const brierBinary = (p, happened) => (p - (happened ? 1 : 0)) ** 2;
export const logLossBinary = (p, happened) => -Math.log(clip(happened ? p : 1 - p));

export function predictedResult(p) {
  if (p.home >= p.draw && p.home >= p.away) return 'H';
  return p.draw >= p.away ? 'D' : 'A';
}

/**
 * Reliability bins over [0, 1]. Bins are [lo, hi), the last one also contains 1.
 * Empty bins keep n = 0 and null statistics (never a made-up number).
 */
export function calibrationBins(pairs, nBins = 10) {
  if (!Number.isInteger(nBins) || nBins < 1) throw new RangeError('nBins must be a positive integer');
  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, sumP: 0, sumO: 0 }));
  for (const { p, o } of pairs) {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`probability out of range: ${p}`);
    const b = bins[Math.min(nBins - 1, Math.floor(p * nBins))];
    b.n++; b.sumP += p; b.sumO += o ? 1 : 0;
  }
  return bins.map((b) => ({
    lo: b.lo, hi: b.hi, n: b.n,
    meanPredicted: b.n ? b.sumP / b.n : null,
    observedFrequency: b.n ? b.sumO / b.n : null,
  }));
}

/** Expected calibration error: sample-weighted mean |observed - predicted| over non-empty bins. */
export function expectedCalibrationError(bins) {
  const total = bins.reduce((s, b) => s + b.n, 0);
  if (total === 0) return null;
  return bins.reduce((s, b) => s + (b.n ? (b.n / total) * Math.abs(b.observedFrequency - b.meanPredicted) : 0), 0);
}

const marketPair = (rec, market) => {
  switch (market) {
    case 'home': return { p: rec.p.home, o: rec.outcome.result === 'H' };
    case 'draw': return { p: rec.p.draw, o: rec.outcome.result === 'D' };
    case 'away': return { p: rec.p.away, o: rec.outcome.result === 'A' };
    case 'over_2_5': return { p: rec.p.over25, o: rec.outcome.over25 };
    case 'btts_yes': return { p: rec.p.btts, o: rec.outcome.btts };
    default: throw new RangeError(`unknown market ${market}`);
  }
};

export const perMatchLoss = (records) => records.map((r) => logLoss1x2(r.p, r.outcome.result));

/** Mean and standard error of (a - b) for paired per-match losses. Negative mean = a is better. */
export function pairedDifference(a, b) {
  if (a.length !== b.length) throw new RangeError('paired samples must have equal length');
  const n = a.length;
  if (n < 2) return { n, mean: n ? a[0] - b[0] : null, se: null };
  const d = a.map((v, i) => v - b[i]);
  const m = mean(d);
  const variance = d.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  return { n, mean: m, se: Math.sqrt(variance / n) };
}

/** Full metric set for a list of records. Returns n = 0 and nulls for an empty list. */
export function evaluate(records, { nBins = 10 } = {}) {
  const n = records.length;
  if (n === 0) {
    return { n: 0, brier1x2: null, logLoss1x2: null, logLoss1x2Se: null, accuracy1x2: null, brierOver25: null, brierBtts: null, logLossOver25: null, logLossBtts: null, calibration: {}, ece: {} };
  }
  const losses = perMatchLoss(records);
  const lm = mean(losses);
  const se = n > 1 ? Math.sqrt(losses.reduce((s, v) => s + (v - lm) ** 2, 0) / (n - 1) / n) : null;
  const calibration = {}; const ece = {};
  for (const mk of MARKETS) {
    calibration[mk] = calibrationBins(records.map((r) => marketPair(r, mk)), nBins);
    ece[mk] = expectedCalibrationError(calibration[mk]);
  }
  return {
    n,
    brier1x2: mean(records.map((r) => brier1x2(r.p, r.outcome.result))),
    logLoss1x2: lm,
    logLoss1x2Se: se,
    accuracy1x2: mean(records.map((r) => (predictedResult(r.p) === r.outcome.result ? 1 : 0))),
    brierOver25: mean(records.map((r) => brierBinary(r.p.over25, r.outcome.over25))),
    brierBtts: mean(records.map((r) => brierBinary(r.p.btts, r.outcome.btts))),
    logLossOver25: mean(records.map((r) => logLossBinary(r.p.over25, r.outcome.over25))),
    logLossBtts: mean(records.map((r) => logLossBinary(r.p.btts, r.outcome.btts))),
    calibration, ece,
  };
}
