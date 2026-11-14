// football-data.co.uk CSV adapter: historical results, shots and corners. Played matches only (no fixtures).
// Column meanings follow the site's published notes as summarised by the soccerdata docs. Not verified live
// from the build sandbox, and the site's licence terms are UNVERIFIED: check them before publishing.
// Kick-off times in these files are assumed to be UK local time (Europe/London); confirm on first real run.
import { ProviderError } from '../lib/errors.js';
import { RateLimiter, requestText } from '../lib/http.js';
import { parseCsv } from '../lib/csv.js';
import { isValidYmd, londonLocalToUtcIso, ymd } from '../lib/dates.js';
import { normalizeName } from '../lib/teams.js';

export const PROVIDER = 'football-data.co.uk';
export const DEFAULT_BASE_URL = 'https://www.football-data.co.uk';
export const MAX_CSV_CHARS = 5_000_000;

const REQUIRED = ['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG'];
const STAT_COLUMNS = [
  ['shotsHome', 'HS'], ['shotsAway', 'AS'], ['shotsOnTargetHome', 'HST'], ['shotsOnTargetAway', 'AST'],
  ['cornersHome', 'HC'], ['cornersAway', 'AC'], ['foulsHome', 'HF'], ['foulsAway', 'AF'],
  ['yellowHome', 'HY'], ['yellowAway', 'AY'], ['redHome', 'HR'], ['redAway', 'AR'],
];

const intOrNull = (s) => (/^\d+$/.test(String(s ?? '').trim()) ? Number(s) : null);

/** 'dd/mm/yyyy' or 'dd/mm/yy' -> { y, m, d } or null. Two-digit years: 00-69 => 2000s, 70-99 => 1900s. */
export function parseCsvDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
  return isValidYmd(y, mo, d) ? { y, m: mo, d } : null;
}

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? { hh, mm } : null;
}

const resultOf = (h, a) => (h > a ? 'H' : h < a ? 'A' : 'D');

/**
 * Normalise CSV text for one division and season.
 * Rows that cannot be trusted are rejected with a reason; nothing is repaired silently.
 */
export function normalizeCsv(text, { div, season, competitionCode }) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: 'empty CSV response' });
  }
  if (text.length > MAX_CSV_CHARS) {
    throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: 'CSV response too large' });
  }
  let parsed;
  try { parsed = parseCsv(text); } catch (cause) {
    throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: 'CSV is malformed', cause });
  }
  const missing = REQUIRED.filter((c) => !parsed.header.includes(c));
  if (missing.length) {
    throw new ProviderError({ provider: PROVIDER, kind: 'parse', message: `CSV is missing required columns: ${missing.join(', ')}` });
  }

  const windowStart = `${season}-07-01`;
  const windowEnd = `${season + 1}-08-31`;
  const matches = [];
  const rejects = [];
  const warnings = [];
  const seen = new Set();

  for (const { line, cells: r } of parsed.rows) {
    const reject = (reason) => rejects.push({ reason, line });

    const date = parseCsvDate(r.Date);
    if (!date) { reject('bad_date'); continue; }
    const matchDate = ymd(date.y, date.m, date.d);
    if (matchDate < windowStart || matchDate > windowEnd) { reject('date_out_of_season'); continue; }

    if (!r.HomeTeam || !r.AwayTeam) { reject('team_name_missing'); continue; }
    if (normalizeName(r.HomeTeam) === normalizeName(r.AwayTeam)) { reject('same_team'); continue; }

    if (r.FTHG === '' && r.FTAG === '') { reject('no_result'); continue; }
    const hg = intOrNull(r.FTHG);
    const ag = intOrNull(r.FTAG);
    if (hg === null || ag === null) { reject('bad_goals'); continue; }
    if (r.FTR && r.FTR !== resultOf(hg, ag)) { reject('result_mismatch'); continue; }

    const key = `${matchDate}|${normalizeName(r.HomeTeam)}|${normalizeName(r.AwayTeam)}`;
    if (seen.has(key)) { reject('duplicate_in_file'); continue; }
    seen.add(key);

    let halfTime = null;
    const hth = intOrNull(r.HTHG);
    const hta = intOrNull(r.HTAG);
    if (hth !== null && hta !== null) {
      if (hth <= hg && hta <= ag) halfTime = { home: hth, away: hta };
      else warnings.push({ code: 'halftime_exceeds_fulltime', line });
    }

    let kickoffUtc = null;
    const time = parseTime(r.Time);
    if (time) kickoffUtc = londonLocalToUtcIso(date.y, date.m, date.d, time.hh, time.mm);

    const stats = {};
    for (const [field, col] of STAT_COLUMNS) stats[field] = intOrNull(r[col]);
    for (const side of ['Home', 'Away']) {
      const shots = stats[`shots${side}`];
      const sot = stats[`shotsOnTarget${side}`];
      if (shots !== null && sot !== null && sot > shots) {
        warnings.push({ code: 'sot_exceeds_shots', line, side: side.toLowerCase() });
        stats[`shots${side}`] = null;
        stats[`shotsOnTarget${side}`] = null;
      }
    }
    const hasStats = Object.values(stats).some((v) => v !== null);

    const slug = (s) => normalizeName(s).replace(/ /g, '_');
    matches.push({
      provider: PROVIDER,
      providerMatchId: `${div}:${season}:${matchDate}:${slug(r.HomeTeam)}:${slug(r.AwayTeam)}`,
      competitionCode,
      season,
      matchday: null,
      stage: null,
      matchDate,
      kickoffUtc,
      kickoffKnown: kickoffUtc !== null,
      status: 'finished',
      home: { providerTeamId: null, name: r.HomeTeam },
      away: { providerTeamId: null, name: r.AwayTeam },
      goals90: { home: hg, away: ag },
      halfTime,
      stats: hasStats ? stats : null,
    });
  }
  return { matches, rejects, warnings };
}

export const seasonCode = (season) => `${String(season % 100).padStart(2, '0')}${String((season + 1) % 100).padStart(2, '0')}`;

export function createFootballDataCsv({
  baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, limiter = null,
  now = () => new Date(), requestOptions = {},
} = {}) {
  // Courtesy spacing: one file per second at most.
  const rl = limiter ?? new RateLimiter({ minIntervalMs: 1000 });
  return {
    name: PROVIDER,

    async fetchSeason({ div, season, competitionCode }) {
      if (!/^[A-Z]{1,3}\d{0,2}$/.test(String(div))) throw new RangeError(`invalid division: ${div}`);
      if (!Number.isInteger(season) || season < 1993 || season > 2100) throw new RangeError(`invalid season: ${season}`);
      if (!competitionCode) throw new RangeError('competitionCode is required');
      const url = `${baseUrl}/mmz4281/${seasonCode(season)}/${div}.csv`;
      const { text } = await requestText(url, { provider: PROVIDER, fetchImpl, limiter: rl, ...requestOptions });
      const out = normalizeCsv(text, { div, season, competitionCode });
      return { ...out, meta: { provider: PROVIDER, fetchedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'), url, rawRows: out.matches.length + out.rejects.length } };
    },
  };
}
