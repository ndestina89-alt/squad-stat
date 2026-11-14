import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from './helpers/db.js';
import { sqliteDb, flakyDb } from './helpers/sqliteDb.js';
import { D1Error } from '../pipeline/lib/d1.js';
import { normalizeMatch, PROVIDER as FDO } from '../pipeline/providers/footballDataOrg.js';
import { normalizeCsv, PROVIDER as CSV } from '../pipeline/providers/footballDataCsv.js';
import { ingestMatches, computeMatchUpdate } from '../pipeline/ingest/matches.js';
import { addAlias } from '../pipeline/ingest/teams.js';
import { applyStatements } from '../pipeline/ingest/apply.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/synthetic-fdorg-matches.json', import.meta.url), 'utf8'));
const csvText = readFileSync(new URL('./fixtures/synthetic-fdcouk-E0.csv', import.meta.url), 'utf8');
const NOW = new Date('2026-11-12T08:00:00Z');
const comp = { id: 1, code: 'PL' };
const fdo = { id: FDO, role: 'primary' };
const csv = { id: CSV, role: 'historical' };
const fastRetry = { baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };

const fdMatches = () => fx.matches.map((r) => normalizeMatch(r, { competitionCode: 'PL', season: 2026 })).filter((r) => r.ok).map((r) => r.match);
const csvMatches = () => normalizeCsv(csvText, { div: 'E0', season: 2026, competitionCode: 'PL' }).matches;
const count = (raw, t) => Number(raw.prepare(`SELECT count(*) c FROM ${t}`).get().c);
const snapshot = (raw) => JSON.stringify(['matches', 'match_provider_ids', 'match_stats', 'teams', 'team_provider_ids'].map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all()));

function setup(opts) {
  const raw = createTestDb();
  let writes = 0;
  const db = sqliteDb(raw, { onStatement: () => { writes++; } });
  return { raw, db, writes: () => writes };
}

test('fd.org ingest creates teams, matches and provider links', async () => {
  const { raw, db } = setup();
  const s = await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW });
  assert.equal(s.fetched, 5);
  assert.equal(s.teamsCreated, 3);
  assert.equal(s.inserted, 5);
  assert.equal(count(raw, 'matches'), 5);
  assert.equal(count(raw, 'match_provider_ids'), 5);
  assert.equal(count(raw, 'team_provider_ids'), 3);
  const m = raw.prepare("SELECT * FROM matches WHERE match_date='2026-08-15'").get();
  assert.equal(m.home_goals, 2);
  assert.equal(m.result_provider, FDO);
});

test('idempotent: an identical second run executes no match writes and changes nothing', async () => {
  const { raw, db, writes } = setup();
  await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW });
  const before = snapshot(raw);
  const w = writes();
  const s2 = await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: new Date('2026-11-12T09:00:00Z') });
  assert.equal(writes(), w, 'no statements at all on rerun');
  assert.equal(s2.inserted + s2.updated + s2.linked + s2.statsWritten + s2.teamsCreated, 0);
  assert.equal(s2.unchanged, 5);
  assert.equal(snapshot(raw), before);
});

test('primary correction of a result is applied and flagged; status never regresses', async () => {
  const { raw, db } = setup();
  const ms = fdMatches();
  await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: ms, now: NOW });
  const edited = ms.map((m) => (m.providerMatchId === '5001' ? { ...m, goals90: { home: 3, away: 1 } } : m));
  const s = await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: edited, now: NOW });
  assert.equal(s.updated, 1);
  assert.equal(s.conflicts[0].code, 'result_overridden');
  assert.equal(raw.prepare("SELECT home_goals h FROM matches WHERE match_date='2026-08-15'").get().h, 3);
  const regress = ms.map((m) => (m.providerMatchId === '5001' ? { ...m, status: 'scheduled', goals90: null, halfTime: null } : m));
  const s3 = await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: regress, now: NOW });
  assert.ok(s3.conflicts.some((c) => c.code === 'status_regression_ignored'));
  assert.equal(raw.prepare("SELECT status s FROM matches WHERE match_date='2026-08-15'").get().s, 'finished');
});

