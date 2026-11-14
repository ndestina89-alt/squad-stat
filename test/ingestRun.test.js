import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from './helpers/db.js';
import { sqliteDb } from './helpers/sqliteDb.js';
import { normalizeMatch, normalizeStandings, PROVIDER as FDO } from '../pipeline/providers/footballDataOrg.js';
import { runProviderIngest, runBackfill } from '../pipeline/ingest/run.js';
import { ingestStandings } from '../pipeline/ingest/standings.js';
import { ingestMatches } from '../pipeline/ingest/matches.js';
import { acquireLock } from '../pipeline/ingest/jobs.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/synthetic-fdorg-matches.json', import.meta.url), 'utf8'));
const matches = fx.matches.map((r) => normalizeMatch(r, { competitionCode: 'PL', season: 2026 })).filter((r) => r.ok).map((r) => r.match);
const standingsJson = { season: { startDate: '2026-08-01' }, standings: [{ type: 'TOTAL', stage: 'REGULAR_SEASON', table: [
  { position: 1, team: { id: 11, name: 'Test FC Alpha' }, playedGames: 3, won: 2, draw: 1, lost: 0, goalsFor: 5, goalsAgainst: 2, points: 7 },
  { position: 2, team: { id: 12, name: 'Test FC Beta' }, playedGames: 3, won: 1, draw: 1, lost: 1, goalsFor: 3, goalsAgainst: 3, points: 4 },
  { position: 3, team: { id: 99, name: 'Unknown FC' }, playedGames: 3, won: 0, draw: 0, lost: 3, goalsFor: 0, goalsAgainst: 9, points: 0 },
] }] };
const standings = normalizeStandings(standingsJson, { competitionCode: 'PL', season: 2026 }).standings;

const NOW = new Date('2026-11-12T08:00:00Z');
const comps = [{ code: 'PL' }, { code: 'PD' }, { code: 'CL' }];
const fetchedMeta = { fetchedAt: '2026-11-12T08:00:00Z' };
const source = (impl) => ({ id: FDO, role: 'primary', supports: () => true, fetchCompetition: impl });
const ok = async ({ competition }) => ({ matches: competition.code === 'PL' ? matches : [], rejects: [{ reason: 'x' }], meta: fetchedMeta, standings: competition.code === 'PL' ? standings : undefined });
const noSleepRetry = { baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };
const rows = (raw, sql) => raw.prepare(sql).all().map((r) => ({ ...r }));

test('records run history, health and releases locks', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const r = await runProviderIngest({ db, provider: source(ok), competitions: comps, season: 2026, owner: 'o1', now: () => NOW, retry: noSleepRetry });
  assert.deepEqual([r.attempted, r.succeeded, r.failed], [3, 3, 0]);
  const runs = rows(raw, 'SELECT job, scope, status, rows_written, rows_rejected FROM job_runs ORDER BY id');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].scope, 'PL:2026');
  assert.ok(['success', 'partial'].includes(runs[0].status));
  assert.ok(runs[0].rows_written > 0);
  assert.equal(raw.prepare('SELECT count(*) c FROM job_locks').get().c, 0);
  const st = raw.prepare('SELECT * FROM source_status WHERE provider_id = ?').get(FDO);
  assert.equal(st.last_success_at, '2026-11-12T08:00:00Z');
  assert.equal(st.consecutive_failures, 0);
  assert.equal(raw.prepare('SELECT count(*) c FROM standings').get().c, 2, 'unknown team skipped');
  assert.equal(r.results[0].status, 'partial', 'unmapped standings row makes the run partial');
});

