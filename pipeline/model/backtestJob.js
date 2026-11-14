// Tune half-life/ridge on one window, evaluate the winner on a later holdout, store the HOLDOUT run.
import { acquireLock, finishRun, releaseLock, startRun } from '../ingest/jobs.js';
import { withRetry } from '../lib/retry.js';
import { MODEL_VERSION } from '../../engine/fit.js';
import { tuneParameters } from '../../engine/backtest.js';
import { loadMatches } from './run.js';
import { persistBacktest } from './persist.js';

export async function runBacktestJob({
  db, competition, grid, tune, holdout, stepDays = 7, minTrainMatches = 30, minEvalMatches = 100,
  owner, now = () => new Date(), codeCommit = null, lockTtlMs = 30 * 60 * 1000, retry = {},
}) {
  if (!owner) throw new RangeError('owner is required');
  const job = `backtest:${competition.code}`;
  if (!(await withRetry(() => acquireLock(db, { job, owner, ttlMs: lockTtlMs, now: now() }), retry))) return { status: 'locked' };
  let runId = null;
  try {
    const startedAt = now();
    runId = await withRetry(() => startRun(db, { job: 'backtest', scope: competition.code, now: startedAt }), retry);
    const matches = await loadMatches(db, competition.id);
    const t = tuneParameters(matches, { grid, tune, holdout, stepDays, minTrainMatches, minEvalMatches });
    const summary = t.holdout.summary;
    if (t.holdout.run.records.length === 0) throw new RangeError('holdout window produced no predictions');
    const stored = await persistBacktest(db, {
      summary, records: t.holdout.run.records, modelVersion: MODEL_VERSION, scope: competition.code, codeCommit, startedAt, finishedAt: now(), retry,
      notes: 'Stored run = holdout window with the setting selected on the tune window. Not tuned on these matches.',
      extraConfig: { selection: { tune, grid: t.grid, best: t.best, boundaryHit: t.boundaryHit, minEvalMatches } },
    });
    await finishRun(db, runId, {
      now: now(), status: t.boundaryHit.length || !summary.model.n ? 'partial' : 'success', rowsWritten: stored.predictionsWritten + 51,
      detail: { backtestRunId: stored.runId, best: t.best, boundaryHit: t.boundaryHit, holdoutN: summary.model.n, holdoutLogLoss: summary.model.logLoss1x2, baselineLogLoss: summary.baseline.logLoss1x2 },
    });
    return { status: 'ok', runId: stored.runId, best: t.best, boundaryHit: t.boundaryHit, holdout: summary };
  } catch (err) {
    if (runId != null) await finishRun(db, runId, { now: now(), status: 'failed', error: err.message }).catch(() => {});
    return { status: 'failed', error: err.message };
  } finally {
    await releaseLock(db, { job, owner }).catch(() => {});
  }
}
