-- Squad Stat schema (Cloudflare D1 = SQLite).
-- Timestamps are UTC ISO-8601 text 'YYYY-MM-DDTHH:MM:SSZ'. match_date is 'YYYY-MM-DD' (Europe/London calendar date).
-- Apply: npx wrangler d1 migrations apply squad-stat --remote

-- ---------------------------------------------------------------- providers
CREATE TABLE providers (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('primary', 'historical', 'fallback')),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  has_match_stats INTEGER NOT NULL DEFAULT 0 CHECK (has_match_stats IN (0, 1)),
  has_xg          INTEGER NOT NULL DEFAULT 0 CHECK (has_xg IN (0, 1)),
  license_status  TEXT NOT NULL DEFAULT 'unverified' CHECK (license_status IN ('verified', 'unverified')),
  attribution     TEXT
);

-- ------------------------------------------------------------ reference data
CREATE TABLE competitions (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  country      TEXT,
  fd_org_code  TEXT UNIQUE,
  csv_div      TEXT UNIQUE,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note         TEXT
);

CREATE TABLE teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  short_name  TEXT,
  tla         TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Provider team IDs are authoritative when a provider has them.
CREATE TABLE team_provider_ids (
  provider_id        TEXT NOT NULL REFERENCES providers (id),
  provider_team_id   TEXT NOT NULL,
  team_id            INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (provider_id, provider_team_id)
);
CREATE INDEX idx_team_provider_ids_team ON team_provider_ids (team_id);

-- Name-based mapping for providers without IDs (CSV). Entries are added deliberately, never guessed.
CREATE TABLE team_aliases (
  provider_id  TEXT NOT NULL REFERENCES providers (id),
  alias_norm   TEXT NOT NULL,
  team_id      INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (provider_id, alias_norm)
);
CREATE INDEX idx_team_aliases_team ON team_aliases (team_id);

-- Names that could not be mapped. Their matches are skipped until someone adds an alias.
CREATE TABLE unmapped_team_names (
  provider_id       TEXT NOT NULL REFERENCES providers (id),
  alias_norm        TEXT NOT NULL,
  name_raw          TEXT NOT NULL,
  competition_code  TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  times_seen        INTEGER NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  PRIMARY KEY (provider_id, alias_norm)
);

-- ------------------------------------------------------------------- matches
CREATE TABLE matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id   INTEGER NOT NULL REFERENCES competitions (id),
  season           INTEGER NOT NULL CHECK (season BETWEEN 1990 AND 2100),   -- start year, 2025 = 2025/26
  matchday         INTEGER,
  stage            TEXT,
  match_date       TEXT NOT NULL CHECK (match_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kickoff_utc      TEXT CHECK (kickoff_utc IS NULL OR kickoff_utc GLOB '????-??-??T??:??:??Z'),
  status           TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'awarded')),
  home_team_id     INTEGER NOT NULL REFERENCES teams (id),
  away_team_id     INTEGER NOT NULL REFERENCES teams (id),
  -- Goals after 90 minutes (regular time), never extra time or penalties. NULL when unknown.
  home_goals       INTEGER CHECK (home_goals IS NULL OR home_goals >= 0),
  away_goals       INTEGER CHECK (away_goals IS NULL OR away_goals >= 0),
  ht_home_goals    INTEGER CHECK (ht_home_goals IS NULL OR ht_home_goals >= 0),
  ht_away_goals    INTEGER CHECK (ht_away_goals IS NULL OR ht_away_goals >= 0),
  result_provider  TEXT REFERENCES providers (id),
  updated_at       TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??Z'),
  CHECK (home_team_id <> away_team_id),
  CHECK ((home_goals IS NULL) = (away_goals IS NULL)),
  CHECK ((ht_home_goals IS NULL) = (ht_away_goals IS NULL)),
  CHECK (status = 'finished' OR home_goals IS NULL),
  -- A league pair meets once per home/away per season; the date separates cup legs.
  UNIQUE (competition_id, season, home_team_id, away_team_id, match_date)
);
CREATE INDEX idx_matches_comp_season ON matches (competition_id, season, match_date);
CREATE INDEX idx_matches_status_date ON matches (status, match_date);
CREATE INDEX idx_matches_home ON matches (home_team_id, match_date);
CREATE INDEX idx_matches_away ON matches (away_team_id, match_date);

-- Provider match IDs resolve to one canonical match; ingestion upserts by (provider_id, provider_match_id).
CREATE TABLE match_provider_ids (
  provider_id        TEXT NOT NULL REFERENCES providers (id),
  provider_match_id  TEXT NOT NULL,
  match_id           INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  PRIMARY KEY (provider_id, provider_match_id)
);
CREATE INDEX idx_match_provider_ids_match ON match_provider_ids (match_id);

