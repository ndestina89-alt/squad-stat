// Serves web/ (with the real CSP from web/_headers) and routes /api/* to the real Worker code over a SQLite-backed D1 facade.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { handle } from '../../worker/src/index.js';

const WEB = new URL('../../web/', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(new URL('_headers', WEB), 'utf8'))[1].trim();

export function startServer({ env, nowMs, configBase = '', apiOverride = null }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const o = apiOverride?.(url, req);
        const r = o ?? await handle(new Request(url, { method: req.method }), env, nowMs);
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      let path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (path.includes('..')) { res.writeHead(400); res.end(); return; }
      const ext = path.slice(path.lastIndexOf('.'));
      let body;
      if (path === '/config.js') body = Buffer.from(`export const API_BASE = ${configBase === null ? 'null' : JSON.stringify(configBase)};\n`);
      else body = await readFile(new URL(`.${path}`, WEB)).catch(() => null);
      if (!body || !TYPES[ext]) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
