import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFootballDataOrg, normalizeMatch, normalizeStandings, PROVIDER } from '../pipeline/providers/footballDataOrg.js';
import { assertNormalizedMatch } from '../pipeline/providers/contract.js';
import { ProviderError } from '../pipeline/lib/errors.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/synthetic-fdorg-matches.json', import.meta.url), 'utf8'));
const byId = (id) => fixture.matches.find((m) => m.id === id);
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const ctx = { competitionCode: 'PL', season: 2026 };

test('regular finished match: goals, half-time, London date', () => {
  const r = normalizeMatch(byId(5001), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.match.goals90, { home: 2, away: 1 });
  assert.deepEqual(r.match.halfTime, { home: 1, away: 0 });
  assert.equal(r.match.status, 'finished');
  assert.equal(r.match.matchDate, '2026-08-15');
  assert.equal(r.match.kickoffUtc, '2026-08-15T14:00:00Z');
  assert.deepEqual(r.match.home, { providerTeamId: '11', name: 'Test FC Alpha' });
  assert.equal(r.match.stats, null, 'free tier has no stats and none are invented');
  assertNormalizedMatch(r.match);
});

test('scheduled match has no goals', () => {
  const r = normalizeMatch(byId(5002), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.match.status, 'scheduled');
  assert.equal(r.match.goals90, null);
  assert.equal(r.match.matchday, 12);
  assertNormalizedMatch(r.match);
});

test('penalty shoot-out uses the regular-time score, never the penalty-inflated fullTime', () => {
  const r = normalizeMatch(byId(5003), ctx);
  assert.deepEqual(r.match.goals90, { home: 1, away: 1 });
  assert.deepEqual(r.match.halfTime, { home: 0, away: 1 });
  assert.equal(r.match.stage, 'LAST_16');
  assert.deepEqual(r.warnings, []);
});

test('extra time without a regularTime block leaves goals unknown instead of guessing', () => {
  const r = normalizeMatch(byId(5004), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.match.goals90, null);
  assert.equal(r.match.status, 'finished');
  assert.deepEqual(r.warnings.map((w) => w.code), ['goals_90_unavailable']);
  assertNormalizedMatch(r.match);
});

test('postponed match keeps status and no goals', () => {
  const r = normalizeMatch(byId(5006), ctx);
  assert.equal(r.match.status, 'postponed');
  assert.equal(r.match.goals90, null);
});

test('malformed or undetermined records are rejected with a reason', () => {
  assert.deepEqual(normalizeMatch(byId(5005), ctx), { ok: false, reason: 'team_not_determined', providerMatchId: '5005' });
  assert.equal(normalizeMatch(fixture.matches[6], ctx).reason, 'bad_id');
  assert.equal(normalizeMatch(byId(5008), ctx).reason, 'unknown_status');
  assert.equal(normalizeMatch(null, ctx).reason, 'not_object');
  assert.equal(normalizeMatch({ ...byId(5001), utcDate: '2026-08-15 14:00' }, ctx).reason, 'bad_utc_date');
  assert.equal(normalizeMatch({ ...byId(5001), awayTeam: { id: 11, name: 'Test FC Alpha' } }, ctx).reason, 'same_team');
  assert.equal(normalizeMatch({ ...byId(5001), homeTeam: { id: 11, name: '  ' } }, ctx).reason, 'team_name_missing');
  assert.equal(normalizeMatch(byId(5001), { competitionCode: 'PL' }).reason, 'bad_season');
});

test('season falls back to the response season start date', () => {
  const raw = { ...byId(5001), season: { startDate: '2026-08-01' } };
  assert.equal(normalizeMatch(raw, { competitionCode: 'PL' }).match.season, 2026);
});

test('implausible half-time is dropped with a warning', () => {
  const raw = structuredClone(byId(5001));
  raw.score.halfTime = { home: 3, away: 0 };
  const r = normalizeMatch(raw, ctx);
  assert.equal(r.match.halfTime, null);
  assert.deepEqual(r.warnings.map((w) => w.code), ['halftime_exceeds_fulltime']);
});

