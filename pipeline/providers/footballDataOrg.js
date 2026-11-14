// football-data.org v4 adapter (free tier: fixtures, results and standings; no stats, xG or lineups).
// The response shapes below follow the public v4 documentation but have NOT been verified against the live API
// from the build sandbox (outbound access to it was blocked). The first real run in GitHub Actions is the check.
import { ProviderError } from '../lib/errors.js';
import { RateLimiter, requestJson } from '../lib/http.js';
import { normalizeUtcIso, utcIsoToLondonDate } from '../lib/dates.js';

export const PROVIDER = 'football-data.org';
export const DEFAULT_BASE_URL = 'https://api.football-data.org/v4';
// Free tier allows 10 requests/minute; 6.5 s spacing keeps a margin.
export const DEFAULT_MIN_INTERVAL_MS = 6500;

const STATUS_MAP = {
  SCHEDULED: 'scheduled', TIMED: 'scheduled',
  IN_PLAY: 'live', PAUSED: 'live',
  FINISHED: 'finished',
  POSTPONED: 'postponed', SUSPENDED: 'postponed',
  CANCELLED: 'cancelled',
  AWARDED: 'awarded',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGoal = (v) => Number.isInteger(v) && v >= 0;
const posInt = (v) => Number.isInteger(v) && v > 0;
const goalPair = (p) => (isObj(p) && isGoal(p.home) && isGoal(p.away) ? { home: p.home, away: p.away } : null);

/**
 * Normalise one raw match. Returns { ok: true, match, warnings } or { ok: false, reason, providerMatchId }.
 * Goals are always the 90-minute score: for matches that went to extra time or penalties the regularTime
 * block is used; if it is absent the goals stay null rather than guessed.
 */
export function normalizeMatch(raw, { competitionCode, season = null } = {}) {
  const providerMatchId = isObj(raw) && raw.id != null ? String(raw.id) : null;
  const reject = (reason) => ({ ok: false, reason, providerMatchId });
  const warnings = [];

  if (!isObj(raw)) return reject('not_object');
  if (!posInt(raw.id)) return reject('bad_id');
  const kickoffUtc = normalizeUtcIso(raw.utcDate);
  if (!kickoffUtc) return reject('bad_utc_date');

  const status = STATUS_MAP[raw.status];
  if (!status) return reject('unknown_status');

  const { homeTeam: h, awayTeam: a } = raw;
  if (!isObj(h) || !isObj(a) || !posInt(h.id) || !posInt(a.id)) return reject('team_not_determined');
  if (h.id === a.id) return reject('same_team');
  const nameOf = (t) => [t.name, t.shortName].find((n) => typeof n === 'string' && n.trim() !== '');
  const homeName = nameOf(h);
  const awayName = nameOf(a);
  if (!homeName || !awayName) return reject('team_name_missing');

  const startYear = Number.parseInt(String(raw.season?.startDate ?? '').slice(0, 4), 10);
  const seasonYear = Number.isInteger(season) ? season : startYear;
  if (!Number.isInteger(seasonYear)) return reject('bad_season');

  let goals90 = null;
  let halfTime = null;
  if (status === 'finished') {
    const score = isObj(raw.score) ? raw.score : {};
    const duration = score.duration ?? 'REGULAR';
    goals90 = goalPair(duration === 'REGULAR' ? score.fullTime : score.regularTime);
    if (!goals90) warnings.push({ code: 'goals_90_unavailable', providerMatchId, duration });
    halfTime = goalPair(score.halfTime);
    if (goals90 && halfTime && (halfTime.home > goals90.home || halfTime.away > goals90.away)) {
      warnings.push({ code: 'halftime_exceeds_fulltime', providerMatchId });
      halfTime = null;
    }
  }

  return {
    ok: true,
    warnings,
    match: {
      provider: PROVIDER,
      providerMatchId,
      competitionCode: competitionCode ?? raw.competition?.code ?? null,
      season: seasonYear,
      matchday: Number.isInteger(raw.matchday) ? raw.matchday : null,
      stage: typeof raw.stage === 'string' ? raw.stage : null,
      matchDate: utcIsoToLondonDate(kickoffUtc),
      kickoffUtc,
      kickoffKnown: true,
      status,
      home: { providerTeamId: String(h.id), name: homeName },
      away: { providerTeamId: String(a.id), name: awayName },
      goals90,
      halfTime,
      stats: null,
    },
  };
}

/** Normalise a /standings response. Only 'TOTAL' tables are kept (home/away splits are skipped). */
export function normalizeStandings(json, { competitionCode, season = null } = {}) {
  if (!isObj(json) || !Array.isArray(json.standings)) {
    throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: 'standings response has no "standings" array' });
  }
  const startYear = Number.parseInt(String(json.season?.startDate ?? '').slice(0, 4), 10);
  const seasonYear = Number.isInteger(season) ? season : startYear;
  const rows = [];
  const rejects = [];
  for (const table of json.standings) {
    if (!isObj(table) || table.type !== 'TOTAL' || !Array.isArray(table.table)) continue;
    const stage = [table.stage, table.group].filter((x) => typeof x === 'string' && x).join(':') || 'TOTAL';
    for (const r of table.table) {
      const t = r?.team;
      const nums = [r?.position, r?.playedGames, r?.won, r?.draw, r?.lost, r?.goalsFor, r?.goalsAgainst];
      if (!isObj(t) || !posInt(t.id) || typeof t.name !== 'string' || !nums.every((n) => Number.isInteger(n) && n >= 0) || !Number.isInteger(r.points)) {
        rejects.push({ reason: 'bad_row', providerTeamId: isObj(t) && t.id != null ? String(t.id) : null });
        continue;
      }
      if (r.won + r.draw + r.lost !== r.playedGames) {
        rejects.push({ reason: 'inconsistent_record', providerTeamId: String(t.id) });
        continue;
      }
      rows.push({
        provider: PROVIDER, competitionCode, season: seasonYear, stage,
        team: { providerTeamId: String(t.id), name: t.name },
        position: r.position, played: r.playedGames, won: r.won, drawn: r.draw, lost: r.lost,
        goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, points: r.points,
      });
    }
  }
  return { standings: rows, rejects };
}

