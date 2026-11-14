import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, requestText, requestJson, parseRetryAfter } from '../pipeline/lib/http.js';
import { ProviderError } from '../pipeline/lib/errors.js';

const res = (status, body = '', headers = {}) => new Response(body, { status, headers });
const scripted = (...responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, calls };
};
const base = { provider: 't', random: () => 1, baseDelayMs: 100 };

test('RateLimiter spaces calls and queues concurrent callers', async () => {
  let t = 1000;
  const slept = [];
  // The clock only advances after a real tick, like a real timer, so concurrent callers see the same "now".
  const sleep = async (ms) => { slept.push(ms); await Promise.resolve(); t += ms; };
  const rl = new RateLimiter({ minIntervalMs: 500, now: () => t, sleep });
  await rl.wait();            // free slot
  await rl.wait();            // must wait 500
  await Promise.all([rl.wait(), rl.wait()]); // two more queue at +500 and +1000
  assert.deepEqual(slept, [500, 500, 1000]);
  assert.throws(() => new RateLimiter({ minIntervalMs: -1 }), RangeError);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('Thu, 12 Nov 2026 08:00:10 GMT', Date.parse('2026-11-12T08:00:00Z')), 10000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('retries 5xx with exponential backoff, then succeeds', async () => {
  const { fetchImpl, calls } = scripted(res(503), res(500), res(200, 'ok'));
  const slept = [];
  const out = await requestText('https://x/y', { ...base, fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.equal(out.text, 'ok');
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [100, 200]);
});

test('429 honours Retry-After', async () => {
  const { fetchImpl } = scripted(res(429, '', { 'retry-after': '2' }), res(200, 'ok'));
  const slept = [];
  await requestText('https://x', { ...base, fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(slept, [2000]);
});

test('a very long Retry-After fails fast as rate_limit instead of blocking the job', async () => {
  const { fetchImpl, calls } = scripted(res(429, '', { 'retry-after': '3600' }));
  const slept = [];
  await assert.rejects(
    requestText('https://x', { ...base, fetchImpl, sleep: async (ms) => slept.push(ms) }),
    (e) => e instanceof ProviderError && e.kind === 'rate_limit' && e.status === 429 && e.retryAfterMs === 3600000,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, []);
});

test('gives up after the retry budget with the last status', async () => {
  const { fetchImpl, calls } = scripted(res(500), res(500), res(500));
  await assert.rejects(
    requestText('https://x', { ...base, retries: 2, fetchImpl, sleep: async () => {} }),
    (e) => e.kind === 'http' && e.status === 500,
  );
  assert.equal(calls.length, 3);
});

test('4xx other than 408/429 is not retried', async () => {
  const { fetchImpl, calls } = scripted(res(403), res(200, 'ok'));
  await assert.rejects(requestText('https://x', { ...base, fetchImpl, sleep: async () => {} }), (e) => e.kind === 'http' && e.status === 403);
  assert.equal(calls.length, 1);
});

test('network errors are retried, then reported as kind=network', async () => {
  const { fetchImpl, calls } = scripted(new TypeError('fetch failed'), new TypeError('fetch failed'));
  await assert.rejects(
    requestText('https://x', { ...base, retries: 1, fetchImpl, sleep: async () => {} }),
    (e) => e.kind === 'network' && e.cause instanceof TypeError,
  );
  assert.equal(calls.length, 2);
});

test('a request that exceeds the timeout is aborted and counted as a network failure', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(requestText('https://x', { ...base, retries: 0, timeoutMs: 20, fetchImpl }), (e) => e.kind === 'network');
});

test('limiter is consulted before every attempt, including retries', async () => {
  const { fetchImpl } = scripted(res(500), res(200, 'ok'));
  let waits = 0;
  await requestText('https://x', { ...base, fetchImpl, sleep: async () => {}, limiter: { wait: async () => { waits++; } } });
  assert.equal(waits, 2);
});

test('headers are sent, and secrets never appear in error messages', async () => {
  const token = 'SECRET-TOKEN-123';
  const { fetchImpl, calls } = scripted(res(403));
  await assert.rejects(
    requestText('https://x/path', { ...base, fetchImpl, headers: { 'X-Auth-Token': token }, sleep: async () => {} }),
    (e) => { assert.ok(!String(e.message).includes(token)); assert.ok(!JSON.stringify(e).includes(token)); return true; },
  );
  assert.equal(calls[0].init.headers['X-Auth-Token'], token);
});

test('requestJson parses JSON and reports invalid JSON as kind=parse', async () => {
  assert.deepEqual(await requestJson('https://x', { ...base, fetchImpl: scripted(res(200, '{"a":1}')).fetchImpl }), { a: 1 });
  await assert.rejects(
    requestJson('https://x', { ...base, fetchImpl: scripted(res(200, '<html>')).fetchImpl }),
    (e) => e.kind === 'parse',
  );
});
