// Db interface (all / run / batch) over node:sqlite, matching pipeline/lib/d1.js.
export function sqliteDb(db, { onStatement = null } = {}) {
  const exec = (sql, params = []) => {
    onStatement?.(sql, params);
    return db.prepare(sql).run(...params);
  };
  return {
    raw: db,
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map((r) => ({ ...r }));
    },
    async run(sql, params = []) {
      const info = exec(sql, params);
      return { changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) exec(s.sql, s.params ?? []);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** Wrap a Db so the first `failTimes` write calls (run/batch) throw a transient D1Error, then recover. */
export function flakyDb(inner, D1Error, { failTimes = 1, kind = 'transient' } = {}) {
  let left = failTimes;
  const maybeFail = () => {
    if (left > 0) { left--; throw new D1Error({ kind, message: 'simulated outage' }); }
  };
  return {
    raw: inner.raw,
    all: (...a) => inner.all(...a),
    run: async (...a) => { maybeFail(); return inner.run(...a); },
    batch: async (...a) => { maybeFail(); return inner.batch(...a); },
    get remainingFailures() { return left; },
  };
}
