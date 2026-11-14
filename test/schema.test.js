import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, insertMatch, seedTeams, NOW } from './helpers/db.js';

const rejects = (db, sql, params = []) =>
  assert.throws(() => db.prepare(sql).run(...params), /constraint|FOREIGN KEY/i, `expected constraint failure: ${sql}`);

test('migrations apply cleanly and foreign keys are enforced', () => {
  const db = createTestDb();
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('competition and provider seeds match config/competitions.json', () => {
  const db = createTestDb();
  const cfg = JSON.parse(readFileSync(new URL('../config/competitions.json', import.meta.url), 'utf8'));
  const rows = db.prepare('SELECT code, name, fd_org_code, csv_div, enabled FROM competitions ORDER BY code').all();
  const expected = cfg
    .map((c) => ({ code: c.code, name: c.name, fd_org_code: c.fdOrgCode, csv_div: c.csvDiv, enabled: c.enabled ? 1 : 0 }))
    .sort((x, y) => x.code.localeCompare(y.code));
  assert.deepEqual(rows.map((r) => ({ ...r })), expected);
  // No provider claims xG, and unverified licences are flagged, not hidden.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM providers WHERE has_xg = 1').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM providers WHERE license_status = 'verified'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM source_status').get().n, 3);
});

test('matches: duplicates, self-play, goals rules and unknown status are rejected', () => {
  const db = createTestDb();
  const teams = seedTeams(db);
  insertMatch(db, { teams });
  assert.throws(() => insertMatch(db, { teams }), /UNIQUE/i, 'same pair, season and date twice');
  insertMatch(db, { teams, row: { match_date: '2026-12-20' } }); // a different date is a different fixture
  assert.throws(() => insertMatch(db, { teams: { a: teams.a, b: teams.a }, row: { match_date: '2027-01-01' } }), /constraint/i);
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '2027-02-01', status: 'finished', home_goals: 1 } }), /constraint/i, 'one-sided goals');
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '2027-02-02', status: 'scheduled', home_goals: 1, away_goals: 0 } }), /constraint/i, 'goals on an unplayed match');
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '2027-02-03', status: 'finished', home_goals: -1, away_goals: 0 } }), /constraint/i);
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '2027-02-04', status: 'weird' } }), /constraint/i);
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '14/11/2026' } }), /constraint/i, 'bad date format');
  assert.throws(() => insertMatch(db, { teams, row: { match_date: '2027-02-05', competition_id: 999 } }), /FOREIGN KEY/i);
  insertMatch(db, { teams, row: { match_date: '2027-02-06', status: 'finished', home_goals: 2, away_goals: 1, ht_home_goals: 1, ht_away_goals: 0 } });
});

test('provider ids are unique per provider and cascade with the match', () => {
  const db = createTestDb();
  const id = insertMatch(db);
  const ins = db.prepare("INSERT INTO match_provider_ids VALUES ('football-data.org', ?, ?, ?, ?)");
  ins.run('123', id, NOW, NOW);
  assert.throws(() => ins.run('123', id, NOW, NOW), /UNIQUE|PRIMARY/i);
  rejects(db, "INSERT INTO match_provider_ids VALUES ('nope', '1', ?, ?, ?)", [id, NOW, NOW]);
  db.prepare('DELETE FROM matches WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM match_provider_ids').get().n, 0);
});

