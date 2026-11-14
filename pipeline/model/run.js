// Model job: per competition, fit on everything known now, store the fit, predict upcoming fixtures, store them.
import { acquireLock, finishRun, releaseLock, startRun, toIso } from '../ingest/jobs.js';
import { withRetry } from '../lib/retry.js';
import { matchEndMs } from '../../engine/eligibility.js';
import { fitDixonColes, FIT_DEFAULTS } from '../../engine/fit.js';
import { predictMatch } from '../../engine/predict.js';
import { loadFit, persistFit, persistPredictions } from './persist.js';

const safe = async (fn, warn) => { try { return await fn(); } catch (e) { warn?.(`bookkeeping failed: ${e.message}`); return null; } };

export async function loadMatches(db, competitionId) {
  const rows = await db.all(
    `SELECT id, season, match_date, kickoff_utc, status, home_team_id, away_team_id, home_goals, away_goals
     FROM matches WHERE competition_id = ?`, [competitionId]);
  return rows.map((r) => ({
    id: r.id, season: r.season, matchDate: r.match_date, kickoffUtc: r.kickoff_utc, status: r.status,
    homeTeamId: r.home_team_id, awayTeamId: r.away_team_id, homeGoals: r.home_goals, awayGoals: r.away_goals,
  }));
}

export async function runModelJob({
  db, competitions, now = () => new Date(), owner, config = {}, horizonDays = 14, lockTtlMs = 15 * 60 * 1000, retry = {}, logger = {},
} = {}) {
  if (!owner) throw new RangeError('owner is required');
  const cfg = { halfLifeDays: FIT_DEFAULTS.halfLifeDays, ridge: FIT_DEFAULTS.ridge, minMatches: FIT_DEFAULTS.minMatches, ...config };
  const warn = logger.warn ?? (() => {});
  const dbComps = new Map((await db.all('SELECT id, code FROM competitions')).map((r) => [r.code, r.id]));
  const results = [];

  for (const competition of competitions) {
    const job = `model:${competition.code}`;
    if (!(await withRetry(() => acquireLock(db, { job, owner, ttlMs: lockTtlMs, now: now() }), retry))) { results.push({ competition: competition.code, status: 'locked' }); continue; }
    let runId = null;
    try {
      const competitionId = dbComps.get(competition.code);
      if (competitionId == null) throw new Error(`competition ${competition.code} is not in the database`);
      runId = await withRetry(() => startRun(db, { job: 'model', scope: competition.code, now: now() }), retry);
      const t = now();
      const matches = await loadMatches(db, competitionId);

      let fit;
      try {
        fit = fitDixonColes(matches, { asOf: t, ...cfg });
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        // Not enough finished matches yet: a normal state for a new league, recorded as partial, never as a fake fit.
        await finishRun(db, runId, { now: now(), status: 'partial', detail: { reason: 'insufficient_data', message: e.message } });
        results.push({ competition: competition.code, status: 'insufficient_data', message: e.message });
        continue;
      }
      const persisted = await persistFit(db, { scope: competition.code, fit, matches, now: t, retry });
      const { fitId, created } = persisted;
      // Same data as an earlier fit: predict with the STORED parameters so every prediction is reproducible from its fit row.
      if (!created) fit = await loadFit(db, fitId);

      const horizonEnd = new Date(t.getTime() + horizonDays * 86400000);
      const today = toIso(t).slice(0, 10);
      const upcoming = matches.filter((m) => m.status === 'scheduled' && m.matchDate >= today && m.matchDate <= toIso(horizonEnd).slice(0, 10));
      const predictions = []; let failed = 0; let skippedStarted = 0;
      for (const m of upcoming) {
        // A prediction made after kickoff is not a pre-match prediction. Unknown kickoff: skip once the whole date is over.
        if (m.kickoffUtc ? Date.parse(m.kickoffUtc) <= t.getTime() : matchEndMs(m) < t.getTime()) { skippedStarted++; continue; }
        try { predictions.push({ matchId: m.id, pred: predictMatch({ fit, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }) }); } catch { failed++; }
      }
      const stored = await persistPredictions(db, { fitId, fit, predictions, now: t, retry });
      const partial = failed > 0 || !fit.diagnostics.converged;
      await finishRun(db, runId, {
        now: now(), status: partial ? 'partial' : 'success', rowsWritten: stored.written + (created ? 1 + fit.diagnostics.nTeams : 0), rowsRejected: failed,
        detail: { fitId, fitCreated: created, converged: fit.diagnostics.converged, nMatches: fit.diagnostics.nMatches, predictionsWritten: stored.written, predictionsSkipped: stored.skipped, predictionFailures: failed, skippedStarted, dataAsOf: fit.dataAsOf },
      });
      results.push({ competition: competition.code, status: partial ? 'partial' : 'success', fitId, fitCreated: created, skippedStarted, ...stored });
    } catch (err) {
      warn(`${job}: ${err.message}`);
      if (runId != null) await safe(() => finishRun(db, runId, { now: now(), status: 'failed', error: err.message }), warn);
      results.push({ competition: competition.code, status: 'failed', error: err.message });
    } finally {
      await safe(() => releaseLock(db, { job, owner }), warn);
    }
  }
  return { results };
}
