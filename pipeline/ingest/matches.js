// Idempotent match ingestion.
//
// The planner compares provider data with what is already in D1 and emits statements ONLY for rows that
// differ, so re-running with identical input writes nothing. That matters on the free plan (100k row writes/day).
//
// Provider policy:
//  - A 'primary' provider (football-data.org) owns status, kickoff, date and results; it may correct them.
//  - Any other provider may only fill gaps (missing result, half-time, kickoff) and promote scheduled -> finished.
//    If its result disagrees with what is stored, nothing is overwritten and a conflict is reported.
//  - A finished match with goals is never regressed to an unplayed state.
import { applyStatements } from './apply.js';
import { ensureProviderTeams, loadResolver, unmappedStatements } from './teams.js';
import { toIso } from './jobs.js';

const STAT_COLUMNS = [
  ['shotsHome', 'shots_home'], ['shotsAway', 'shots_away'],
  ['shotsOnTargetHome', 'shots_on_target_home'], ['shotsOnTargetAway', 'shots_on_target_away'],
  ['cornersHome', 'corners_home'], ['cornersAway', 'corners_away'],
  ['foulsHome', 'fouls_home'], ['foulsAway', 'fouls_away'],
  ['yellowHome', 'yellow_home'], ['yellowAway', 'yellow_away'],
  ['redHome', 'red_home'], ['redAway', 'red_away'],
];
// Column names below come from this whitelist only, never from input.
const UPDATABLE = new Set(['status', 'matchday', 'stage', 'match_date', 'kickoff_utc', 'home_goals', 'away_goals', 'ht_home_goals', 'ht_away_goals', 'result_provider']);

const dayNum = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / 86400000;
const pairKey = (h, a) => `${h}|${a}`;
const dateKey = (h, a, d) => `${h}|${a}|${d}`;
const MAX_DATE_TOLERANCE_DAYS = 1;

/** Decide what to change on an existing match row. Pure. */
export function computeMatchUpdate(row, m, { isPrimary, providerId, takenDates }) {
  const set = {};
  const flags = [];
  const inc = m.goals90;

  if (m.status === 'finished' && inc) {
    if (row.home_goals == null) {
      Object.assign(set, { home_goals: inc.home, away_goals: inc.away, result_provider: providerId });
    } else if (row.home_goals !== inc.home || row.away_goals !== inc.away) {
      const detail = { matchId: row.id, stored: [row.home_goals, row.away_goals], incoming: [inc.home, inc.away], provider: providerId };
      if (isPrimary) {
        Object.assign(set, { home_goals: inc.home, away_goals: inc.away, result_provider: providerId });
        flags.push({ code: 'result_overridden', ...detail });
      } else {
        flags.push({ code: 'result_conflict', ...detail });
      }
    }
  }

  const goalsAfter = set.home_goals ?? row.home_goals;
  let status = row.status;
  if (isPrimary) {
    status = m.status;
    // Never regress a played match, and never leave goals on a non-finished match (schema CHECK).
    if (goalsAfter != null && status !== 'finished') {
      status = 'finished';
      if (m.status !== 'finished') flags.push({ code: 'status_regression_ignored', matchId: row.id, incoming: m.status });
    }
  } else if (m.status === 'finished' && row.status !== 'finished') {
    status = 'finished';
  }
  if (status !== row.status) set.status = status;

  if (m.status === 'finished' && m.halfTime) {
    const differs = row.ht_home_goals !== m.halfTime.home || row.ht_away_goals !== m.halfTime.away;
    if (row.ht_home_goals == null || (isPrimary && differs)) {
      set.ht_home_goals = m.halfTime.home;
      set.ht_away_goals = m.halfTime.away;
    }
  }

  if (m.kickoffUtc && (row.kickoff_utc == null || (isPrimary && row.kickoff_utc !== m.kickoffUtc))) set.kickoff_utc = m.kickoffUtc;

  if (isPrimary && m.matchDate !== row.match_date) {
    const next = dateKey(row.home_team_id, row.away_team_id, m.matchDate);
    if (takenDates.has(next)) {
      flags.push({ code: 'date_conflict', matchId: row.id, stored: row.match_date, incoming: m.matchDate });
    } else {
      takenDates.delete(dateKey(row.home_team_id, row.away_team_id, row.match_date));
      takenDates.add(next);
      set.match_date = m.matchDate;
    }
  }

  for (const [field, col] of [['matchday', 'matchday'], ['stage', 'stage']]) {
    const v = m[field];
    if (v != null && (row[col] == null || (isPrimary && row[col] !== v))) set[col] = v;
  }
  return { set, flags };
}

