#!/usr/bin/env node
// Fit + predict for competitions. Config defaults come from config/model.json; flags override them.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createD1Client } from '../lib/d1.js';
import { loadCompetitions, enabledCompetitions } from '../config.js';
import { runModelJob } from '../model/run.js';
import { parseModelArgs } from './modelArgs.js';

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

async function main() {
  const args = parseModelArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(new URL('../../config/model.json', import.meta.url), 'utf8'));
  const db = createD1Client({ accountId: need('CLOUDFLARE_ACCOUNT_ID'), databaseId: need('D1_DATABASE_ID'), apiToken: need('CLOUDFLARE_API_TOKEN') });
  let competitions = enabledCompetitions(loadCompetitions());
  if (args.competitions) competitions = competitions.filter((c) => args.competitions.includes(c.code));
  const { results } = await runModelJob({
    db, competitions, owner: `${process.env.GITHUB_RUN_ID ?? 'local'}-${randomUUID().slice(0, 8)}`, horizonDays: cfg.predictionHorizonDays,
    config: { halfLifeDays: args.halfLifeDays ?? cfg.halfLifeDays, ridge: args.ridge ?? cfg.ridge, minMatches: cfg.minTrainMatches },
    logger: { warn: (m) => console.warn(m) },
  });
  for (const r of results) console.log(JSON.stringify(r));
  // "insufficient_data" is a normal state for a new league; only outright failures make the workflow red.
  return results.length > 0 && results.every((r) => r.status === 'failed') ? 1 : 0;
}
main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 2; });
