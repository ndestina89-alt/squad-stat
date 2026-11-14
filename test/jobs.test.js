import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.js';
import { sqliteDb } from './helpers/sqliteDb.js';
import {
  acquireLock, releaseLock, startRun, finishRun, reapStaleRuns, recordAttempt, recordProviderResult,
} from '../pipeline/ingest/jobs.js';

const T0 = new Date('2026-11-12T08:00:00Z');
const plus = (ms) => new Date(T0.getTime() + ms);
const fresh = () => { const raw = createTestDb(); return { raw, db: sqliteDb(raw) }; };

test('only one owner can hold a lock; a second owner is refused until it expires', async () => {
  const { db } = fresh();
  assert.equal(await acquireLock(db, { job: 'ingest:PL', owner: 'a', ttlMs: 600000, now: T0 }), true);
  assert.equal(await acquireLock(db, { job: 'ingest:PL', owner: 'b', ttlMs: 600000, now: plus(1000) }), false);
  assert.equal(await acquireLock(db, { job: 'ingest:PL', owner: 'a', ttlMs: 600000, now: plus(2000) }), false, 'even the same owner cannot re-enter a live lease');
  assert.equal(await acquireLock(db, { job: 'ingest:PD', owner: 'b', ttlMs: 600000, now: T0 }), true, 'locks are per job');
  assert.equal(await acquireLock(db, { job: 'ingest:PL', owner: 'b', ttlMs: 600000, now: plus(600000) }), true, 'expired lease can be taken over');
  const row = (await db.all("SELECT owner, expires_at FROM job_locks WHERE job = 'ingest:PL'"))[0];
  assert.equal(row.owner, 'b');
  assert.equal(row.expires_at, '2026-11-12T08:20:00Z');
});

test('concurrent acquisition yields exactly one winner', async () => {
  const { db } = fresh();
  const results = await Promise.all(['a', 'b', 'c', 'd'].map((owner) => acquireLock(db, { job: 'j', owner, ttlMs: 60000, now: T0 })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('release only works for the current owner', async () => {
  const { db } = fresh();
  await acquireLock(db, { job: 'j', owner: 'a', ttlMs: 60000, now: T0 });
  assert.equal(await releaseLock(db, { job: 'j', owner: 'b' }), false);
  assert.equal(await releaseLock(db, { job: 'j', owner: 'a' }), true);
  assert.equal(await acquireLock(db, { job: 'j', owner: 'b', ttlMs: 60000, now: plus(1) }), true);
});

test('lock arguments are validated', async () => {
  const { db } = fresh();
  await assert.rejects(acquireLock(db, { job: 'j', owner: 'a', ttlMs: 0, now: T0 }), RangeError);
  await assert.rejects(acquireLock(db, { job: '', owner: 'a', ttlMs: 1000, now: T0 }), RangeError);
});

test('run history: start, finish with detail, and oversized detail is truncated', async () => {
  const { db } = fresh();
  const id = await startRun(db, { job: 'ingest:x', scope: 'PL', now: T0 });
  assert.equal((await db.all('SELECT status FROM job_runs WHERE id = ?', [id]))[0].status, 'running');
  await finishRun(db, id, { now: plus(5000), status: 'success', rowsWritten: 12, rowsRejected: 3, detail: { inserted: 12 } });
  const r = (await db.all('SELECT * FROM job_runs WHERE id = ?', [id]))[0];
  assert.deepEqual([r.status, r.rows_written, r.rows_rejected, r.finished_at], ['success', 12, 3, '2026-11-12T08:00:05Z']);
  assert.deepEqual(JSON.parse(r.detail_json), { inserted: 12 });
  const id2 = await startRun(db, { job: 'ingest:x', now: T0 });
  await finishRun(db, id2, { status: 'failed', error: 'e'.repeat(2000), detail: { big: 'x'.repeat(9000) } });
  const r2 = (await db.all('SELECT error, detail_json FROM job_runs WHERE id = ?', [id2]))[0];
  assert.equal(r2.error.length, 500);
  assert.equal(JSON.parse(r2.detail_json).truncated, true);
});

test('runs left "running" by a crashed runner are reaped; recent and finished ones are not', async () => {
  const { db } = fresh();
  const old = await startRun(db, { job: 'a', now: plus(-3 * 3600000) });
  const recent = await startRun(db, { job: 'b', now: plus(-60000) });
  const done = await startRun(db, { job: 'c', now: plus(-5 * 3600000) });
  await finishRun(db, done, { status: 'success', now: plus(-5 * 3600000 + 1000) });
  assert.equal(await reapStaleRuns(db, { now: T0 }), 1);
  const st = Object.fromEntries((await db.all('SELECT id, status FROM job_runs')).map((r) => [r.id, r.status]));
  assert.deepEqual(st, { [old]: 'failed', [recent]: 'running', [done]: 'success' });
});

test('provider health: success advances last_success_at; failures accumulate and reset only on a clean run', async () => {
  const { db } = fresh();
  const P = 'football-data.org';
  const get = async () => (await db.all('SELECT * FROM source_status WHERE provider_id = ?', [P]))[0];
  await recordAttempt(db, P, T0);
  assert.equal((await get()).last_attempt_at, '2026-11-12T08:00:00Z');
  assert.equal((await get()).last_success_at, null);

  await recordProviderResult(db, P, { now: T0, succeeded: 5, failed: 1, error: 'HTTP 503' });
  let s = await get();
  assert.deepEqual([s.last_success_at, s.consecutive_failures, s.last_error], ['2026-11-12T08:00:00Z', 1, 'HTTP 503']);

  await recordProviderResult(db, P, { now: plus(3600000), succeeded: 0, failed: 6, error: 'down' });
  s = await get();
  assert.deepEqual([s.last_success_at, s.consecutive_failures], ['2026-11-12T08:00:00Z', 2]);

  await recordProviderResult(db, P, { now: plus(7200000), succeeded: 6, failed: 0 });
  s = await get();
  assert.deepEqual([s.last_success_at, s.consecutive_failures, s.last_error], ['2026-11-12T10:00:00Z', 0, null]);

  await assert.rejects(recordAttempt(db, 'nope', T0), /no row/);
});
