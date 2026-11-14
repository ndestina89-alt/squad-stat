// Leakage guard: what counts as "known" at a given moment.
// A match is usable only if it was finished and had ended strictly before asOf.
const MATCH_DURATION_MS = 3 * 3600 * 1000; // generous: 90 min + half-time + stoppage + extra margin

/** Latest plausible end time (ms). Unknown kickoff => the end of the match date (conservative). */
export function matchEndMs(m) {
  if (m.kickoffUtc) return Date.parse(m.kickoffUtc) + MATCH_DURATION_MS;
  return Date.parse(`${m.matchDate}T23:59:59Z`);
}

export function isUsable(m, asOfMs) {
  return m.status === 'finished'
    && Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals)
    && Number.isFinite(matchEndMs(m)) && matchEndMs(m) < asOfMs;
}

export const toAsOfMs = (asOf) => {
  const t = asOf instanceof Date ? asOf.getTime() : Date.parse(asOf);
  if (!Number.isFinite(t)) throw new RangeError('asOf is not a valid date');
  return t;
};

/** Deterministic chronological order. */
export const byTime = (a, b) => matchEndMs(a) - matchEndMs(b) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
