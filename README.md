# Squad Stat

Prediksi pra-pertandingan sepak bola. GitHub Actions menghitung (ingest, fitting, backtest), Cloudflare D1 menyimpan,
Worker hanya membaca. Alasannya: Workers gratis dibatasi 10 ms CPU per invocation, terlalu kecil untuk fitting model.

## Status

| Bagian | Status |
|---|---|
| Skema D1 + migrasi (`migrations/`) | Selesai, diuji di SQLite lokal (constraint, FK, unique, cascade) |
| Adapter football-data.org (`pipeline/providers/footballDataOrg.js`) | Selesai, diuji dengan fixture sintetis. **Belum diuji ke API asli** |
| Adapter CSV football-data.co.uk (`pipeline/providers/footballDataCsv.js`) | Selesai, diuji dengan fixture sintetis. **Belum diuji ke situs asli** |
| Util: HTTP retry/backoff/rate limit, parser CSV, tanggal/zona waktu, resolver tim | Selesai, diuji |
| Worker `/api/health` | Selesai, diuji terhadap skema nyata |
| Klien D1 REST (`pipeline/lib/d1.js`) | Selesai, diuji dengan fetch palsu. **Format REST D1 belum diverifikasi ke Cloudflare asli** |
| Ingestion idempoten (`pipeline/ingest/`): job_locks, job_runs, retry + exponential backoff, isolasi per liga | Selesai, diuji end to end terhadap SQLite dengan fixture sintetis |
| CLI ingestion (`pipeline/bin/ingest.js`: `fd`, `csv`, `unmapped`, `teams`, `alias`) | Ditulis; parser argumen dan alur alias diuji. **Belum pernah dijalankan ke API/D1 asli** |
| Mesin statistik (`engine/`): Elo dinamis, Dixon-Coles berpeluruhan waktu, matriks skor + ekor, L-BFGS | Selesai, diuji (gradien vs beda hingga, pemulihan parameter sintetis, tanpa kebocoran) |
| Persistensi fit/rating/prediksi ke D1 + job model (`pipeline/model/`) | Selesai, diuji di SQLite (idempoten, atomik, retry, reproduksibel dari fit tersimpan) |
| Backtest walk-forward, metrik (Brier, log-loss, kalibrasi), tuning half-life/ridge dengan holdout | Selesai, diuji. **Belum dijalankan pada data asli, jadi belum ada angka akurasi yang boleh diklaim** |
| Worker API baca: `/api/competitions`, `/api/matches`, `/api/matches/:id`, `/api/standings`, `/api/ratings`, `/api/evaluation` | Selesai, diuji terhadap skema nyata. Belum di-deploy |
| Frontend (`web/`): grid pertandingan, filter, modal detail (matriks skor + odds wajar), rating tim, evaluasi model, status kesegaran | Selesai, diuji di Chromium sungguhan terhadap kode Worker asli + SQLite, dengan CSP ketat |
| Workflow GitHub Actions (`.github/workflows/`): pipeline terjadwal, refresh CSV, backfill, backtest, deploy, watchdog, CI | Selesai; struktur dan keamanannya dites secara statis. **Belum pernah dijalankan di GitHub** |
| Deploy ke Cloudflare | **Belum dilakukan**, panduan di bawah |

Semua fixture di `test/fixtures/` ditulis tangan, bertanda `synthetic`, dengan tim fiktif. Bukan data asli.

## Struktur

```
migrations/    0001_schema.sql, 0002_seed_reference.sql   (diterapkan berurutan oleh wrangler)
config/        competitions.json                          (sumber kebenaran daftar liga; dicek terhadap seed SQL)
pipeline/
  lib/         http.js csv.js dates.js teams.js errors.js d1.js retry.js
  providers/   footballDataOrg.js footballDataCsv.js contract.js
  ingest/      jobs.js apply.js teams.js matches.js standings.js providers.js run.js
  model/       persist.js run.js backtestJob.js            (simpan fit/prediksi/backtest; job model; job backtest)
  bin/         ingest.js model.js backtest.js args.js modelArgs.js
  config.js    pemuat dan validator competitions.json
engine/        poisson.js scoreMatrix.js elo.js optimizer.js fit.js predict.js eligibility.js metrics.js backtest.js
config/        competitions.json model.json                (model.json: default BELUM dituning)
worker/src/    index.js routes.js                         (API baca; routes.js = endpoint data)
web/           index.html styles.css config.js _headers favicon.svg js/(api format views app main).js   (situs statis, tanpa build)
test/          *.test.js, fixtures/, helpers/
wrangler.toml  .env.example  .github/workflows/*.yml
```

