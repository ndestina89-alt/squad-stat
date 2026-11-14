// Cloudflare D1 over the REST API, used from GitHub Actions (the Worker binding is not available there).
//
// UNVERIFIED against the live API (outbound access was blocked while building): the endpoint path, the
// { sql, params } body, the { batch: [...] } body and the { result: [{ results, meta }] } response shape follow
// Cloudflare's public docs as remembered. The first real run is the check. Everything the ingestion code needs is
// behind the three-method interface below, so a corrected client is a one-file change.
//
// Db interface (also implemented over node:sqlite in tests/helpers):
//   all(sql, params)   -> rows[]
//   run(sql, params)   -> { changes, lastRowId }
//   batch(statements)  -> void; statements = [{ sql, params }], applied atomically
import { ProviderError } from './errors.js';
import { requestJson } from './http.js';

export class D1Error extends Error {
  /** kind: 'transient' (retry may help) | 'permanent' (it will not) */
  constructor({ kind, message, status = null, cause = undefined }) {
    super(`[d1] ${message}`, cause ? { cause } : undefined);
    this.name = 'D1Error';
    this.kind = kind;
    this.status = status;
  }
}

const clean = (params = []) => params.map((p) => (p === undefined ? null : p));

export function createD1Client({
  accountId, databaseId, apiToken, baseUrl = 'https://api.cloudflare.com/client/v4',
  fetchImpl = globalThis.fetch, requestOptions = {},
} = {}) {
  for (const [name, value] of Object.entries({ accountId, databaseId, apiToken })) {
    if (typeof value !== 'string' || value.trim() === '') throw new D1Error({ kind: 'permanent', message: `${name} is not set` });
  }
  if (!/^[A-Za-z0-9-]+$/.test(accountId) || !/^[A-Za-z0-9-]+$/.test(databaseId)) {
    throw new D1Error({ kind: 'permanent', message: 'accountId/databaseId contain invalid characters' });
  }
  const url = `${baseUrl}/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function post(payload) {
    let json;
    try {
      json = await requestJson(url, {
        provider: 'd1', method: 'POST', fetchImpl,
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        ...requestOptions,
      });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      const transient = e.kind === 'network' || e.kind === 'rate_limit' || (e.kind === 'http' && e.status >= 500);
      throw new D1Error({ kind: transient ? 'transient' : 'permanent', message: e.message, status: e.status, cause: e });
    }
    if (!json || json.success !== true || !Array.isArray(json.result)) {
      const msg = json?.errors?.[0]?.message ?? 'unexpected response shape';
      throw new D1Error({ kind: 'permanent', message: `query failed: ${String(msg).slice(0, 300)}` });
    }
    for (const r of json.result) {
      if (r && r.success === false) throw new D1Error({ kind: 'permanent', message: 'statement failed' });
    }
    return json.result;
  }

  return {
    async all(sql, params = []) {
      const [r] = await post({ sql, params: clean(params) });
      return r?.results ?? [];
    },
    async run(sql, params = []) {
      const [r] = await post({ sql, params: clean(params) });
      return { changes: r?.meta?.changes ?? 0, lastRowId: r?.meta?.last_row_id ?? null };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      await post({ batch: statements.map((s) => ({ sql: s.sql, params: clean(s.params) })) });
    },
  };
}
