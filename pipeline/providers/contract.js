/**
 * Normalized provider output. Every adapter returns { matches, rejects, warnings, meta }.
 *
 * NormalizedMatch {
 *   provider: string,                 // providers.id
 *   providerMatchId: string,
 *   competitionCode: string,          // our canonical code (PL, PD, ...)
 *   season: number,                   // start year
 *   matchday: number | null, stage: string | null,
 *   matchDate: 'YYYY-MM-DD',          // Europe/London calendar date
 *   kickoffUtc: string | null, kickoffKnown: boolean,
 *   status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled' | 'awarded',
 *   home: { providerTeamId: string | null, name: string },
 *   away: { providerTeamId: string | null, name: string },
 *   goals90: { home: number, away: number } | null,   // regular time only; null when unknown
 *   halfTime: { home: number, away: number } | null,
 *   stats: { shotsHome, shotsAway, shotsOnTargetHome, ... } | null,   // provider-specific definitions
 * }
 * Reject { reason: string, providerMatchId?: string, line?: number }  (row skipped, reason recorded)
 */
export const MATCH_STATUSES = ['scheduled', 'live', 'finished', 'postponed', 'cancelled', 'awarded'];

const isInt = (v) => Number.isInteger(v) && v >= 0;

/** Throws if a normalized match violates the contract. Used by adapters' tests and by ingestion as a guard. */
export function assertNormalizedMatch(m) {
  const fail = (msg) => { throw new Error(`Invalid NormalizedMatch (${m?.provider}/${m?.providerMatchId}): ${msg}`); };
  if (!m || typeof m !== 'object') fail('not an object');
  if (!m.provider || !m.providerMatchId) fail('missing provider ids');
  if (!m.competitionCode) fail('missing competitionCode');
  if (!Number.isInteger(m.season)) fail('season must be an integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.matchDate)) fail('bad matchDate');
  if (m.kickoffUtc != null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.kickoffUtc)) fail('bad kickoffUtc');
  if (m.kickoffKnown !== (m.kickoffUtc != null)) fail('kickoffKnown must match kickoffUtc');
  if (!MATCH_STATUSES.includes(m.status)) fail('bad status');
  for (const side of ['home', 'away']) {
    if (!m[side] || typeof m[side].name !== 'string' || !m[side].name.trim()) fail(`${side}.name missing`);
  }
  if (m.goals90 != null) {
    if (!isInt(m.goals90.home) || !isInt(m.goals90.away)) fail('goals90 must be non-negative integers');
    if (m.status !== 'finished') fail('goals90 only allowed on finished matches');
  }
  if (m.halfTime != null && (!isInt(m.halfTime.home) || !isInt(m.halfTime.away))) fail('halfTime invalid');
  return m;
}