## Cara kerja ingestion

- Setiap kombinasi (provider, liga, musim) adalah satu unit kerja: ambil lock di `job_locks` (lease dengan
  kedaluwarsa, satu upsert atomik), catat di `job_runs`, jalankan, lepas lock di `finally`. Kegagalan satu liga tidak
  menghentikan liga lain. Run yang menggantung (runner mati) ditandai `failed` oleh `reapStaleRuns`.
- Idempoten dan hemat kuota tulis (100k baris/hari di D1 gratis): planner membandingkan data provider dengan isi D1 dan
  hanya menulis baris yang berubah. Run kedua dengan input sama menulis nol baris data (dites).
- Provider `primary` (football-data.org) boleh mengoreksi hasil/status/jam (dicatat sebagai `result_overridden`);
  provider lain hanya mengisi yang kosong dan melaporkan `result_conflict` bila skor berbeda. Laga selesai tidak pernah
  dimundurkan ke status belum main.
- Error D1/jaringan sementara diulang dengan exponential backoff + jitter; error permanen tidak diulang. Setiap chunk
  ditulis atomik (batch).
- Status run `partial` bila ada nama tim belum terpetakan atau konflik hasil.

## Mesin statistik

- **Dixon-Coles**: `log λ = μ + h + a[tuan rumah] − d[tamu]`, `log ν = μ + a[tamu] − d[tuan rumah]`, koreksi τ pada skor
  0-0/0-1/1-0/1-1, bobot peluruhan `exp(−ξ·umur_hari)` (half-life default 365 hari), penalti ridge, gradien analitik,
  L-BFGS. **Nilai default half-life dan ridge belum dituning**; tuning harus lewat backtest walk-forward (Tahap berikut).
- **Matriks skor**: ukuran adaptif (dengan batas atas), massa di luar matriks dilaporkan sebagai `tailMass`, tidak
  dinormalisasi diam-diam. BTTS dihitung dengan rumus tertutup, Over/Under dari 1 − P(total ≤ garis).
- **Elo** hanya rating tampilan/baseline; tidak dikalikan ke λ (menghindari penghitungan ganda kekuatan tim).
- **Tanpa kebocoran**: hanya laga yang selesai *sebelum* `asOf` yang dipakai; kickoff tidak diketahui dianggap selesai di
  akhir tanggal laga.
- `expected_home_goals` adalah ekspektasi gol model (`model_goal_expectation`), bukan xG.
- Batasan: satu fit per kompetisi (liga). Kompetisi antar-klub (CL) memerlukan pendekatan lintas liga yang belum dibuat.
  Ketidakpastian parameter tidak dipropagasikan ke probabilitas.

## Backtest dan tuning

- **Walk-forward**: untuk setiap titik T (tiap `stepDays`), model difit hanya dengan laga yang selesai sebelum T, lalu
  memprediksi laga yang mulai di [T, T+step). Tes membuktikan: mengubah semua hasil setelah suatu titik tidak mengubah
  satu pun prediksi sebelumnya (bit-identik), dan tes kontrol membuktikan perubahan itu *terdeteksi* bila memang ada.
- **Metrik**: Brier 1X2 (multi-kelas), log-loss, akurasi, Brier/log-loss Over 2.5 dan BTTS, bin kalibrasi per pasar
  (bin kosong disimpan NULL), ECE. Setiap run dibandingkan dengan **baseline tanpa-skill** (frekuensi liga dari data
  latih saja) beserta selisih log-loss berpasangan dan standard error-nya.
- **Tuning tanpa membocorkan seleksi**: half-life dan ridge dipilih pada jendela *tune*, lalu hasil yang dilaporkan
  dan disimpan adalah jendela *holdout* yang tidak ikut seleksi. Jendela harus diberikan eksplisit dan tidak boleh
  tumpang tindih. Jika nilai terbaik jatuh di tepi grid, itu ditandai (`boundaryHit`) dan run berstatus `partial`.
