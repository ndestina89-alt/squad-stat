import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/src/index.js';
import { createTestDb, d1Adapter } from './helpers/db.js';
import { sqliteDb } from './helpers/sqliteDb.js';
import { seedLeague } from './helpers/league.js';
import { runModelJob, loadMatches } from '../pipeline/model/run.js';
import { persistBacktest } from '../pipeline/model/persist.js';
import { walkForward, summarize } from '../engine/backtest.js';

const NOW = new Date('2026-01-10T08:00:00Z');
const req = (path, method = 'GET') => new Request(`https://api.test${path}`, { method });
const get = async (env, path, nowMs = NOW.getTime() + 3600000) => { const r = await handle(req(path), env, nowMs); return { status: r.status, body: await r.json(), headers: r.headers }; };

async function populated() {
  const raw = createTestDb();
  const fixtures = [{ date: '2026-01-12', home: 1, away: 2 }, { date: '2026-01-14', home: 3, away: 4 }, { date: '2026-02-20', home: 5, away: 6 }];
  seedLeague(raw, { fixtures });
  const db = sqliteDb(raw);
  await runModelJob({ db, competitions: [{ code: 'PL' }], owner: 'o', now: () => NOW });
  raw.prepare("INSERT INTO standings (competition_id, season, stage, team_id, position, played, won, drawn, lost, goals_for, goals_against, points, provider_id, fetched_at) VALUES (1, 2025, 'REGULAR_SEASON', 2, 2, 3, 1, 1, 1, 3, 3, 4, 'football-data.org', '2026-01-10T06:00:00Z'), (1, 2025, 'REGULAR_SEASON', 1, 1, 3, 2, 1, 0, 5, 2, 7, 'football-data.org', '2026-01-10T06:00:00Z')").run();
  return { raw, db, env: { DB: d1Adapter(raw), STALE_AFTER_HOURS: '6' }, fixtures };
}

test('/api/competitions lists enabled competitions with the latest model info', async () => {
  const { env } = await populated();
  const { status, body } = await get(env, '/api/competitions');
  assert.equal(status, 200);
  assert.ok(!body.data.some((c) => c.code === 'EL'), 'disabled competition hidden');
  const pl = body.data.find((c) => c.code === 'PL');
  assert.ok(pl.model_data_as_of && pl.model_version.startsWith('dc-td-1'));
  assert.equal(body.data.find((c) => c.code === 'PD').model_data_as_of, null);
  assert.equal(body.meta.model_stale, false);
});

test('/api/matches returns upcoming matches with honest prediction fields', async () => {
  const { env, fixtures } = await populated();
  const { body } = await get(env, '/api/matches?competition=PL&status=scheduled');
  assert.equal(body.data.length, 3, 'two predicted fixtures plus the one outside the horizon');
  assert.deepEqual(body.data.map((m) => m.match_date), [...body.data.map((m) => m.match_date)].sort());
  const m = body.data.find((x) => x.id === fixtures[0].id);
  assert.equal(m.home.name, 'Synthetic FC 1');
  assert.equal(m.score, null);
  assert.equal(m.prediction.goal_expectation.kind, 'model_goal_expectation');
  const pr = m.prediction.probabilities;
  assert.ok(Math.abs(pr.home + pr.draw + pr.away - 1) <= 0.001);
  assert.ok(m.prediction.tail_mass >= 0 && m.prediction.data_as_of && m.prediction.model_version);
  const far = body.data.find((x) => x.match_date === '2026-02-20');
  assert.equal(far.prediction, null, 'no prediction is invented for a match outside the horizon');
  assert.equal(body.meta.has_more, false);
});