-- Per-provider stats, never merged: shot/corner definitions can differ between providers.
CREATE TABLE match_stats (
  match_id           INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  provider_id        TEXT NOT NULL REFERENCES providers (id),
  shots_home         INTEGER CHECK (shots_home IS NULL OR shots_home >= 0),
  shots_away         INTEGER CHECK (shots_away IS NULL OR shots_away >= 0),
  shots_on_target_home INTEGER CHECK (shots_on_target_home IS NULL OR shots_on_target_home >= 0),
  shots_on_target_away INTEGER CHECK (shots_on_target_away IS NULL OR shots_on_target_away >= 0),
  corners_home       INTEGER CHECK (corners_home IS NULL OR corners_home >= 0),
  corners_away       INTEGER CHECK (corners_away IS NULL OR corners_away >= 0),
  fouls_home         INTEGER CHECK (fouls_home IS NULL OR fouls_home >= 0),
  fouls_away         INTEGER CHECK (fouls_away IS NULL OR fouls_away >= 0),
  yellow_home        INTEGER CHECK (yellow_home IS NULL OR yellow_home >= 0),
  yellow_away        INTEGER CHECK (yellow_away IS NULL OR yellow_away >= 0),
  red_home           INTEGER CHECK (red_home IS NULL OR red_home >= 0),
  red_away           INTEGER CHECK (red_away IS NULL OR red_away >= 0),
  fetched_at         TEXT NOT NULL CHECK (fetched_at GLOB '????-??-??T??:??:??Z'),
  PRIMARY KEY (match_id, provider_id),
  CHECK (shots_on_target_home IS NULL OR shots_home IS NULL OR shots_on_target_home <= shots_home),
  CHECK (shots_on_target_away IS NULL OR shots_away IS NULL OR shots_on_target_away <= shots_away)
);

CREATE TABLE standings (
  competition_id  INTEGER NOT NULL REFERENCES competitions (id),
  season          INTEGER NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'TOTAL',
  team_id         INTEGER NOT NULL REFERENCES teams (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  played          INTEGER NOT NULL CHECK (played >= 0),
  won             INTEGER NOT NULL CHECK (won >= 0),
  drawn           INTEGER NOT NULL CHECK (drawn >= 0),
  lost            INTEGER NOT NULL CHECK (lost >= 0),
  goals_for       INTEGER NOT NULL CHECK (goals_for >= 0),
  goals_against   INTEGER NOT NULL CHECK (goals_against >= 0),
  points          INTEGER NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers (id),
  fetched_at      TEXT NOT NULL CHECK (fetched_at GLOB '????-??-??T??:??:??Z'),
  PRIMARY KEY (competition_id, season, stage, team_id),
  CHECK (won + drawn + lost = played)
);

-- ------------------------------------------------------------------- model
-- One row per fitted model snapshot. Everything a prediction used traces back here.
CREATE TABLE model_fits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version  TEXT NOT NULL,
  scope          TEXT NOT NULL,                    -- competition code or 'GLOBAL'
  data_as_of     TEXT NOT NULL CHECK (data_as_of GLOB '????-??-??T??:??:??Z'),  -- fit used only matches finished before this
  n_matches      INTEGER NOT NULL CHECK (n_matches > 0),
  params_json    TEXT NOT NULL CHECK (json_valid(params_json)),
  created_at     TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??Z'),
  UNIQUE (model_version, scope, data_as_of)
);

CREATE TABLE team_ratings (
  fit_id          INTEGER NOT NULL REFERENCES model_fits (id) ON DELETE CASCADE,
  team_id         INTEGER NOT NULL REFERENCES teams (id),
  elo             REAL NOT NULL,
  attack          REAL NOT NULL CHECK (attack > 0),
  defense         REAL NOT NULL CHECK (defense > 0),
  home_advantage  REAL,
  matches_used    INTEGER NOT NULL CHECK (matches_used >= 0),
  PRIMARY KEY (fit_id, team_id)
);

CREATE TABLE predictions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id               INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  fit_id                 INTEGER NOT NULL REFERENCES model_fits (id),
  model_version          TEXT NOT NULL,
  predicted_at           TEXT NOT NULL CHECK (predicted_at GLOB '????-??-??T??:??:??Z'),
  data_as_of             TEXT NOT NULL CHECK (data_as_of GLOB '????-??-??T??:??:??Z'),
  -- Kept distinct on purpose: a model's goal expectation is not xG.
  goal_expectation_kind  TEXT NOT NULL DEFAULT 'model_goal_expectation'
                         CHECK (goal_expectation_kind IN ('model_goal_expectation', 'estimated_xg', 'actual_xg')),
  expected_home_goals    REAL NOT NULL CHECK (expected_home_goals >= 0),
  expected_away_goals    REAL NOT NULL CHECK (expected_away_goals >= 0),
  p_home                 REAL NOT NULL CHECK (p_home BETWEEN 0 AND 1),
  p_draw                 REAL NOT NULL CHECK (p_draw BETWEEN 0 AND 1),
  p_away                 REAL NOT NULL CHECK (p_away BETWEEN 0 AND 1),
  p_over_2_5             REAL NOT NULL CHECK (p_over_2_5 BETWEEN 0 AND 1),
  p_btts_yes             REAL NOT NULL CHECK (p_btts_yes BETWEEN 0 AND 1),
  tail_mass              REAL NOT NULL CHECK (tail_mass BETWEEN 0 AND 1),   -- probability beyond the score matrix
  matrix_max_goals       INTEGER NOT NULL CHECK (matrix_max_goals >= 1),
  top_scores_json        TEXT CHECK (top_scores_json IS NULL OR json_valid(top_scores_json)),
  uncertainty_json       TEXT CHECK (uncertainty_json IS NULL OR json_valid(uncertainty_json)),
  feature_hash           TEXT NOT NULL,
  CHECK (data_as_of <= predicted_at),
  CHECK (abs(p_home + p_draw + p_away - 1.0) <= 0.001),
  UNIQUE (match_id, fit_id)
);
CREATE INDEX idx_predictions_match ON predictions (match_id, predicted_at);