function validateRef(competitionCode, season) {
  if (!/^[A-Z0-9]{2,5}$/.test(String(competitionCode))) throw new RangeError(`invalid competition code: ${competitionCode}`);
  if (!Number.isInteger(season) || season < 1990 || season > 2100) throw new RangeError(`invalid season: ${season}`);
}

export function createFootballDataOrg({
  token, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, limiter = null,
  now = () => new Date(), requestOptions = {},
} = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ProviderError({ provider: PROVIDER, kind: 'config', message: 'FOOTBALL_DATA_ORG_TOKEN is not set' });
  }
  const rl = limiter ?? new RateLimiter({ minIntervalMs: DEFAULT_MIN_INTERVAL_MS });
  const get = (url) => requestJson(url, {
    provider: PROVIDER, fetchImpl, limiter: rl, headers: { 'X-Auth-Token': token, Accept: 'application/json' }, ...requestOptions,
  });

  return {
    name: PROVIDER,

    /** All matches of a competition-season: past results and upcoming fixtures in one request. */
    async listMatches({ competitionCode, season }) {
      validateRef(competitionCode, season);
      const url = `${baseUrl}/competitions/${competitionCode}/matches?season=${season}`;
      const json = await get(url);
      if (!isObj(json) || !Array.isArray(json.matches)) {
        throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: 'matches response has no "matches" array' });
      }
      const matches = [];
      const rejects = [];
      const warnings = [];
      for (const raw of json.matches) {
        const r = normalizeMatch(raw, { competitionCode, season });
        if (r.ok) { matches.push(r.match); warnings.push(...r.warnings); } else rejects.push({ reason: r.reason, providerMatchId: r.providerMatchId });
      }
      return { matches, rejects, warnings, meta: { provider: PROVIDER, fetchedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'), url, rawCount: json.matches.length } };
    },

    async listStandings({ competitionCode, season }) {
      validateRef(competitionCode, season);
      const url = `${baseUrl}/competitions/${competitionCode}/standings?season=${season}`;
      const json = await get(url);
      const { standings, rejects } = normalizeStandings(json, { competitionCode, season });
      return { standings, rejects, meta: { provider: PROVIDER, fetchedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'), url } };
    },
  };
}
