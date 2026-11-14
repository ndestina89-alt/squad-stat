import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.js';
import { sqliteDb, flakyDb } from './helpers/sqliteDb.js';
import { seedLeague } from './helpers/league.js';
import { D1Error } from '../pipeline/lib/d1.js';
import { runModelJob } from '../pipeline/model/run.js';
import { loadFit, persistBacktest, persistFit, persistPredictions, versionTag } from '../pipeline/model/persist.js';
import { fitDixonColes } from '../engine/fit.js';
import { predictMatch } from '../engine/predict.js';
import { walkForward, summarize } from '../engine/backtest.js';
import { loadMatches } from '../pipeline/model/run.js';

const NOW = new Date('2026-01-10T08:00:00Z');
const fastRetry = { baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };
const FIX = () => [{ date: '2026-01-12', home: 1, away: 2 }, { date: '2026-01-14', home: 3, away: 4 }, { date: '2026-02-20', home: 5, away: 6 }, { date: '2026-01-09', home: 2, away: 1 }];
const count = (raw, t) => Number(raw.prepare(`SELECT count(*) c FROM ${t}`).get().c);
const all = (raw, t) => raw.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all().map((r) => ({ ...r }));

function setup() {
  const raw = createTestDb();
  const fixtures = FIX();
  seedLeague(raw, { fixtures });
  return { raw, db: sqliteDb(raw), fixtures };
}
const job = (db, extra = {}) => runModelJob({ db, competitions: [{ code: 'PL' }], owner: 'o', now: () => NOW, retry: fastRetry, ...extra });

test('model job stores fit, ratings and predictions only for scheduled matches within the horizon', async () => {
  const { raw, db, fixtures } = setup();
  const r = await job(db);
  assert.equal(r.results[0].status, 'success', JSON.stringify(r));
  assert.equal(count(raw, 'model_fits'), 1);
  assert.equal(count(raw, 'team_ratings'), 6);
  const preds = raw.prepare('SELECT match_id FROM predictions ORDER BY match_id').all().map((x) => x.match_id);
  assert.deepEqual(preds, [fixtures[0].id, fixtures[1].id], 'only the two fixtures inside 14 days; not the past one nor the far-future one');
  const p = raw.prepare('SELECT * FROM predictions WHERE match_id = ?').get(fixtures[0].id);
  assert.equal(p.goal_expectation_kind, 'model_goal_expectation');
  assert.ok(p.data_as_of <= p.predicted_at);
  assert.ok(Math.abs(p.p_home + p.p_draw + p.p_away - 1) < 1e-3);
  assert.equal(JSON.parse(p.uncertainty_json).lowData, false);
  assert.ok(p.model_version.startsWith('dc-td-1:hl365:r1'));
  assert.equal(raw.prepare("SELECT status FROM job_runs WHERE job='model'").get().status, 'success');
  assert.equal(count(raw, 'job_locks'), 0);
});

test('never predicts a match that has already kicked off', async () => {
  const { raw, db } = setup();
  const id = Number(raw.prepare(`INSERT INTO matches (competition_id, season, match_date, kickoff_utc, status, home_team_id, away_team_id, updated_at)
    VALUES (1, 2025, '2026-01-10', '2026-01-10T06:00:00Z', 'scheduled', 3, 5, '2026-01-09T00:00:00Z')`).run().lastInsertRowid);
  const later = Number(raw.prepare(`INSERT INTO matches (competition_id, season, match_date, kickoff_utc, status, home_team_id, away_team_id, updated_at)
    VALUES (1, 2025, '2026-01-10', '2026-01-10T19:00:00Z', 'scheduled', 4, 6, '2026-01-09T00:00:00Z')`).run().lastInsertRowid);
  const r = await job(db);
  assert.equal(r.results[0].skippedStarted, 1);
  assert.equal(raw.prepare('SELECT count(*) c FROM predictions WHERE match_id = ?').get(id).c, 0);
  assert.equal(raw.prepare('SELECT count(*) c FROM predictions WHERE match_id = ?').get(later).c, 1, 'a later kickoff the same day is still predicted');
});

