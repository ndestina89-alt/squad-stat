// Turns a fit into one match prediction, shaped like a row of the `predictions` table.
// The goal expectations are the MODEL's lambda and nu. They are labelled model_goal_expectation, never xG.
import { buildScoreMatrix, bttsProbability, overProbability, resultProbabilities, topScores } from './scoreMatrix.js';
import { featureHash } from './fit.js';
import { eloExpected } from './elo.js';

export const LOW_DATA_EFFECTIVE_MATCHES = 8;
export const MAX_TAIL_FOR_STORAGE = 1e-3; // the predictions table requires p_home+p_draw+p_away within 0.001 of 1

export function predictMatch({ fit, homeTeamId, awayTeamId, elo = null, neutral = false, maxGoals = null }) {
  const { mu, homeAdvantage, rho, teams } = fit.params;
  const flags = [];
  const lookup = (id, side) => {
    const t = teams[id];
    if (!t) { flags.push(`${side}_team_unknown`); return { attack: 1, defense: 1, effectiveMatches: 0, matchesUsed: 0 }; }
    return t;
  };
  const home = lookup(homeTeamId, 'home');
  const away = lookup(awayTeamId, 'away');
  if (home === away && homeTeamId === awayTeamId) throw new RangeError('home and away team are the same');

  // exp(a) = attack multiplier, exp(d) = defence strength.
  const lambda = Math.exp(mu + (neutral ? 0 : homeAdvantage)) * home.attack / away.defense;
  const nu = Math.exp(mu) * away.attack / home.defense;

  const m = buildScoreMatrix({ lambda, nu, rho, maxGoals });
  if (m.tailMass > MAX_TAIL_FOR_STORAGE) throw new RangeError(`tail mass ${m.tailMass} is too large to store; raise maxGoals`);
  const r = resultProbabilities(m);
  const lowData = Math.min(home.effectiveMatches, away.effectiveMatches) < LOW_DATA_EFFECTIVE_MATCHES;
  if (lowData) flags.push('low_data');

  const inputs = { modelVersion: fit.modelVersion, dataAsOf: fit.dataAsOf, homeTeamId, awayTeamId, lambda, nu, rho, neutral };
  return {
    modelVersion: fit.modelVersion,
    dataAsOf: fit.dataAsOf,
    goalExpectationKind: 'model_goal_expectation',
    expectedHomeGoals: lambda,
    expectedAwayGoals: nu,
    pHome: r.home, pDraw: r.draw, pAway: r.away,
    pOver25: overProbability(m, 2.5),
    pBttsYes: bttsProbability(m),
    tailMass: m.tailMass,
    matrixMaxGoals: m.maxGoals,
    topScores: topScores(m, 5).map((c) => ({ home: c.home, away: c.away, p: c.p })),
    uncertainty: {
      flags, lowData,
      homeEffectiveMatches: home.effectiveMatches, awayEffectiveMatches: away.effectiveMatches,
      homeMatchesUsed: home.matchesUsed, awayMatchesUsed: away.matchesUsed,
      note: 'Probabilities come from point estimates; parameter uncertainty is not propagated.',
    },
    eloExpectedHome: elo ? eloExpected(elo.home, elo.away) : null,
    featureHash: featureHash(inputs),
  };
}
