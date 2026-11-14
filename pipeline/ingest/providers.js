// Adapters from provider clients to the shape the orchestrator expects:
//   { id, role, supports(competition), fetchCompetition({ competition, season }) -> { matches, rejects, meta, standings? } }
import { PROVIDER as FD_ORG } from '../providers/footballDataOrg.js';
import { PROVIDER as FD_CSV } from '../providers/footballDataCsv.js';

/** football-data.org: primary source for fixtures, results and standings of the current season. */
export function footballDataOrgSource(client, { includeStandings = true } = {}) {
  return {
    id: FD_ORG,
    role: 'primary',
    supports: (c) => Boolean(c.fdOrgCode),
    async fetchCompetition({ competition, season }) {
      const r = await client.listMatches({ competitionCode: competition.fdOrgCode, season });
      const out = {
        matches: r.matches.map((m) => ({ ...m, competitionCode: competition.code })),
        rejects: r.rejects, warnings: r.warnings, meta: r.meta,
      };
      if (includeStandings) {
        const s = await client.listStandings({ competitionCode: competition.fdOrgCode, season });
        out.standings = s.standings;
      }
      return out;
    },
  };
}

/** football-data.co.uk CSV: historical results and shots. Competitions without a CSV division are skipped. */
export function footballDataCsvSource(client) {
  return {
    id: FD_CSV,
    role: 'historical',
    supports: (c) => Boolean(c.csvDiv),
    async fetchCompetition({ competition, season }) {
      return client.fetchSeason({ div: competition.csvDiv, season, competitionCode: competition.code });
    },
  };
}
