-- Reference rows. Keep in sync with config/competitions.json (a test enforces this).

INSERT INTO providers (id, display_name, base_url, role, enabled, has_match_stats, has_xg, license_status, attribution) VALUES
  ('football-data.org',    'football-data.org (free tier)', 'https://api.football-data.org/v4',   'primary',    1, 0, 0, 'unverified', 'Data provided by football-data.org'),
  ('football-data.co.uk',  'football-data.co.uk CSV',       'https://www.football-data.co.uk',   'historical', 1, 1, 0, 'unverified', 'Data from football-data.co.uk'),
  ('espn',                 'ESPN scoreboard (unofficial)',  'https://site.api.espn.com',          'fallback',   0, 0, 0, 'unverified', NULL);

INSERT INTO competitions (code, name, country, fd_org_code, csv_div, enabled, note) VALUES
  ('PL',  'Premier League',        'England', 'PL',  'E0',  1, NULL),
  ('PD',  'La Liga',               'Spain',   'PD',  'SP1', 1, NULL),
  ('SA',  'Serie A',               'Italy',   'SA',  'I1',  1, NULL),
  ('BL1', 'Bundesliga',            'Germany', 'BL1', 'D1',  1, NULL),
  ('FL1', 'Ligue 1',               'France',  'FL1', 'F1',  1, NULL),
  ('CL',  'UEFA Champions League', NULL,      'CL',  NULL,  1, NULL),
  ('EL',  'UEFA Europa League',    NULL,      'EL',  NULL,  0, 'Not in the football-data.org free-tier list (third-party summary) and no verified free source. Disabled until data is confirmed.');

INSERT INTO source_status (provider_id) SELECT id FROM providers;
