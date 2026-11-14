import { ProviderError } from './errors.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spaces calls at least `minIntervalMs` apart. Slot assignment is synchronous, so concurrent callers queue correctly. */
export class RateLimiter {
  constructor({ minIntervalMs, now = () => Date.now(), sleep = defaultSleep }) {
    if (!(minIntervalMs >= 0)) throw new RangeError('minIntervalMs must be >= 0');
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleep;
    this.nextAt = 0;
  }

  async wait() {
    const t = this.now();
    const slot = Math.max(t, this.nextAt);
    this.nextAt = slot + this.minIntervalMs;
    if (slot > t) await this.sleep(slot - t);
  }
}

/** Retry-After as milliseconds (delta-seconds or HTTP-date), or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * GET with timeout, exponential backoff with jitter, rate limiting and Retry-After handling.
 * Retries network errors, 408, 429 and 5xx. Other 4xx fail immediately.
 * A Retry-After longer than `maxRetryAfterMs` is surfaced as a rate_limit error instead of blocking the job.
 */
export async function requestText(url, {
  provider, method = 'GET', body = undefined, headers = {}, fetchImpl = globalThis.fetch, limiter = null, retries = 3,
  baseDelayMs = 1000, maxDelayMs = 30000, maxRetryAfterMs = 120000, timeoutMs = 20000,
  sleep = defaultSleep, random = Math.random, now = () => Date.now(),
} = {}) {
  const backoff = (attempt) => Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() * 0.5);

  for (let attempt = 0; ; attempt++) {
    if (limiter) await limiter.wait();
    let res;
    let text = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        res = await fetchImpl(url, { method, headers, body, signal: ctl.signal });
        if (res.ok) text = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      if (attempt >= retries) {
        throw new ProviderError({ provider, kind: 'network', message: `network error after ${attempt + 1} attempt(s)`, cause });
      }
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return { status: res.status, headers: res.headers, text };

    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    const kind = res.status === 429 ? 'rate_limit' : 'http';
    const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'), now());
    if (!retryable || attempt >= retries) {
      throw new ProviderError({ provider, kind, status: res.status, retryAfterMs, message: `HTTP ${res.status}` });
    }
    if (retryAfterMs != null && retryAfterMs > maxRetryAfterMs) {
      throw new ProviderError({ provider, kind: 'rate_limit', status: res.status, retryAfterMs, message: `HTTP ${res.status}, retry-after ${Math.round(retryAfterMs / 1000)}s exceeds limit` });
    }
    await sleep(retryAfterMs ?? backoff(attempt));
  }
}

export async function requestJson(url, opts) {
  const { text } = await requestText(url, opts);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderError({ provider: opts.provider, kind: 'parse', message: 'response is not valid JSON', cause });
  }
}
