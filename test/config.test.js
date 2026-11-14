import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompetitions, enabledCompetitions } from '../pipeline/config.js';

test('shipped config loads; Europa League is present but disabled', () => {
  const list = loadCompetitions();
  assert.deepEqual(enabledCompetitions(list).map((c) => c.code), ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL']);
  assert.equal(list.find((c) => c.code === 'EL').enabled, false);
});

test('duplicate codes, divisions and malformed entries are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-cfg-'));
  const load = (obj) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, JSON.stringify(obj)); return loadCompetitions(p); };
  const ok = { code: 'PL', name: 'X', fdOrgCode: 'PL', csvDiv: 'E0', enabled: true };
  assert.throws(() => load([ok, { ...ok, fdOrgCode: 'XX', csvDiv: 'E1' }]), /Duplicate code/);
  assert.throws(() => load([ok, { ...ok, code: 'PD', fdOrgCode: 'PD' }]), /Duplicate csvDiv/);
  assert.throws(() => load([{ ...ok, enabled: 'yes' }]), /Invalid competition/);
  assert.throws(() => load([{ ...ok, code: 'pl' }]), /Invalid competition/);
  assert.throws(() => load({}), /array/);
});