test('CSV merges into the fd.org match by natural key, adds stats, never overrides the primary result', async () => {
  const { raw, db } = setup();
  await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW });
  const ids = Object.fromEntries(raw.prepare('SELECT name, id FROM teams').all().map((r) => [r.name, r.id]));
  for (const n of ['Test FC Alpha', 'Test FC Beta', 'Test FC Gamma']) await addAlias(db, { provider: CSV, nameRaw: n, teamId: ids[n] });
  const before = count(raw, 'matches');
  const s = await ingestMatches({ db, provider: csv, competition: comp, season: 2026, matches: csvMatches(), now: NOW });
  assert.equal(s.teamsCreated, 0, 'non-primary providers never create teams');
  assert.ok(s.unmappedSkipped >= 1 && s.unmappedNames.includes('Test FC "Delta"'));
  assert.equal(raw.prepare("SELECT count(*) c FROM unmapped_team_names").get().c >= 1, true);
  const merged = raw.prepare("SELECT id, home_goals, result_provider FROM matches WHERE match_date='2026-08-15'").get();
  assert.equal(merged.result_provider, FDO);
  const st = raw.prepare('SELECT * FROM match_stats WHERE match_id = ?').get(merged.id);
  assert.equal(st.provider_id, CSV);
  assert.equal(st.shots_home, 14);
  assert.ok(count(raw, 'matches') >= before, 'new historical matches may be added');
  // rerun: identical, only the unmapped bookkeeping may execute
  const snap = snapshot(raw);
  const s2 = await ingestMatches({ db, provider: csv, competition: comp, season: 2026, matches: csvMatches(), now: NOW });
  assert.equal(s2.inserted + s2.updated + s2.linked + s2.statsWritten, 0);
  assert.equal(snapshot(raw), snap);
});

test('non-primary conflicting result is reported, not applied', async () => {
  const { raw, db } = setup();
  await ingestMatches({ db, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW });
  const ids = Object.fromEntries(raw.prepare('SELECT name, id FROM teams').all().map((r) => [r.name, r.id]));
  for (const n of ['Test FC Alpha', 'Test FC Beta', 'Test FC Gamma']) await addAlias(db, { provider: CSV, nameRaw: n, teamId: ids[n] });
  const ms = csvMatches().map((m) => (m.matchDate === '2026-08-15' ? { ...m, goals90: { home: 0, away: 5 } } : m));
  const s = await ingestMatches({ db, provider: csv, competition: comp, season: 2026, matches: ms, now: NOW });
  assert.ok(s.conflicts.some((c) => c.code === 'result_conflict'));
  assert.equal(raw.prepare("SELECT home_goals h FROM matches WHERE match_date='2026-08-15'").get().h, 2);
});

test('computeMatchUpdate: non-primary only fills gaps', () => {
  const row = { id: 1, status: 'scheduled', home_goals: null, away_goals: null, ht_home_goals: null, ht_away_goals: null, kickoff_utc: null, match_date: '2026-08-15', home_team_id: 1, away_team_id: 2, matchday: null, stage: null };
  const m = { status: 'finished', goals90: { home: 1, away: 0 }, halfTime: { home: 0, away: 0 }, kickoffUtc: '2026-08-15T14:00:00Z', matchDate: '2026-08-15', matchday: null, stage: null };
  const { set } = computeMatchUpdate(row, m, { isPrimary: false, providerId: 'x', takenDates: new Set() });
  assert.equal(set.status, 'finished');
  assert.equal(set.home_goals, 1);
  assert.equal(set.kickoff_utc, '2026-08-15T14:00:00Z');
  const { set: s2 } = computeMatchUpdate({ ...row, match_date: '2026-08-14' }, m, { isPrimary: false, providerId: 'x', takenDates: new Set() });
  assert.equal(s2.match_date, undefined, 'non-primary never moves a date');
});

test('transient D1 failures are retried and the ingest still completes', async () => {
  const raw = createTestDb();
  const flaky = flakyDb(sqliteDb(raw), D1Error, { failTimes: 2 });
  const s = await ingestMatches({ db: flaky, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW, retry: fastRetry });
  assert.equal(flaky.remainingFailures, 0);
  assert.equal(s.inserted, 5);
  assert.equal(count(raw, 'matches'), 5);
});

test('permanent D1 failure is not retried and surfaces', async () => {
  const raw = createTestDb();
  const flaky = flakyDb(sqliteDb(raw), D1Error, { failTimes: 5, kind: 'permanent' });
  await assert.rejects(ingestMatches({ db: flaky, provider: fdo, competition: comp, season: 2026, matches: fdMatches(), now: NOW, retry: fastRetry }));
  assert.equal(flaky.remainingFailures, 4, 'exactly one attempt');
});

test('a failing chunk rolls back atomically', async () => {
  const raw = createTestDb();
  const db = sqliteDb(raw);
  const bad = [
    { sql: "INSERT INTO teams (name) VALUES ('ok')", params: [] },
    { sql: 'INSERT INTO nonexistent VALUES (1)', params: [] },
  ];
  await assert.rejects(applyStatements(db, bad, { retry: fastRetry }));
  assert.equal(count(raw, 'teams'), 0);
});