test('/api/matches finished results are newest first, with score basis; filters and paging work', async () => {
  const { env } = await populated();
  const a = await get(env, '/api/matches?competition=PL&status=finished&limit=5');
  assert.equal(a.body.data.length, 5);
  assert.equal(a.body.meta.has_more, true);
  assert.ok(a.body.data[0].match_date >= a.body.data[4].match_date);
  assert.equal(a.body.data[0].score.basis, 'regular_time');
  assert.equal(a.body.data[0].prediction, null);
  const b = await get(env, '/api/matches?competition=PL&status=finished&limit=5&offset=5');
  assert.ok(!b.body.data.some((m) => a.body.data.some((x) => x.id === m.id)), 'pages do not overlap');
  const ranged = await get(env, '/api/matches?competition=PL&status=finished&from=2025-08-01&to=2025-08-02');
  assert.ok(ranged.body.data.length > 0 && ranged.body.data.every((m) => m.match_date >= '2025-08-01' && m.match_date <= '2025-08-02'));
  assert.equal((await get(env, '/api/matches?competition=PD')).body.data.length, 0);
});

test('the latest prediction per match is the one served', async () => {
  const { raw, env, fixtures } = await populated();
  const row = raw.prepare('SELECT * FROM predictions WHERE match_id = ?').get(fixtures[0].id);
  raw.prepare("INSERT INTO model_fits (model_version, scope, data_as_of, n_matches, params_json, created_at) VALUES ('other', 'PL', '2026-01-05T00:00:00Z', 1, '{}', '2026-01-10T09:00:00Z')").run();
  const fid = raw.prepare("SELECT id FROM model_fits WHERE model_version = 'other'").get().id;
  raw.prepare(`INSERT INTO predictions (match_id, fit_id, model_version, predicted_at, data_as_of, expected_home_goals, expected_away_goals, p_home, p_draw, p_away, p_over_2_5, p_btts_yes, tail_mass, matrix_max_goals, feature_hash)
    VALUES (?, ?, 'other', '2026-01-10T09:00:00Z', '2026-01-05T00:00:00Z', 1, 1, 0.4, 0.3, 0.3, 0.5, 0.5, 0, 10, 'h')`).run(fixtures[0].id, fid);
  const { body } = await get(env, `/api/matches/${fixtures[0].id}`);
  assert.equal(body.data.prediction.model_version, 'other');
  assert.notEqual(row.model_version, 'other');
});

test('/api/matches/:id gives top scores, uncertainty, feature hash and the team ratings of the predicting fit', async () => {
  const { env, fixtures } = await populated();
  const { status, body } = await get(env, `/api/matches/${fixtures[0].id}`);
  assert.equal(status, 200);
  const p = body.data.prediction;
  assert.equal(p.top_scores.length, 5);
  assert.ok(Array.isArray(p.uncertainty.flags));
  assert.match(p.feature_hash, /^[0-9a-f]{64}$/);
  assert.ok(body.data.team_ratings.home.attack > 0 && body.data.team_ratings.away.elo > 0);
  assert.equal((await get(env, '/api/matches/999999')).status, 404);
  assert.equal((await get(env, '/api/matches/abc')).status, 404);
});

test('/api/standings and /api/ratings and /api/evaluation', async () => {
  const { raw, db, env } = await populated();
  const st = await get(env, '/api/standings?competition=PL');
  assert.deepEqual(st.body.data.map((r) => r.position), [1, 2]);
  assert.equal(st.body.meta.season, 2025);
  assert.deepEqual((await get(env, '/api/standings?competition=PD')).body.data, []);
  const rt = await get(env, '/api/ratings?competition=PL');
  assert.equal(rt.body.data.length, 6);
  assert.ok(rt.body.data[0].elo >= rt.body.data[5].elo);
  assert.ok(rt.body.meta.fit.data_as_of);
  assert.deepEqual((await get(env, '/api/ratings?competition=PD')).body.data, []);

  assert.equal((await get(env, '/api/evaluation?competition=PL')).body.meta.reason, 'no_backtest_yet');
  const ms = await loadMatches(db, 1);
  const run = walkForward(ms, { from: '2025-09-15T00:00:00Z', to: '2025-10-15T00:00:00Z', halfLifeDays: 365, ridge: 0.5, minTrainMatches: 20 });
  const summary = summarize(run);
  await persistBacktest(db, { summary, records: run.records, modelVersion: 'dc-td-1', scope: 'PL', startedAt: NOW, finishedAt: NOW });
  const ev = await get(env, '/api/evaluation?competition=PL');
  assert.equal(ev.body.data.n_matches, run.records.length);
  assert.ok(Math.abs(ev.body.data.metrics.log_loss_1x2 - summary.model.logLoss1x2) < 1e-12);
  assert.equal(Object.keys(ev.body.data.calibration).length, 5);
  assert.equal(ev.body.data.calibration.home.length, 10);
  assert.equal(ev.body.data.config.half_life_days, 365);
  assert.ok(ev.body.data.baseline.logLoss1x2 > 0);
  assert.equal((await get(env, '/api/evaluation?competition=PD')).body.data, null);
  void raw;
});

