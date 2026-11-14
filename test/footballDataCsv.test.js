import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFootballDataCsv, normalizeCsv, parseCsvDate, seasonCode, PROVIDER } from '../pipeline/providers/footballDataCsv.js';
import { assertNormalizedMatch } from '../pipeline/providers/contract.js';
import { createTeamResolver } from '../pipeline/lib/teams.js';

const csv = readFileSync(new URL('./fixtures/synthetic-fdcouk-E0.csv', import.meta.url), 'utf8');
const run = () => normalizeCsv(csv, { div: 'E0', season: 2026, competitionCode: 'PL' });
const find = (out, date, home) => out.matches.find((m) => m.matchDate === date && m.home.name === home);

test('accepts valid rows, rejects bad ones with a reason and line number', () => {
  const out = run();
  assert.equal(out.matches.length, 7);
  assert.deepEqual(out.rejects, [
    { reason: 'result_mismatch', line: 6 },
    { reason: 'no_result', line: 7 },
    { reason: 'bad_date', line: 8 },
    { reason: 'date_out_of_season', line: 9 },
    { reason: 'same_team', line: 10 },
    { reason: 'bad_goals', line: 11 },
    { reason: 'duplicate_in_file', line: 13 },
    { reason: 'bad_date', line: 15 },
  ]);
  out.matches.forEach(assertNormalizedMatch);
});

test('full row: goals, half-time, stats and kick-off converted from UK time', () => {
  const m = find(run(), '2026-08-15', 'Test FC Alpha');
  assert.deepEqual(m.goals90, { home: 2, away: 1 });
  assert.deepEqual(m.halfTime, { home: 1, away: 0 });
  assert.equal(m.kickoffUtc, '2026-08-15T14:00:00Z', '15:00 BST');
  assert.equal(m.kickoffKnown, true);
  assert.equal(m.status, 'finished');
  assert.equal(m.competitionCode, 'PL');
  assert.deepEqual(m.stats, {
    shotsHome: 14, shotsAway: 9, shotsOnTargetHome: 6, shotsOnTargetAway: 3, cornersHome: 7, cornersAway: 3,
    foulsHome: 10, foulsAway: 12, yellowHome: 1, yellowAway: 2, redHome: 0, redAway: 0,
  });
  assert.equal(m.home.providerTeamId, null, 'CSV has no team ids');
  assert.match(m.providerMatchId, /^E0:2026:2026-08-15:test_fc_alpha:test_fc_beta$/);
});

test('two-digit years, winter kick-off and empty stat columns', () => {
  const out = run();
  const a = find(out, '2026-08-22', 'Test FC Beta');
  assert.equal(a.kickoffUtc, '2026-08-22T11:30:00Z');
  const b = find(out, '2027-01-05', 'Test FC Gamma');
  assert.equal(b.kickoffUtc, '2027-01-05T20:00:00Z');
  assert.equal(b.stats, null, 'all stat columns empty means no stats object, not zeros');
  assert.deepEqual(b.goals90, { home: 1, away: 3 });
});

test('missing time leaves kick-off unknown instead of inventing one', () => {
  const m = find(run(), '2026-10-25', 'test fc  alpha');
  assert.equal(m.kickoffUtc, null);
  assert.equal(m.kickoffKnown, false);
});

test('impossible values are dropped with warnings, not repaired', () => {
  const out = run();
  const m = find(out, '2026-09-12', 'Test FC "Delta"');
  assert.equal(m.halfTime, null, 'half-time 3-0 in a 2-2 match');
  assert.equal(m.stats.shotsHome, null, 'shots on target (7) cannot exceed shots (5)');
  assert.equal(m.stats.shotsOnTargetHome, null);
  assert.equal(m.stats.shotsAway, 6);
  assert.equal(m.stats.shotsOnTargetAway, 2);
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ['halftime_exceeds_fulltime', 'sot_exceeds_shots']);
});