test('a failing league does not stop the others and is recorded as failed', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const src = source(async (a) => { if (a.competition.code === 'PD') throw new Error('boom'); return ok(a); });
  const r = await runProviderIngest({ db, provider: src, competitions: comps, season: 2026, owner: 'o1', now: () => NOW, retry: noSleepRetry });
  assert.deepEqual(r.results.map((x) => x.status).map((s) => (s === 'partial' ? 'success' : s)), ['success', 'failed', 'success']);
  const failed = raw.prepare("SELECT * FROM job_runs WHERE status='failed'").get();
  assert.equal(failed.scope, 'PD:2026');
  assert.match(failed.error, /boom/);
  const st = raw.prepare('SELECT * FROM source_status WHERE provider_id = ?').get(FDO);
  assert.equal(st.consecutive_failures, 1);
  assert.match(st.last_error, /PD/);
  assert.equal(st.last_success_at, '2026-11-12T08:00:00Z');
  assert.equal(raw.prepare('SELECT count(*) c FROM job_locks').get().c, 0, 'lock released even on failure');
});

test('all leagues failing increments failures and keeps last_success_at untouched', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const src = source(async () => { throw new Error('down'); });
  for (let i = 0; i < 2; i++) await runProviderIngest({ db, provider: src, competitions: [comps[0]], season: 2026, owner: 'o', now: () => NOW, retry: noSleepRetry });
  const st = raw.prepare('SELECT * FROM source_status WHERE provider_id = ?').get(FDO);
  assert.equal(st.consecutive_failures, 2);
  assert.equal(st.last_success_at, null);
});

test('a held lock makes the competition be skipped, not run twice', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  await acquireLock(db, { job: `ingest:${FDO}:PL:2026`, owner: 'other', ttlMs: 600000, now: NOW });
  let calls = 0;
  const src = source(async (a) => { calls++; return ok(a); });
  const r = await runProviderIngest({ db, provider: src, competitions: [comps[0], comps[1]], season: 2026, owner: 'me', now: () => NOW, retry: noSleepRetry });
  assert.equal(r.results[0].status, 'locked');
  assert.equal(calls, 1);
  assert.equal(raw.prepare("SELECT owner FROM job_locks WHERE job LIKE '%:PL:%'").get().owner, 'other', 'foreign lock untouched');
});

test('an expired lock is taken over', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  await acquireLock(db, { job: `ingest:${FDO}:PL:2026`, owner: 'dead', ttlMs: 1000, now: new Date(NOW.getTime() - 3600000) });
  const r = await runProviderIngest({ db, provider: source(ok), competitions: [comps[0]], season: 2026, owner: 'me', now: () => NOW, retry: noSleepRetry });
  assert.notEqual(r.results[0].status, 'locked');
});

test('abandoned running runs are reaped at start', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  raw.prepare("INSERT INTO job_runs (job, scope, started_at, status) VALUES ('ingest:x','PL:2026','2026-11-12T01:00:00Z','running')").run();
  await runProviderIngest({ db, provider: source(ok), competitions: [comps[0]], season: 2026, owner: 'me', now: () => NOW, retry: noSleepRetry });
  assert.equal(raw.prepare("SELECT status FROM job_runs WHERE job='ingest:x'").get().status, 'failed');
});

test('unsupported competitions are skipped without a run record', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const src = { ...source(ok), supports: (c) => c.code === 'PL' };
  const r = await runProviderIngest({ db, provider: src, competitions: comps, season: 2026, owner: 'o', now: () => NOW, retry: noSleepRetry });
  assert.equal(r.attempted, 1);
  assert.equal(raw.prepare('SELECT count(*) c FROM job_runs').get().c, 1);
});

test('rerunning the whole orchestrator writes no new data rows', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const go = () => runProviderIngest({ db, provider: source(ok), competitions: [comps[0]], season: 2026, owner: 'o', now: () => NOW, retry: noSleepRetry });
  await go();
  const snap = JSON.stringify(['matches', 'standings', 'teams'].map((t) => rows(raw, `SELECT * FROM ${t}`)));
  const r2 = await go();
  assert.equal(JSON.stringify(['matches', 'standings', 'teams'].map((t) => rows(raw, `SELECT * FROM ${t}`))), snap);
  assert.equal(r2.results[0].summary.unchanged, 5);
  assert.equal(r2.results[0].standings.upserted, 0);
});

