import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, createTeamResolver, suggestTeams } from '../pipeline/lib/teams.js';

test('normalizeName strips accents, punctuation and case but keeps distinguishing tokens', () => {
  assert.equal(normalizeName('Atlético  Madrid'), 'atletico madrid');
  assert.equal(normalizeName('Brighton & Hove Albion'), 'brighton and hove albion');
  assert.equal(normalizeName("Newcastle Utd."), 'newcastle utd');
  assert.notEqual(normalizeName('Man United'), normalizeName('Manchester United FC'), 'no fuzzy merging');
  assert.equal(normalizeName(null), '');
});

test('resolver prefers provider ids, then explicit aliases, and never guesses', () => {
  const r = createTeamResolver({
    providerIds: [{ provider: 'football-data.org', providerTeamId: '11', teamId: 1 }],
    aliases: [{ provider: 'football-data.co.uk', aliasNorm: 'test fc alpha', teamId: 1 }],
  });
  assert.deepEqual(r.resolve('football-data.org', { id: '11', name: 'whatever' }), { ok: true, teamId: 1, via: 'provider_id' });
  assert.deepEqual(r.resolve('football-data.co.uk', { name: 'TEST FC  Alpha' }), { ok: true, teamId: 1, via: 'alias' });
  const miss = r.resolve('football-data.co.uk', { name: 'Test FC Alpha Reserves' });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'unmapped');
  assert.equal(miss.aliasNorm, 'test fc alpha reserves');
  // Aliases are per provider: another provider's alias does not leak across.
  assert.equal(r.resolve('football-data.org', { name: 'Test FC Alpha' }).ok, false);
});

test('conflicting mappings fail at build time', () => {
  assert.throws(() => createTeamResolver({
    aliases: [
      { provider: 'p', aliasNorm: 'x', teamId: 1 },
      { provider: 'p', aliasNorm: 'x', teamId: 2 },
    ],
  }), /Conflicting/);
  // Repeating the identical mapping is harmless.
  createTeamResolver({ aliases: [{ provider: 'p', aliasNorm: 'x', teamId: 1 }, { provider: 'p', aliasNorm: 'x', teamId: 1 }] });
});

test('suggestions rank by token overlap and are advisory only', () => {
  const teams = [{ id: 1, name: 'Manchester United FC' }, { id: 2, name: 'Manchester City FC' }, { id: 3, name: 'Leeds United' }];
  const s = suggestTeams('Man United', teams);
  assert.equal(s[0].teamId, 1);
  assert.ok(s.every((x) => x.score > 0 && x.score <= 1));
  assert.deepEqual(suggestTeams('', teams), []);
  assert.deepEqual(suggestTeams('Zzzz', teams), []);
});
