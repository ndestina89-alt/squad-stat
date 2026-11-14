// DOM wiring: hash routing, filters, modal. All markup comes from views.js (escaped); this file only moves it into the page.
import { ApiError } from './api.js';
import { errorPanel, evaluationPanel, freshnessStrip, matchGrid, matchModal, ratingsTable } from './views.js';

const PAGE = 30;

export function parseHash(hash) {
  const raw = (hash || '#/').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const q = new URLSearchParams(query);
  const m = /^\/match\/(\d{1,9})$/.exec(path);
  return { path: m ? '/' : path || '/', matchId: m ? m[1] : null, q };
}

export function createApp({ document: doc, window: win, api, configError, now = () => Date.now() }) {
  const $ = (id) => doc.getElementById(id);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const st = { health: null, healthError: false, meta: null, competitions: [], matches: [], offset: 0, hasMore: false, token: 0 };

  // Relative ages are computed against the newest server timestamp we have seen, falling back to the device clock.
  const clock = () => st.serverNow ?? now();
  const noteServerTime = (meta) => { const t = Date.parse(meta?.generated_at ?? ''); if (Number.isFinite(t)) st.serverNow = t; };
  const setStrip = () => { $('strip').innerHTML = freshnessStrip({ health: st.health, healthError: st.healthError || !!configError, meta: st.meta, nowMs: clock() }); };
  const fail = (err) => { $('view').innerHTML = errorPanel(err instanceof ApiError ? err : new ApiError('http', String(err))); };

  function route() {
    const r = parseHash(win.location.hash);
    for (const a of doc.querySelectorAll('[data-nav]')) {
      const on = (a.dataset.nav === 'matches' && r.path === '/') || a.getAttribute('href') === `#${r.path}`;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    return r;
  }

  function readFilters(r) {
    return { c: r.q.get('c') ?? '', s: r.q.get('s') === 'finished' ? 'finished' : 'scheduled', from: r.q.get('from') ?? '', to: r.q.get('to') ?? '' };
  }
  function writeFilters(r) {
    const f = readFilters(r);
    $('f-comp').value = f.c;
    for (const el of doc.querySelectorAll('input[name="s"]')) el.checked = el.value === f.s;
    $('f-from').value = f.from; $('f-to').value = f.to;
    const isMatches = r.path === '/';
    $('filters').hidden = !(isMatches || r.path === '/ratings' || r.path === '/evaluation');
    for (const id of ['f-status-wrap', 'f-from-wrap', 'f-to-wrap']) $(id).hidden = !isMatches;
    return f;
  }
  function navigateWith(patch) {
    const r = parseHash(win.location.hash);
    const q = new URLSearchParams(r.q);
    for (const [k, v] of Object.entries(patch)) { if (v) q.set(k, v); else q.delete(k); }
    q.delete('x');
    win.location.hash = `#${r.path}${q.size ? `?${q}` : ''}`;
  }

  async function loadMatches(r, { append = false } = {}) {
    const f = readFilters(r);
    const token = ++st.token;
    if (!append) { $('view').innerHTML = '<p class="loading">Memuat pertandingan</p>'; st.offset = 0; st.matches = []; }
    try {
      const body = await api.matches({ competition: f.c, status: f.s, from: f.from, to: f.to, limit: PAGE, offset: st.offset });
      if (token !== st.token) return;
      noteServerTime(body.meta);
      st.matches = append ? st.matches.concat(body.data) : body.data;
      st.hasMore = body.meta.has_more; st.offset = st.matches.length; st.meta = body.meta;
      setStrip();
      $('view').innerHTML = matchGrid(st.matches, { tz, hasMore: st.hasMore });
    } catch (e) { if (token === st.token) fail(e); }
  }

  async function loadRatings(r) {
    const c = readFilters(r).c;
    if (!c) { $('view').innerHTML = '<div class="empty"><h2>Pilih kompetisi</h2><p>Rating dihitung per kompetisi. Pilih satu dari daftar di atas.</p></div>'; return; }
    const token = ++st.token;
    $('view').innerHTML = '<p class="loading">Memuat rating</p>';
    try { const body = await api.ratings({ competition: c }); noteServerTime(body.meta); if (token === st.token) $('view').innerHTML = `<h1 class="pg">Rating tim</h1>${ratingsTable(body, { nowMs: clock(), tz })}`; } catch (e) { if (token === st.token) fail(e); }
  }

  async function loadEvaluation(r) {
    const c = readFilters(r).c;
    if (!c) { $('view').innerHTML = '<div class="empty"><h2>Pilih kompetisi</h2><p>Evaluasi dihitung per kompetisi. Pilih satu dari daftar di atas.</p></div>'; return; }
    const token = ++st.token;
    $('view').innerHTML = '<p class="loading">Memuat evaluasi</p>';
    try { const body = await api.evaluation({ competition: c }); noteServerTime(body.meta); if (token === st.token) $('view').innerHTML = `<h1 class="pg">Evaluasi model</h1>${evaluationPanel(body, { tz, nowMs: clock() })}`; } catch (e) { if (token === st.token) fail(e); }
  }

  async function openMatch(id) {
    const dlg = $('dlg');
    $('dlg-body').innerHTML = '<p class="loading">Memuat detail</p>';
    if (!dlg.open) dlg.showModal();
    try {
      const d = await api.match(id);
      noteServerTime(d.meta);
      $('dlg-body').innerHTML = matchModal(d, { tz, nowMs: clock() });
      st.meta = d.meta; setStrip();
    } catch (e) { $('dlg-body').innerHTML = errorPanel(e instanceof ApiError ? e : new ApiError('http', String(e))); }
  }

  async function render() {
    const r = route();
    writeFilters(r);
    if (r.matchId) openMatch(r.matchId); else if ($('dlg').open) $('dlg').close();
    if (configError) { fail(configError); setStrip(); return; }
    if (r.matchId && st.matches.length) return; // keep the list behind the modal as it is
    if (r.path === '/ratings') await loadRatings(r);
    else if (r.path === '/evaluation') await loadEvaluation(r);
    else await loadMatches(r);
  }

  async function boot() {
    setStrip();
    if (!configError) {
      const [h, c] = await Promise.allSettled([api.health(), api.competitions()]);
      if (h.status === 'fulfilled') { st.health = h.value; st.healthError = false; const t = Date.parse(h.value.now ?? ''); if (Number.isFinite(t)) st.serverNow = t; } else st.healthError = true;
      if (c.status === 'fulfilled') {
        st.competitions = c.value.data; st.meta = { ...(st.meta ?? {}), ...c.value.meta };
        const sel = $('f-comp');
        for (const comp of st.competitions) { const o = doc.createElement('option'); o.value = comp.code; o.textContent = comp.name; sel.append(o); }
      }
      setStrip();
    }
    await render();
  }

  function start() {
    $('filters').addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'f-comp') navigateWith({ c: t.value });
      else if (t.name === 's') navigateWith({ s: t.value === 'finished' ? 'finished' : '' });
      else if (t.id === 'f-from') navigateWith({ from: t.value });
      else if (t.id === 'f-to') navigateWith({ to: t.value });
    });
    $('filters').addEventListener('submit', (e) => e.preventDefault());
    doc.addEventListener('click', (e) => {
      const t = e.target instanceof win.Element ? e.target : null;
      if (!t) return;
      const open = t.closest('[data-match]');
      if (open) { win.location.hash = `#/match/${open.dataset.match}${win.location.hash.includes('?') ? `?${win.location.hash.split('?')[1]}` : ''}`; return; }
      if (t.closest('[data-close]')) { closeDialog(); return; }
      if (t.closest('[data-more]')) { loadMatches(parseHash(win.location.hash), { append: true }); return; }
      if (t.closest('[data-retry]')) { render(); return; }
      if (t === $('dlg')) closeDialog(); // click on the backdrop
    });
    $('dlg').addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
    win.addEventListener('hashchange', () => {
      const r = parseHash(win.location.hash);
      if (r.matchId) { route(); openMatch(r.matchId); return; }
      if ($('dlg').open) { $('dlg').close(); if (st.matches.length && r.path === '/') { route(); writeFilters(r); return; } }
      render();
    });
    return boot();
  }

  function closeDialog() {
    const r = parseHash(win.location.hash);
    if ($('dlg').open) $('dlg').close();
    const q = r.q.toString();
    win.history.replaceState(null, '', `#/${q ? `?${q}` : ''}`);
    route();
  }

  return { start, render };
}
