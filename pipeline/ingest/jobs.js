// Job bookkeeping on top of the Db interface: lease locks, run history and provider health.

export const toIso = (d) => (d instanceof Date ? d : new Date(d)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Take the lease for `job`. Atomic: a single upsert that only overwrites an EXPIRED lease.
 * Not re-entrant on purpose: if a retried call's first attempt actually succeeded, the run is skipped and the
 * lease expires by itself (TTL), which is safer than two runs believing they hold it.
 * Returns true if this owner now holds the lock.
 */
export async function acquireLock(db, { job, owner, ttlMs, now = new Date() }) {
  if (!job || !owner) throw new RangeError('job and owner are required');
  if (!(ttlMs > 0)) throw new RangeError('ttlMs must be > 0');
  const start = new Date(now);
  const { changes } = await db.run(
    `INSERT INTO job_locks (job, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (job) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
     WHERE job_locks.expires_at <= excluded.acquired_at`,
    [job, owner, toIso(start), toIso(new Date(start.getTime() + Math.ceil(ttlMs / 1000) * 1000))],
  );
  return changes > 0;
}

/** Release the lock only if this owner still holds it. */
export async function releaseLock(db, { job, owner }) {
  const { changes } = await db.run('DELETE FROM job_locks WHERE job = ? AND owner = ?', [job, owner]);
  return changes > 0;
}

export async function startRun(db, { job, scope = null, now = new Date() }) {
  const { lastRowId } = await db.run(
    "INSERT INTO job_runs (job, scope, started_at, status) VALUES (?, ?, ?, 'running')",
    [job, scope, toIso(now)],
  );
  if (lastRowId == null) throw new Error('job_runs insert did not return an id');
  return lastRowId;
}

const MAX_DETAIL_CHARS = 4000;

export async function finishRun(db, id, { now = new Date(), status, rowsWritten = 0, rowsRejected = 0, error = null, detail = null }) {
  let detailJson = detail == null ? null : JSON.stringify(detail);
  if (detailJson && detailJson.length > MAX_DETAIL_CHARS) detailJson = JSON.stringify({ truncated: true, chars: detailJson.length });
  await db.run(
    'UPDATE job_runs SET finished_at = ?, status = ?, rows_written = ?, rows_rejected = ?, error = ?, detail_json = ? WHERE id = ?',
    [toIso(now), status, rowsWritten, rowsRejected, error == null ? null : String(error).slice(0, 500), detailJson, id],
  );
}

/** Mark runs that never recorded an end (crashed runner) as failed so history and health do not lie. */
export async function reapStaleRuns(db, { now = new Date(), olderThanMs = 60 * 60 * 1000 } = {}) {
  const cutoff = toIso(new Date(new Date(now).getTime() - olderThanMs));
  const { changes } = await db.run(
    "UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'abandoned: no finish recorded' WHERE status = 'running' AND started_at < ?",
    [toIso(now), cutoff],
  );
  return changes;
}

export async function recordAttempt(db, provider, now = new Date()) {
  const { changes } = await db.run('UPDATE source_status SET last_attempt_at = ? WHERE provider_id = ?', [toIso(now), provider]);
  if (changes === 0) throw new Error(`source_status has no row for provider ${provider}`);
}

/**
 * Provider health after a run over several competitions.
 * last_success_at advances when at least one competition succeeded; consecutive_failures resets only when none failed.
 */
export async function recordProviderResult(db, provider, { now = new Date(), succeeded, failed, error = null }) {
  const { changes } = await db.run(
    `UPDATE source_status SET
       last_success_at = CASE WHEN ? > 0 THEN ? ELSE last_success_at END,
       consecutive_failures = CASE WHEN ? > 0 THEN consecutive_failures + 1 ELSE 0 END,
       last_error = CASE WHEN ? > 0 THEN ? ELSE NULL END
     WHERE provider_id = ?`,
    [succeeded, toIso(now), failed, failed, error == null ? null : String(error).slice(0, 300), provider],
  );
  if (changes === 0) throw new Error(`source_status has no row for provider ${provider}`);
}
