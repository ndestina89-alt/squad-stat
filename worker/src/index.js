// Read-only API Worker. It only runs small SELECTs: the Workers Free plan allows 10 ms CPU per invocation,
// so all heavy computation lives in GitHub Actions and results are read from D1 here.

import { BadRequest, routeData } from './routes.js';

const DEFAULT_STALE_AFTER_HOURS = 6;

const HEALTH_PROVIDERS_SQL = `
  SELECT p.id AS provider, p.role, s.last_attempt_at, s.last_success_at, s.last_error, s.consecutive_failures
  FROM providers p
  LEFT JOIN source_status s ON s.provider_id = p.id
  WHERE p.enabled = 1
  ORDER BY p.id`;

const LATEST_JOBS_SQL = `
  SELECT job, scope, status, started_at, finished_at, rows_written, rows_rejected
  FROM job_runs
  WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job)
  ORDER BY job`;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, env, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=30',
      ...corsHeaders(env),
      ...extra,
    },
  });
}

export function staleAfterMs(env) {
  const h = Number(env.STALE_AFTER_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_STALE_AFTER_HOURS) * 3600 * 1000;
}

/**
 * Overall status: 'stale' if any enabled provider has never succeeded or is older than the threshold,
 * 'degraded' if the latest attempts are failing but data is still fresh, otherwise 'ok'.
 */
export async function buildHealth(env, nowMs) {
  const limit = staleAfterMs(env);
  const [{ results: providerRows }, { results: jobRows }] = await Promise.all([
    env.DB.prepare(HEALTH_PROVIDERS_SQL).all(),
    env.DB.prepare(LATEST_JOBS_SQL).all(),
  ]);

  const providers = providerRows.map((r) => {
    const ageMs = r.last_success_at ? nowMs - Date.parse(r.last_success_at) : null;
    return {
      provider: r.provider,
      role: r.role,
      last_attempt_at: r.last_attempt_at,
      last_success_at: r.last_success_at,
      consecutive_failures: r.consecutive_failures ?? 0,
      last_error: r.last_error ? String(r.last_error).slice(0, 200) : null,
      age_minutes: ageMs == null ? null : Math.max(0, Math.round(ageMs / 60000)),
      stale: ageMs == null || ageMs > limit,
    };
  });

  let status = 'ok';
  if (providers.some((p) => p.consecutive_failures > 0)) status = 'degraded';
  if (providers.some((p) => p.stale)) status = 'stale';

  return {
    status,
    now: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    stale_after_hours: limit / 3600000,
    providers,
    latest_jobs: jobRows,
  };
}

export async function handle(request, env, nowMs = Date.now()) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, env, { Allow: 'GET, HEAD, OPTIONS' });
  }

  if (url.pathname === '/api/health') {
    try {
      const body = await buildHealth(env, nowMs);
      return json(body, 200, env);
    } catch (err) {
      // Log details server-side only; never leak internals to the client.
      console.error('health check failed', err);
      return json({ status: 'error', error: 'database_unavailable' }, 503, env, { 'Cache-Control': 'no-store' });
    }
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      const r = await routeData(url, env, nowMs);
      if (r) return json(r.body, r.status, env);
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: 'bad_request', detail: err.message }, 400, env, { 'Cache-Control': 'no-store' });
      console.error('data route failed', err);
      return json({ error: 'database_unavailable' }, 503, env, { 'Cache-Control': 'no-store' });
    }
  }
  return json({ error: 'not_found' }, 404, env);
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
