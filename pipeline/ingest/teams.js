import { createTeamResolver, normalizeName } from '../lib/teams.js';
import { applyStatements } from './apply.js';
import { toIso } from './jobs.js';

/** Build a resolver from the mapping tables. */
export async function loadResolver(db) {
  const [ids, aliases] = await Promise.all([
    db.all('SELECT provider_id, provider_team_id, team_id FROM team_provider_ids'),
    db.all('SELECT provider_id, alias_norm, team_id FROM team_aliases'),
  ]);
  return createTeamResolver({
    providerIds: ids.map((r) => ({ provider: r.provider_id, providerTeamId: r.provider_team_id, teamId: r.team_id })),
    aliases: aliases.map((r) => ({ provider: r.provider_id, aliasNorm: r.alias_norm, teamId: r.team_id })),
  });
}

/**
 * Create canonical teams for provider team ids not seen before. Only for providers whose ids are authoritative.
 * Each team and its id mapping are written in one atomic batch pair (last_insert_rowid links them).
 * Returns the number of teams created.
 */
export async function ensureProviderTeams(db, { provider, refs, resolver, now = new Date(), retry = {} }) {
  const seen = new Set();
  const statements = [];
  for (const ref of refs) {
    const id = ref.providerTeamId;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    if (resolver.resolve(provider, { id, name: ref.name }).ok) continue;
    statements.push(
      { sql: 'INSERT INTO teams (name, created_at) VALUES (?, ?)', params: [ref.name, toIso(now)] },
      { sql: 'INSERT INTO team_provider_ids (provider_id, provider_team_id, team_id) VALUES (?, ?, last_insert_rowid())', params: [provider, String(id)] },
    );
  }
  await applyStatements(db, statements, { retry });
  return statements.length / 2;
}

/** Explicitly map a provider's team name to a canonical team. Fails if the alias already maps elsewhere. */
export async function addAlias(db, { provider, nameRaw, teamId }) {
  const aliasNorm = normalizeName(nameRaw);
  if (!aliasNorm) throw new RangeError('alias name is empty');
  await db.batch([
    { sql: 'INSERT INTO team_aliases (provider_id, alias_norm, team_id) VALUES (?, ?, ?)', params: [provider, aliasNorm, teamId] },
    { sql: 'DELETE FROM unmapped_team_names WHERE provider_id = ? AND alias_norm = ?', params: [provider, aliasNorm] },
  ]);
  return aliasNorm;
}

/** Statements that record unmapped names. They write at most once per name per day, so reruns do not churn. */
export function unmappedStatements({ provider, items, competitionCode, now = new Date() }) {
  const ts = toIso(now);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.aliasNorm || seen.has(it.aliasNorm)) continue;
    seen.add(it.aliasNorm);
    out.push({
      sql: `INSERT INTO unmapped_team_names (provider_id, alias_norm, name_raw, competition_code, first_seen_at, last_seen_at, times_seen)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT (provider_id, alias_norm) DO UPDATE SET last_seen_at = excluded.last_seen_at, times_seen = unmapped_team_names.times_seen + 1
            WHERE substr(unmapped_team_names.last_seen_at, 1, 10) < substr(excluded.last_seen_at, 1, 10)`,
      params: [provider, it.aliasNorm, it.nameRaw, competitionCode, ts, ts],
    });
  }
  return out;
}