function updateStatement(id, set, now) {
  const cols = Object.keys(set);
  for (const c of cols) if (!UPDATABLE.has(c)) throw new Error(`refusing to update column ${c}`);
  return {
    sql: `UPDATE matches SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    params: [...cols.map((c) => set[c]), toIso(now), id],
  };
}

const linkStatement = (providerId, providerMatchId, matchId, ts) => ({
  sql: 'INSERT OR IGNORE INTO match_provider_ids (provider_id, provider_match_id, match_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  params: [providerId, providerMatchId, matchId, ts, ts],
});

function statsDiffers(existing, stats) {
  if (!existing) return true;
  return STAT_COLUMNS.some(([f, col]) => (existing[col] ?? null) !== (stats[f] ?? null));
}

/**
 * Pure planner. `resolved` = [{ m, homeId, awayId }] with canonical team ids.
 * Returns { statements, counts, conflicts }.
 */
export function planMatches({ provider, competition, season, resolved, existing, links, statsByMatch, now, fetchedAt }) {
  const isPrimary = provider.role === 'primary';
  const ts = toIso(now);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const byPair = new Map();
  for (const r of existing) {
    const k = pairKey(r.home_team_id, r.away_team_id);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  const takenDates = new Set(existing.map((r) => dateKey(r.home_team_id, r.away_team_id, r.match_date)));
  const linkedTo = new Map(); // matchId -> provider match id already linked for this provider
  for (const [pid, mid] of links) linkedTo.set(mid, pid);
  const claimed = new Set();

  const statements = [];
  const conflicts = [];
  const counts = { inserted: 0, updated: 0, unchanged: 0, linked: 0, statsWritten: 0, duplicateIncoming: 0 };

  const statsStatement = (matchRef, stats, existingStats) => {
    if (!stats || !statsDiffers(existingStats, stats)) return null;
    const cols = STAT_COLUMNS.map(([, c]) => c);
    const vals = STAT_COLUMNS.map(([f]) => stats[f] ?? null);
    if (matchRef.id != null) {
      return {
        sql: `INSERT OR REPLACE INTO match_stats (match_id, provider_id, ${cols.join(', ')}, fetched_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
        params: [matchRef.id, provider.id, ...vals, fetchedAt],
      };
    }
    return {
      sql: `INSERT OR REPLACE INTO match_stats (match_id, provider_id, ${cols.join(', ')}, fetched_at)
            SELECT id, ?, ${cols.map(() => '?').join(', ')}, ? FROM matches
            WHERE competition_id = ? AND season = ? AND home_team_id = ? AND away_team_id = ? AND match_date = ?`,
      params: [provider.id, ...vals, fetchedAt, competition.id, season, matchRef.home, matchRef.away, matchRef.date],
    };
  };

  for (const { m, homeId, awayId } of resolved) {
    let target = null;
    const linkedId = links.get(m.providerMatchId);
    if (linkedId != null && byId.has(linkedId)) {
      target = byId.get(linkedId);
    } else {
      let best = null;
      for (const r of byPair.get(pairKey(homeId, awayId)) ?? []) {
        if (claimed.has(r.id)) continue;
        const other = linkedTo.get(r.id);
        if (other !== undefined && other !== m.providerMatchId) continue; // already tied to a different provider match
        const diff = Math.abs(dayNum(r.match_date) - dayNum(m.matchDate));
        if (diff <= MAX_DATE_TOLERANCE_DAYS && (best === null || diff < best.diff)) best = { row: r, diff };
      }
      target = best?.row ?? null;
    }

    if (target) {
      if (claimed.has(target.id)) { counts.duplicateIncoming++; continue; }
      claimed.add(target.id);
      if (target.home_team_id !== homeId || target.away_team_id !== awayId) {
        conflicts.push({ code: 'team_mismatch', matchId: target.id, providerMatchId: m.providerMatchId });
        continue;
      }
      let changed = false;
      const { set, flags } = computeMatchUpdate(target, m, { isPrimary, providerId: provider.id, takenDates });
      conflicts.push(...flags);
      if (Object.keys(set).length > 0) {
        statements.push(updateStatement(target.id, set, now));
        counts.updated++;
        changed = true;
      }
      if (!links.has(m.providerMatchId)) {
        statements.push(linkStatement(provider.id, m.providerMatchId, target.id, ts));
        counts.linked++;
        changed = true;
      }
      const st = statsStatement({ id: target.id }, m.stats, statsByMatch.get(target.id));
      if (st) { statements.push(st); counts.statsWritten++; changed = true; }
      if (!changed) counts.unchanged++;
      continue;
    }

    // New match.
    const key = dateKey(homeId, awayId, m.matchDate);
    if (takenDates.has(key)) { counts.duplicateIncoming++; continue; }
    takenDates.add(key);
    const played = m.status === 'finished';
    const goals = played ? m.goals90 : null;
    statements.push({
      sql: `INSERT INTO matches (competition_id, season, matchday, stage, match_date, kickoff_utc, status, home_team_id, away_team_id,
                                 home_goals, away_goals, ht_home_goals, ht_away_goals, result_provider, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (competition_id, season, home_team_id, away_team_id, match_date) DO NOTHING`,
      params: [
        competition.id, season, m.matchday, m.stage, m.matchDate, m.kickoffUtc, m.status, homeId, awayId,
        goals?.home ?? null, goals?.away ?? null, played ? m.halfTime?.home ?? null : null, played ? m.halfTime?.away ?? null : null,
        goals ? provider.id : null, ts,
      ],
    });
    statements.push({
      sql: `INSERT OR IGNORE INTO match_provider_ids (provider_id, provider_match_id, match_id, first_seen_at, last_seen_at)
            SELECT ?, ?, id, ?, ? FROM matches
            WHERE competition_id = ? AND season = ? AND home_team_id = ? AND away_team_id = ? AND match_date = ?`,
      params: [provider.id, m.providerMatchId, ts, ts, competition.id, season, homeId, awayId, m.matchDate],
    });
    counts.inserted++;
    const st = statsStatement({ id: null, home: homeId, away: awayId, date: m.matchDate }, m.stats, null);
    if (st) { statements.push(st); counts.statsWritten++; }
  }
  return { statements, counts, conflicts };
}

