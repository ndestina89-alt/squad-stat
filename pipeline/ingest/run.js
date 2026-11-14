// Orchestrator: one provider, one season, many competitions.
// Each competition is its own locked, recorded unit of work, so a failure in one never stops the others.
import { withRetry } from '../lib/retry.js';
import { acquireLock, finishRun, reapStaleRuns, recordAttempt, recordProviderResult, releaseLock, startRun } from './jobs.js';
import { ingestMatches } from './matches.js';
import { ingestStandings } from './standings.js';

const noop = () => {};
const safe = async (fn, log) => { try { return await fn(); } catch (e) { log(`bookkeeping failed: ${e.message}`); return null; } };

export async function runProviderIngest({
  db, provider, competitions, season, now = () => new Date(), owner, lockTtlMs = 15 * 60 * 1000,
  retry = {}, logger = {},
} = {}) {
  if (!owner) throw new RangeError('owner is required');
  const log = { info: logger.info ?? noop, warn: logger.warn ?? noop };

  await safe(() => reapStaleRuns(db, { now: now() }), log.warn);
  const dbCompetitions = new Map((await db.all('SELECT id, code FROM competitions')).map((r) => [r.code, r.id]));
  const results = [];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let lastError = null;

  await recordAttempt(db, provider.id, now());

  for (const competition of competitions) {
    if (provider.supports && !provider.supports(competition)) {
      results.push({ competition: competition.code, status: 'unsupported' });
      continue;
    }
    const job = `ingest:${provider.id}:${competition.code}:${season}`;
    if (!(await withRetry(() => acquireLock(db, { job, owner, ttlMs: lockTtlMs, now: now() }), retry))) {
      log.warn(`${job}: another run holds the lock, skipping`);
      results.push({ competition: competition.code, status: 'locked' });
      continue;
    }

    attempted++;
    let runId = null;
    try {
      const competitionId = dbCompetitions.get(competition.code);
      if (competitionId == null) throw new Error(`competition ${competition.code} is not in the database (run migrations)`);
      const dbComp = { id: competitionId, code: competition.code };

      runId = await withRetry(() => startRun(db, { job: `ingest:${provider.id}`, scope: `${competition.code}:${season}`, now: now() }), retry);
      const fetched = await provider.fetchCompetition({ competition, season });
      const matchSummary = await ingestMatches({
        db, provider, competition: dbComp, season, matches: fetched.matches,
        now: now(), fetchedAt: fetched.meta?.fetchedAt, retry,
      });
      let standingsSummary = null;
      if (fetched.standings) {
        standingsSummary = await ingestStandings({
          db, provider, competition: dbComp, season, standings: fetched.standings,
          now: now(), fetchedAt: fetched.meta?.fetchedAt, retry,
        });
      }

      const partial = matchSummary.unmappedSkipped > 0 || matchSummary.conflicts.length > 0 || (standingsSummary?.unmappedSkipped ?? 0) > 0;
      const status = partial ? 'partial' : 'success';
      const { conflicts, unmappedNames, ...counts } = matchSummary;
      await finishRun(db, runId, {
        now: now(), status,
        rowsWritten: matchSummary.statementsExecuted + (standingsSummary?.statementsExecuted ?? 0),
        rowsRejected: (fetched.rejects?.length ?? 0) + matchSummary.unmappedSkipped + matchSummary.duplicateIncoming,
        detail: {
          ...counts,
          conflictCount: conflicts.length, conflictSample: conflicts.slice(0, 5),
          unmappedNames: unmappedNames.slice(0, 10),
          rejectReasons: countBy(fetched.rejects ?? [], (r) => r.reason),
          standings: standingsSummary,
        },
      });
      succeeded++;
      results.push({ competition: competition.code, status, runId, summary: matchSummary, standings: standingsSummary });
      log.info(`${job}: ${status}, ${matchSummary.inserted} inserted, ${matchSummary.updated} updated`);
    } catch (err) {
      failed++;
      lastError = `${competition.code}: ${err.message}`;
      log.warn(`${job}: failed: ${err.message}`);
      if (runId != null) await safe(() => finishRun(db, runId, { now: now(), status: 'failed', error: err.message }), log.warn);
      results.push({ competition: competition.code, status: 'failed', runId, error: err.message });
    } finally {
      await safe(() => releaseLock(db, { job, owner }), log.warn);
    }
  }

  if (attempted > 0) await recordProviderResult(db, provider.id, { now: now(), succeeded, failed, error: lastError });
  return { provider: provider.id, season, results, attempted, succeeded, failed };
}

/** Run several seasons in order (historical backfill). One season's failure does not stop the rest. */
export async function runBackfill({ seasons, ...opts }) {
  const runs = [];
  for (const season of seasons) runs.push(await runProviderIngest({ ...opts, season }));
  return runs;
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}
