// End-to-end: real Chromium -> real static files (strict CSP) -> real Worker code -> SQLite with migrations applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { createTestDb, d1Adapter } from './helpers/db.js';
import { sqliteDb } from './helpers/sqliteDb.js';
import { seedLeague } from './helpers/league.js';
import { startServer } from './helpers/webServer.js';
import { runModelJob, loadMatches } from '../pipeline/model/run.js';
import { persistBacktest } from '../pipeline/model/persist.js';
import { walkForward, summarize } from '../engine/backtest.js';

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* optional */ }
const SHOTS = process.env.SHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = new Date('2026-01-10T08:00:00Z');
const SERVER_NOW = NOW.getTime() + 3600000;

async function world({ evil = false, backtest = false } = {}) {
  const raw = createTestDb();
  const fixtures = [{ date: '2026-01-12', home: 1, away: 2 }, { date: '2026-01-14', home: 3, away: 4 }, { date: '2026-02-20', home: 5, away: 6 }];
  seedLeague(raw, { fixtures });
  if (evil) raw.prepare("UPDATE teams SET name = '<img src=x onerror=\"window.__xss=1\">Evil\" FC' WHERE id = 1").run();
  const db = sqliteDb(raw);
  await runModelJob({ db, competitions: [{ code: 'PL' }], owner: 'o', now: () => NOW });
  raw.prepare("UPDATE source_status SET last_success_at = '2026-01-10T07:30:00Z', last_attempt_at = '2026-01-10T07:30:00Z'").run();
  if (backtest) {
    const ms = await loadMatches(db, 1);
    const run = walkForward(ms, { from: '2025-09-15T00:00:00Z', to: '2025-11-15T00:00:00Z', halfLifeDays: 365, ridge: 0.5, minTrainMatches: 20 });
    await persistBacktest(db, { summary: summarize(run), records: run.records, modelVersion: 'dc-td-1', scope: 'PL', startedAt: NOW, finishedAt: NOW,
      extraConfig: { selection: { tune: { from: '2025-08-20T00:00:00Z', to: '2025-09-15T00:00:00Z' }, best: { halfLifeDays: 365, ridge: 0.5 }, boundaryHit: [], grid: [{ halfLifeDays: 365, ridge: 0.5, logLoss: 1.01, n: 80 }] } } });
  }
  return { raw, env: { DB: d1Adapter(raw), STALE_AFTER_HOURS: '6' }, fixtures };
}

