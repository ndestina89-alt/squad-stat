// Static checks of the GitHub Actions workflows: safety properties that are easy to break by editing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../.github/workflows/', import.meta.url);
const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
const skip = py.status === 0 ? false : 'python3 with PyYAML not available';

const load = (file) => {
  const r = spawnSync('python3', ['-c', 'import sys,json,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', new URL(file, DIR).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  if ('true' in doc) { doc.on = doc.true; delete doc.true; } // YAML 1.1 parses `on` as boolean true
  return doc;
};
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const raw = (f) => readFileSync(new URL(f, DIR), 'utf8');
const SECRETS = new Set(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'D1_DATABASE_ID', 'FOOTBALL_DATA_ORG_TOKEN']);

test('expected workflows exist', { skip }, () => {
  assert.deepEqual(files.sort(), ['backfill.yml', 'backtest.yml', 'ci.yml', 'csv-refresh.yml', 'deploy.yml', 'pipeline.yml', 'watchdog.yml']);
});

test('every workflow is least-privilege and every job has a timeout', { skip }, () => {
  for (const f of files) {
    const d = load(f);
    assert.deepEqual(d.permissions, { contents: 'read' }, `${f} permissions`);
    for (const [name, job] of Object.entries(d.jobs)) assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60, `${f}:${name} timeout`);
  }
});

test('no workflow uses pull_request_target and actions are pinned to a major version', { skip }, () => {
  for (const f of files) {
    const text = raw(f);
    assert.ok(!/pull_request_target/.test(text), f);
    for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[\w.-]+\/[\w.-]+@v\d+$/, `${f}: ${m[1]} must be pinned`);
  }
});

test('secrets and user inputs reach scripts only through env, never interpolated into run:', { skip }, () => {
  for (const f of files) {
    const d = load(f);
    for (const [name, job] of Object.entries(d.jobs)) for (const step of job.steps ?? []) {
      if (!step.run) continue;
      assert.ok(!/\$\{\{/.test(step.run), `${f}:${name}: expression inside run: ${step.run.split('\n')[0]}`);
    }
  }
});

test('only documented secrets are referenced and none has a fallback default', { skip }, () => {
  for (const f of files) {
    const text = raw(f);
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) assert.ok(SECRETS.has(m[1]), `${f} references unknown secret ${m[1]}`);
    assert.ok(!/secrets\.\w+.*\|\|/.test(text), 'no defaults for secrets');
  }
});

test('workflows that write to the database share one concurrency group and never cancel a running write', { skip }, () => {
  for (const f of ['pipeline.yml', 'csv-refresh.yml', 'backfill.yml', 'backtest.yml']) {
    const d = load(f);
    assert.equal(d.concurrency.group, 'squad-stat-db', f);
    assert.equal(d.concurrency['cancel-in-progress'], false, f);
  }
});

test('scheduled workflows are opt-in via PIPELINE_ENABLED and use off-peak minutes', { skip }, () => {
  for (const f of ['pipeline.yml', 'csv-refresh.yml', 'watchdog.yml']) {
    const d = load(f);
    assert.ok(d.on.schedule?.length > 0, `${f} has a schedule`);
    for (const s of d.on.schedule) {
      const fields = s.cron.trim().split(/\s+/);
      assert.equal(fields.length, 5, s.cron);
      assert.ok(!['0', '00'].includes(fields[0]) && !/^\*/.test(fields[0]), `${f}: ${s.cron} should not run at the top of the hour`);
    }
    for (const [name, job] of Object.entries(d.jobs)) assert.match(job.if, /vars\.PIPELINE_ENABLED == 'true'/, `${f}:${name}`);
  }
  for (const f of ['backfill.yml', 'backtest.yml', 'deploy.yml']) assert.equal(load(f).on.schedule, undefined, `${f} must stay manual`);
});

test('every script a workflow runs exists, and its flags are ones the CLI accepts', { skip }, () => {
  const ingest = readFileSync(new URL('../pipeline/bin/args.js', import.meta.url), 'utf8');
  const modelArgs = readFileSync(new URL('../pipeline/bin/modelArgs.js', import.meta.url), 'utf8');
  for (const f of files) {
    for (const m of raw(f).matchAll(/node (pipeline\/bin\/[\w.]+\.js)([^\n]*)/g)) {
      assert.ok(existsSync(new URL(`../${m[1]}`, import.meta.url)), `${f}: ${m[1]} missing`);
      for (const flag of m[2].matchAll(/--([a-z-]+)/g)) {
        const known = ingest.includes(`'--${flag[1]}'`) || ingest.includes(`--${flag[1]}`) || modelArgs.includes(`'${flag[1]}'`) || modelArgs.includes(`${flag[1]}:`) || modelArgs.includes(`--${flag[1]}`);
        assert.ok(known, `${f}: unknown flag --${flag[1]}`);
      }
    }
  }
});

test('the pipeline runs ingest before the model, and the model still runs if ingest fails', { skip }, () => {
  const d = load('pipeline.yml');
  assert.equal(d.jobs.model.needs, 'ingest');
  assert.match(d.jobs.model.if, /!cancelled\(\)/);
});

test('deploy refuses placeholders, tests first, and applies migrations before deploying the Worker', { skip }, () => {
  const d = load('deploy.yml');
  const runs = d.jobs.deploy.steps.map((s) => s.run ?? '');
  const idx = (re) => runs.findIndex((r) => re.test(r));
  assert.ok(idx(/npm test/) >= 0 && idx(/npm test/) < idx(/placeholder/));
  assert.ok(idx(/placeholder/) < idx(/migrations apply/));
  assert.ok(idx(/migrations apply/) < idx(/wrangler@4 deploy/));
  assert.ok(idx(/wrangler@4 deploy/) < idx(/pages deploy/));
  assert.match(runs.join('\n'), /00000000-0000-0000-0000-000000000000/);
  assert.match(runs.join('\n'), /API_BASE = null/);
});

test('manual input validation steps exist for every workflow that takes inputs', { skip }, () => {
  for (const f of ['backfill.yml', 'backtest.yml', 'pipeline.yml']) {
    const steps = load(f).jobs;
    const any = Object.values(steps).some((j) => j.steps.some((s) => /Validate/.test(s.name ?? '')));
    assert.ok(any, `${f} validates inputs`);
  }
});

test('placeholders that deploy guards look for are really still in the repository defaults', () => {
  assert.match(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), /00000000-0000-0000-0000-000000000000/);
  assert.match(readFileSync(new URL('../web/config.js', import.meta.url), 'utf8'), /API_BASE = null/);
});