test('idempotent: rerunning with no new results writes no fit, rating or prediction rows', async () => {
  const { raw, db } = setup();
  await job(db);
  const snap = JSON.stringify(['model_fits', 'team_ratings', 'predictions'].map((t) => all(raw, t)));
  const later = new Date('2026-01-10T14:00:00Z');
  const r = await job(db, { now: () => later });
  assert.equal(r.results[0].fitCreated, false);
  assert.equal(r.results[0].written, 0);
  assert.equal(JSON.stringify(['model_fits', 'team_ratings', 'predictions'].map((t) => all(raw, t))), snap);
});

test('a new fixture is added to the existing fit without refitting', async () => {
  const { raw, db } = setup();
  await job(db);
  raw.prepare(`INSERT INTO matches (competition_id, season, match_date, kickoff_utc, status, home_team_id, away_team_id, updated_at)
    VALUES (1, 2025, '2026-01-13', '2026-01-13T15:00:00Z', 'scheduled', 4, 5, '2026-01-10T00:00:00Z')`).run();
  const r = await job(db, { now: () => new Date('2026-01-10T20:00:00Z') });
  assert.equal(r.results[0].fitCreated, false);
  assert.equal(r.results[0].written, 1);
  assert.equal(count(raw, 'model_fits'), 1);
  assert.equal(count(raw, 'predictions'), 3);
});

test('predictions are reproducible from the stored fit alone', async () => {
  const { raw, db, fixtures } = setup();
  await job(db);
  const fitId = raw.prepare('SELECT id FROM model_fits').get().id;
  const stored = await loadFit(db, fitId);
  const again = predictMatch({ fit: stored, homeTeamId: 1, awayTeamId: 2 });
  const row = raw.prepare('SELECT * FROM predictions WHERE match_id = ?').get(fixtures[0].id);
  assert.equal(row.feature_hash, again.featureHash);
  assert.ok(Math.abs(row.p_home - again.pHome) < 1e-12);
  assert.ok(Math.abs(row.expected_home_goals - again.expectedHomeGoals) < 1e-12);
});

test('with the same data but a later asOf the stored fit is reused for prediction (no silent parameter drift)', async () => {
  const { raw, db, fixtures } = setup();
  await job(db);
  const before = raw.prepare('SELECT p_home FROM predictions WHERE match_id = ?').get(fixtures[0].id).p_home;
  raw.prepare("DELETE FROM predictions").run();
  await job(db, { now: () => new Date('2026-01-11T08:00:00Z') });
  const after = raw.prepare('SELECT p_home FROM predictions WHERE match_id = ?').get(fixtures[0].id).p_home;
  assert.equal(after, before);
});

test('different hyperparameters get their own fit instead of colliding', async () => {
  const { raw, db } = setup();
  await job(db);
  await job(db, { config: { halfLifeDays: 120, ridge: 0.5 } });
  assert.equal(count(raw, 'model_fits'), 2);
  const versions = raw.prepare('SELECT model_version v FROM model_fits ORDER BY id').all().map((r) => r.v);
  assert.notEqual(versions[0], versions[1]);
});

test('too little data is reported as partial / insufficient_data, with no fit stored', async () => {
  const raw = createTestDb();
  seedLeague(raw, { rounds: 1, nTeams: 4 });
  const r = await job(sqliteDb(raw));
  assert.equal(r.results[0].status, 'insufficient_data');
  assert.equal(count(raw, 'model_fits'), 0);
  assert.equal(raw.prepare("SELECT status FROM job_runs WHERE job='model'").get().status, 'partial');
});

test('a failing competition does not stop the others; locks respected', async () => {
  const { raw, db } = setup();
  const r = await runModelJob({ db, competitions: [{ code: 'ZZ' }, { code: 'PL' }], owner: 'o', now: () => NOW, retry: fastRetry });
  assert.deepEqual(r.results.map((x) => x.status), ['failed', 'success']);
  assert.match(r.results[0].error, /not in the database/);
  raw.prepare("INSERT INTO job_locks (job, owner, acquired_at, expires_at) VALUES ('model:PL','x','2026-01-10T07:59:00Z','2026-01-10T08:30:00Z')").run();
  const r2 = await job(db, { now: () => NOW });
  assert.equal(r2.results[0].status, 'locked');
});