async function withPage(opts, fn, { viewport = { width: 1280, height: 900 }, serverOpts = {} } = {}) {
  const w = await world(opts);
  const srv = await startServer({ env: w.env, nowMs: SERVER_NOW, ...serverOpts });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, timezoneId: 'Asia/Jakarta', locale: 'id-ID', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try { await fn({ page, origin: srv.origin, problems, ...w }); } finally { await browser.close(); await srv.close(); }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const opts = { skip: chromium ? false : 'playwright not installed' };

test('home: grid, freshness strip, competition filter; no console errors or CSP violations', opts, async () => {
  await withPage({}, async ({ page, origin, problems }) => {
    await page.goto(origin);
    await page.waitForSelector('.fx');
    assert.equal(await page.locator('.fx').count(), 3);
    assert.match(await page.locator('#strip').innerText(), /Sumber data segar/);
    assert.match(await page.locator('#strip').innerText(), /Model: dijalankan/);
    const opts2 = await page.locator('#f-comp option').allInnerTexts();
    assert.ok(opts2.includes('Premier League') && !opts2.includes('UEFA Europa League'));
    const first = page.locator('.fx').first();
    assert.match(await first.innerText(), /Synthetic FC 1/);
    assert.match(await first.innerText(), /\d+,\d%/, 'Indonesian decimal comma');
    assert.match(await first.innerText(), /Gol diharapkan model/);
    const far = page.locator('.fx', { hasText: 'Synthetic FC 5' });
    assert.match(await far.innerText(), /Belum ada prediksi/, 'a match outside the horizon is not given an invented prediction');
    await shot(page, 'home');
    assert.deepEqual(problems, []);
  });
});

test('modal: probabilities, fair odds = 1/p, score matrix, provenance, Escape closes', opts, async () => {
  await withPage({}, async ({ page, origin, fixtures, problems }) => {
    await page.goto(origin);
    await page.waitForSelector('.fx');
    await page.locator('.fx-btn').first().click();
    await page.waitForSelector('dialog[open] .matrix');
    const dlg = page.locator('dialog');
    assert.match(page.url(), new RegExp(`#/match/${fixtures[0].id}`));
    const api = await (await fetch(`${origin}/api/matches/${fixtures[0].id}`)).json();
    const p = api.data.prediction.probabilities;
    const oddsRow = await dlg.locator('.odds-table tbody tr').first().innerText();
    const expected = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1 / p.home);
    assert.ok(oddsRow.includes(expected), `${oddsRow} should contain fair odds ${expected}`);
    assert.equal(await dlg.locator('.odds-table tbody tr').count(), 7);
    assert.ok(await dlg.locator('.matrix tbody tr').count() >= 5);
    assert.match(await dlg.innerText(), /bukan harga pasar/);
    assert.match(await dlg.innerText(), /bukan xG/);
    assert.match(await dlg.innerText(), /Massa probabilitas di luar matriks/);
    assert.match(await dlg.innerText(), /dc-td-1:hl365:r1/);
    assert.ok(await dlg.locator('.matrix td.top').count() >= 1);
    await shot(page, 'modal');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    assert.ok(!/match\//.test(page.url()));
    assert.equal(await page.locator('.fx').count(), 3, 'list is intact behind the modal');
    assert.deepEqual(problems, []);
  });
});

test('matrix cells in the page add up to what the API reports (no hidden renormalisation)', opts, async () => {
  await withPage({}, async ({ page, origin, fixtures }) => {
    await page.goto(`${origin}/#/match/${fixtures[0].id}`);
    await page.waitForSelector('dialog[open] .matrix');
    const cells = await page.locator('.matrix tbody td').allInnerTexts();
    const total = cells.reduce((s, t) => s + Number(t.replace(',', '.')), 0);
    const api = await (await fetch(`${origin}/api/matches/${fixtures[0].id}`)).json();
    const expected = (1 - api.data.score_matrix.tail_mass) * 100;
    assert.ok(Math.abs(total - expected) < 0.5, `displayed ${total} vs ${expected}`);
  });
});

test('deep link opens the modal directly; an unknown match shows a clear message', opts, async () => {
  await withPage({}, async ({ page, origin, fixtures }) => {
    await page.goto(`${origin}/#/match/${fixtures[1].id}`);
    await page.waitForSelector('dialog[open] h2');
    assert.match(await page.locator('dialog h2').innerText(), /Synthetic FC 3/);
    await page.goto(`${origin}/#/match/987654`);
    await page.reload();
    await page.waitForSelector('dialog[open] .err');
    assert.match(await page.locator('dialog').innerText(), /tidak ditemukan/i);
  });
});

test('filters: status tab, date range, competition', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(origin);
    await page.waitForSelector('.fx');
    await page.locator('.seg label', { hasText: 'Hasil' }).click();
    await page.waitForSelector('.score');
    assert.ok(await page.locator('.fx').count() > 0);
    assert.ok((await page.locator('.fx').first().innerText()).match(/\d\s*:\s*\d/));
    await page.fill('#f-from', '2025-08-01');
    await page.fill('#f-to', '2025-08-02');
    await page.waitForFunction(() => { const n = document.querySelectorAll('.fx').length; return n > 0 && n < 30; });
    assert.ok(await page.locator('.day').count() <= 3, 'London dates 08-01..08-02 can span three local days in Jakarta');
    const dates = await page.locator('.fx-btn').evaluateAll((els) => els.length);
    assert.ok(dates >= 6 && dates <= 12);
    await page.selectOption('#f-comp', 'PL');
    assert.match(page.url(), /c=PL/);
    await page.locator('.seg label', { hasText: 'Mendatang' }).click();
    await page.fill('#f-from', '');
    await page.fill('#f-to', '');
    await page.waitForSelector('.fx');
    assert.equal(await page.locator('.fx').count(), 3);
    await page.fill('#f-from', '2026-03-01');
    await page.waitForSelector('.empty');
    assert.match(await page.locator('.empty').innerText(), /Tidak ada pertandingan/);
  });
});

test('load more paginates finished matches without duplicates', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(`${origin}/#/?s=finished`);
    await page.waitForSelector('.fx');
    assert.equal(await page.locator('.fx').count(), 30);
    await page.locator('[data-more]').click();
    await page.waitForFunction(() => document.querySelectorAll('.fx').length === 60);
    const ids = await page.locator('.fx-btn').evaluateAll((els) => els.map((e) => e.dataset.match));
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('ratings page: needs a competition, then shows the fitted table with its data_as_of', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(`${origin}/#/ratings`);
    await page.waitForSelector('.empty');
    assert.match(await page.locator('.empty').innerText(), /Pilih kompetisi/);
    await page.selectOption('#f-comp', 'PL');
    await page.waitForSelector('table.rt');
    assert.equal(await page.locator('table.rt tbody tr').count(), 6);
    assert.match(await page.locator('#view').innerText(), /Data hingga/);
    assert.equal(await page.locator('#nav a[aria-current="page"]').innerText(), 'Rating tim');
    await shot(page, 'ratings');
  });
});

