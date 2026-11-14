export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const poissonSample = (rng, lam) => { const L = Math.exp(-lam); let k = 0; let p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; };

/** Synthetic league with KNOWN parameters, for recovery tests. Nothing here resembles real data. */
export function simulateLeague({ seed = 1, nTeams = 8, rounds = 14, mu = 0.2, h = 0.25, rho = 0, startMs = Date.UTC(2025, 7, 1) } = {}) {
  const rng = mulberry32(seed);
  const attack = []; const defense = [];
  for (let i = 0; i < nTeams; i++) { attack.push((rng() - 0.5) * 0.6); defense.push((rng() - 0.5) * 0.6); }
  const matches = [];
  let id = 0;
  for (let r = 0; r < rounds; r++) for (let i = 0; i < nTeams; i++) for (let j = 0; j < nTeams; j++) {
    if (i === j) continue;
    id++;
    const t = new Date(startMs + id * 86400000 / 4);
    const lam = Math.exp(mu + h + attack[i] - defense[j]); const nu = Math.exp(mu + attack[j] - defense[i]);
    let x = poissonSample(rng, lam); let y = poissonSample(rng, nu);
    void rho;
    matches.push({ id, homeTeamId: i + 1, awayTeamId: j + 1, homeGoals: x, awayGoals: y, status: 'finished', matchDate: t.toISOString().slice(0, 10), kickoffUtc: t.toISOString().slice(0, 19) + 'Z' });
  }
  return { matches, truth: { attack, defense, mu, h } };
}

/** Weekly fixtures over several seasons with fixed true strengths. Entirely synthetic. */
export function simulateSeasons({ seed = 1, nTeams = 12, weeks = 80, mu = 0.15, h = 0.3, spread = 0.45, start = '2024-08-10' } = {}) {
  const rng = mulberry32(seed);
  const attack = Array.from({ length: nTeams }, () => (rng() - 0.5) * 2 * spread);
  const defense = Array.from({ length: nTeams }, () => (rng() - 0.5) * 2 * spread);
  const matches = [];
  let id = 0;
  for (let w = 0; w < weeks; w++) {
    const order = Array.from({ length: nTeams }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const day = new Date(Date.parse(`${start}T00:00:00Z`) + w * 7 * 86400000);
    for (let k = 0; k + 1 < nTeams; k += 2) {
      const [i, j] = order.slice(k, k + 2);
      id++;
      const lam = Math.exp(mu + h + attack[i] - defense[j]); const nu = Math.exp(mu + attack[j] - defense[i]);
      matches.push({
        id, homeTeamId: i + 1, awayTeamId: j + 1, homeGoals: poissonSample(rng, lam), awayGoals: poissonSample(rng, nu), status: 'finished',
        matchDate: day.toISOString().slice(0, 10), kickoffUtc: `${day.toISOString().slice(0, 10)}T15:00:00Z`,
      });
    }
  }
  return { matches, truth: { attack, defense, mu, h } };
}
