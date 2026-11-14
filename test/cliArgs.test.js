import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, seasonRange } from '../pipeline/bin/args.js';

const p = (a) => parseArgs(a, { currentSeason: 2026 });
test('fd defaults', () => {
  assert.deepEqual(p(['fd']), { command: 'fd', competitions: null, standings: true, season: 2026, from: null, to: null, search: null, name: null, teamId: null, provider: 'football-data.co.uk' });
  assert.deepEqual(p(['fd', '--season', '2025', '--competitions', 'pl, pd', '--no-standings']).competitions, ['PL', 'PD']);
});
test('csv range', () => {
  const a = p(['csv', '--from', '2022']);
  assert.deepEqual([a.from, a.to], [2022, 2026]);
  assert.deepEqual(seasonRange(2024, 2026), [2024, 2025, 2026]);
});
test('bad input is rejected', () => {
  for (const bad of [[], ['x'], ['fd', '--season'], ['fd', '--season', '25'], ['fd', '--nope'], ['csv'], ['csv', '--from', '2026', '--to', '2020'], ['csv', '--from', '2000', '--to', '2026'], ['fd', '--competitions', ',']]) {
    assert.throws(() => p(bad), RangeError, JSON.stringify(bad));
  }
});

test('teams and alias commands', () => {
  assert.equal(p(['teams', '--search', 'Man']).search, 'Man');
  const a = p(['alias', '--name', 'Man United', '--team-id', '12']);
  assert.deepEqual([a.name, a.teamId, a.provider], ['Man United', 12, 'football-data.co.uk']);
  for (const bad of [['alias'], ['alias', '--name', 'x'], ['alias', '--team-id', '3'], ['alias', '--name', 'x', '--team-id', 'abc'], ['alias', '--name', 'x', '--team-id', '-1']]) assert.throws(() => p(bad), RangeError, JSON.stringify(bad));
});
