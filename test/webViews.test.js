// Unit tests for the frontend's pure modules (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, fairOdds, pct, num, relativeAge, matchDay, fmtTime, fmtDateTime } from '../web/js/format.js';
import { collapseMatrix, scoreMatrixTable, matchTile, matchGrid, matchModal, freshnessStrip, evaluationPanel, calibrationSvg, ratingsTable, errorPanel, probBar } from '../web/js/views.js';
import { createApi, ApiError } from '../web/js/api.js';
import { parseHash } from '../web/js/app.js';
import { buildScoreMatrix } from '../engine/scoreMatrix.js';

const NOW = Date.parse('2026-01-10T09:00:00Z');
const prediction = (over = {}) => ({
  model_version: 'dc-td-1:hl365:r1', predicted_at: '2026-01-10T08:00:00Z', data_as_of: '2026-01-09T20:00:00Z',
  probabilities: { home: 0.5, draw: 0.25, away: 0.25, over_2_5: 0.55, btts_yes: 0.5 },
  goal_expectation: { kind: 'model_goal_expectation', home: 1.6, away: 1.1 }, tail_mass: 1e-9, matrix_max_goals: 12,
  top_scores: [{ home: 1, away: 0, p: 0.12 }], uncertainty: { flags: [], note: 'n' }, feature_hash: 'a'.repeat(64), ...over,
});
const match = (over = {}) => ({ id: 7, competition: 'PL', season: 2025, matchday: 3, match_date: '2026-01-12', kickoff_utc: '2026-01-12T15:00:00Z', status: 'scheduled',
  home: { id: 1, name: 'A FC' }, away: { id: 2, name: 'B FC' }, score: null, prediction: prediction(), ...over });

test('esc escapes all HTML-significant characters', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(5), '5');
});
test('number formatting uses Indonesian separators and never invents values', () => {
  assert.equal(pct(0.4521), '45,2%');
  assert.equal(pct(null), '–');
  assert.equal(pct(NaN), '–');
  assert.equal(num(1.234, 2), '1,23');
  assert.equal(fairOdds(0.5), '2,00');
  assert.equal(fairOdds(0.25), '4,00');
  assert.equal(fairOdds(0), '–');
  assert.equal(fairOdds(1.2), '–');
  assert.equal(fairOdds(null), '–');
  assert.equal(fairOdds(0.0005), '>1.000');
});
test('fair odds are the exact reciprocal of the probability', () => {
  for (const p of [0.07, 0.33, 0.61, 0.93]) assert.equal(fairOdds(p), new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1 / p));
});
test('relative age wording and bad input', () => {
  assert.equal(relativeAge('2026-01-10T08:59:40Z', NOW), 'baru saja');
  assert.equal(relativeAge('2026-01-10T08:30:00Z', NOW), '30 menit lalu');
  assert.equal(relativeAge('2026-01-10T03:00:00Z', NOW), '6 jam lalu');
  assert.equal(relativeAge('2026-01-05T09:00:00Z', NOW), '5 hari lalu');
  assert.equal(relativeAge(null, NOW), 'belum pernah');
  assert.equal(relativeAge('2026-01-10T10:00:00Z', NOW), 'baru saja', 'future timestamps do not produce negative ages');
});
test('times use a colon and the viewer timezone; unknown kickoff falls back to the stored date', () => {
  assert.equal(fmtTime('2026-01-12T15:00:00Z', 'Asia/Jakarta'), '22:00');
  assert.match(fmtDateTime('2026-01-12T15:00:00Z', 'Asia/Jakarta'), /12 Jan.*22:00/);
  assert.equal(matchDay({ kickoff_utc: '2026-01-12T20:00:00Z', match_date: '2026-01-12' }, 'Asia/Jakarta'), '2026-01-13');
  assert.equal(matchDay({ kickoff_utc: null, match_date: '2026-01-12' }, 'Asia/Jakarta'), '2026-01-12');
});

