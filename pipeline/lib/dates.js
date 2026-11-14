// Date helpers. match_date is the Europe/London calendar date, for every provider, so records can be matched.

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Europe/London wall-clock at instant `ms`, expressed as if it were UTC milliseconds. */
function londonWallAsUtcMs(ms) {
  const p = Object.fromEntries(LONDON.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function isValidYmd(y, m, d) {
  if (![y, m, d].every(Number.isInteger) || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Convert a Europe/London local date+time to a UTC ISO string. Nonexistent (spring-forward) times shift forward. */
export function londonLocalToUtcIso(y, m, d, hh, mm) {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive - (londonWallAsUtcMs(naive) - naive);
  guess = naive - (londonWallAsUtcMs(guess) - guess);
  return iso(guess);
}

/** Europe/London calendar date (YYYY-MM-DD) of a UTC ISO instant. */
export function utcIsoToLondonDate(isoString) {
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return null;
  const w = new Date(londonWallAsUtcMs(ms));
  return ymd(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate());
}

/** Normalise an ISO UTC instant to 'YYYY-MM-DDTHH:MM:SSZ'. */
export function normalizeUtcIso(s) {
  const m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z$/.exec(s);
  if (!m) return null;
  const [y, mo, d, hh, mi] = m.slice(1, 6).map(Number);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  // Date.parse silently rolls impossible dates over (Feb 31 -> Mar 3), so check the components explicitly.
  if (!isValidYmd(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return null;
  return iso(Date.UTC(y, mo - 1, d, hh, mi, ss));
}

/** Season start year for a calendar date (a season starts in July or later). */
export function seasonOfDate(dateYmd) {
  const [y, m] = dateYmd.split('-').map(Number);
  return m >= 7 ? y : y - 1;
}

export const seasonLabel = (season) => `${season}-${String((season + 1) % 100).padStart(2, '0')}`;