test('evaluation page: honest empty state, then metrics, baseline verdict and calibration plots', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(`${origin}/#/evaluation?c=PL`);
    await page.waitForSelector('.empty');
    assert.match(await page.locator('.empty').innerText(), /Belum ada backtest/);
    assert.match(await page.locator('.empty').innerText(), /Tidak ada angka akurasi/);
  });
  await withPage({ backtest: true }, async ({ page, origin, problems }) => {
    await page.goto(`${origin}/#/evaluation?c=PL`);
    await page.waitForSelector('.verdict');
    const text = await page.locator('#view').innerText();
    assert.match(text, /Log-loss 1X2/);
    assert.match(text, /Baseline/);
    assert.match(text, /holdout/i);
    assert.equal(await page.locator('svg.cal').count(), 5);
    assert.ok(await page.locator('svg.cal circle').count() > 0);
    await shot(page, 'evaluation');
    assert.deepEqual(problems, []);
  });
});

test('staleness is shown, not hidden: old model run and stale providers', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(origin);
    await page.waitForSelector('.strip.bad');
    const t = await page.locator('#strip').innerText();
    assert.match(t, /usang/i);
    assert.match(t, /prediksi mungkin usang/);
  }, { serverOpts: { nowMs: NOW.getTime() + 3 * 86400000 } });
});

test('API failure shows an actionable error and Retry recovers', opts, async () => {
  let fail = true;
  await withPage({}, async ({ page, origin }) => {
    await page.goto(origin);
    await page.waitForSelector('.err');
    assert.match(await page.locator('.err').innerText(), /tidak dapat dimuat/);
    fail = false;
    await page.locator('[data-retry]').click();
    await page.waitForSelector('.fx');
  }, { serverOpts: { apiOverride: (url) => (fail && url.pathname === '/api/matches' ? new Response('{"error":"database_unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } }) : null) } });
});

test('unconfigured API_BASE says so instead of showing empty data', opts, async () => {
  await withPage({}, async ({ page, origin }) => {
    await page.goto(origin);
    await page.waitForSelector('.err');
    assert.match(await page.locator('.err').innerText(), /API_BASE/);
    assert.equal(await page.locator('.fx').count(), 0);
  }, { serverOpts: { configBase: null } });
});

test('XSS: hostile team names are rendered as text everywhere', opts, async () => {
  await withPage({ evil: true }, async ({ page, origin, fixtures, problems }) => {
    await page.goto(origin);
    await page.waitForSelector('.fx');
    assert.match(await page.locator('.fx').first().innerText(), /<img src=x/);
    await page.locator('.fx-btn').first().click();
    await page.waitForSelector('dialog[open] .matrix');
    assert.match(await page.locator('dialog h2').innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => window.__xss ?? null), null);
    assert.equal(await page.locator('#view img, dialog img').count(), 0);
    void fixtures; void problems;
  });
});

test('mobile layout has no horizontal overflow on list, modal and evaluation', opts, async () => {
  await withPage({ backtest: true }, async ({ page, origin, fixtures }) => {
    for (const hash of ['#/', `#/match/${fixtures[0].id}`, '#/evaluation?c=PL', '#/ratings?c=PL']) {
      await page.goto(`${origin}/${hash}`);
      await page.reload();
      await page.waitForSelector(hash.includes('match') ? 'dialog[open] .matrix' : '#view *:not(.loading)');
      await page.waitForTimeout(150);
      const over = await page.evaluate(() => {
        const d = document.querySelector('dialog[open]');
        return { page: document.documentElement.scrollWidth - window.innerWidth, dlg: d ? d.scrollWidth - d.clientWidth : 0 };
      });
      assert.ok(over.page <= 1, `${hash} page overflow ${over.page}`);
      assert.ok(over.dlg <= 1, `${hash} dialog overflow ${over.dlg}`);
      if (hash.includes('match')) await shot(page, 'modal-mobile');
      if (hash === '#/') await shot(page, 'home-mobile');
    }
  }, { viewport: { width: 390, height: 800 } });
});
