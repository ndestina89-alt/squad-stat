// Test helpers: D1 is SQLite, so migrations are applied to an in-memory node:sqlite database.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

export function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
  return db;
}

/** Minimal D1-compatible facade (prepare/bind/all/first/run) over node:sqlite. */
export function d1Adapter(db) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...p) { params = p; return stmt; },
        async all() {
          const rows = db.prepare(sql).all(...params).map((r) => ({ ...r }));
          return { results: rows, success: true };
        },
        async first() {
          const r = db.prepare(sql).get(...params);
          return r ? { ...r } : null;
        },
        async run() {
          const info = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
  };
}

export const NOW = '2026-11-12T08:00:00Z';

/** Insert two teams and return their ids. */
export function seedTeams(db) {
  const ins = db.prepare('INSERT INTO teams (name) VALUES (?)');
  const a = Number(ins.run('Test FC Alpha').lastInsertRowid);
  const b = Number(ins.run('Test FC Beta').lastInsertRowid);
  return { a, b };
}

export function insertMatch(db, over = {}) {
  const { a, b } = over.teams ?? seedTeams(db);
  const row = {
    competition_id: 1, season: 2026, match_date: '2026-11-14', kickoff_utc: '2026-11-14T15:00:00Z',
    status: 'scheduled', home_team_id: a, away_team_id: b, home_goals: null, away_goals: null,
    ht_home_goals: null, ht_away_goals: null, updated_at: NOW, ...over.row,
  };
  const cols = Object.keys(row);
  const sql = `INSERT INTO matches (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(db.prepare(sql).run(...cols.map((c) => row[c])).lastInsertRowid);
}
