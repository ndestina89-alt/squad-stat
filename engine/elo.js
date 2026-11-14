// Dynamic Elo. Used as a transparent rating and baseline; it is NOT multiplied into the Dixon-Coles
// goal expectations (that would count team strength twice).
import { byTime, isUsable, toAsOfMs } from './eligibility.js';

export const ELO_DEFAULTS = Object.freeze({ k: 20, homeAdvantage: 60, initial: 1500 });

export const eloExpected = (ratingHome, ratingAway, homeAdvantage = ELO_DEFAULTS.homeAdvantage) =>
  1 / (1 + 10 ** (-(ratingHome + homeAdvantage - ratingAway) / 400));

/** Goal-difference multiplier: 1 for a one-goal win or a draw, 1.5 for two goals, (11 + gd) / 8 beyond. */
export const goalDifferenceMultiplier = (gd) => {
  const d = Math.abs(gd);
  if (d <= 1) return 1;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
};

/** One update. Returns the new ratings; the update is zero-sum. */
export function eloUpdate(ratingHome, ratingAway, homeGoals, awayGoals, opts = {}) {
  const { k, homeAdvantage } = { ...ELO_DEFAULTS, ...opts };
  const expected = eloExpected(ratingHome, ratingAway, homeAdvantage);
  const actual = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const delta = k * goalDifferenceMultiplier(homeGoals - awayGoals) * (actual - expected);
  return { home: ratingHome + delta, away: ratingAway - delta, expected, delta };
}

/**
 * Replay eligible matches in time order. Only matches that ended strictly before asOf are used.
 * matches: { id, homeTeamId, awayTeamId, homeGoals, awayGoals, status, matchDate, kickoffUtc }.
 * Returns Map(teamId -> { elo, matches }).
 */
export function computeElo(matches, { asOf, ...opts } = {}) {
  const cfg = { ...ELO_DEFAULTS, ...opts };
  const cutoff = toAsOfMs(asOf);
  const ratings = new Map();
  const get = (id) => { if (!ratings.has(id)) ratings.set(id, { elo: cfg.initial, matches: 0 }); return ratings.get(id); };
  for (const m of matches.filter((x) => isUsable(x, cutoff)).sort(byTime)) {
    const h = get(m.homeTeamId); const a = get(m.awayTeamId);
    const u = eloUpdate(h.elo, a.elo, m.homeGoals, m.awayGoals, cfg);
    h.elo = u.home; a.elo = u.away; h.matches++; a.matches++;
  }
  return ratings;
}