- Tes menegaskan harness tidak mengarang skill: pada data acak tanpa struktur, model tidak mengalahkan baseline.
- Catatan kuota: satu run backtest menulis satu baris per laga holdout + 50 bin. Hanya konfigurasi terpilih yang
  disimpan, bukan seluruh grid.

## API baca (Worker)

`GET /api/competitions`, `/api/matches?competition=&status=&from=&to=&limit=&offset=`, `/api/matches/:id`,
`/api/standings?competition=&season=`, `/api/ratings?competition=`, `/api/evaluation?competition=` (plus `/api/health`).
Parameter divalidasi ketat (400 untuk yang tidak dikenal), semua query memakai bind parameter, hanya GET/HEAD/OPTIONS,
error database menjadi 503 generik. Respons membawa `model_version`, `data_as_of`, `predicted_at`, `tail_mass`, label
`goal_expectation.kind` (`model_goal_expectation`, bukan xG), flag data-sedikit, dan `meta.model_stale`.
Prediksi hanya dibuat untuk laga yang belum mulai dan berada dalam horizon; di luar itu `prediction` bernilai `null`.

## Menjalankan tes

Butuh Node 22.5+ (memakai `node:sqlite`). Tanpa dependensi, tanpa `npm install`.

```
npm test
```

## Keputusan desain yang perlu diketahui

- **Skor 90 menit.** `matches.home_goals/away_goals` selalu skor waktu normal. Untuk laga dengan perpanjangan waktu
  atau adu penalti, adapter memakai blok `regularTime`. Jika tidak ada, skor dibiarkan `NULL` (bukan ditebak) dan
  laga itu tidak dipakai untuk pelatihan.
- **Tidak ada penggabungan statistik antar provider.** `match_stats` punya satu baris per (laga, provider),
  karena definisi tembakan/korner bisa berbeda.
- **Tidak ada xG.** Tidak ada provider yang dicatat punya xG (`has_xg = 0`), dan kolom
  `predictions.goal_expectation_kind` membedakan `model_goal_expectation`, `estimated_xg`, dan `actual_xg`.
- **Tim tidak pernah dicocokkan dengan menebak.** ID provider dipakai bila ada; untuk CSV hanya alias eksplisit di
  `team_aliases`. Nama yang belum terpetakan dicatat di `unmapped_team_names` dan laganya dilewati sampai ada alias.
- **Prediksi bisa direproduksi.** Setiap prediksi menunjuk `model_fits` (parameter, `data_as_of`) dan menyimpan
  `feature_hash`; `data_as_of <= predicted_at` dipaksa oleh constraint. Backtest menyimpan setiap prediksi
  out-of-sample beserta `data_cutoff`.
- **Probabilitas divalidasi di database**: setiap probabilitas 0..1 dan 1X2 berjumlah 1 (toleransi 0,001).
- **Tanggal laga** disimpan sebagai tanggal kalender Europe/London agar rekaman dari provider berbeda bisa dicocokkan.

## Frontend

Situs statis di `web/` (Cloudflare Pages), JavaScript ES module tanpa build dan tanpa dependensi. Halaman: Pertandingan
(grid per hari, filter kompetisi, mendatang/hasil, rentang tanggal, muat lebih banyak), modal detail (peluang 1X2,
**odds wajar = 1 ÷ peluang, tanpa margin bandar**, matriks skor 0..6 + bucket 7+ dengan massa ekor yang ditampilkan,
skor tersering, rating tim, asal angka), Rating tim, dan Evaluasi model (metrik vs baseline, putusan dengan 2 standard
error, kalibrasi, tabel pemilihan parameter).

Kejujuran data di antarmuka:
- Strip kesegaran selalu tampil: status sumber (`/api/health`), umur sukses terakhir tiap provider, kapan job model
  terakhir jalan, dan `model_stale`. Umur dihitung terhadap jam **server**, jadi jam perangkat yang salah tidak bisa
  memalsukan kesegaran.
- Laga tanpa prediksi menampilkan "Belum ada prediksi", bukan angka karangan. Evaluasi kosong menampilkan "Belum ada
  backtest". `API_BASE` yang belum diisi menampilkan pesan konfigurasi, bukan halaman kosong.
- Gol diharapkan diberi label "model", bukan xG. Semua teks dinamis di-escape; CSP melarang skrip dan gaya inline
  (`web/_headers`), dan tes membuktikan nama tim berbahaya tampil sebagai teks.

