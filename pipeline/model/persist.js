// Persistence of fits, predictions and backtests. Writes are idempotent (existence is checked first) and atomic per call.
// Plain INSERT on purpose: INSERT OR IGNORE would silently drop rows that violate a CHECK constraint.
import { applyStatements } from '../ingest/apply.js';
import { toIso } from '../ingest/jobs.js';
import { computeElo } from '../../engine/elo.js';
import { MARKETS } from '../../engine/metrics.js';

/** model_version carries the hyperparameters, so different settings never collide on UNIQUE(model_version, scope, data_as_of). */
export const versionTag = (fit) => `${fit.modelVersion}:hl${fit.config.halfLifeDays}:r${fit.config.ridge}`;

export async function findFit(db, { modelVersion, scope, dataAsOf }) {
  const rows = await db.all('SELECT id FROM model_fits WHERE model_version = ? AND scope = ? AND data_as_of = ?', [modelVersion, scope, dataAsOf]);
  return rows.length ? rows[0].id : null;
}

/**
 * Store a fit and its team ratings in ONE atomic batch. Idempotent: the key is (model_version, scope, data_as_of),
 * where data_as_of is the end of the newest match used, so a rerun with no new results writes nothing.
 * Returns { fitId, created }.
 */
export async function persistFit(db, { scope, fit, matches, now = new Date(), retry = {} }) {
  const modelVersion = versionTag(fit);
  const existing = await findFit(db, { modelVersion, scope, dataAsOf: fit.dataAsOf });
  if (existing != null) return { fitId: existing, created: false };

  const elo = computeElo(matches, { asOf: fit.asOf });
  const params = { ...fit.params, config: fit.config, diagnostics: fit.diagnostics, asOf: fit.asOf, baseModelVersion: fit.modelVersion, dataAsOf: fit.dataAsOf };
  const key = [modelVersion, scope, fit.dataAsOf];
  const statements = [{
    sql: `INSERT INTO model_fits (model_version, scope, data_as_of, n_matches, params_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (model_version, scope, data_as_of) DO NOTHING`,
    params: [modelVersion, scope, fit.dataAsOf, fit.diagnostics.nMatches, JSON.stringify(params), toIso(now)],
  }];
  for (const [teamId, t] of Object.entries(fit.params.teams)) {
    const e = elo.get(Number(teamId));
    statements.push({
      sql: `INSERT INTO team_ratings (fit_id, team_id, elo, attack, defense, home_advantage, matches_used)
            VALUES ((SELECT id FROM model_fits WHERE model_version = ? AND scope = ? AND data_as_of = ?), ?, ?, ?, ?, ?, ?)`,
      params: [...key, Number(teamId), e?.elo ?? 1500, t.attack, t.defense, fit.params.homeAdvantage, t.matchesUsed],
    });
  }
  await applyStatements(db, statements, { chunkSize: 500, retry }); // one chunk = one transaction
  return { fitId: await findFit(db, { modelVersion, scope, dataAsOf: fit.dataAsOf }), created: true };
}

/** Rebuild the fit object exactly as stored, so predictions are reproducible from the database alone. */
export async function loadFit(db, fitId) {
  const rows = await db.all('SELECT params_json, data_as_of FROM model_fits WHERE id = ?', [fitId]);
  if (!rows.length) throw new Error(`fit ${fitId} not found`);
  const p = JSON.parse(rows[0].params_json);
  const { config, diagnostics, asOf, baseModelVersion, dataAsOf, ...params } = p;
  return { modelVersion: baseModelVersion, asOf, dataAsOf: rows[0].data_as_of, params, config, diagnostics };
}

/**
 * Store predictions for (fit, match). Existing (match_id, fit_id) pairs are skipped, so reruns write nothing.
 * predictions: [{ matchId, pred }] with pred from engine/predict.js.
 */
