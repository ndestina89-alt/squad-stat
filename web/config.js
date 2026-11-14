// Where the read-only API Worker lives. Edit after `wrangler deploy` prints the URL.
// null  = not configured yet (the UI says so instead of showing empty or fake data)
// ''    = same origin (only if you route /api/* to the Worker on the same domain)
export const API_BASE = null; // e.g. 'https://squad-stat-api.YOUR-SUBDOMAIN.workers.dev'