## Workflow GitHub Actions

| File | Pemicu | Isi |
|---|---|---|
| `pipeline.yml` | tiap 6 jam (menit 17) + manual | `ingest` football-data.org (musim berjalan) lalu `model` (fit + prediksi). Model tetap jalan bila ingest gagal |
| `csv-refresh.yml` | Senin 03:43 UTC + manual | Refresh musim berjalan dari CSV (hasil + tembakan/korner/kartu) |
| `backfill.yml` | manual | Backfill CSV historis (`from`, `to`, `competitions`) |
| `backtest.yml` | manual | Tuning pada jendela tune, evaluasi + simpan jendela holdout. Jendela **selalu eksplisit**, tidak ditebak |
| `deploy.yml` | manual | `npm test`, tolak placeholder, migrasi D1, deploy Worker, deploy Pages |
| `watchdog.yml` | tiap 3 jam (menit 29) + manual | Gagal (sehingga GitHub mengirim email) bila `/api/health` bukan `ok` |
| `ci.yml` | push / PR | `npm test` |

Pengerasan: `permissions: contents: read` di semua workflow; timeout di semua job; satu grup `concurrency`
(`squad-stat-db`) untuk semua yang menulis ke D1, tanpa membatalkan run yang sedang menulis (lock di database
`job_locks` menjadi lapis kedua); input manual divalidasi dengan regex dan dilewatkan lewat `env`, bukan
diinterpolasi ke skrip; secret hanya di blok `env`; action dipatok ke versi mayor; tanpa `pull_request_target`;
jadwal **tidak aktif** sampai variabel repo `PIPELINE_ENABLED` bernilai `true`. Semua ini dites di `test/workflows.test.js`.
Untuk keamanan rantai pasok yang lebih ketat, patok action ke SHA commit.

## Biaya, kuota, dan risiko tagihan

Target Rp0/bulan, tetapi **gratis bukan berarti tanpa batas**. Angka berikut dari pengetahuan saya dan **belum
diverifikasi ulang di dashboard Anda**; periksa sebelum mengandalkannya.

| Layanan | Batas gratis yang dipakai desain ini | Risiko |
|---|---|---|
| GitHub Actions (repo publik) | Runner standar gratis untuk repo publik | Workflow terjadwal di repo publik dinonaktifkan GitHub setelah 60 hari tanpa aktivitas repo; aktifkan lagi manual. Watchdog ikut mati karena terjadwal juga |
| Cloudflare Workers Free | 100 ribu request/hari, 10 ms CPU/invocation | Melewati batas membuat request gagal, bukan menagih, selama Anda tetap di paket Free dan tidak berlangganan paket berbayar |
| Cloudflare D1 Free | 100 ribu baris ditulis/hari, 5 juta dibaca/hari, 5 GB | Ingestion hemat-tulis (hanya baris berubah). Satu backtest menulis satu baris per laga holdout |
| Cloudflare Pages | 500 build/bulan; situs ini statis tanpa build | Rendah |
| football-data.org (gratis) | 10 request/menit, hanya musim berjalan | Pipeline membatasi diri 1 request per 6,5 detik |

Apakah pendaftaran Cloudflare/D1 meminta kartu kredit **belum saya verifikasi**. Jika diminta, anggap ada risiko
tagihan bila Anda sendiri mengaktifkan paket berbayar atau fitur berbayar; jangan melakukannya. Satu-satunya jalur
berbayar dalam desain ini adalah jika Anda menaikkan paket secara sadar.

## Menjalankan tes

Butuh Node 22.5+ (memakai `node:sqlite`). Tanpa dependensi, tanpa `npm install`.

```
npm test
```

Tes browser (`test/webUi.test.js`) memakai Playwright + Chromium jika tersedia, dan dilewati otomatis jika tidak
(mis. di CI GitHub). Untuk menyimpan tangkapan layar: `SHOT_DIR=/tmp/shots npm test`.

## Keputusan desain yang perlu diketahui

- **Skor 90 menit.** `matches.home_goals/away_goals` selalu skor waktu normal. Untuk laga dengan perpanjangan waktu
  atau adu penalti, adapter memakai blok `regularTime`. Jika tidak ada, skor dibiarkan `NULL` (bukan ditebak) dan
  laga itu tidak dipakai untuk pelatihan.
