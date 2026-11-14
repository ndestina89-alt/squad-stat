import { applyStatements } from './apply.js';
import { loadResolver } from './teams.js';
import { toIso } from './jobs.js';

const FIELDS = [
  ['position', 'position'], ['played', 'played'], ['won', 'won'], ['drawn', 'drawn'], ['lost', 'lost'],
  ['goalsFor', 'goals_for'], ['goalsAgainst', 'goals_against'], ['points', 'points'],
];

/** Upsert standings rows that changed. Teams must already exist (matches are ingested first). */
export async function ingestStandings({ db, provider, competition, season, standings, now = new Date(), fetchedAt = toIso(now), retry = {} }) {
  const resolver = await loadResolver(db);
  const existing = await db.all('SELECT * FROM standings WHERE competition_id = ? AND season = ?', [competition.id, season]);
  const byKey = new Map(existing.map((r) => [`${r.stage}|${r.team_id}`, r]));

  const statements = [];
  const counts = { upserted: 0, unchanged: 0, unmappedSkipped: 0 };
  for (const s of standings) {
    const t = resolver.resolve(provider.id, { id: s.team.providerTeamId, name: s.team.name });
    if (!t.ok) { counts.unmappedSkipped++; continue; }
    const prev = byKey.get(`${s.stage}|${t.teamId}`);
    if (prev && FIELDS.every(([f, col]) => prev[col] === s[f]) && prev.provider_id === provider.id) { counts.unchanged++; continue; }
    const cols = FIELDS.map(([, c]) => c);
    statements.push({
      sql: `INSERT INTO standings (competition_id, season, stage, team_id, ${cols.join(', ')}, provider_id, fetched_at)
            VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)
            ON CONFLICT (competition_id, season, stage, team_id) DO UPDATE SET
              ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, provider_id = excluded.provider_id, fetched_at = excluded.fetched_at`,
      params: [competition.id, season, s.stage, t.teamId, ...FIELDS.map(([f]) => s[f]), provider.id, fetchedAt],
    });
    counts.upserted++;
  }
  const statementsExecuted = await applyStatements(db, statements, { retry });
  return { ...counts, statementsExecuted };
}
