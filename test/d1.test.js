import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1Client, D1Error } from '../pipeline/lib/d1.js';

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const creds = { accountId: 'acc123', databaseId: 'db-456', apiToken: 'SECRET-CF-TOKEN' };
const fast = { retries: 0, sleep: async () => {} };

function client(fetchImpl, extra = {}) {
  return createD1Client({ ...creds, fetchImpl, requestOptions: fast, ...extra });
}

test('all(): POSTs sql and params to the database query endpoint with a bearer token', async () => {
  const calls = [];
  const d1 = client(async (url, init) => { calls.push({ url, init }); return ok([{ results: [{ a: 1 }], success: true, meta: {} }]); });
  const rows = await d1.all('SELECT ? AS a', [undefined]);
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db-456/query');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer SECRET-CF-TOKEN');
  assert.deepEqual(JSON.parse(calls[0].init.body), { sql: 'SELECT ? AS a', params: [null] }, 'undefined becomes null');
});

test('run() returns changes and last row id', async () => {
  const d1 = client(async () => ok([{ results: [], success: true, meta: { changes: 2, last_row_id: 9 } }]));
  assert.deepEqual(await d1.run('UPDATE t SET a = 1'), { changes: 2, lastRowId: 9 });
});

test('batch() sends all statements in one request and skips empty batches', async () => {
  const calls = [];
  const d1 = client(async (url, init) => { calls.push(JSON.parse(init.body)); return ok([{ success: true }, { success: true }]); });
  await d1.batch([{ sql: 'A', params: [1] }, { sql: 'B' }]);
  await d1.batch([]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { batch: [{ sql: 'A', params: [1] }, { sql: 'B', params: [] }] });
});

test('network failures, 429 and 5xx are transient; 4xx and SQL errors are permanent', async () => {
  const kindOf = async (fetchImpl) => {
    try { await client(fetchImpl).all('SELECT 1'); } catch (e) { assert.ok(e instanceof D1Error); return e.kind; }
    return 'none';
  };
  assert.equal(await kindOf(async () => { throw new TypeError('fetch failed'); }), 'transient');
  assert.equal(await kindOf(async () => new Response('', { status: 503 })), 'transient');
  assert.equal(await kindOf(async () => new Response('', { status: 429 })), 'transient');
  assert.equal(await kindOf(async () => new Response('', { status: 401 })), 'permanent');
  assert.equal(await kindOf(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'no such table: x' }] }), { status: 200 })), 'permanent');
  assert.equal(await kindOf(async () => ok([{ success: false }])), 'permanent');
  assert.equal(await kindOf(async () => new Response('<html>', { status: 200 })), 'permanent', 'non-JSON body');
});

test('credentials are validated up front and never appear in errors', async () => {
  assert.throws(() => createD1Client({ ...creds, apiToken: '' }), /apiToken is not set/);
  assert.throws(() => createD1Client({ ...creds, accountId: 'a/../b' }), /invalid characters/);
  const d1 = client(async () => new Response('', { status: 401 }));
  await assert.rejects(d1.all('SELECT 1'), (e) => { assert.ok(!String(e.message).includes('SECRET-CF-TOKEN')); return true; });
});