- **Tidak ada penggabungan statistik antar provider.** `match_stats` punya satu baris per (laga, provider),
  karena definisi tembakan/korner bisa berbeda.
- **Tidak ada xG.** Tidak ada provider yang dicatat punya xG (`has_xg = 0`), dan kolom
  `predictions.goal_expectation_kind` membedakan `model_goal_expectation`, `estimated_xg`, dan `actual_xg`.
- **Tim tidak pernah dicocokkan dengan menebak.** ID provider dipakai bila ada; untuk CSV hanya alias eksplisit di
  `team_aliases`. Nama yang belum terpetakan dicatat di `unmapped_team_names` dan laganya dilewati sampai ada alias
  (lihat langkah 12).
- **Prediksi bisa direproduksi.** Setiap prediksi menunjuk `model_fits` (parameter, `data_as_of`) dan menyimpan
  `feature_hash`; `data_as_of <= predicted_at` dipaksa oleh constraint. Backtest menyimpan setiap prediksi
  out-of-sample beserta `data_cutoff`. Matriks skor tidak disimpan; Worker membangunnya ulang dari λ, ν, ρ tersimpan
  dengan kode yang sama (tes memastikan hasilnya cocok dengan probabilitas tersimpan).
- **Probabilitas divalidasi di database**: setiap probabilitas 0..1 dan 1X2 berjumlah 1 (toleransi 0,001).
- **Tanggal laga** disimpan sebagai tanggal kalender Europe/London agar rekaman dari provider berbeda bisa dicocokkan.
- **Fit dipakai ulang bila data sama.** Kunci fit adalah `data_as_of` (akhir laga terbaru yang dipakai). Run ulang tanpa
  hasil baru tidak menulis apa pun dan memprediksi dengan parameter tersimpan.

## Belum terverifikasi (cek sebelum produksi)

1. Bentuk respons football-data.org v4 mengikuti dokumentasi publik, tetapi belum dicoba ke API asli
   (akses keluar dari lingkungan pembangunan diblokir). Run pertama di GitHub Actions adalah pengujiannya.
2. Format REST D1 yang dipakai `pipeline/lib/d1.js` (endpoint, body `batch`, bentuk respons) belum diuji ke Cloudflare.
3. Lisensi football-data.co.uk untuk aplikasi publik: **belum diverifikasi**. `providers.license_status = 'unverified'`.
4. Jam kick-off di CSV diasumsikan waktu Inggris (Europe/London). Konfirmasi pada run pertama.
5. Europa League dinonaktifkan (`enabled = 0`) sampai ada sumber gratis yang terverifikasi.
6. Nama izin token Cloudflare dan versi `wrangler@4` di `deploy.yml` belum dicoba; sesuaikan bila CLI berubah.
7. Workflow belum pernah dijalankan di GitHub; `test/workflows.test.js` hanya memeriksa struktur dan keamanannya.
8. Tidak ada angka akurasi yang boleh diklaim sebelum backtest berjalan pada data asli (langkah 13).

## Panduan deploy langkah demi langkah

Dilakukan oleh Anda. Setiap langkah punya cara memeriksa hasilnya. Jangan lanjut bila pemeriksaan gagal.

**A. Persiapan**
1. Pastikan `node --version` minimal 22.5 lalu jalankan `npm test`. Harus lulus semua (tes browser boleh "skipped").
2. Buat repositori **publik** di GitHub, lalu `git init && git add . && git commit -m "Squad Stat" && git remote add origin ... && git push -u origin main`.
   Pilih lisensi sendiri; belum ada file `LICENSE`. Pastikan `git status` tidak memuat file `.env`.
3. Daftar token gratis di football-data.org. Jangan commit token.

**B. Cloudflare**
4. `npx wrangler login`, lalu `npx wrangler whoami` untuk mencatat **Account ID**.
5. `npx wrangler d1 create squad-stat`. Salin `database_id` ke `wrangler.toml` (ganti `0000...`), commit.
6. `npx wrangler d1 migrations apply squad-stat --remote`. Periksa: `npx wrangler d1 execute squad-stat --remote --command "SELECT code, enabled FROM competitions"`
   harus menampilkan liga dari `config/competitions.json`.