test('listMatches: sends token header and season, normalises, reports rejects and meta', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(fixture); };
  const p = createFootballDataOrg({
    token: 'TOKEN-ABC', fetchImpl, limiter: { wait: async () => {} }, now: () => new Date('2026-11-12T08:00:00.456Z'),
  });
  const out = await p.listMatches({ competitionCode: 'PL', season: 2026 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.football-data.org/v4/competitions/PL/matches?season=2026');
  assert.equal(calls[0].init.headers['X-Auth-Token'], 'TOKEN-ABC');
  assert.equal(out.matches.length, 5);
  assert.deepEqual(out.rejects.map((r) => r.reason).sort(), ['bad_id', 'team_not_determined', 'unknown_status']);
  assert.equal(out.meta.rawCount, 8);
  assert.equal(out.meta.fetchedAt, '2026-11-12T08:00:00Z');
  assert.ok(!JSON.stringify(out).includes('TOKEN-ABC'), 'token must not leak into results');
  out.matches.forEach(assertNormalizedMatch);
  assert.ok(out.matches.every((m) => m.provider === PROVIDER && m.competitionCode === 'PL' && m.season === 2026));
  assert.equal(new Set(out.matches.map((m) => m.providerMatchId)).size, out.matches.length);
});

test('listMatches validates inputs and response shape', async () => {
  const p = createFootballDataOrg({ token: 't', fetchImpl: async () => jsonRes({ message: 'nope' }), limiter: { wait: async () => {} } });
  await assert.rejects(p.listMatches({ competitionCode: 'PL', season: 2026 }), (e) => e instanceof ProviderError && e.kind === 'parse');
  await assert.rejects(p.listMatches({ competitionCode: 'PL/../x', season: 2026 }), RangeError);
  await assert.rejects(p.listMatches({ competitionCode: 'pl', season: 2026 }), RangeError);
  await assert.rejects(p.listMatches({ competitionCode: 'PL', season: '2026' }), RangeError);
  await assert.rejects(p.listMatches({ competitionCode: 'PL', season: 1800 }), RangeError);
});

test('a missing token fails at construction with a config error', () => {
  assert.throws(() => createFootballDataOrg({ token: '' }), (e) => e.kind === 'config');
  assert.throws(() => createFootballDataOrg({}), (e) => e.kind === 'config');
});

test('provider failures surface as ProviderError and do not need the other competitions to fail', async () => {
  const fetchImpl = async (url) => (url.includes('/PL/') ? new Response('', { status: 403 }) : jsonRes({ matches: [] }));
  const p = createFootballDataOrg({ token: 't', fetchImpl, limiter: { wait: async () => {} } });
  await assert.rejects(p.listMatches({ competitionCode: 'PL', season: 2026 }), (e) => e.kind === 'http' && e.status === 403);
  assert.deepEqual((await p.listMatches({ competitionCode: 'PD', season: 2026 })).matches, []);
});

const standingsJson = {
  season: { startDate: '2026-08-01' },
  standings: [
    {
      stage: 'REGULAR_SEASON', type: 'TOTAL', table: [
        { position: 1, team: { id: 11, name: 'Test FC Alpha' }, playedGames: 8, won: 5, draw: 2, lost: 1, points: 17, goalsFor: 10, goalsAgainst: 5 },
        { position: 2, team: { id: 12, name: 'Test FC Beta' }, playedGames: 9, won: 5, draw: 2, lost: 1, points: 17, goalsFor: 9, goalsAgainst: 6 },
        { position: 3, team: { id: 13 }, playedGames: 8, won: 1, draw: 1, lost: 1, points: 4, goalsFor: 1, goalsAgainst: 1 },
      ],
    },
    { stage: 'REGULAR_SEASON', type: 'HOME', table: [{ position: 1, team: { id: 11, name: 'Test FC Alpha' }, playedGames: 4, won: 4, draw: 0, lost: 0, points: 12, goalsFor: 8, goalsAgainst: 1 }] },
  ],
};

test('standings keep TOTAL tables only and reject inconsistent rows', () => {
  const { standings, rejects } = normalizeStandings(standingsJson, { competitionCode: 'PL', season: 2026 });
  assert.equal(standings.length, 1);
  assert.equal(standings[0].team.providerTeamId, '11');
  assert.equal(standings[0].stage, 'REGULAR_SEASON');
  assert.deepEqual(rejects.map((r) => r.reason), ['inconsistent_record', 'bad_row']);
  assert.throws(() => normalizeStandings({}, ctx), (e) => e.kind === 'parse');
});
