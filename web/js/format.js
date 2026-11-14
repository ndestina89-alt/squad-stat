// Pure formatting helpers. All user-visible dynamic text goes through esc().
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const nfCache = new Map();
const nf = (d) => {
  if (!nfCache.has(d)) nfCache.set(d, new Intl.NumberFormat('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return nfCache.get(d);
};
const ok = (x) => typeof x === 'number' && Number.isFinite(x);

export const pct = (p, d = 1) => (ok(p) ? `${nf(d).format(p * 100)}%` : '–');
export const num = (x, d = 2) => (ok(x) ? nf(d).format(x) : '–');

/** Fair odds = 1 / probability, with no bookmaker margin. Not a market price. */
export function fairOdds(p) {
  if (!ok(p) || p <= 0 || p > 1) return '–';
  const o = 1 / p;
  return o > 1000 ? '>1.000' : nf(2).format(o);
}

const MINUTE = 60000;
export function relativeAge(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return 'belum pernah';
  const d = nowMs - t;
  if (d < 0) return 'baru saja';
  if (d < MINUTE) return 'baru saja';
  if (d < 60 * MINUTE) return `${Math.floor(d / MINUTE)} menit lalu`;
  if (d < 48 * 60 * MINUTE) return `${Math.floor(d / (60 * MINUTE))} jam lalu`;
  return `${Math.floor(d / (24 * 60 * MINUTE))} hari lalu`;
}

const fmt = (opts, tz) => new Intl.DateTimeFormat('id-ID', { ...opts, ...(tz ? { timeZone: tz } : {}) });
const colon = (s) => s.replace(/(\d{2})\.(\d{2})/, '$1:$2'); // id-ID prints 22.00; use 22:00
export const fmtDateTime = (iso, tz) => (Number.isFinite(Date.parse(iso ?? '')) ? colon(fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }, tz).format(new Date(iso))) : '–');
export const fmtTime = (iso, tz) => (Number.isFinite(Date.parse(iso ?? '')) ? colon(fmt({ hour: '2-digit', minute: '2-digit', hour12: false }, tz).format(new Date(iso))) : null);

/** Calendar day (YYYY-MM-DD) in the viewer's timezone for a match; falls back to the stored date when kickoff is unknown. */
export function matchDay(m, tz) {
  if (m.kickoff_utc && Number.isFinite(Date.parse(m.kickoff_utc))) {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(new Date(m.kickoff_utc));
    return parts;
  }
  return m.match_date;
}
export const dayLabel = (ymd) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }, 'UTC').format(new Date(`${ymd}T12:00:00Z`));

export const MARKET_LABELS = { home: 'Tuan rumah menang', draw: 'Seri', away: 'Tamu menang', over_2_5: 'Lebih dari 2,5 gol', btts_yes: 'Kedua tim mencetak gol' };