7. Buat API token Cloudflare (My Profile > API Tokens) dengan izin edit untuk D1, Workers Scripts, dan Pages pada akun Anda.
   Simpan token hanya di GitHub Secrets.
8. `npx wrangler pages project create squad-stat --production-branch main`.

**C. GitHub Secrets dan variabel** (Settings > Secrets and variables > Actions)
9. Secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`, `FOOTBALL_DATA_ORG_TOKEN`.
   Variabel `PIPELINE_ENABLED` **jangan** diisi dulu.

**D. Deploy API dan situs**
10. `npx wrangler deploy` (sekali, untuk mengetahui URL Worker, mis. `https://squad-stat-api.<subdomain>.workers.dev`).
    Buka `<URL>/api/health`. Pada instalasi baru hasil yang benar adalah `"status": "stale"` (belum ada ingestion).
    Ubah `ALLOWED_ORIGIN` di `wrangler.toml` menjadi URL Pages Anda bila sudah diketahui, ganti `API_BASE` di `web/config.js`
    dengan URL Worker, tambahkan URL Worker ke `connect-src` di `web/_headers` bila bukan `workers.dev`, commit, push.
11. Jalankan workflow **deploy** (Actions > deploy > Run workflow). Buka URL Pages: strip kesegaran harus menampilkan
    status usang dan daftar pertandingan kosong dengan pesan arahan. Itu benar untuk database kosong.

**E. Data pertama (run manual pertama ke layanan asli: kemungkinan ada perbaikan kecil)**
12. Jalankan workflow **pipeline** dengan `competitions=PL`. Baca log. Jika gagal, salin pesan error; bentuk respons API
    atau format REST D1 mungkin perlu penyesuaian. Setelah sukses, `/api/matches?competition=PL` berisi laga.
    Lalu workflow **backfill** (`from=2021`). Nama tim CSV yang belum terpetakan dilewati dan dicatat; lihat dengan
    `node pipeline/bin/ingest.js unmapped` (butuh env `CLOUDFLARE_*`, `D1_DATABASE_ID`), cari id tim dengan
    `node pipeline/bin/ingest.js teams --search Manchester`, petakan dengan
    `node pipeline/bin/ingest.js alias --name "Man United" --team-id 12`, lalu jalankan ulang backfill. Ulangi sampai tidak ada yang tersisa.
13. **Backtest**: jalankan workflow **backtest** dengan jendela eksplisit, mis. `tune 2022-08-01..2024-06-01`,
    `holdout 2024-08-01..2026-05-31`. Buka halaman Evaluasi. Baca putusannya apa adanya: jika model tidak bisa dibedakan dari
    baseline atau lebih buruk, itu hasilnya. Jika nilai terbaik di tepi grid, perluas `tuningGrid` di `config/model.json`
    dan ulangi. Salin half-life/ridge terpilih ke `config/model.json` (hapus catatan "belum dituning" hanya setelah ini), commit.
14. Jalankan workflow **pipeline** lagi. Prediksi muncul untuk laga dalam 14 hari ke depan.

**F. Operasi rutin**
15. Setelah 12 sampai 14 berhasil: isi variabel `PIPELINE_ENABLED=true` dan `API_BASE_URL=<URL Worker>`. Jadwal mulai berjalan.
16. Pantau: strip kesegaran di situs, email gagal dari `watchdog`, dan halaman Actions. Sekali sebulan buka repo agar jadwal
    tidak dinonaktifkan GitHub (batas 60 hari tanpa aktivitas).
17. **Mematikan darurat**: set `PIPELINE_ENABLED` ke `false` (semua jadwal berhenti, situs tetap menyajikan data terakhir).
    **Rollback** kode: jalankan ulang `deploy` dari commit sebelumnya. Data: cek ketersediaan fitur Time Travel D1 di akun Anda.

Masalah umum: `status: stale` setelah pipeline hidup berarti ingest gagal (lihat log); `model_stale: true` berarti job model
belum sukses dalam 36 jam; laga CSV tidak muncul berarti nama tim belum dipetakan; `partial` di `job_runs` berarti ada
konflik hasil atau nama belum terpetakan (lihat `detail_json`).

## Variabel lingkungan

Lihat `.env.example`. Secret hanya ada di GitHub Secrets; tidak ada yang dikirim ke browser.
