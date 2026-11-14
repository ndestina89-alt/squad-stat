#!/usr/bin/env node
// Walk-forward tuning + holdout evaluation for one competition. Windows must be given explicitly.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createD1Client } from '../lib/d1.js';
import { loadCompetitions } from '../config.js';
import { runBacktestJob } from '../model/backtestJob.js';
import { parseBacktestArgs } from './modelArgs.js';

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

async function main() {
  const args = parseBacktestArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(new URL('../../config/model.json', import.meta.url), 'utf8'));
  const db = createD1Client({ accountId: need('CLOUDFLARE_ACCOUNT_ID'), databaseId: need('D1_DATABASE_ID'), apiToken: need('CLOUDFLARE_API_TOKEN') });
  if (!loadCompetitions().some((c) => c.code === args.competition && c.enabled)) throw new Error(`unknown or disabled competition: ${args.competition}`);
  const row = (await db.all('SELECT id FROM competitions WHERE code = ?', [args.competition]))[0];
  if (!row) throw new Error(`competition ${args.competition} is not in the database`);
  const r = await runBacktestJob({
    db, competition: { id: row.id, code: args.competition }, grid: cfg.tuningGrid, tune: args.tune, holdout: args.holdout, stepDays: args.stepDays,
    minTrainMatches: cfg.minTrainMatches, owner: `${process.env.GITHUB_RUN_ID ?? 'local'}-${randomUUID().slice(0, 8)}`, codeCommit: process.env.GITHUB_SHA ?? null,
  });
  if (r.status === 'ok') {
    const h = r.holdout;
    console.log(JSON.stringify({ best: r.best, boundaryHit: r.boundaryHit, holdout: { n: h.model.n, logLoss: h.model.logLoss1x2, brier: h.model.brier1x2, baselineLogLoss: h.baseline.logLoss1x2, diffVsBaseline: h.logLossVsBaseline.mean, diffSe: h.logLossVsBaseline.se } }, null, 2));
    if (r.boundaryHit.length) console.warn(`WARNING: best value is on the grid edge for ${r.boundaryHit.join(', ')}; widen the grid in config/model.json.`);
    return 0;
  }
  console.error(JSON.stringify(r));
  return r.status === 'locked' ? 0 : 1;
}
main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 2; });