/**
 * Ingest normalized matches for one competition-season from one provider.
 * provider = { id, role }, competition = { id, code }.
 */
export async function ingestMatches({
  db, provider, competition, season, matches, now = new Date(), fetchedAt = toIso(now),
  autoCreateTeams = provider.role === 'primary', retry = {},
}) {
  let resolver = await loadResolver(db);
  let teamsCreated = 0;
  if (autoCreateTeams) {
    const refs = matches.flatMap((m) => [
      { providerTeamId: m.home.providerTeamId, name: m.home.name },
      { providerTeamId: m.away.providerTeamId, name: m.away.name },
    ]);
    teamsCreated = await ensureProviderTeams(db, { provider: provider.id, refs, resolver, now, retry });
    if (teamsCreated > 0) resolver = await loadResolver(db);
  }

  const resolved = [];
  const unmapped = [];
  let unmappedSkipped = 0;
  for (const m of matches) {
    const h = resolver.resolve(provider.id, { id: m.home.providerTeamId, name: m.home.name });
    const a = resolver.resolve(provider.id, { id: m.away.providerTeamId, name: m.away.name });
    if (h.ok && a.ok) resolved.push({ m, homeId: h.teamId, awayId: a.teamId });
    else {
      unmappedSkipped++;
      for (const r of [h, a]) if (!r.ok) unmapped.push({ aliasNorm: r.aliasNorm, nameRaw: r.nameRaw });
    }
  }

  const scope = [competition.id, season];
  const existing = await db.all(
    `SELECT id, match_date, kickoff_utc, status, home_team_id, away_team_id, home_goals, away_goals,
            ht_home_goals, ht_away_goals, matchday, stage
     FROM matches WHERE competition_id = ? AND season = ?`, scope);
  const linkRows = await db.all(
    `SELECT provider_match_id, match_id FROM match_provider_ids
     WHERE provider_id = ? AND match_id IN (SELECT id FROM matches WHERE competition_id = ? AND season = ?)`,
    [provider.id, ...scope]);
  const statRows = await db.all(
    `SELECT * FROM match_stats WHERE provider_id = ? AND match_id IN (SELECT id FROM matches WHERE competition_id = ? AND season = ?)`,
    [provider.id, ...scope]);

  const plan = planMatches({
    provider, competition, season, resolved, existing,
    links: new Map(linkRows.map((r) => [r.provider_match_id, r.match_id])),
    statsByMatch: new Map(statRows.map((r) => [r.match_id, r])),
    now, fetchedAt,
  });

  const statements = [
    ...plan.statements,
    ...unmappedStatements({ provider: provider.id, items: unmapped, competitionCode: competition.code, now }),
  ];
  const applied = await applyStatements(db, statements, { retry });

  return {
    fetched: matches.length,
    ...plan.counts,
    teamsCreated,
    unmappedSkipped,
    unmappedNames: [...new Set(unmapped.map((u) => u.nameRaw))],
    conflicts: plan.conflicts,
    statementsExecuted: applied + teamsCreated * 2,
  };
}