export async function persistPredictions(db, { fitId, fit, predictions, now = new Date(), retry = {} }) {
  const predictedAt = toIso(now);
  if (fit.dataAsOf > predictedAt) throw new RangeError('fit uses data newer than predicted_at');
  const have = new Set((await db.all('SELECT match_id FROM predictions WHERE fit_id = ?', [fitId])).map((r) => r.match_id));
  const fresh = predictions.filter((p) => !have.has(p.matchId));
  const statements = fresh.map(({ matchId, pred }) => ({
    sql: `INSERT INTO predictions (match_id, fit_id, model_version, predicted_at, data_as_of, goal_expectation_kind,
            expected_home_goals, expected_away_goals, p_home, p_draw, p_away, p_over_2_5, p_btts_yes, tail_mass,
            matrix_max_goals, top_scores_json, uncertainty_json, feature_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [matchId, fitId, versionTag(fit), predictedAt, pred.dataAsOf, pred.goalExpectationKind,
      pred.expectedHomeGoals, pred.expectedAwayGoals, pred.pHome, pred.pDraw, pred.pAway, pred.pOver25, pred.pBttsYes,
      pred.tailMass, pred.matrixMaxGoals, JSON.stringify(pred.topScores), JSON.stringify(pred.uncertainty), pred.featureHash],
  }));
  await applyStatements(db, statements, { chunkSize: 100, retry });
  return { written: statements.length, skipped: predictions.length - fresh.length };
}

/**
 * Store one backtest run (config, metrics, every out-of-sample prediction, calibration bins) atomically.
 * Call it for the chosen configuration only, not for every grid point: each run writes one row per predicted match,
 * and D1 Free allows 100k row writes per day.
 */
export async function persistBacktest(db, { summary, records, modelVersion, scope, codeCommit = null, notes = null, startedAt, finishedAt, extraConfig = {}, retry = {} }) {
  if (!(records.length > 0)) throw new RangeError('refusing to store a backtest with no predictions');
  const m = summary.model;
  const config = { scope, ...summary.config, ...extraConfig, counts: summary.counts, skippedBlocks: summary.skippedBlocks.length, logLossVsBaseline: summary.logLossVsBaseline, baseline: { logLoss1x2: summary.baseline.logLoss1x2, brier1x2: summary.baseline.brier1x2 } };
  const { lastRowId } = await db.run(
    `INSERT INTO backtest_runs (model_version, code_commit, started_at, finished_at, config_json, n_matches, brier_1x2, log_loss_1x2,
       accuracy_1x2, brier_over_2_5, brier_btts, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [modelVersion, codeCommit, toIso(startedAt), toIso(finishedAt), JSON.stringify(config), m.n, m.brier1x2, m.logLoss1x2, m.accuracy1x2, m.brierOver25, m.brierBtts, notes]);

  const statements = [];
  for (const r of records) {
    statements.push({
      sql: 'INSERT INTO backtest_predictions (run_id, match_id, data_cutoff, p_home, p_draw, p_away, p_over_2_5, p_btts_yes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [lastRowId, r.matchId, r.cutoff, r.p.home, r.p.draw, r.p.away, r.p.over25, r.p.btts],
    });
  }
  for (const market of MARKETS) {
    for (const b of m.calibration[market]) {
      statements.push({
        sql: 'INSERT INTO calibration_bins (run_id, market, bin_lo, bin_hi, n, mean_predicted, observed_frequency) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [lastRowId, market, b.lo, b.hi, b.n, b.meanPredicted, b.observedFrequency],
      });
    }
  }
  try {
    await applyStatements(db, statements, { chunkSize: 400, retry });
  } catch (e) {
    // Do not leave a header row that claims metrics without the predictions behind them (cascade removes children).
    try { await db.run('DELETE FROM backtest_runs WHERE id = ?', [lastRowId]); } catch { /* best effort */ }
    throw e;
  }
  return { runId: lastRowId, predictionsWritten: records.length };
}
