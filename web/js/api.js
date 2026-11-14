// Thin client for the read-only Worker API. Never throws raw errors into the UI: every failure is an ApiError with a kind.
export class ApiError extends Error {
  constructor(kind, message, status = null) { super(message); this.kind = kind; this.status = status; }
}

export function createApi({ base, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 10000 }) {
  if (base == null) throw new ApiError('config', 'API_BASE belum diatur di web/config.js');
  const root = String(base).replace(/\/+$/, '');

  async function get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    const url = `${root}${path}${qs.size ? `?${qs}` : ''}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new ApiError(e?.name === 'AbortError' ? 'timeout' : 'network', 'API tidak dapat dijangkau');
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch { /* handled below */ }
    if (!res.ok) {
      const kind = res.status === 404 ? 'not_found' : res.status === 400 ? 'bad_request' : res.status === 503 ? 'unavailable' : 'http';
      throw new ApiError(kind, body?.detail || body?.error || `HTTP ${res.status}`, res.status);
    }
    if (body == null) throw new ApiError('parse', 'Respons API tidak valid', res.status);
    return body;
  }

  return {
    health: () => get('/api/health'),
    competitions: () => get('/api/competitions'),
    matches: (p) => get('/api/matches', p),
    match: (id) => get(`/api/matches/${encodeURIComponent(id)}`),
    standings: (p) => get('/api/standings', p),
    ratings: (p) => get('/api/ratings', p),
    evaluation: (p) => get('/api/evaluation', p),
  };
}
