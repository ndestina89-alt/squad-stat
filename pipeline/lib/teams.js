/** Lowercase, strip accents and punctuation, collapse whitespace. Deliberately keeps tokens like "fc": aliases are explicit. */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Resolves provider team references to canonical team ids using ONLY explicit mappings.
 * A provider ID mapping wins; otherwise the normalised name is looked up in the alias table.
 * Anything else is reported as unmapped; nothing is guessed.
 */
export function createTeamResolver({ providerIds = [], aliases = [] } = {}) {
  const byId = new Map();
  const byAlias = new Map();
  const put = (map, key, teamId, label) => {
    if (map.has(key) && map.get(key) !== teamId) {
      throw new Error(`Conflicting team mapping for ${label}: ${map.get(key)} vs ${teamId}`);
    }
    map.set(key, teamId);
  };
  for (const r of providerIds) put(byId, `${r.provider}|${r.providerTeamId}`, r.teamId, `${r.provider} id ${r.providerTeamId}`);
  for (const r of aliases) put(byAlias, `${r.provider}|${r.aliasNorm}`, r.teamId, `${r.provider} alias "${r.aliasNorm}"`);

  return {
    resolve(provider, { id = null, name = '' } = {}) {
      if (id != null && byId.has(`${provider}|${id}`)) return { ok: true, teamId: byId.get(`${provider}|${id}`), via: 'provider_id' };
      const aliasNorm = normalizeName(name);
      if (aliasNorm && byAlias.has(`${provider}|${aliasNorm}`)) return { ok: true, teamId: byAlias.get(`${provider}|${aliasNorm}`), via: 'alias' };
      return { ok: false, reason: 'unmapped', provider, providerTeamId: id, aliasNorm, nameRaw: name };
    },
  };
}

/** Suggestions for a human to review when adding an alias. Never applied automatically. */
export function suggestTeams(name, teams, limit = 3) {
  const target = new Set(normalizeName(name).split(' ').filter(Boolean));
  if (target.size === 0) return [];
  return teams
    .map((t) => {
      const tokens = new Set(normalizeName(t.name).split(' ').filter(Boolean));
      // A target token matches exactly, or as a prefix of a candidate token ("man" ~ "manchester", min 3 letters).
      const inter = [...target].filter((x) => tokens.has(x) || (x.length >= 3 && [...tokens].some((c) => c.startsWith(x)))).length;
      const denom = target.size + tokens.size - inter;
      return { teamId: t.id, name: t.name, score: denom === 0 ? 0 : inter / denom };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