test('missing owner and missing competition are rejected clearly', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  await assert.rejects(runProviderIngest({ db, provider: source(ok), competitions: comps, season: 2026 }), /owner/);
  const r = await runProviderIngest({ db, provider: source(ok), competitions: [{ code: 'ZZ' }], season: 2026, owner: 'o', now: () => NOW });
  assert.equal(r.results[0].status, 'failed');
  assert.match(r.results[0].error, /not in the database/);
});

test('backfill runs seasons in order and isolates a failing season', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  const seen = [];
  const src = source(async ({ season }) => { seen.push(season); if (season === 2025) throw new Error('nope'); return { matches: [], rejects: [], meta: fetchedMeta }; });
  const runs = await runBackfill({ seasons: [2024, 2025, 2026], db, provider: src, competitions: [comps[0]], owner: 'o', now: () => NOW, retry: noSleepRetry });
  assert.deepEqual(seen, [2024, 2025, 2026]);
  assert.deepEqual(runs.map((r) => r.failed), [0, 1, 0]);
});

test('standings: upsert, change detection, update in place', async () => {
  const raw = createTestDb(); const db = sqliteDb(raw);
  await ingestMatches({ db, provider: { id: FDO, role: 'primary' }, competition: { id: 1, code: 'PL' }, season: 2026, matches, now: NOW });
  const args = { db, provider: { id: FDO }, competition: { id: 1 }, season: 2026, now: NOW };
  const a = await ingestStandings({ ...args, standings });
  assert.deepEqual([a.upserted, a.unchanged, a.unmappedSkipped], [2, 0, 1]);
  const b = await ingestStandings({ ...args, standings });
  assert.deepEqual([b.upserted, b.unchanged, b.statementsExecuted], [0, 2, 0]);
  const changed = standings.map((s) => (s.position === 1 ? { ...s, played: 4, won: 3, points: 10 } : s));
  const c = await ingestStandings({ ...args, standings: changed });
  assert.equal(c.upserted, 1);
  assert.equal(raw.prepare('SELECT count(*) c FROM standings').get().c, 2);
  assert.equal(raw.prepare('SELECT points p FROM standings WHERE position = 1').get().p, 10);
});

test('alias workflow end to end: an unmapped CSV name is skipped, then maps after addAlias and the next run ingests it', async () => {
  const { addAlias } = await import('../pipeline/ingest/teams.js');
  const { PROVIDER: CSVP } = await import('../pipeline/providers/footballDataCsv.js');
  const raw = createTestDb(); const db = sqliteDb(raw);
  await ingestMatches({ db, provider: { id: FDO, role: 'primary' }, competition: { id: 1, code: 'PL' }, season: 2026, matches, now: NOW });
  const csvMatch = { ...matches[0], providerMatchId: 'csv-1', home: { name: 'Alpha Town', providerTeamId: null }, away: { name: 'Beta City', providerTeamId: null } };
  const run = () => ingestMatches({ db, provider: { id: CSVP, role: 'historical' }, competition: { id: 1, code: 'PL' }, season: 2026, matches: [csvMatch], now: NOW });
  const before = await run();
  assert.equal(before.unmappedSkipped, 1);
  assert.equal(raw.prepare('SELECT count(*) c FROM unmapped_team_names').get().c >= 1, true);
  const ids = Object.fromEntries(raw.prepare('SELECT name, id FROM teams').all().map((r) => [r.name, r.id]));
  await addAlias(db, { provider: CSVP, nameRaw: 'Alpha Town', teamId: ids['Test FC Alpha'] });
  await addAlias(db, { provider: CSVP, nameRaw: 'Beta City', teamId: ids['Test FC Beta'] });
  assert.equal(raw.prepare("SELECT count(*) c FROM unmapped_team_names WHERE alias_norm IN ('alpha town','beta city')").get().c, 0, 'alias clears the unmapped entry');
  const after = await run();
  assert.equal(after.unmappedSkipped, 0);
  assert.equal(after.inserted, 0, 'it merged into the existing fd.org match instead of duplicating');
  await assert.rejects(addAlias(db, { provider: CSVP, nameRaw: 'Alpha Town', teamId: ids['Test FC Beta'] }), 'a conflicting alias is refused');
});