test('transient D1 failures during persistence are retried', async () => {
  const { raw } = setup();
  const flaky = flakyDb(sqliteDb(raw), D1Error, { failTimes: 2 });
  const r = await job(flaky);
  assert.equal(r.results[0].status, 'success');
  assert.equal(flaky.remainingFailures, 0);
  assert.equal(count(raw, 'model_fits'), 1);
});

test('persistFit is atomic: a failure leaves neither fit nor ratings behind', async () => {
  const { raw, db } = setup();
  const matches = await loadMatches(db, 1);
  const fit = fitDixonColes(matches, { asOf: NOW });
  fit.params.teams[1].attack = -1; // violates CHECK (attack > 0) in team_ratings
  await assert.rejects(persistFit(db, { scope: 'PL', fit, matches, now: NOW, retry: fastRetry }));
  assert.equal(count(raw, 'model_fits'), 0);
  assert.equal(count(raw, 'team_ratings'), 0);
});

test('persistPredictions refuses a fit that postdates predicted_at', async () => {
  const { db } = setup();
  const matches = await loadMatches(db, 1);
  const fit = fitDixonColes(matches, { asOf: NOW });
  const { fitId } = await persistFit(db, { scope: 'PL', fit, matches, now: NOW });
  await assert.rejects(persistPredictions(db, { fitId, fit, predictions: [], now: new Date('2025-01-01T00:00:00Z') }), /newer than predicted_at/);
});

test('backtest persistence: header metrics, every prediction, calibration bins; rerun creates a separate run', async () => {
  const { raw, db } = setup();
  const matches = await loadMatches(db, 1);
  const run = walkForward(matches, { from: '2025-09-15T00:00:00Z', to: '2025-10-15T00:00:00Z', halfLifeDays: 365, ridge: 0.5, minTrainMatches: 20 });
  const summary = summarize(run);
  assert.ok(run.records.length > 30);
  const res = await persistBacktest(db, { summary, records: run.records, modelVersion: 'dc-td-1', scope: 'PL', startedAt: NOW, finishedAt: NOW, retry: fastRetry });
  const hdr = raw.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(res.runId);
  assert.equal(hdr.n_matches, run.records.length);
  assert.ok(Math.abs(hdr.log_loss_1x2 - summary.model.logLoss1x2) < 1e-15);
  assert.equal(JSON.parse(hdr.config_json).scope, 'PL');
  assert.equal(count(raw, 'backtest_predictions'), run.records.length);
  assert.equal(count(raw, 'calibration_bins'), 5 * 10);
  const stored = raw.prepare('SELECT SUM(n) n FROM calibration_bins WHERE market = ?').get('home').n;
  assert.equal(stored, run.records.length);
  assert.ok(raw.prepare('SELECT COUNT(*) c FROM backtest_predictions WHERE data_cutoff > ?').get('2025-10-15T00:00:00Z').c === 0);
  await persistBacktest(db, { summary, records: run.records, modelVersion: 'dc-td-1', scope: 'PL', startedAt: NOW, finishedAt: NOW });
  assert.equal(count(raw, 'backtest_runs'), 2);
});

test('backtest persistence refuses empty runs and cleans up the header if child writes fail', async () => {
  const { raw, db } = setup();
  const matches = await loadMatches(db, 1);
  const run = walkForward(matches, { from: '2025-09-15T00:00:00Z', to: '2025-10-01T00:00:00Z', minTrainMatches: 20 });
  const summary = summarize(run);
  await assert.rejects(persistBacktest(db, { summary, records: [], modelVersion: 'x', scope: 'PL', startedAt: NOW, finishedAt: NOW }), /no predictions/);
  const bad = run.records.map((r, i) => (i === 0 ? { ...r, matchId: 987654 } : r)); // FK violation
  await assert.rejects(persistBacktest(db, { summary, records: bad, modelVersion: 'x', scope: 'PL', startedAt: NOW, finishedAt: NOW, retry: fastRetry }));
  assert.equal(count(raw, 'backtest_runs'), 0);
  assert.equal(count(raw, 'backtest_predictions'), 0);
});

test('versionTag encodes the hyperparameters', () => {
  assert.equal(versionTag({ modelVersion: 'm', config: { halfLifeDays: 90, ridge: 0.5 } }), 'm:hl90:r0.5');
});
