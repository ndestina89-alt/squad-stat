#!/usr/bin/env node
// Ingestion entry point (GitHub Actions or a one-off local run). Secrets come from the environment only.
import { randomUUID } from 'node:crypto';
import { createD1Client } from '../lib/d1.js';
import { seasonOfDate } from '../lib/dates.js';
import { loadCompetitions, enabledCompetitions } from '../config.js';
import { createFootballDataOrg } from '../providers/footballDataOrg.js';
import { createFootballDataCsv } from '../providers/footballDataCsv.js';
import { footballDataOrgSource, footballDataCsvSource } from '../ingest/providers.js';
import { runBackfill, runProviderIngest } from '../ingest/run.js';
import { addAlias } from '../ingest/teams.js';
import { parseArgs, seasonRange, USAGE } from './args.js';

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const log = { info: (m) => console.log(m), warn: (m) => console.warn(m) };

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const args = parseArgs(process.argv.slice(2), { currentSeason: seasonOfDate(today) });
  const db = createD1Client({ accountId: need('CLOUDFLARE_ACCOUNT_ID'), databaseId: need('D1_DATABASE_ID'), apiToken: need('CLOUDFLARE_API_TOKEN') });

  if (args.command === 'unmapped') {
    const rows = await db.all('SELECT provider_id, name_raw, competition_code, times_seen, last_seen_at FROM unmapped_team_names ORDER BY times_seen DESC LIMIT 100');
    console.table(rows);
    return 0;
  }

  if (args.command === 'teams') {
    const like = `%${(args.search ?? '').replace(/[%_]/g, '')}%`;
    console.table(await db.all('SELECT id, name FROM teams WHERE name LIKE ? ORDER BY name LIMIT 100', [like]));
    return 0;
  }
  if (args.command === 'alias') {
    const team = (await db.all('SELECT id, name FROM teams WHERE id = ?', [args.teamId]))[0];
    if (!team) throw new Error(`no team with id ${args.teamId} (use the teams command to find it)`);
    const prov = (await db.all('SELECT id FROM providers WHERE id = ?', [args.provider]))[0];
    if (!prov) throw new Error(`unknown provider ${args.provider}`);
    const norm = await addAlias(db, { provider: args.provider, nameRaw: args.name, teamId: team.id });
    console.log(`mapped "${args.name}" (${norm}) -> #${team.id} ${team.name} for ${args.provider}`);
    return 0;
  }

  let competitions = enabledCompetitions(loadCompetitions());
  if (args.competitions) {
    const known = new Set(competitions.map((c) => c.code));
    const bad = args.competitions.filter((c) => !known.has(c));
    if (bad.length) throw new Error(`unknown or disabled competitions: ${bad.join(', ')}`);
    competitions = competitions.filter((c) => args.competitions.includes(c.code));
  }
  const owner = `${process.env.GITHUB_RUN_ID ?? 'local'}-${randomUUID().slice(0, 8)}`;
  const common = { db, competitions, owner, logger: log };

  let runs;
  if (args.command === 'fd') {
    const provider = footballDataOrgSource(createFootballDataOrg({ token: need('FOOTBALL_DATA_ORG_TOKEN') }), { includeStandings: args.standings });
    runs = [await runProviderIngest({ ...common, provider, season: args.season })];
  } else {
    runs = await runBackfill({ ...common, provider: footballDataCsvSource(createFootballDataCsv()), seasons: seasonRange(args.from, args.to) });
  }
  for (const r of runs) console.log(JSON.stringify({ season: r.season, attempted: r.attempted, succeeded: r.succeeded, failed: r.failed, results: r.results.map((x) => ({ c: x.competition, s: x.status, e: x.error })) }));
  // Non-zero only if every attempted competition failed, so one broken league does not turn the whole workflow red.
  return runs.every((r) => r.attempted > 0 && r.failed === r.attempted) ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`${e.message}\n\n${USAGE}`); process.exitCode = 2; });
