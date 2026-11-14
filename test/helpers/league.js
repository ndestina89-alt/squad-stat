// Seed a synthetic league (fictional teams, simulated results) into a test database.
import { simulateLeague } from '../engine/helpers.js';

export function seedLeague(raw, { seed = 7, nTeams = 6, rounds = 10, competitionId = 1, season = 2025, fixtures = [] } = {}) {
  const { matches } = simulateLeague({ seed, nTeams, rounds });
  const insTeam = raw.prepare('INSERT INTO teams (id, name) VALUES (?, ?)');
  for (let i = 1; i <= nTeams; i++) insTeam.run(i, `Synthetic FC ${i}`);
  const ins = raw.prepare(`INSERT INTO matches (id, competition_id, season, match_date, kickoff_utc, status, home_team_id, away_team_id,
    home_goals, away_goals, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`);
  for (const m of matches) ins.run(m.id, competitionId, season, m.matchDate, m.kickoffUtc, 'finished', m.homeTeamId, m.awayTeamId, m.homeGoals, m.awayGoals);
  let id = 100000;
  for (const f of fixtures) { ins.run(++id, competitionId, season, f.date, `${f.date}T15:00:00Z`, 'scheduled', f.home, f.away, null, null); f.id = id; }
  return { matches, lastKickoff: matches[matches.length - 1].kickoffUtc };
}