test('short rows are tolerated; identical keys within a file are not', () => {
  const out = run();
  assert.ok(find(out, '2026-11-07', 'Test FC Beta'), 'row with missing trailing cells is kept');
  assert.equal(out.matches.filter((m) => m.matchDate === '2026-10-24').length, 1);
  assert.equal(new Set(out.matches.map((m) => m.providerMatchId)).size, out.matches.length);
});

test('structural problems throw instead of returning partial data', () => {
  assert.throws(() => normalizeCsv('', { div: 'E0', season: 2026, competitionCode: 'PL' }), (e) => e.kind === 'parse');
  assert.throws(() => normalizeCsv('Date,HomeTeam\n1/1/2026,A', { div: 'E0', season: 2026, competitionCode: 'PL' }), /missing required columns: AwayTeam, FTHG, FTAG/);
  assert.throws(() => normalizeCsv('<html>not csv</html>', { div: 'E0', season: 2026, competitionCode: 'PL' }), /missing required columns/);
  assert.throws(() => normalizeCsv('a,b\n"x', { div: 'E0', season: 2026, competitionCode: 'PL' }), (e) => e.kind === 'parse');
});

test('date and season helpers', () => {
  assert.deepEqual(parseCsvDate('05/01/2027'), { y: 2027, m: 1, d: 5 });
  assert.deepEqual(parseCsvDate('22/08/26'), { y: 2026, m: 8, d: 22 });
  assert.deepEqual(parseCsvDate('03/09/95'), { y: 1995, m: 9, d: 3 });
  assert.equal(parseCsvDate('31/02/2026'), null);
  assert.equal(parseCsvDate('2026-08-15'), null);
  assert.equal(seasonCode(2026), '2627');
  assert.equal(seasonCode(1999), '9900');
});

test('fetchSeason builds the season URL, validates input and returns meta', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(csv, { status: 200 }); };
  const p = createFootballDataCsv({ fetchImpl, limiter: { wait: async () => {} }, now: () => new Date('2026-11-12T08:00:00.9Z') });
  const out = await p.fetchSeason({ div: 'E0', season: 2026, competitionCode: 'PL' });
  assert.deepEqual(calls, ['https://www.football-data.co.uk/mmz4281/2627/E0.csv']);
  assert.equal(out.matches.length, 7);
  assert.equal(out.meta.provider, PROVIDER);
  assert.equal(out.meta.fetchedAt, '2026-11-12T08:00:00Z');
  assert.equal(out.meta.rawRows, 15);
  await assert.rejects(p.fetchSeason({ div: '../etc', season: 2026, competitionCode: 'PL' }), RangeError);
  await assert.rejects(p.fetchSeason({ div: 'E0', season: 1980, competitionCode: 'PL' }), RangeError);
  await assert.rejects(p.fetchSeason({ div: 'E0', season: 2026 }), RangeError);
});

test('a 404 for a season that does not exist yet surfaces as an http error', async () => {
  const p = createFootballDataCsv({ fetchImpl: async () => new Response('', { status: 404 }), limiter: { wait: async () => {} } });
  await assert.rejects(p.fetchSeason({ div: 'E0', season: 2026, competitionCode: 'PL' }), (e) => e.kind === 'http' && e.status === 404);
});

test('CSV names resolve only through explicit aliases; the rest are reported as unmapped', () => {
  const resolver = createTeamResolver({
    aliases: [
      { provider: PROVIDER, aliasNorm: 'test fc alpha', teamId: 1 },
      { provider: PROVIDER, aliasNorm: 'test fc beta', teamId: 2 },
    ],
  });
  const names = new Set(run().matches.flatMap((m) => [m.home.name, m.away.name]));
  const results = [...names].map((n) => resolver.resolve(PROVIDER, { name: n }));
  const unmapped = results.filter((r) => !r.ok).map((r) => r.nameRaw).sort();
  assert.deepEqual(unmapped, ['Test FC "Delta"', 'Test FC Gamma']);
  assert.ok(results.filter((r) => r.ok).every((r) => r.via === 'alias'));
});
