import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.js';
import { sqliteDb } from './helpers/sqliteDb.js';
import { seedLeague } from './helpers/league.js';
import { runBacktestJob } from '../pipeline/model/backtestJob.js';
import { parseBacktestArgs, parseModelArgs } from '../pipeline/bin/modelArgs.js';
import { createD1Client } from '../pipeline/lib/d1.js';
import { readFileSync } from 'node:fs';

const NOW = new Date('2026-03-20T00:00:00Z');
const base = () => {
  const raw = createTestDb();
  seedLeague(raw, { seed: 31, nTeams: 8, rounds: 18, season: 2025 });
  return { raw, db: sqliteDb(raw) };
};
const opts = (db, extra = {}) => ({
  db, competition: { id: 1, code: 'PL' }, grid: { halfLifeDays: [90, 365, 3650], ridge: [0.5, 2] },
  tune: { from: '2025-11-01T00:00:00Z', to: '2026-01-20T00:00:00Z' }, holdout: { from: '2026-01-20T00:00:00Z', to: '2026-03-15T00:00:00Z' },
  minEvalMatches: 50, owner: 'o', now: () => NOW, ...extra,
});

test('tunes on one window and stores the HOLDOUT run with the selection recorded', async () => {
  const { raw, db } = base();
  const r = await runBacktestJob(opts(db));
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const hdr = raw.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(r.runId);
  const cfg = JSON.parse(hdr.config_json);
  assert.equal(cfg.scope, 'PL');
  assert.equal(cfg.selection.grid.length, 6);
  assert.equal(cfg.selection.best.halfLifeDays, r.best.halfLifeDays);
  assert.equal(cfg.from, '2026-01-20T00:00:00Z', 'stored window is the holdout, not the tune window');
  const bad = raw.prepare("SELECT count(*) c FROM backtest_predictions WHERE data_cutoff < '2026-01-20T00:00:00Z'").get().c;
  assert.equal(Number(bad), 0);
  assert.match(hdr.notes, /holdout/i);
  assert.equal(raw.prepare("SELECT status FROM job_runs WHERE job = 'backtest'").get().status.length > 0, true);
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM job_locks').get().c), 0);
});

test('failure is recorded, lock released, nothing half-stored', async () => {
  const { raw, db } = base();
  const r = await runBacktestJob(opts(db, { minEvalMatches: 100000 }));
  assert.equal(r.status, 'failed');
  assert.match(r.error, /at least/);
  assert.equal(raw.prepare("SELECT status FROM job_runs WHERE job = 'backtest'").get().status, 'failed');
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM backtest_runs').get().c), 0);
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM job_locks').get().c), 0);
});

test('a held lock stops a concurrent backtest', async () => {
  const { raw, db } = base();
  raw.prepare("INSERT INTO job_locks (job, owner, acquired_at, expires_at) VALUES ('backtest:PL','x','2026-03-19T23:59:00Z','2026-03-20T00:30:00Z')").run();
  assert.equal((await runBacktestJob(opts(db))).status, 'locked');
});

test('CLI argument parsing: windows are required, ordered and non-overlapping', () => {
  const ok = parseBacktestArgs(['--competition', 'pl', '--tune-from', '2024-08-01', '--tune-to', '2025-06-01', '--holdout-from', '2025-08-01', '--holdout-to', '2026-05-30']);
  assert.equal(ok.competition, 'PL');
  assert.equal(ok.tune.from, '2024-08-01T00:00:00Z');
  assert.equal(ok.stepDays, 7);
  const base = ['--competition', 'PL', '--tune-from', '2024-08-01', '--tune-to', '2025-06-01', '--holdout-from', '2025-08-01', '--holdout-to', '2026-05-30'];
  assert.throws(() => parseBacktestArgs(base.slice(2)), /competition/);
  assert.throws(() => parseBacktestArgs([...base, '--bogus']), RangeError);
  assert.throws(() => parseBacktestArgs([...base.slice(0, 5), '2025-09-01', ...base.slice(6)]), /before the holdout/);
  assert.throws(() => parseBacktestArgs([...base, '--step-days', '0']), RangeError);
  assert.throws(() => parseBacktestArgs(base.map((v) => (v === '2025-06-01' ? '2024-01-01' : v))), RangeError);
  assert.throws(() => parseBacktestArgs(base.map((v) => (v === '2025-08-01' ? '2025-13-01' : v))), RangeError);
  assert.deepEqual(parseModelArgs([]), { competitions: null, halfLifeDays: null, ridge: null });
  assert.deepEqual(parseModelArgs(['--competitions', 'pl,pd', '--half-life', '200', '--ridge', '0']), { competitions: ['PL', 'PD'], halfLifeDays: 200, ridge: 0 });
  assert.throws(() => parseModelArgs(['--half-life', '-1']), RangeError);
  assert.throws(() => parseModelArgs(['--x']), RangeError);
});

test('config/model.json is valid and its grid is usable', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/model.json', import.meta.url), 'utf8'));
  assert.ok(cfg.tuningGrid.halfLifeDays.every((v) => v > 0) && cfg.tuningGrid.ridge.every((v) => v >= 0));
  assert.ok(cfg.predictionHorizonDays > 0 && cfg.minTrainMatches >= 1);
  assert.match(cfg._note, /NOT tuned/);
  void createD1Client;
});
