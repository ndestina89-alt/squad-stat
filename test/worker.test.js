import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, buildHealth } from '../worker/src/index.js';
import { createTestDb, d1Adapter } from './helpers/db.js';

const NOW = Date.parse('2026-11-12T08:00:00Z');
const req = (path, method = 'GET') => new Request(`https://api.test${path}`, { method });

function setup() {
  const db = createTestDb();
  return { db, env: { DB: d1Adapter(db), STALE_AFTER_HOURS: '6' } };
}
const mark = (db, provider, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE source_status SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE provider_id = ?`).run(...cols.map((c) => fields[c]), provider);
};

test('fresh install: enabled providers have never succeeded, so the service reports stale (no fake "ok")', async () => {
  const { env } = setup();
  const res = await handle(req('/api/health'), env, NOW);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'stale');
  assert.deepEqual(body.providers.map((p) => p.provider), ['football-data.co.uk', 'football-data.org'], 'disabled ESPN is not monitored');
  assert.ok(body.providers.every((p) => p.stale && p.age_minutes === null && p.last_success_at === null));
  assert.deepEqual(body.latest_jobs, []);
});

test('ok when every enabled provider succeeded recently', async () => {
  const { db, env } = setup();
  mark(db, 'football-data.org', { last_success_at: '2026-11-12T07:30:00Z', last_attempt_at: '2026-11-12T07:30:00Z' });
  mark(db, 'football-data.co.uk', { last_success_at: '2026-11-12T03:00:00Z' });
  const body = await (await handle(req('/api/health'), env, NOW)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.providers.find((p) => p.provider === 'football-data.org').age_minutes, 30);
  assert.equal(body.stale_after_hours, 6);
});

test('degraded when attempts fail but data is still within the freshness window', async () => {
  const { db, env } = setup();
  mark(db, 'football-data.org', { last_success_at: '2026-11-12T07:00:00Z', consecutive_failures: 2, last_error: 'HTTP 503' });
  mark(db, 'football-data.co.uk', { last_success_at: '2026-11-12T07:00:00Z' });
  const body = await (await handle(req('/api/health'), env, NOW)).json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.providers[1].last_error, 'HTTP 503');
});

test('stale beats degraded once the last success is older than the threshold', async () => {
  const { db, env } = setup();
  mark(db, 'football-data.org', { last_success_at: '2026-11-12T01:00:00Z', consecutive_failures: 3 });
  mark(db, 'football-data.co.uk', { last_success_at: '2026-11-12T07:00:00Z' });
  const body = await (await handle(req('/api/health'), env, NOW)).json();
  assert.equal(body.status, 'stale');
  assert.equal(body.providers.find((p) => p.provider === 'football-data.org').stale, true);
});

test('threshold is configurable and falls back to 6 hours on bad config', async () => {
  const { db, env } = setup();
  mark(db, 'football-data.org', { last_success_at: '2026-11-12T05:00:00Z' });
  mark(db, 'football-data.co.uk', { last_success_at: '2026-11-12T05:00:00Z' });
  assert.equal((await buildHealth({ ...env, STALE_AFTER_HOURS: '2' }, NOW)).status, 'stale');
  assert.equal((await buildHealth({ ...env, STALE_AFTER_HOURS: '12' }, NOW)).status, 'ok');
  assert.equal((await buildHealth({ ...env, STALE_AFTER_HOURS: 'abc' }, NOW)).stale_after_hours, 6);
  assert.equal((await buildHealth({ ...env, STALE_AFTER_HOURS: '-1' }, NOW)).stale_after_hours, 6);
});

test('latest run of each job is listed', async () => {
  const { db, env } = setup();
  const ins = db.prepare("INSERT INTO job_runs (job, scope, started_at, finished_at, status, rows_written) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run('ingest', 'PL', '2026-11-12T06:00:00Z', '2026-11-12T06:01:00Z', 'failed', 0);
  ins.run('ingest', 'PL', '2026-11-12T07:00:00Z', '2026-11-12T07:01:00Z', 'success', 42);
  ins.run('fit', 'PL', '2026-11-12T07:05:00Z', null, 'running', 0);
  const body = await (await handle(req('/api/health'), env, NOW)).json();
  assert.deepEqual(body.latest_jobs.map((j) => [j.job, j.status, j.rows_written]), [['fit', 'running', 0], ['ingest', 'success', 42]]);
});

test('database failure returns 503 without leaking internals', async () => {
  const env = { DB: { prepare: () => { throw new Error('D1_ERROR: secret table name leaked'); } } };
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await handle(req('/api/health'), env, NOW);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(!text.includes('secret'));
    assert.equal(JSON.parse(text).status, 'error');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    console.error = orig;
  }
});

test('routing, methods and CORS', async () => {
  const { env } = setup();
  assert.equal((await handle(req('/nope'), env, NOW)).status, 404);
  assert.equal((await handle(req('/api/health?x=1'), env, NOW)).status, 200);
  const post = await handle(req('/api/health', 'POST'), env, NOW);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
  const opt = await handle(req('/api/health', 'OPTIONS'), env, NOW);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  const res = await handle(req('/api/health'), { ...env, ALLOWED_ORIGIN: 'https://squad-stat.pages.dev' }, NOW);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://squad-stat.pages.dev');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
