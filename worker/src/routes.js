// Read-only data endpoints. Only small, indexed SELECTs with bound parameters; no computation beyond reshaping rows.
// Everything the frontend needs to be honest is passed through: model version, data_as_of, predicted_at, tail mass,
// the goal-expectation label and low-data flags.

import { buildScoreMatrix } from '../../engine/scoreMatrix.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const STATUSES = new Set(['scheduled', 'live', 'finished', 'postponed', 'cancelled', 'awarded']);
const MODEL_STALE_DEFAULT_HOURS = 36;

export class BadRequest extends Error {}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const parseJson = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const all = async (env, sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results;
const first = async (env, sql, params = []) => (await all(env, sql, params))[0] ?? null;

function competitionParam(url) {
  const v = url.searchParams.get('competition');
  if (v == null) return null;
  if (!/^[A-Z0-9]{2,5}$/.test(v)) throw new BadRequest('competition must be 2-5 upper-case letters or digits');
  return v;
}
function intParam(url, name, { min, max, def }) {
  const v = url.searchParams.get(name);
  if (v == null) return def;
  if (!/^\d{1,6}$/.test(v)) throw new BadRequest(`${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return n;
}
function dateParam(url, name) {
  const v = url.searchParams.get(name);
  if (v == null) return null;
  if (!isYmd(v)) throw new BadRequest(`${name} must be a valid YYYY-MM-DD date`);
  return v;
}
function rejectUnknownParams(url, allowed) {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new BadRequest(`unknown parameter: ${k}`);
}

const isoNow = (nowMs) => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
const modelStaleMs = (env) => {
  const h = Number(env.MODEL_STALE_AFTER_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : MODEL_STALE_DEFAULT_HOURS) * 3600000;
};

/** When did the model job last succeed (optionally for one competition) and is that too old? */
async function modelFreshness(env, nowMs, code) {
  const row = code
    ? await first(env, "SELECT MAX(finished_at) AS t FROM job_runs WHERE job = 'model' AND scope = ? AND status IN ('success', 'partial')", [code])
    : await first(env, "SELECT MAX(finished_at) AS t FROM job_runs WHERE job = 'model' AND status IN ('success', 'partial')");
  const t = row?.t ?? null;
  return { model_last_run_at: t, model_stale: t == null || nowMs - Date.parse(t) > modelStaleMs(env) };
}

const PREDICTION_COLUMNS = `p.id AS p_id, p.fit_id, p.model_version, p.predicted_at, p.data_as_of AS p_data_as_of, p.goal_expectation_kind,
  p.expected_home_goals, p.expected_away_goals, p.p_home, p.p_draw, p.p_away, p.p_over_2_5, p.p_btts_yes, p.tail_mass, p.matrix_max_goals,
  p.top_scores_json, p.uncertainty_json, p.feature_hash`;

const MATCH_SELECT = `
  SELECT m.id, c.code AS competition, m.season, m.matchday, m.stage, m.match_date, m.kickoff_utc, m.status,
         m.home_team_id, ht.name AS home_name, m.away_team_id, at.name AS away_name, m.home_goals, m.away_goals,
         ${PREDICTION_COLUMNS}
  FROM matches m
  JOIN competitions c ON c.id = m.competition_id
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
  LEFT JOIN predictions p ON p.id = (SELECT id FROM predictions WHERE match_id = m.id ORDER BY predicted_at DESC, id DESC LIMIT 1)`;

function shapePrediction(r, { detail = false } = {}) {
  if (r.p_id == null) return null;
  const base = {
    model_version: r.model_version,
    predicted_at: r.predicted_at,
    data_as_of: r.p_data_as_of,
    probabilities: { home: r.p_home, draw: r.p_draw, away: r.p_away, over_2_5: r.p_over_2_5, btts_yes: r.p_btts_yes },
    goal_expectation: { kind: r.goal_expectation_kind, home: r.expected_home_goals, away: r.expected_away_goals },
    tail_mass: r.tail_mass,
  };
  if (!detail) return base;
  const unc = parseJson(r.uncertainty_json);
  return { ...base, fit_id: r.fit_id, matrix_max_goals: r.matrix_max_goals, top_scores: parseJson(r.top_scores_json), uncertainty: unc, feature_hash: r.feature_hash };
}

function shapeMatch(r, opts) {
  return {
    id: r.id, competition: r.competition, season: r.season, matchday: r.matchday, stage: r.stage,
    match_date: r.match_date, kickoff_utc: r.kickoff_utc, status: r.status,
    home: { id: r.home_team_id, name: r.home_name }, away: { id: r.away_team_id, name: r.away_name },
    score: r.home_goals == null ? null : { home: r.home_goals, away: r.away_goals, basis: 'regular_time' },
    prediction: shapePrediction(r, opts),
  };
}

async function listCompetitions(env, nowMs) {
  const rows = await all(env, `
    SELECT c.code, c.name, c.country,
      (SELECT f.data_as_of FROM model_fits f WHERE f.scope = c.code ORDER BY f.data_as_of DESC, f.id DESC LIMIT 1) AS model_data_as_of,
      (SELECT f.model_version FROM model_fits f WHERE f.scope = c.code ORDER BY f.data_as_of DESC, f.id DESC LIMIT 1) AS model_version,
      (SELECT f.n_matches FROM model_fits f WHERE f.scope = c.code ORDER BY f.data_as_of DESC, f.id DESC LIMIT 1) AS model_n_matches
    FROM competitions c WHERE c.enabled = 1 ORDER BY c.name`);
  const fresh = await modelFreshness(env, nowMs, null);
  return { data: rows, meta: { generated_at: isoNow(nowMs), ...fresh } };
}

async function listMatches(url, env, nowMs) {
  rejectUnknownParams(url, ['competition', 'status', 'from', 'to', 'limit', 'offset']);
  const code = competitionParam(url);
  const status = url.searchParams.get('status');
  if (status != null && !STATUSES.has(status)) throw new BadRequest(`status must be one of ${[...STATUSES].join(', ')}`);
  const from = dateParam(url, 'from'); const to = dateParam(url, 'to');
  if (from && to && to < from) throw new BadRequest('to must not be before from');
  const limit = intParam(url, 'limit', { min: 1, max: MAX_LIMIT, def: DEFAULT_LIMIT });
  const offset = intParam(url, 'offset', { min: 0, max: 100000, def: 0 });

  const where = []; const params = [];
  if (code) { where.push('c.code = ?'); params.push(code); }
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (from) { where.push('m.match_date >= ?'); params.push(from); }
  if (to) { where.push('m.match_date <= ?'); params.push(to); }
  // Past results newest first; everything else soonest first.
  const order = status === 'finished' ? 'm.match_date DESC, m.kickoff_utc DESC, m.id DESC' : 'm.match_date ASC, m.kickoff_utc ASC, m.id ASC';
  const rows = await all(env, `${MATCH_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit + 1, offset]);
  const hasMore = rows.length > limit;
  const fresh = await modelFreshness(env, nowMs, code);
  return {
    data: rows.slice(0, limit).map((r) => shapeMatch(r)),
    meta: { generated_at: isoNow(nowMs), limit, offset, has_more: hasMore, filters: { competition: code, status, from, to }, ...fresh },
  };
}

/**
 * The full matrix is not stored; it is rebuilt from the stored lambda, nu, rho and matrix size with the same code the
 * model job used (a few hundred multiplications, far under the Worker CPU limit). Null if the fit row is unusable.
 */
async function scoreMatrixFor(env, r) {
  try {
    const fit = await first(env, "SELECT json_extract(params_json, '$.rho') AS rho FROM model_fits WHERE id = ?", [r.fit_id]);
    if (fit?.rho == null) return null;
    const m = buildScoreMatrix({ lambda: r.expected_home_goals, nu: r.expected_away_goals, rho: fit.rho, maxGoals: r.matrix_max_goals });
    const round = (v) => Math.round(v * 1e8) / 1e8;
    return { max_goals: m.maxGoals, rho: fit.rho, tail_mass: m.tailMass, source: 'recomputed_from_stored_parameters', cells: m.matrix.map((row) => row.map(round)) };
  } catch (err) {
    console.error('score matrix rebuild failed', err);
    return null;
  }
}

async function matchDetail(id, env, nowMs) {
  const r = await first(env, `${MATCH_SELECT} WHERE m.id = ?`, [id]);
  if (!r) return null;
  const out = shapeMatch(r, { detail: true });
  if (r.p_id != null) {
    const ratings = await all(env, 'SELECT team_id, elo, attack, defense, matches_used FROM team_ratings WHERE fit_id = ? AND team_id IN (?, ?)', [r.fit_id, r.home_team_id, r.away_team_id]);
    const byTeam = new Map(ratings.map((x) => [x.team_id, x]));
    const pick = (tid) => { const x = byTeam.get(tid); return x ? { elo: x.elo, attack: x.attack, defense: x.defense, matches_used: x.matches_used } : null; };
    out.team_ratings = { home: pick(r.home_team_id), away: pick(r.away_team_id) };
    out.score_matrix = await scoreMatrixFor(env, r);
  }
  return { data: out, meta: { generated_at: isoNow(nowMs), ...(await modelFreshness(env, nowMs, r.competition)) } };
}

async function standings(url, env, nowMs) {
  rejectUnknownParams(url, ['competition', 'season']);
  const code = competitionParam(url);
  if (!code) throw new BadRequest('competition is required');
  let season = url.searchParams.get('season');
  if (season != null) {
    if (!/^\d{4}$/.test(season)) throw new BadRequest('season must be a 4-digit start year');
    season = Number(season);
  } else {
    season = (await first(env, 'SELECT MAX(s.season) AS s FROM standings s JOIN competitions c ON c.id = s.competition_id WHERE c.code = ?', [code]))?.s ?? null;
  }
  if (season == null) return { data: [], meta: { generated_at: isoNow(nowMs), competition: code, season: null, fetched_at: null } };
  const rows = await all(env, `
    SELECT s.stage, s.position, s.team_id, t.name AS team, s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against, s.points, s.provider_id, s.fetched_at
    FROM standings s JOIN competitions c ON c.id = s.competition_id JOIN teams t ON t.id = s.team_id
    WHERE c.code = ? AND s.season = ? ORDER BY s.stage, s.position`, [code, season]);
  const fetchedAt = rows.reduce((m, r) => (m == null || r.fetched_at < m ? r.fetched_at : m), null);
  return { data: rows, meta: { generated_at: isoNow(nowMs), competition: code, season, oldest_row_fetched_at: fetchedAt } };
}

async function ratings(url, env, nowMs) {
  rejectUnknownParams(url, ['competition']);
  const code = competitionParam(url);
  if (!code) throw new BadRequest('competition is required');
  const fit = await first(env, 'SELECT id, model_version, data_as_of, n_matches, created_at FROM model_fits WHERE scope = ? ORDER BY data_as_of DESC, id DESC LIMIT 1', [code]);
  if (!fit) return { data: [], meta: { generated_at: isoNow(nowMs), competition: code, fit: null } };
  const rows = await all(env, `
    SELECT r.team_id, t.name AS team, r.elo, r.attack, r.defense, r.matches_used
    FROM team_ratings r JOIN teams t ON t.id = r.team_id WHERE r.fit_id = ? ORDER BY r.elo DESC, t.name`, [fit.id]);
  return {
    data: rows,
    meta: {
      generated_at: isoNow(nowMs), competition: code,
      fit: { model_version: fit.model_version, data_as_of: fit.data_as_of, n_matches: fit.n_matches, created_at: fit.created_at },
      note: 'attack/defense are multipliers relative to the league average (1.0); elo is a display rating',
    },
  };
}

async function evaluation(url, env, nowMs) {
  rejectUnknownParams(url, ['competition']);
  const code = competitionParam(url);
  if (!code) throw new BadRequest('competition is required');
  const run = await first(env, `
    SELECT id, model_version, started_at, finished_at, config_json, n_matches, brier_1x2, log_loss_1x2, accuracy_1x2, brier_over_2_5, brier_btts, notes
    FROM backtest_runs WHERE json_extract(config_json, '$.scope') = ? ORDER BY id DESC LIMIT 1`, [code]);
  if (!run) return { data: null, meta: { generated_at: isoNow(nowMs), competition: code, reason: 'no_backtest_yet' } };
  const bins = await all(env, 'SELECT market, bin_lo, bin_hi, n, mean_predicted, observed_frequency FROM calibration_bins WHERE run_id = ? ORDER BY market, bin_lo', [run.id]);
  const calibration = {};
  for (const b of bins) (calibration[b.market] ??= []).push({ lo: b.bin_lo, hi: b.bin_hi, n: b.n, mean_predicted: b.mean_predicted, observed_frequency: b.observed_frequency });
  const cfg = parseJson(run.config_json) ?? {};
  return {
    data: {
      run_id: run.id, model_version: run.model_version, finished_at: run.finished_at, n_matches: run.n_matches,
      window: { from: cfg.from ?? null, to: cfg.to ?? null },
      metrics: { brier_1x2: run.brier_1x2, log_loss_1x2: run.log_loss_1x2, accuracy_1x2: run.accuracy_1x2, brier_over_2_5: run.brier_over_2_5, brier_btts: run.brier_btts },
      baseline: cfg.baseline ?? null, log_loss_vs_baseline: cfg.logLossVsBaseline ?? null,
      config: { half_life_days: cfg.halfLifeDays ?? null, ridge: cfg.ridge ?? null, step_days: cfg.stepDays ?? null },
      selection: cfg.selection ?? null, calibration, notes: run.notes,
    },
    meta: { generated_at: isoNow(nowMs), competition: code },
  };
}

/** Returns { status, body } for a data route, or null if the path is not one. Throws BadRequest for invalid input. */
export async function routeData(url, env, nowMs) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p === '/api/competitions') { rejectUnknownParams(url, []); return { status: 200, body: await listCompetitions(env, nowMs) }; }
  if (p === '/api/matches') return { status: 200, body: await listMatches(url, env, nowMs) };
  const m = /^\/api\/matches\/(\d{1,9})$/.exec(p);
  if (m) {
    rejectUnknownParams(url, []);
    const body = await matchDetail(Number(m[1]), env, nowMs);
    return body ? { status: 200, body } : { status: 404, body: { error: 'not_found' } };
  }
  if (p === '/api/standings') return { status: 200, body: await standings(url, env, nowMs) };
  if (p === '/api/ratings') return { status: 200, body: await ratings(url, env, nowMs) };
  if (p === '/api/evaluation') return { status: 200, body: await evaluation(url, env, nowMs) };
  return null;
}