test('staleness: the model is reported overdue when its last success is old or missing', async () => {
  const { env } = await populated();
  assert.equal((await get(env, '/api/matches?competition=PL', NOW.getTime() + 3 * 86400000)).body.meta.model_stale, true);
  const empty = { DB: d1Adapter(createTestDb()), STALE_AFTER_HOURS: '6' };
  const r = await get(empty, '/api/matches');
  assert.equal(r.body.meta.model_last_run_at, null);
  assert.equal(r.body.meta.model_stale, true);
});

test('input validation returns 400 with a reason; nothing is interpolated into SQL', async () => {
  const { env } = await populated();
  for (const path of [
    '/api/matches?competition=pl', "/api/matches?competition=PL'%3B%20DROP%20TABLE%20matches--", '/api/matches?status=bogus', '/api/matches?limit=0', '/api/matches?limit=101',
    '/api/matches?limit=abc', '/api/matches?from=2026-02-30', '/api/matches?from=2026-02-01&to=2026-01-01', '/api/matches?foo=1', '/api/standings', '/api/standings?competition=PL&season=26',
    '/api/ratings', '/api/evaluation', '/api/competitions?x=1', '/api/matches/1?x=1',
  ]) {
    const r = await get(env, path);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error, 'bad_request');
  }
  const t = (await env.DB.prepare("SELECT count(*) c FROM sqlite_master WHERE name = 'matches'").all()).results[0].c;
  assert.equal(t, 1);
});

test('database failure returns a generic 503 without leaking internals; writes are refused; unknown routes 404', async () => {
  const broken = { DB: { prepare() { throw new Error('secret connection string xyz'); } } };
  const r = await handle(req('/api/matches'), broken, NOW.getTime());
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(await r.json()).includes('secret'));
  const { env } = await populated();
  assert.equal((await handle(req('/api/matches', 'POST'), env, NOW.getTime())).status, 405);
  assert.equal((await get(env, '/api/nope')).status, 404);
  assert.equal((await get(env, '/api/matches/')).status, 200, 'trailing slash on the collection is tolerated');
});

test('responses carry CORS and caching headers', async () => {
  const { env } = await populated();
  const r = await get(env, '/api/matches?competition=PL');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('cache-control'), /max-age/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('match detail includes a score matrix rebuilt from stored parameters that agrees with the stored probabilities', async () => {
  const { raw, env, fixtures } = await populated();
  const { body } = await get(env, `/api/matches/${fixtures[0].id}`);
  const sm = body.data.score_matrix;
  assert.ok(sm && sm.cells.length === sm.max_goals + 1);
  assert.equal(sm.source, 'recomputed_from_stored_parameters');
  const sum = sm.cells.flat().reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - (1 - sm.tail_mass)) < 1e-6, 'matrix mass equals 1 - reported tail');
  let home = 0; let draw = 0; let away = 0;
  sm.cells.forEach((row, x) => row.forEach((p, y) => { if (x > y) home += p; else if (x === y) draw += p; else away += p; }));
  const pr = body.data.prediction.probabilities;
  assert.ok(Math.abs(home - pr.home) < 1e-5 && Math.abs(draw - pr.draw) < 1e-5 && Math.abs(away - pr.away) < 1e-5);
  // an unusable fit row degrades to null instead of failing the endpoint
  raw.prepare("UPDATE model_fits SET params_json = '{}'").run();
  const again = await get(env, `/api/matches/${fixtures[0].id}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.score_matrix, null);
});
