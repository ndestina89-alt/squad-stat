// Dixon-Coles score matrix and markets derived from it.
//
// p(x, y) = tau(x, y) * Pois(x; lambda) * Pois(y; nu). The tau correction only touches 0-0, 0-1, 1-0, 1-1 and
// is built so the infinite joint still sums to 1. The matrix is truncated, so the mass beyond it is REPORTED as
// tailMass and never silently renormalised away.
import { poissonPmfArray, poissonTail } from './poisson.js';

export function tau(x, y, lambda, nu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * nu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + nu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Throws if rho makes any corrected cell non-positive (probabilities would be invalid). */
export function assertValidRho(lambda, nu, rho) {
  for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    if (!(tau(x, y, lambda, nu, rho) > 0)) throw new RangeError(`rho=${rho} gives a non-positive correction at ${x}-${y} for lambda=${lambda}, nu=${nu}`);
  }
}

/** Smallest n whose combined marginal tails fall below tailTarget, up to cap. */
export function chooseMaxGoals(lambda, nu, { tailTarget = 1e-9, cap = 30, min = 6 } = {}) {
  for (let n = min; n <= cap; n++) {
    if (poissonTail(lambda, n) + poissonTail(nu, n) < tailTarget) return n;
  }
  return cap;
}

/**
 * Build the matrix. maxGoals is fixed if given, otherwise chosen adaptively (with a cap).
 * Returns { matrix (rows = home goals, cols = away goals), maxGoals, tailMass, lambda, nu, rho }.
 */
export function buildScoreMatrix({ lambda, nu, rho = 0, maxGoals = null, tailTarget = 1e-9, cap = 30 }) {
  if (!(lambda >= 0) || !(nu >= 0) || !Number.isFinite(lambda) || !Number.isFinite(nu)) throw new RangeError('lambda and nu must be finite and >= 0');
  if (!Number.isFinite(rho)) throw new RangeError('rho must be finite');
  assertValidRho(lambda, nu, rho);
  const n = maxGoals ?? chooseMaxGoals(lambda, nu, { tailTarget, cap });
  if (!Number.isInteger(n) || n < 1) throw new RangeError('maxGoals must be an integer >= 1');
  const ph = poissonPmfArray(lambda, n);
  const pa = poissonPmfArray(nu, n);
  const matrix = [];
  let sum = 0;
  for (let x = 0; x <= n; x++) {
    const row = new Array(n + 1);
    for (let y = 0; y <= n; y++) {
      row[y] = tau(x, y, lambda, nu, rho) * ph[x] * pa[y];
      sum += row[y];
    }
    matrix.push(row);
  }
  return { matrix, maxGoals: n, tailMass: Math.max(0, 1 - sum), lambda, nu, rho };
}

/** Result probabilities straight from the matrix. They sum to 1 - tailMass, by design. */
export function resultProbabilities({ matrix }) {
  let home = 0; let draw = 0; let away = 0;
  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      if (x > y) home += matrix[x][y]; else if (x === y) draw += matrix[x][y]; else away += matrix[x][y];
    }
  }
  return { home, draw, away };
}

/**
 * P(total goals > line) for a half-goal line such as 2.5 (also accepts whole lines: strictly more than).
 * Computed as 1 - P(total <= floor(line)); every cell with that total lies inside the matrix, so the
 * truncated tail does not distort it. Throws when the matrix is too small for the line.
 */
export function overProbability({ matrix, maxGoals }, line) {
  const k = Math.floor(line);
  if (!(line >= 0) || k > maxGoals) throw new RangeError(`line ${line} needs maxGoals >= ${k}`);
  let under = 0;
  for (let x = 0; x <= k; x++) for (let y = 0; x + y <= k; y++) under += matrix[x][y];
  return Math.min(1, Math.max(0, 1 - under));
}

/**
 * P(both teams score), exact and independent of truncation:
 * 1 - P(X=0) - P(Y=0) + P(0,0), with P(X=0)=e^-lambda, P(Y=0)=e^-nu and P(0,0)=(1 - lambda*nu*rho)e^-(lambda+nu).
 */
export function bttsProbability({ lambda, nu, rho }) {
  return 1 - Math.exp(-lambda) - Math.exp(-nu) + (1 - lambda * nu * rho) * Math.exp(-lambda - nu);
}

export function topScores({ matrix }, k = 5) {
  const cells = [];
  for (let x = 0; x < matrix.length; x++) for (let y = 0; y < matrix[x].length; y++) cells.push({ home: x, away: y, p: matrix[x][y] });
  cells.sort((a, b) => b.p - a.p || a.home - b.home || a.away - b.away);
  return cells.slice(0, k);
}