test('match_stats are kept per provider and reject impossible values', () => {
  const db = createTestDb();
  const id = insertMatch(db);
  const ins = (p, shots, sot) => db.prepare(
    "INSERT INTO match_stats (match_id, provider_id, shots_home, shots_on_target_home, fetched_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, p, shots, sot, NOW);
  ins('football-data.co.uk', 12, 5);
  ins('espn', 14, 6); // a second provider gets its own row; nothing is merged
  assert.throws(() => ins('football-data.co.uk', 1, 1), /UNIQUE|PRIMARY/i);
  assert.throws(() => ins('espn', 3, 3), /UNIQUE|PRIMARY/i);
  const id2 = insertMatch(db, { row: { match_date: '2026-12-01' }, teams: { a: 1, b: 2 } });
  assert.throws(() => db.prepare(
    "INSERT INTO match_stats (match_id, provider_id, shots_home, shots_on_target_home, fetched_at) VALUES (?, 'espn', 3, 5, ?)"
  ).run(id2, NOW), /constraint/i, 'shots on target cannot exceed shots');
});

function insertFit(db) {
  return Number(db.prepare(
    "INSERT INTO model_fits (model_version, scope, data_as_of, n_matches, params_json, created_at) VALUES ('m1', 'PL', ?, 100, '{}', ?)"
  ).run(NOW, NOW).lastInsertRowid);
}

function prediction(db, matchId, fitId, over = {}) {
  const r = {
    match_id: matchId, fit_id: fitId, model_version: 'm1', predicted_at: NOW, data_as_of: NOW,
    expected_home_goals: 1.5, expected_away_goals: 1.1, p_home: 0.45, p_draw: 0.27, p_away: 0.28,
    p_over_2_5: 0.5, p_btts_yes: 0.5, tail_mass: 1e-7, matrix_max_goals: 10, feature_hash: 'abc', ...over,
  };
  const cols = Object.keys(r);
  return db.prepare(`INSERT INTO predictions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
}

test('predictions enforce probability validity, the xG label and reproducibility keys', () => {
  const db = createTestDb();
  const m = insertMatch(db);
  const fit = insertFit(db);
  prediction(db, m, fit);
  assert.throws(() => prediction(db, m, fit), /UNIQUE/i, 'one prediction per match and fit');
  const m2 = insertMatch(db, { row: { match_date: '2026-12-02' }, teams: { a: 1, b: 2 } });
  assert.throws(() => prediction(db, m2, fit, { p_home: 0.6 }), /constraint/i, '1X2 must sum to 1');
  assert.throws(() => prediction(db, m2, fit, { p_over_2_5: 1.2 }), /constraint/i);
  assert.throws(() => prediction(db, m2, fit, { tail_mass: -0.1 }), /constraint/i);
  assert.throws(() => prediction(db, m2, fit, { goal_expectation_kind: 'xg' }), /constraint/i);
  assert.throws(() => prediction(db, m2, fit, { data_as_of: '2026-11-13T00:00:00Z' }), /constraint/i, 'data cannot postdate the prediction');
  assert.throws(() => prediction(db, m2, 9999), /FOREIGN KEY/i);
  assert.throws(() => prediction(db, m2, fit, { top_scores_json: 'not json' }), /constraint/i);
  prediction(db, m2, fit, { goal_expectation_kind: 'model_goal_expectation', top_scores_json: '[]' });
});

test('backtest rows validate metrics and calibration bins', () => {
  const db = createTestDb();
  const m = insertMatch(db);
  const run = Number(db.prepare(
    "INSERT INTO backtest_runs (model_version, started_at, config_json) VALUES ('m1', ?, '{}')"
  ).run(NOW).lastInsertRowid);
  db.prepare(
    "INSERT INTO backtest_predictions VALUES (?, ?, ?, 0.4, 0.3, 0.3, 0.5, 0.5)"
  ).run(run, m, NOW);
  assert.throws(() => db.prepare("INSERT INTO backtest_predictions VALUES (?, ?, ?, 0.4, 0.3, 0.3, 0.5, 0.5)").run(run, m, NOW), /UNIQUE|PRIMARY/i);
  assert.throws(() => db.prepare("INSERT INTO backtest_runs (model_version, started_at, config_json, brier_1x2) VALUES ('m', ?, '{}', -1)").run(NOW), /constraint/i);
  db.prepare("INSERT INTO calibration_bins VALUES (?, 'home', 0.0, 0.1, 10, 0.05, 0.04)").run(run);
  assert.throws(() => db.prepare("INSERT INTO calibration_bins VALUES (?, 'home', 0.2, 0.1, 1, 0.1, 0.1)").run(run), /constraint/i, 'bin_hi must exceed bin_lo');
  assert.throws(() => db.prepare("INSERT INTO calibration_bins VALUES (?, 'corners', 0.0, 0.1, 1, 0.1, 0.1)").run(run), /constraint/i);
  db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(run);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM backtest_predictions').get().n, 0, 'cascade removes run children');
});

test('job lock is one row per job and rejects an inverted lease', () => {
  const db = createTestDb();
  db.prepare("INSERT INTO job_locks VALUES ('ingest:PL', 'run-1', '2026-11-12T08:00:00Z', '2026-11-12T08:10:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO job_locks VALUES ('ingest:PL', 'run-2', '2026-11-12T08:01:00Z', '2026-11-12T08:11:00Z')").run(), /UNIQUE|PRIMARY/i);
  assert.throws(() => db.prepare("INSERT INTO job_locks VALUES ('ingest:PD', 'run-1', '2026-11-12T08:10:00Z', '2026-11-12T08:00:00Z')").run(), /constraint/i);
  assert.throws(() => db.prepare("INSERT INTO job_runs (job, started_at, status) VALUES ('x', ?, 'done')").run(NOW), /constraint/i);
});

test('standings require consistent played/won/drawn/lost', () => {
  const db = createTestDb();
  const { a } = seedTeams(db);
  const ins = (played) => db.prepare(
    "INSERT INTO standings (competition_id, season, team_id, position, played, won, drawn, lost, goals_for, goals_against, points, provider_id, fetched_at) VALUES (1, 2026, ?, 1, ?, 5, 2, 1, 10, 5, 17, 'football-data.org', ?)"
  ).run(a, played, NOW);
  assert.throws(() => ins(9), /constraint/i);
  ins(8);
});

test('unmapped team names accumulate without duplicating', () => {
  const db = createTestDb();
  db.prepare("INSERT INTO unmapped_team_names VALUES ('football-data.co.uk', 'man united', 'Man United', 'PL', ?, ?, 1)").run(NOW, NOW);
  assert.throws(() => db.prepare("INSERT INTO unmapped_team_names VALUES ('football-data.co.uk', 'man united', 'Man United', 'PL', ?, ?, 1)").run(NOW, NOW), /UNIQUE|PRIMARY/i);
});