test('collapseMatrix preserves the total mass and adds a 7+ bucket only when needed', () => {
  const m = buildScoreMatrix({ lambda: 1.8, nu: 1.3, rho: -0.05, maxGoals: 12 });
  const total = (c) => c.flat().reduce((a, b) => a + b, 0);
  const c = collapseMatrix(m.matrix);
  assert.equal(c.cells.length, 8);
  assert.equal(c.labels[7], '7+');
  assert.ok(Math.abs(total(c.cells) - total(m.matrix)) < 1e-12);
  const small = buildScoreMatrix({ lambda: 1.8, nu: 1.3, rho: 0, maxGoals: 5 });
  assert.equal(collapseMatrix(small.matrix).cells.length, 6);
});
test('score matrix table: highlights three most likely scores, reports tail, handles missing matrix', () => {
  const m = buildScoreMatrix({ lambda: 1.5, nu: 1.2, rho: -0.05, maxGoals: 10 });
  const html = scoreMatrixTable({ cells: m.matrix, tail_mass: m.tailMass }, { homeName: 'A', awayName: 'B' });
  assert.equal((html.match(/class="m\d+ top"/g) ?? []).length, 3);
  assert.match(html, /tidak dinormalisasi ulang/);
  assert.match(scoreMatrixTable(null, { homeName: 'A', awayName: 'B' }), /tidak tersedia/);
});
test('probability bar segments are proportional and labelled', () => {
  const html = probBar({ home: 0.5, draw: 0.25, away: 0.25 });
  assert.match(html, /class="seg-h" x="0" y="0" width="50\.000"/);
  assert.match(html, /class="seg-a" x="75\.000"/);
  assert.match(html, /aria-label="Peluang: tuan rumah 50,0%/);
});

test('every view escapes hostile names, and emits no inline handlers or styles', () => {
  const evil = '<img src=x onerror=alert(1)>"';
  const m = match({ home: { id: 1, name: evil }, away: { id: 2, name: evil } });
  const outputs = [
    matchTile(m, { tz: 'UTC' }), matchGrid([m], { tz: 'UTC', hasMore: true }),
    matchModal({ data: { ...m, team_ratings: { home: null, away: null }, score_matrix: null } }, { tz: 'UTC', nowMs: NOW }),
    ratingsTable({ data: [{ team: evil, elo: 1500, attack: 1, defense: 1, matches_used: 3 }], meta: { fit: { data_as_of: '2026-01-09T00:00:00Z', n_matches: 9, model_version: evil } } }, { nowMs: NOW, tz: 'UTC' }),
    freshnessStrip({ health: { status: 'ok', providers: [{ provider: evil, stale: false, last_success_at: '2026-01-10T08:00:00Z' }] }, meta: null, nowMs: NOW }),
  ];
  for (const html of outputs) {
    assert.ok(!html.includes('<img'), 'raw tag leaked');
    // Strip quoted attribute values and text nodes (where escaped hostile text may legitimately contain "onerror="); no handler may remain in real markup.
    const markup = html.replace(/"[^"]*"/g, '""').replace(/>[^<]*</g, '><');
    assert.ok(!/\son\w+\s*=/i.test(markup), 'inline handler');
    assert.ok(!/\sstyle=/i.test(html), 'inline style (blocked by CSP)');
  }
});

test('match modal without a prediction states so and shows no numbers', () => {
  const html = matchModal({ data: match({ prediction: null }) }, { tz: 'UTC', nowMs: NOW });
  assert.match(html, /Belum ada prediksi/);
  assert.ok(!/Odds wajar/.test(html));
});
test('match modal shows low-data flags and the goal-expectation label', () => {
  const html = matchModal({ data: { ...match({ prediction: prediction({ uncertainty: { flags: ['low_data', 'away_team_unknown'], note: 'x' } }) }), team_ratings: null, score_matrix: null } }, { tz: 'UTC', nowMs: NOW });
  assert.match(html, /Data tim sedikit/);
  assert.match(html, /Tim tamu belum punya data/);
  assert.match(html, /model_goal_expectation/);
  assert.match(html, /bukan xG/);
});
test('finished match shows the regular-time score', () => {
  assert.match(matchTile(match({ status: 'finished', score: { home: 2, away: 1, basis: 'regular_time' }, prediction: null }), { tz: 'UTC' }), /2<i>:<\/i>1/);
});
test('empty grid gives direction, not a blank page', () => {
  assert.match(matchGrid([], { tz: 'UTC', hasMore: false }), /Tidak ada pertandingan/);
});

test('freshness strip: ok, stale provider, degraded, error, overdue model; uses the server clock', () => {
  const base = { providers: [{ provider: 'p', stale: false, last_success_at: '2026-01-10T08:30:00Z' }] };
  assert.match(freshnessStrip({ health: { status: 'ok', ...base }, meta: null, nowMs: NOW }), /strip good/);
  assert.match(freshnessStrip({ health: { status: 'stale', providers: [{ provider: 'p', stale: true, last_success_at: null }] }, meta: null, nowMs: NOW }), /strip bad[\s\S]*belum pernah berhasil/);
  assert.match(freshnessStrip({ health: { status: 'degraded', ...base }, meta: null, nowMs: NOW }), /strip warn/);
  assert.match(freshnessStrip({ health: null, healthError: true, meta: null, nowMs: NOW }), /tidak dapat dibaca/);
  assert.match(freshnessStrip({ health: { status: 'ok', ...base }, meta: { model_stale: true, model_last_run_at: null }, nowMs: NOW }), /belum pernah dijalankan, prediksi mungkin usang/);
  const skewed = freshnessStrip({ health: { status: 'ok', now: '2026-01-10T09:00:00Z', providers: [{ provider: 'p', stale: false, last_success_at: '2026-01-10T08:30:00Z' }] }, meta: null, nowMs: NOW + 400 * 86400000 });
  assert.match(skewed, /30 menit lalu/, 'a wrong device clock cannot change displayed ages');
});

const evalBody = (v, extra = {}) => ({ data: {
  run_id: 1, model_version: 'm', finished_at: '2026-01-10T08:00:00Z', n_matches: 100, window: { from: '2025-09-01T00:00:00Z', to: '2025-12-01T00:00:00Z' },
  metrics: { brier_1x2: 0.6, log_loss_1x2: 1.0, accuracy_1x2: 0.5, brier_over_2_5: 0.25, brier_btts: 0.25 }, baseline: { logLoss1x2: 1.05, brier1x2: 0.63 },
  log_loss_vs_baseline: v, config: { half_life_days: 365, ridge: 1 }, selection: { tune: { from: '2025-01-01T00:00:00Z', to: '2025-08-01T00:00:00Z' }, best: { halfLifeDays: 365, ridge: 1 }, boundaryHit: [], grid: [] },
  calibration: {}, ...extra }, meta: {} });
test('evaluation verdict is conservative and follows the standard errors', () => {
  const t = (v, extra) => evaluationPanel(evalBody(v, extra), { tz: 'UTC', nowMs: NOW });
  assert.match(t({ mean: -0.1, se: 0.02, n: 100 }), /verdict good[\s\S]*lebih baik dari baseline/);
  assert.match(t({ mean: -0.03, se: 0.03, n: 100 }), /verdict warn[\s\S]*Belum bisa dibedakan/);
  assert.match(t({ mean: 0.1, se: 0.02, n: 100 }), /verdict bad[\s\S]*lebih buruk/);
  assert.match(t(null), /belum dapat dinilai/);
  assert.match(t({ mean: -0.1, se: 0.02, n: 100 }, { selection: { tune: {}, best: { halfLifeDays: 90, ridge: 1 }, boundaryHit: ['halfLifeDays'], grid: [] } }), /tepi grid/);
  assert.match(evaluationPanel({ data: null, meta: {} }, { tz: 'UTC', nowMs: NOW }), /Belum ada backtest/);
});
test('calibration svg: empty bins are not drawn, small bins are faded, area scales with n', () => {
  const svg = calibrationSvg([
    { lo: 0, hi: 0.1, n: 0, mean_predicted: null, observed_frequency: null },
    { lo: 0.1, hi: 0.2, n: 5, mean_predicted: 0.15, observed_frequency: 0.2 },
    { lo: 0.2, hi: 0.3, n: 50, mean_predicted: 0.25, observed_frequency: 0.24 },
  ], 'Seri');
  assert.equal((svg.match(/<circle/g) ?? []).length, 2);
  assert.match(svg, /dot-low/);
  assert.match(svg, /dot-ok/);
  const r = [...svg.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(r[1] > r[0]);
  assert.equal((calibrationSvg([], 'x').match(/<circle/g) ?? []).length, 0);
});

test('error panel explains each failure kind and offers retry except for config errors', () => {
  assert.match(errorPanel(new ApiError('config', 'x')), /API_BASE/);
  assert.ok(!errorPanel(new ApiError('config', 'x')).includes('data-retry'));
  assert.match(errorPanel(new ApiError('unavailable', 'x')), /data-retry/);
  assert.match(errorPanel(new ApiError('network', 'x')), /tidak dapat dijangkau/);
});

test('parseHash handles routes, queries and match deep links', () => {
  assert.deepEqual([parseHash('').path, parseHash('#/ratings?c=PL').path, parseHash('#/ratings?c=PL').q.get('c')], ['/', '/ratings', 'PL']);
  const m = parseHash('#/match/42?c=PL&s=finished');
  assert.equal(m.matchId, '42');
  assert.equal(m.path, '/');
  assert.equal(m.q.get('s'), 'finished');
  assert.equal(parseHash('#/match/abc').matchId, null);
});

// ---- API client
const res = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
test('api client: unconfigured base is a config error; query building skips empty values', async () => {
  assert.throws(() => createApi({ base: null }), (e) => e instanceof ApiError && e.kind === 'config');
  let seen;
  const api = createApi({ base: 'https://x.test/', fetchImpl: async (u) => { seen = u; return res(200, { data: [] }); } });
  await api.matches({ competition: 'PL', status: '', from: null, limit: 5 });
  assert.equal(seen, 'https://x.test/api/matches?competition=PL&limit=5');
  await api.match('12');
  assert.equal(seen, 'https://x.test/api/matches/12');
});
test('api client maps failures to typed errors', async () => {
  const kind = async (fetchImpl) => { try { await createApi({ base: '', fetchImpl, timeoutMs: 30 }).health(); return 'none'; } catch (e) { return e.kind; } };
  assert.equal(await kind(async () => res(404, { error: 'not_found' })), 'not_found');
  assert.equal(await kind(async () => res(400, { error: 'bad_request', detail: 'x' })), 'bad_request');
  assert.equal(await kind(async () => res(503, { error: 'database_unavailable' })), 'unavailable');
  assert.equal(await kind(async () => res(500, 'oops')), 'http');
  assert.equal(await kind(async () => res(200, 'not json')), 'parse');
  assert.equal(await kind(async () => { throw new TypeError('fetch failed'); }), 'network');
  assert.equal(await kind((_, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))), 'timeout');
});
