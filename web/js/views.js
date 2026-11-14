// Pure view functions: data in, HTML string out. No DOM access, so they are unit-tested in Node.
// Every dynamic value passes through esc(); markup contains no inline styles or handlers (strict CSP).
import { dayLabel, esc, fairOdds, fmtDateTime, fmtTime, MARKET_LABELS, matchDay, num, pct, relativeAge } from './format.js';

// ---------------------------------------------------------------- freshness
const HEALTH_TEXT = {
  ok: 'Sumber data segar',
  degraded: 'Sumber data bermasalah, data masih dalam batas segar',
  stale: 'Data pertandingan mungkin usang',
  error: 'Status data tidak dapat dibaca',
};

/** Always-visible strip. health = /api/health body or null; meta = latest meta with model_last_run_at / model_stale. */
export function freshnessStrip({ health, healthError, meta, nowMs: clientNow }) {
  // Ages are measured against the SERVER clock (health.now / meta.generated_at) so a wrong device clock cannot fake freshness.
  const nowMs = Date.parse(meta?.generated_at ?? health?.now ?? '') || clientNow;
  const status = healthError ? 'error' : health?.status ?? 'error';
  const cls = status === 'ok' ? 'good' : status === 'error' || status === 'stale' ? 'bad' : 'warn';
  const providers = (health?.providers ?? []).map((p) => {
    const age = p.last_success_at ? relativeAge(p.last_success_at, nowMs) : 'belum pernah berhasil';
    return `<li class="${p.stale ? 'bad' : ''}"><span>${esc(p.provider)}</span><span>${esc(age)}${p.stale ? ' (usang)' : ''}</span></li>`;
  }).join('');
  let model = '';
  if (meta && 'model_stale' in meta) {
    const when = meta.model_last_run_at ? relativeAge(meta.model_last_run_at, nowMs) : 'belum pernah dijalankan';
    model = `<p class="${meta.model_stale ? 'bad' : 'good'}">Model: dijalankan ${esc(when)}${meta.model_stale ? ', prediksi mungkin usang' : ''}</p>`;
  }
  return `<div class="strip ${cls}" role="status">
    <p class="strip-main"><span class="dot" aria-hidden="true"></span>${esc(HEALTH_TEXT[status] ?? HEALTH_TEXT.error)}</p>
    ${model}
    ${providers ? `<details><summary>Rincian sumber</summary><ul class="prov">${providers}</ul></details>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- shared bits
/** Stacked 1X2 bar as SVG (attributes only, so it works under a strict CSP). */
export function probBar(p, { label = true } = {}) {
  const h = Math.max(0, p.home) * 100; const d = Math.max(0, p.draw) * 100; const a = Math.max(0, p.away) * 100;
  return `<svg class="pbar" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="Peluang: tuan rumah ${esc(pct(p.home))}, seri ${esc(pct(p.draw))}, tamu ${esc(pct(p.away))}">
    <rect class="seg-h" x="0" y="0" width="${h.toFixed(3)}" height="4"/>
    <rect class="seg-d" x="${h.toFixed(3)}" y="0" width="${d.toFixed(3)}" height="4"/>
    <rect class="seg-a" x="${(h + d).toFixed(3)}" y="0" width="${a.toFixed(3)}" height="4"/>
  </svg>${label ? `<div class="pnums"><span class="n-h">${esc(pct(p.home))}</span><span class="n-d">${esc(pct(p.draw))}</span><span class="n-a">${esc(pct(p.away))}</span></div>` : ''}`;
}

const flagText = { home_team_unknown: 'Tim tuan rumah belum punya data', away_team_unknown: 'Tim tamu belum punya data', low_data: 'Data tim sedikit, prediksi kurang andal' };
const flagBadges = (unc) => (unc?.flags ?? []).map((f) => `<span class="badge warn">${esc(flagText[f] ?? f)}</span>`).join('');

// ---------------------------------------------------------------- match grid
export function matchTile(m, { tz }) {
  const time = m.kickoff_utc ? fmtTime(m.kickoff_utc, tz) : null;
  const p = m.prediction;
  const mid = m.score ? `<span class="score" aria-label="Skor ${m.score.home} sama ${m.score.away}">${m.score.home}<i>:</i>${m.score.away}</span>` : `<span class="vs">${time ? esc(time) : 'jam belum diketahui'}</span>`;
  const pred = p
    ? `${probBar(p.probabilities)}<div class="xg"><span>Gol diharapkan model</span><b>${esc(num(p.goal_expectation.home, 2))}</b><i>:</i><b>${esc(num(p.goal_expectation.away, 2))}</b></div>`
    : '<p class="nopred">Belum ada prediksi untuk laga ini</p>';
  return `<li class="fx"><button type="button" class="fx-btn" data-match="${esc(m.id)}" aria-label="Detail ${esc(m.home.name)} lawan ${esc(m.away.name)}">
    <span class="fx-comp">${esc(m.competition)}${m.matchday ? `<span class="md">Pekan ${esc(m.matchday)}</span>` : ''}</span>
    <span class="fx-teams"><span class="t-home">${esc(m.home.name)}</span>${mid}<span class="t-away">${esc(m.away.name)}</span></span>
    ${pred}
  </button></li>`;
}

export function matchGrid(matches, { tz, hasMore }) {
  if (matches.length === 0) {
    return '<div class="empty"><h2>Tidak ada pertandingan</h2><p>Ubah kompetisi atau rentang tanggal. Jika baru memasang sistem, jalankan workflow ingest terlebih dahulu.</p></div>';
  }
  const groups = new Map();
  for (const m of matches) {
    const k = matchDay(m, tz);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const html = [...groups].map(([day, list]) => `<section class="day"><h2>${esc(dayLabel(day))}</h2><ul class="fx-grid">${list.map((m) => matchTile(m, { tz })).join('')}</ul></section>`).join('');
  return `${html}${hasMore ? '<div class="more"><button type="button" class="btn" data-more>Muat lebih banyak</button></div>' : ''}`;
}

// ---------------------------------------------------------------- score matrix
const COLLAPSE_AT = 6;

/** Collapse a full matrix into 0..6 plus a "7+" bucket so the table stays readable. Totals are preserved. */
export function collapseMatrix(cells) {
  const n = cells.length - 1;
  if (n <= COLLAPSE_AT) return { cells, labels: cells.map((_, i) => String(i)) };
  const size = COLLAPSE_AT + 2;
  const out = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) out[Math.min(x, size - 1)][Math.min(y, size - 1)] += cells[x][y];
  return { cells: out, labels: out.map((_, i) => (i === size - 1 ? `${COLLAPSE_AT + 1}+` : String(i))) };
}

export function scoreMatrixTable(matrix, { homeName, awayName }) {
  if (!matrix) return '<p class="muted">Matriks skor tidak tersedia untuk prediksi ini.</p>';
  const { cells, labels } = collapseMatrix(matrix.cells);
  const flat = cells.flat();
  const max = Math.max(...flat);
  const top = new Set([...flat.keys()].sort((a, b) => flat[b] - flat[a]).slice(0, 3));
  const size = cells.length;
  const head = `<tr><th class="corner" scope="col"><span class="sr">Gol tuan rumah (baris) lawan gol tamu (kolom)</span></th>${labels.map((l) => `<th scope="col">${esc(l)}</th>`).join('')}</tr>`;
  const rows = cells.map((row, x) => `<tr><th scope="row">${esc(labels[x])}</th>${row.map((p, y) => {
    const bucket = max > 0 ? Math.round((p / max) * 20) : 0;
    return `<td class="m${bucket}${top.has(x * size + y) ? ' top' : ''}" title="${esc(`${labels[x]}-${labels[y]}: ${pct(p, 2)}`)}">${esc(pct(p, p < 0.01 ? 2 : 1).replace('%', ''))}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="matrix-wrap"><p class="axis-away">${esc(awayName)} (gol)</p><div class="matrix-row"><p class="axis-home">${esc(homeName)} (gol)</p>
    <table class="matrix"><caption class="sr">Peluang setiap skor akhir, dalam persen</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>
    <p class="note">Angka dalam persen. Massa probabilitas di luar matriks (tail): <b>${esc(pct(matrix.tail_mass, 4))}</b>, tidak dinormalisasi ulang. Matriks dihitung ulang dari parameter tersimpan.</p>`;
}

// ---------------------------------------------------------------- match modal
function oddsRow(label, p) {
  return `<tr><th scope="row">${esc(label)}</th><td>${esc(pct(p))}</td><td class="odds">${esc(fairOdds(p))}</td></tr>`;
}

export function matchModal(d, { tz, nowMs }) {
  const m = d.data; const p = m.prediction;
  const when = m.kickoff_utc ? fmtDateTime(m.kickoff_utc, tz) : `${m.match_date}, jam belum diketahui`;
  const head = `<header class="mh"><p class="mh-sub">${esc(m.competition)}, musim ${esc(m.season)}${m.matchday ? `, pekan ${esc(m.matchday)}` : ''}</p>
    <h2 id="dlg-title">${esc(m.home.name)} <span class="vs-s">lawan</span> ${esc(m.away.name)}</h2>
    <p class="mh-when">${esc(when)}${m.score ? `<span class="score big">${m.score.home}<i>:</i>${m.score.away}</span><span class="note">Skor waktu normal (90 menit)</span>` : ''}</p></header>`;
  if (!p) {
    return `${head}<div class="empty"><h3>Belum ada prediksi</h3><p>Prediksi dibuat oleh job model untuk laga yang belum mulai dan berada dalam horizon prediksi. Tidak ada angka yang dikarang untuk laga ini.</p></div>`;
  }
  const pr = p.probabilities;
  const odds = `<div class="tbl"><table class="odds-table"><thead><tr><th scope="col">Pasar</th><th scope="col">Peluang</th><th scope="col">Odds wajar</th></tr></thead><tbody>
    ${oddsRow(MARKET_LABELS.home, pr.home)}${oddsRow(MARKET_LABELS.draw, pr.draw)}${oddsRow(MARKET_LABELS.away, pr.away)}
    ${oddsRow('Lebih dari 2,5 gol', pr.over_2_5)}${oddsRow('Kurang dari 2,5 gol', 1 - pr.over_2_5)}
    ${oddsRow('Kedua tim mencetak gol', pr.btts_yes)}${oddsRow('Salah satu tim tidak mencetak gol', 1 - pr.btts_yes)}</tbody></table></div>
    <p class="note">Odds wajar = 1 ÷ peluang model, tanpa margin bandar. Ini bukan harga pasar dan bukan saran taruhan.</p>`;
  const tops = (p.top_scores ?? []).map((s) => `<li><b>${s.home}-${s.away}</b><span>${esc(pct(s.p))}</span></li>`).join('');
  const r = d.data.team_ratings;
  const ratingRow = (name, x) => (x ? `<tr><th scope="row">${esc(name)}</th><td>${esc(num(x.elo, 0))}</td><td>${esc(num(x.attack, 2))}</td><td>${esc(num(x.defense, 2))}</td><td>${esc(x.matches_used)}</td></tr>` : `<tr><th scope="row">${esc(name)}</th><td colspan="4">belum ada data</td></tr>`);
  const unc = p.uncertainty;
  return `${head}
    <section class="blk"><h3>Peluang hasil</h3>${probBar(pr)}
      <div class="legend"><span class="k-h">${esc(m.home.name)}</span><span class="k-d">Seri</span><span class="k-a">${esc(m.away.name)}</span></div>
      <p class="xg-l">Gol diharapkan model: <b>${esc(num(p.goal_expectation.home, 2))}</b> lawan <b>${esc(num(p.goal_expectation.away, 2))}</b>. Ini ekspektasi gol dari model, bukan xG.</p>
      ${flagBadges(unc)}</section>
    <section class="blk"><h3>Odds wajar</h3>${odds}</section>
    <section class="blk"><h3>Matriks skor</h3>${scoreMatrixTable(d.data.score_matrix, { homeName: m.home.name, awayName: m.away.name })}
      <ul class="tops">${tops}</ul></section>
    ${r ? `<section class="blk"><h3>Rating tim saat prediksi</h3><div class="tbl"><table class="rt"><thead><tr><th scope="col">Tim</th><th scope="col">Elo</th><th scope="col">Serangan</th><th scope="col">Pertahanan</th><th scope="col">Laga dipakai</th></tr></thead><tbody>${ratingRow(m.home.name, r.home)}${ratingRow(m.away.name, r.away)}</tbody></table></div></section>` : ''}
    <section class="blk prov-blk"><h3>Asal angka</h3><dl>
      <dt>Versi model</dt><dd>${esc(p.model_version)}</dd>
      <dt>Data hingga</dt><dd>${esc(fmtDateTime(p.data_as_of, tz))} (${esc(relativeAge(p.data_as_of, nowMs))})</dd>
      <dt>Prediksi dibuat</dt><dd>${esc(fmtDateTime(p.predicted_at, tz))} (${esc(relativeAge(p.predicted_at, nowMs))})</dd>
      <dt>Jenis gol diharapkan</dt><dd>${esc(p.goal_expectation.kind)}</dd>
      <dt>Ukuran matriks</dt><dd>0 sampai ${esc(p.matrix_max_goals)} gol per tim</dd>
      <dt>Sidik fitur</dt><dd class="hash">${esc((p.feature_hash ?? '').slice(0, 16))}</dd></dl>
      <p class="note">${esc(unc?.note ?? '')}</p></section>`;
}

// ---------------------------------------------------------------- ratings
export function ratingsTable(body, { nowMs, tz }) {
  const fit = body.meta?.fit;
  if (!fit || body.data.length === 0) return '<div class="empty"><h2>Belum ada rating</h2><p>Rating muncul setelah job model berhasil dijalankan pada data yang cukup.</p></div>';
  const rows = body.data.map((r, i) => `<tr><td class="rk">${i + 1}</td><th scope="row">${esc(r.team)}</th><td>${esc(num(r.elo, 0))}</td><td>${esc(num(r.attack, 2))}</td><td>${esc(num(r.defense, 2))}</td><td>${esc(r.matches_used)}</td></tr>`).join('');
  return `<p class="note">Data hingga ${esc(fmtDateTime(fit.data_as_of, tz))} (${esc(relativeAge(fit.data_as_of, nowMs))}), ${esc(fit.n_matches)} laga, model ${esc(fit.model_version)}.</p>
    <div class="tbl"><table class="rt wide"><thead><tr><th scope="col">#</th><th scope="col">Tim</th><th scope="col">Elo</th><th scope="col">Serangan</th><th scope="col">Pertahanan</th><th scope="col">Laga dipakai</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Serangan dan pertahanan adalah pengali relatif terhadap rata-rata liga (1,00). Pertahanan lebih tinggi berarti lebih sulit dibobol. Elo hanya rating tampilan.</p>`;
}

// ---------------------------------------------------------------- evaluation
/** Reliability diagram. Point area = number of matches in the bin; bins under 10 matches are drawn faded. */
export function calibrationSvg(bins, title) {
  const S = 200; const pad = 24; const w = S - pad - 6;
  const x = (v) => pad + v * w; const y = (v) => S - pad - v * w;
  const pts = bins.filter((b) => b.n > 0 && b.mean_predicted != null);
  const maxN = Math.max(1, ...pts.map((b) => b.n));
  const dots = pts.map((b) => `<circle class="${b.n < 10 ? 'dot-low' : 'dot-ok'}" cx="${x(b.mean_predicted).toFixed(2)}" cy="${y(b.observed_frequency).toFixed(2)}" r="${(2 + 4 * Math.sqrt(b.n / maxN)).toFixed(2)}"><title>${esc(`prediksi ${pct(b.mean_predicted)}, terjadi ${pct(b.observed_frequency)}, ${b.n} laga`)}</title></circle>`).join('');
  const line = pts.length > 1 ? `<polyline class="cal-line" fill="none" points="${pts.map((b) => `${x(b.mean_predicted).toFixed(2)},${y(b.observed_frequency).toFixed(2)}`).join(' ')}"/>` : '';
  const ticks = [0, 0.5, 1].map((t) => `<text class="tick" x="${x(t)}" y="${S - 10}" text-anchor="middle">${t * 100}</text><text class="tick" x="${pad - 5}" y="${y(t) + 3}" text-anchor="end">${t * 100}</text>`).join('');
  return `<svg class="cal" viewBox="0 0 ${S} ${S + 8}" role="img" aria-label="${esc(title)}: peluang prediksi dibanding frekuensi kejadian"><rect class="cal-bg" x="${pad}" y="${y(1)}" width="${w}" height="${w}"/>
    <line class="cal-diag" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>${line}${dots}${ticks}
    <text class="tick" x="${S / 2}" y="${S + 6}" text-anchor="middle">prediksi (%)</text></svg>`;
}

function verdict(d) {
  const v = d.log_loss_vs_baseline;
  if (!v || v.mean == null || v.se == null) return { cls: 'warn', text: 'Perbandingan dengan baseline belum dapat dinilai (data terlalu sedikit).' };
  if (v.mean + 2 * v.se < 0) return { cls: 'good', text: 'Model lebih baik dari baseline: selisih log-loss melebihi 2 standard error.' };
  if (v.mean - 2 * v.se > 0) return { cls: 'bad', text: 'Model lebih buruk dari baseline pada data holdout ini.' };
  return { cls: 'warn', text: 'Belum bisa dibedakan dari baseline: selisih log-loss dalam 2 standard error.' };
}

export function evaluationPanel(body, { tz, nowMs }) {
  const d = body.data;
  if (!d) return '<div class="empty"><h2>Belum ada backtest</h2><p>Evaluasi baru tampil setelah backtest walk-forward dijalankan pada data historis. Tidak ada angka akurasi yang ditampilkan sebelum itu.</p></div>';
  const m = d.metrics; const b = d.baseline; const v = verdict(d);
  const best = d.selection?.best; const edge = d.selection?.boundaryHit ?? [];
  const grid = (d.selection?.grid ?? []).map((g) => `<tr${best && g.halfLifeDays === best.halfLifeDays && g.ridge === best.ridge ? ' class="pick"' : ''}><th scope="row">${esc(g.halfLifeDays)}</th><td>${esc(g.ridge)}</td><td>${esc(num(g.logLoss, 4))}</td><td>${esc(g.n)}</td></tr>`).join('');
  const cal = Object.entries(MARKET_LABELS).map(([k, label]) => `<figure>${calibrationSvg(d.calibration?.[k] ?? [], label)}<figcaption>${esc(label)}</figcaption></figure>`).join('');
  return `<p class="note">Jendela holdout ${esc(d.window.from?.slice(0, 10) ?? '?')} sampai ${esc(d.window.to?.slice(0, 10) ?? '?')}, ${esc(d.n_matches)} laga, selesai ${esc(relativeAge(d.finished_at, nowMs))}. Setiap prediksi dibuat hanya dengan data sebelum pertandingannya.</p>
    <p class="verdict ${v.cls}">${esc(v.text)}</p>
    <div class="metrics"><div class="tbl"><table class="rt"><thead><tr><th scope="col">Metrik (lebih kecil lebih baik)</th><th scope="col">Model</th><th scope="col">Baseline</th></tr></thead><tbody>
      <tr><th scope="row">Log-loss 1X2</th><td>${esc(num(m.log_loss_1x2, 4))}</td><td>${esc(num(b?.logLoss1x2, 4))}</td></tr>
      <tr><th scope="row">Brier 1X2</th><td>${esc(num(m.brier_1x2, 4))}</td><td>${esc(num(b?.brier1x2, 4))}</td></tr>
      <tr><th scope="row">Brier lebih dari 2,5 gol</th><td>${esc(num(m.brier_over_2_5, 4))}</td><td>–</td></tr>
      <tr><th scope="row">Brier kedua tim mencetak gol</th><td>${esc(num(m.brier_btts, 4))}</td><td>–</td></tr>
      <tr><th scope="row">Akurasi 1X2</th><td>${esc(pct(m.accuracy_1x2))}</td><td>–</td></tr></tbody></table></div>
      <p class="note">Baseline: frekuensi hasil liga dari data latih saja. Selisih log-loss rata-rata ${esc(num(d.log_loss_vs_baseline?.mean, 4))} (SE ${esc(num(d.log_loss_vs_baseline?.se, 4))}; negatif berarti model lebih baik).</p></div>
    <h3>Kalibrasi</h3><div class="cal-grid">${cal}</div>
    <p class="note">Titik di garis diagonal berarti peluang prediksi sesuai frekuensi nyata. Ukuran titik menunjukkan jumlah laga; titik pudar berisi kurang dari 10 laga.</p>
    <h3>Pemilihan parameter</h3>
    <p class="note">Dipilih pada jendela tune ${esc(d.selection?.tune?.from?.slice(0, 10) ?? '?')} sampai ${esc(d.selection?.tune?.to?.slice(0, 10) ?? '?')}. Hasil di atas dari jendela holdout yang tidak ikut seleksi. Half-life ${esc(d.config.half_life_days)} hari, ridge ${esc(d.config.ridge)}.</p>
    ${edge.length ? `<p class="verdict warn">Nilai terbaik berada di tepi grid (${esc(edge.join(', '))}); perluas grid sebelum memercayainya.</p>` : ''}
    ${grid ? `<div class="tbl"><table class="rt"><thead><tr><th scope="col">Half-life (hari)</th><th scope="col">Ridge</th><th scope="col">Log-loss tune</th><th scope="col">Laga</th></tr></thead><tbody>${grid}</tbody></table></div>` : ''}`;
}

export function errorPanel(err) {
  const msg = {
    config: 'Alamat API belum diatur. Isi API_BASE di web/config.js lalu deploy ulang.',
    network: 'API tidak dapat dijangkau. Periksa koneksi atau alamat API di web/config.js.',
    timeout: 'API terlalu lama merespons. Coba lagi sebentar lagi.',
    unavailable: 'Database sedang tidak tersedia. Data yang tersimpan tidak hilang; coba lagi nanti.',
    bad_request: 'Permintaan tidak valid. Periksa filter yang dipilih.',
    not_found: 'Data tidak ditemukan.',
  }[err?.kind] ?? 'Terjadi kesalahan saat memuat data.';
  return `<div class="empty err" role="alert"><h2>Data tidak dapat dimuat</h2><p>${esc(msg)}</p>${err?.kind === 'config' ? '' : '<button type="button" class="btn" data-retry>Coba lagi</button>'}</div>`;
}
