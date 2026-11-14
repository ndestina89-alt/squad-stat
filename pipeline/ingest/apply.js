import { withRetry } from '../lib/retry.js';

/**
 * Apply statements in atomic chunks, each retried on transient database errors.
 * Chunks are applied in order and every statement is idempotent, so a failure part-way is repaired by the next run.
 * Returns the number of statements applied. Keep chunkSize even: team creation uses insert/link pairs.
 */
export async function applyStatements(db, statements, { chunkSize = 50, retry = {} } = {}) {
  let applied = 0;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    await withRetry(() => db.batch(chunk), retry);
    applied += chunk.length;
  }
  return applied;
}
