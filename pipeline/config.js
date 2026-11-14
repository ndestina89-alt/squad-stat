import { readFileSync } from 'node:fs';

/** Load and validate config/competitions.json. Fails loudly on duplicates so bad config cannot reach production. */
export function loadCompetitions(path = new URL('../config/competitions.json', import.meta.url)) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list)) throw new Error('competitions.json must be an array');
  const seen = { code: new Set(), fdOrgCode: new Set(), csvDiv: new Set() };
  for (const c of list) {
    if (!/^[A-Z0-9]{2,5}$/.test(c.code) || typeof c.name !== 'string' || typeof c.enabled !== 'boolean') {
      throw new Error(`Invalid competition entry: ${JSON.stringify(c)}`);
    }
    for (const k of ['code', 'fdOrgCode', 'csvDiv']) {
      if (c[k] == null) continue;
      if (seen[k].has(c[k])) throw new Error(`Duplicate ${k}: ${c[k]}`);
      seen[k].add(c[k]);
    }
  }
  return list;
}

export const enabledCompetitions = (list) => list.filter((c) => c.enabled);