-- ---------------------------------------------------------------- backtest
CREATE TABLE backtest_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version  TEXT NOT NULL,
  code_commit    TEXT,
  started_at     TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??Z'),
  finished_at    TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??Z'),
  config_json    TEXT NOT NULL CHECK (json_valid(config_json)),
  n_matches      INTEGER CHECK (n_matches IS NULL OR n_matches >= 0),
  brier_1x2      REAL CHECK (brier_1x2 IS NULL OR brier_1x2 >= 0),
  log_loss_1x2   REAL CHECK (log_loss_1x2 IS NULL OR log_loss_1x2 >= 0),
  accuracy_1x2   REAL CHECK (accuracy_1x2 IS NULL OR accuracy_1x2 BETWEEN 0 AND 1),
  brier_over_2_5 REAL CHECK (brier_over_2_5 IS NULL OR brier_over_2_5 >= 0),
  brier_btts     REAL CHECK (brier_btts IS NULL OR brier_btts >= 0),
  notes          TEXT
);

-- Every out-of-sample prediction is stored so a run can be recomputed and audited.
CREATE TABLE backtest_predictions (
  run_id       INTEGER NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  match_id     INTEGER NOT NULL REFERENCES matches (id),
  data_cutoff  TEXT NOT NULL CHECK (data_cutoff GLOB '????-??-??T??:??:??Z'),  -- only data before this was used
  p_home       REAL NOT NULL CHECK (p_home BETWEEN 0 AND 1),
  p_draw       REAL NOT NULL CHECK (p_draw BETWEEN 0 AND 1),
  p_away       REAL NOT NULL CHECK (p_away BETWEEN 0 AND 1),
  p_over_2_5   REAL NOT NULL CHECK (p_over_2_5 BETWEEN 0 AND 1),
  p_btts_yes   REAL NOT NULL CHECK (p_btts_yes BETWEEN 0 AND 1),
  PRIMARY KEY (run_id, match_id),
  CHECK (abs(p_home + p_draw + p_away - 1.0) <= 0.001)
);

CREATE TABLE calibration_bins (
  run_id              INTEGER NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  market              TEXT NOT NULL CHECK (market IN ('home', 'draw', 'away', 'over_2_5', 'btts_yes')),
  bin_lo              REAL NOT NULL CHECK (bin_lo >= 0),
  bin_hi              REAL NOT NULL CHECK (bin_hi <= 1),
  n                   INTEGER NOT NULL CHECK (n >= 0),
  mean_predicted      REAL CHECK (mean_predicted IS NULL OR mean_predicted BETWEEN 0 AND 1),
  observed_frequency  REAL CHECK (observed_frequency IS NULL OR observed_frequency BETWEEN 0 AND 1),
  PRIMARY KEY (run_id, market, bin_lo),
  CHECK (bin_hi > bin_lo)
);

-- ------------------------------------------------------ operations / health
CREATE TABLE source_status (
  provider_id           TEXT PRIMARY KEY REFERENCES providers (id),
  last_attempt_at       TEXT CHECK (last_attempt_at IS NULL OR last_attempt_at GLOB '????-??-??T??:??:??Z'),
  last_success_at       TEXT CHECK (last_success_at IS NULL OR last_success_at GLOB '????-??-??T??:??:??Z'),
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
);

CREATE TABLE job_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job            TEXT NOT NULL,
  scope          TEXT,
  started_at     TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??Z'),
  finished_at    TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??Z'),
  status         TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  rows_written   INTEGER NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  rows_rejected  INTEGER NOT NULL DEFAULT 0 CHECK (rows_rejected >= 0),
  error          TEXT,
  detail_json    TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
);
CREATE INDEX idx_job_runs_job ON job_runs (job, started_at);

-- Lease lock so overlapping scheduled runs cannot ingest the same scope concurrently.
CREATE TABLE job_locks (
  job          TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  acquired_at  TEXT NOT NULL CHECK (acquired_at GLOB '????-??-??T??:??:??Z'),
  expires_at   TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??Z'),
  CHECK (expires_at > acquired_at)
);
