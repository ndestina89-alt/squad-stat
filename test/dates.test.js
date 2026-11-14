import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidYmd, londonLocalToUtcIso, utcIsoToLondonDate, normalizeUtcIso, seasonOfDate, seasonLabel } from '../pipeline/lib/dates.js';

test('London local time converts to UTC across DST', () => {
  assert.equal(londonLocalToUtcIso(2026, 8, 15, 15, 0), '2026-08-15T14:00:00Z', 'BST is UTC+1');
  assert.equal(londonLocalToUtcIso(2027, 1, 5, 20, 0), '2027-01-05T20:00:00Z', 'GMT is UTC+0');
  assert.equal(londonLocalToUtcIso(2026, 3, 29, 0, 30), '2026-03-29T00:30:00Z', 'just before spring forward');
  assert.equal(londonLocalToUtcIso(2026, 3, 29, 3, 0), '2026-03-29T02:00:00Z', 'just after spring forward');
  assert.equal(londonLocalToUtcIso(2026, 10, 25, 12, 0), '2026-10-25T12:00:00Z', 'after fall back');
});

test('UTC instants map to the London calendar date', () => {
  assert.equal(utcIsoToLondonDate('2026-08-15T23:30:00Z'), '2026-08-16');
  assert.equal(utcIsoToLondonDate('2026-01-15T23:30:00Z'), '2026-01-15');
  assert.equal(utcIsoToLondonDate('garbage'), null);
});

test('date validation and normalisation', () => {
  assert.equal(isValidYmd(2026, 2, 31), false);
  assert.equal(isValidYmd(2028, 2, 29), true);
  assert.equal(isValidYmd(2026, 13, 1), false);
  assert.equal(normalizeUtcIso('2026-08-15T14:00:00Z'), '2026-08-15T14:00:00Z');
  assert.equal(normalizeUtcIso('2026-08-15T14:00Z'), '2026-08-15T14:00:00Z');
  assert.equal(normalizeUtcIso('2026-08-15T14:00:00.123Z'), '2026-08-15T14:00:00Z');
  assert.equal(normalizeUtcIso('2026-08-15T14:00:00+01:00'), null, 'offsets are not accepted');
  assert.equal(normalizeUtcIso('2026-02-31T14:00:00Z'), null, 'impossible dates must not roll over');
  assert.equal(normalizeUtcIso('2026-08-15T24:00:00Z'), null);
  assert.equal(normalizeUtcIso('2026-08-15T14:60:00Z'), null);
  assert.equal(normalizeUtcIso(null), null);
});

test('season helpers', () => {
  assert.equal(seasonOfDate('2026-08-01'), 2026);
  assert.equal(seasonOfDate('2027-05-30'), 2026);
  assert.equal(seasonOfDate('2026-07-01'), 2026);
  assert.equal(seasonLabel(2026), '2026-27');
  assert.equal(seasonLabel(1999), '1999-00');
});
