import { D1Error } from './d1.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only database errors flagged transient are retried here. HTTP-level retries already happened in requestText. */
export const isTransient = (err) => err instanceof D1Error && err.kind === 'transient';

/**
 * Run `fn` up to `attempts` times with exponential backoff and jitter.
 * `fn` must be idempotent: every ingestion write is an upsert or a guarded insert, so replaying is safe.
 */
export async function withRetry(fn, {
  attempts = 3, baseDelayMs = 500, maxDelayMs = 15000, isRetryable = isTransient,
  sleep = defaultSleep, random = Math.random, onRetry = () => {},
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be >= 1');
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + random() * 0.5);
      onRetry({ attempt, delay, err });
      await sleep(delay);
    }
  }
}
