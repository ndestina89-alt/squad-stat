import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isTransient } from '../pipeline/lib/retry.js';
import { D1Error } from '../pipeline/lib/d1.js';

const transient = () => new D1Error({ kind: 'transient', message: 'boom' });
const permanent = () => new D1Error({ kind: 'permanent', message: 'bad sql' });

test('retries transient errors with exponential backoff and returns the eventual result', async () => {
  let calls = 0;
  const delays = [];
  const out = await withRetry(async (attempt) => {
    calls++;
    if (attempt < 3) throw transient();
    return 'done';
  }, { baseDelayMs: 100, random: () => 1, sleep: async (ms) => delays.push(ms) });
  assert.equal(out, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('jitter keeps delays within 50-100% of the exponential value', async () => {
  const delays = [];
  await assert.rejects(withRetry(async () => { throw transient(); }, { attempts: 4, baseDelayMs: 1000, random: () => 0, sleep: async (ms) => delays.push(ms) }));
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test('delay is capped at maxDelayMs', async () => {
  const delays = [];
  await assert.rejects(withRetry(async () => { throw transient(); }, { attempts: 6, baseDelayMs: 1000, maxDelayMs: 3000, random: () => 1, sleep: async (ms) => delays.push(ms) }));
  assert.deepEqual(delays, [1000, 2000, 3000, 3000, 3000]);
});

test('permanent errors and unknown errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw permanent(); }, { sleep: async () => {} }), D1Error);
  await assert.rejects(withRetry(async () => { calls++; throw new TypeError('bug'); }, { sleep: async () => {} }), TypeError);
  assert.equal(calls, 2);
  assert.equal(isTransient(transient()), true);
  assert.equal(isTransient(permanent()), false);
  assert.equal(isTransient(new Error('x')), false);
});

test('gives up after the attempt budget and rethrows the last error; onRetry observes each retry', async () => {
  const seen = [];
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw transient(); }, { attempts: 3, sleep: async () => {}, onRetry: (i) => seen.push(i.attempt) }),
    (e) => e.kind === 'transient',
  );
  assert.equal(calls, 3);
  assert.deepEqual(seen, [1, 2]);
  await assert.rejects(withRetry(async () => 1, { attempts: 0 }), RangeError);
});
