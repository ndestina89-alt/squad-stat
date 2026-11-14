// Argument parsing for the ingest CLI. Pure, so it can be tested without network or database.
export const USAGE = `Usage:
  node pipeline/bin/ingest.js fd   [--season YYYY] [--competitions PL,PD] [--no-standings]
  node pipeline/bin/ingest.js csv  --from YYYY [--to YYYY] [--competitions PL,PD]
  node pipeline/bin/ingest.js unmapped
  node pipeline/bin/ingest.js teams [--search TEXT]
  node pipeline/bin/ingest.js alias --name "Man United" --team-id 12 [--provider football-data.co.uk]
Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID, FOOTBALL_DATA_ORG_TOKEN (fd only)`;

const year = (v, name) => {
  if (!/^\d{4}$/.test(String(v ?? ''))) throw new RangeError(`--${name} must be a 4-digit year`);
  const n = Number(v);
  if (n < 1990 || n > 2100) throw new RangeError(`--${name} out of range`);
  return n;
};

export function parseArgs(argv, { currentSeason }) {
  const [command, ...rest] = argv;
  if (!['fd', 'csv', 'unmapped', 'teams', 'alias'].includes(command)) throw new RangeError(`unknown command: ${command ?? '(none)'}`);
  const out = { command, competitions: null, standings: true, season: currentSeason, from: null, to: null, search: null, name: null, teamId: null, provider: 'football-data.co.uk' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { if (i + 1 >= rest.length) throw new RangeError(`${a} needs a value`); return rest[++i]; };
    if (a === '--season') out.season = year(val(), 'season');
    else if (a === '--from') out.from = year(val(), 'from');
    else if (a === '--to') out.to = year(val(), 'to');
    else if (a === '--competitions') {
      out.competitions = val().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (out.competitions.length === 0) throw new RangeError('--competitions is empty');
    } else if (a === '--no-standings') out.standings = false;
    else if (a === '--search') out.search = val().trim();
    else if (a === '--name') out.name = val().trim();
    else if (a === '--provider') out.provider = val().trim();
    else if (a === '--team-id') { const v = val(); if (!/^\d{1,9}$/.test(v)) throw new RangeError('--team-id must be a positive integer'); out.teamId = Number(v); }
    else throw new RangeError(`unknown option: ${a}`);
  }
  if (command === 'alias') {
    if (!out.name) throw new RangeError('alias needs --name');
    if (out.teamId == null) throw new RangeError('alias needs --team-id');
  }
  if (command === 'csv') {
    if (out.from == null) throw new RangeError('csv needs --from');
    out.to ??= currentSeason;
    if (out.to < out.from) throw new RangeError('--to is before --from');
    if (out.to - out.from > 15) throw new RangeError('refusing more than 16 seasons in one run');
  }
  return out;
}

export const seasonRange = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
